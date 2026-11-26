import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import { resolveWorktreesRoot } from '../src/services/settings.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-workspace-')));
const repoPath = path.join(tempRoot, 'repo');
const defaultRoot = path.join(tempRoot, 'worktrees');
const customRoot = path.join(tempRoot, 'custom-worktrees');
let core: Core | null = null;
let projectId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# workspace settings\n', 'utf8');
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\n.env.local\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
  // Untracked local secrets that Nest may copy into a worktree.
  writeFileSync(path.join(repoPath, '.env'), 'TOKEN=from-project\n', 'utf8');
  writeFileSync(path.join(repoPath, '.env.local'), 'LOCAL=1\n', 'utf8');

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: defaultRoot,
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

function requireCore(): Core {
  if (!core) throw new Error('core was not created');
  return core;
}

describe('worktree root setting', () => {
  it('keeps new worktrees in the default root and copies no env files by default', async () => {
    const service = requireCore();
    expect(service.settings.get()).toMatchObject({ worktreeRoot: '', copyEnvFiles: false });

    const task = await service.tasks.create({ projectId, title: 'default root' });

    expect(task.workspacePath.startsWith(defaultRoot)).toBe(true);
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(existsSync(path.join(task.workspacePath, '.env'))).toBe(false);
    expect(existsSync(path.join(task.workspacePath, '.env.local'))).toBe(false);
  });

  it('creates the next task in the saved root and leaves existing worktrees alone', async () => {
    const service = requireCore();
    const [existing] = service.tasks
      .list(projectId)
      .filter((task) => task.kind === 'worktree' && task.title === 'default root');
    if (!existing) throw new Error('the default-root task was not found');

    service.settings.update({ worktreeRoot: customRoot, copyEnvFiles: true });
    const task = await service.tasks.create({ projectId, title: 'custom root' });

    expect(task.workspacePath.startsWith(realpathSync.native(customRoot))).toBe(true);
    expect(readFileSync(path.join(task.workspacePath, '.env'), 'utf8')).toBe(
      'TOKEN=from-project\n',
    );
    expect(readFileSync(path.join(task.workspacePath, '.env.local'), 'utf8')).toBe('LOCAL=1\n');

    // No migration: the earlier worktree stays where it was created.
    const unchanged = service.tasks.get(existing.id);
    expect(unchanged.workspacePath).toBe(existing.workspacePath);
    expect(existsSync(unchanged.workspacePath)).toBe(true);
  });

  it('reports an unusable root instead of silently using another folder', async () => {
    const service = requireCore();
    // A file where a directory is expected: the path cannot be created.
    const blocker = path.join(tempRoot, 'not-a-directory');
    writeFileSync(blocker, 'x', 'utf8');
    service.settings.update({ worktreeRoot: path.join(blocker, 'worktrees') });

    try {
      await expect(service.tasks.create({ projectId, title: 'bad root' })).rejects.toMatchObject({
        code: 'worktree_root_unusable',
      });
    } finally {
      service.settings.update({ worktreeRoot: '', copyEnvFiles: false });
    }

    // The failure left no task behind and the default root still works.
    expect(service.tasks.list(projectId).some((task) => task.title === 'bad root')).toBe(false);
    const task = await service.tasks.create({ projectId, title: 'back to default' });
    expect(task.workspacePath.startsWith(defaultRoot)).toBe(true);
  });

  it('resolves the effective root from the default and the saved value', () => {
    expect(resolveWorktreesRoot(defaultRoot, '')).toBe(defaultRoot);
    expect(resolveWorktreesRoot(defaultRoot, '   ')).toBe(defaultRoot);
    expect(resolveWorktreesRoot(defaultRoot, customRoot)).toBe(path.resolve(customRoot));
  });
});
