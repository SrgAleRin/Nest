import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, nowIso } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-paths-')));
const worktreesRoot = path.join(tempRoot, 'worktrees');
let core: Core | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
    .replace(/\r\n/g, '\n')
    .trim();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Git prints worktree paths with forward slashes on every platform. */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    path.resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(a) === normalize(b);
}

function registeredWorktrees(repoPath: string): string[] {
  return git(['worktree', 'list', '--porcelain'], repoPath)
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

/** A repository whose directory name is `repo`, under its own parent. */
function makeRepo(parent: string): string {
  const repoPath = path.join(tempRoot, parent, 'repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.name', 'Nest'], repoPath);
  git(['config', 'user.email', 'nest@example.com'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), `# ${parent}\n`, 'utf8');
  git(['add', '.'], repoPath);
  git(['commit', '-m', 'init'], repoPath);
  return repoPath;
}

beforeAll(() => {
  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot,
    fakeHarnessScript,
  });
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('workspace paths', () => {
  it('keeps same-named repositories in different directories', async () => {
    if (!core) throw new Error('core was not created');

    const first = await core.projects.add(makeRepo('one'));
    const second = await core.projects.add(makeRepo('two'));
    expect(first.project.name).toBe('repo');
    expect(second.project.name).toBe('repo');
    const firstRepo = first.project.path;
    const secondRepo = second.project.path;

    const a = await core.tasks.create({
      projectId: first.project.id,
      title: 'Same title',
      setupScript: null,
    });
    const b = await core.tasks.create({
      projectId: second.project.id,
      title: 'Same title',
      setupScript: null,
    });

    expect(a.workspacePath).not.toBe(b.workspacePath);
    expect(path.dirname(a.workspacePath)).not.toBe(path.dirname(b.workspacePath));
    expect(existsSync(a.workspacePath)).toBe(true);
    expect(existsSync(b.workspacePath)).toBe(true);
    // Each worktree belongs to its own repository, nothing is shared.
    expect(registeredWorktrees(firstRepo).some((entry) => samePath(entry, a.workspacePath))).toBe(
      true,
    );
    expect(registeredWorktrees(secondRepo).some((entry) => samePath(entry, b.workspacePath))).toBe(
      true,
    );
  });

  it('serializes concurrent creations so they never share a path or branch', async () => {
    if (!core) throw new Error('core was not created');

    const { project } = await core.projects.add(makeRepo('race'));
    const [first, second] = await Promise.all([
      core.tasks.create({ projectId: project.id, title: 'Race', setupScript: null }),
      core.tasks.create({ projectId: project.id, title: 'Race', setupScript: null }),
    ]);

    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(first.branch).not.toBe(second.branch);
    expect(first.slug).not.toBe(second.slug);
    expect(existsSync(first.workspacePath)).toBe(true);
    expect(existsSync(second.workspacePath)).toBe(true);
  });

  it('rolls back only its own artifacts when creation fails after the worktree exists', async () => {
    if (!core) throw new Error('core was not created');

    const { project } = await core.projects.add(makeRepo('rollback'));
    const repoPath = project.path;
    const keep = await core.tasks.create({
      projectId: project.id,
      title: 'Keep me',
      setupScript: null,
    });

    // Fail the task INSERT, which happens after the worktree and branch exist.
    core.db.exec(
      "CREATE TRIGGER nest_fail_create BEFORE INSERT ON tasks WHEN NEW.title = 'Explode' " +
        "BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
    );
    let failure: unknown = null;
    try {
      await core.tasks.create({ projectId: project.id, title: 'Explode', setupScript: null });
    } catch (error) {
      failure = error;
    } finally {
      core.db.exec('DROP TRIGGER nest_fail_create');
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('simulated failure');

    // The failed creation left no directory, branch or row behind.
    const explodePath = path.join(path.dirname(keep.workspacePath), 'explode');
    expect(existsSync(explodePath)).toBe(false);
    expect(gitOrNull(['rev-parse', '--verify', 'refs/heads/nest/explode'], repoPath)).toBeNull();
    expect(core.tasks.list(project.id).some((task) => task.title === 'Explode')).toBe(false);

    // Another task's worktree and branch were never touched.
    expect(existsSync(keep.workspacePath)).toBe(true);
    expect(git(['rev-parse', '--verify', `refs/heads/${keep.branch}`], repoPath)).toHaveLength(40);
    expect(registeredWorktrees(repoPath).some((entry) => samePath(entry, keep.workspacePath))).toBe(
      true,
    );

    // The same title works again once the failure is gone.
    const retried = await core.tasks.create({
      projectId: project.id,
      title: 'Explode',
      setupScript: null,
    });
    expect(existsSync(retried.workspacePath)).toBe(true);
  });

  it('keeps tasks whose workspace uses the old path scheme working', async () => {
    if (!core) throw new Error('core was not created');

    const { project } = await core.projects.add(makeRepo('legacy'));
    const repoPath = project.path;
    // The pre-suffix layout: worktreesRoot/<project basename>/<slug>.
    const legacyPath = path.join(worktreesRoot, 'repo', 'legacy');
    git(['worktree', 'add', '--no-track', '-b', 'nest/legacy', legacyPath, 'main'], repoPath);

    const id = newId();
    const timestamp = nowIso();
    core.db
      .prepare(
        `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
         VALUES (?, ?, 'worktree', 'legacy', 'Legacy task', 'nest/legacy', ?, 'active', ?, ?)`,
      )
      .run(id, project.id, legacyPath, timestamp, timestamp);

    const status = await core.git.status(id);
    expect(status.branch).toBe('nest/legacy');

    // A new task of the same name is created under the new scheme instead of
    // reusing the legacy directory.
    const fresh = await core.tasks.create({
      projectId: project.id,
      title: 'Legacy task',
      setupScript: null,
    });
    expect(fresh.workspacePath).not.toBe(legacyPath);
    expect(fresh.slug).toBe('legacy-task');
    expect(existsSync(legacyPath)).toBe(true);
  });
});
