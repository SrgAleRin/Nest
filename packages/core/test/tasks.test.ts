import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestEvent } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-tasks-')));
const repoPath = path.join(tempRoot, 'repo');
const remotePath = path.join(tempRoot, 'origin.git');
const events: NestEvent[] = [];
let core: Core | null = null;
let projectId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# tasks\n', 'utf8');
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\n.env.local\n', 'utf8');
  mkdirSync(path.join(repoPath, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(repoPath, 'scripts', 'setup-ok.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('setup.log', 'ok');\n",
    'utf8',
  );
  writeFileSync(
    path.join(repoPath, 'scripts', 'setup-fail.mjs'),
    "process.stderr.write('boom');\nprocess.exit(3);\n",
    'utf8',
  );
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );

  // Local env files are untracked in real repos and are copied by Nest.
  writeFileSync(path.join(repoPath, '.env'), 'TOKEN=from-project\n', 'utf8');
  writeFileSync(path.join(repoPath, '.env.local'), 'LOCAL=1\n', 'utf8');

  // A file remote makes git fetch and origin/main resolution real.
  git(['init', '--bare', '--initial-branch=main', remotePath], tempRoot);
  git(['remote', 'add', 'origin', remotePath], repoPath);
  git(['push', '-u', 'origin', 'main'], repoPath);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
    onEvent: (event) => events.push(event),
  });
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('task setup', () => {
  it('copies env files and runs the setup script in the new worktree', async () => {
    if (!core) throw new Error('core was not created');
    const script = 'node scripts/setup-ok.mjs';

    const task = await core.tasks.create({
      projectId,
      title: 'Setup works',
      setupScript: script,
    });

    expect(task.setupError).toBeNull();
    expect(task.workspacePath).toContain('setup-works');
    expect(readFileSync(path.join(task.workspacePath, '.env'), 'utf8')).toBe(
      'TOKEN=from-project\n',
    );
    expect(readFileSync(path.join(task.workspacePath, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    expect(readFileSync(path.join(task.workspacePath, 'setup.log'), 'utf8')).toBe('ok');

    // The script is remembered on the project, so the dialog prefills it.
    expect(core.projects.get(projectId).setupScript).toBe(script);
  });

  it('keeps the worktree and records setupError when the setup script fails', async () => {
    if (!core) throw new Error('core was not created');
    const task = await core.tasks.create({
      projectId,
      title: 'Setup fails',
      setupScript: 'node scripts/setup-fail.mjs',
    });

    expect(task.setupError).toMatch(/exited with code 3/);
    expect(task.setupError).toContain('boom');
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(core.tasks.get(task.id).setupError).toBe(task.setupError);
    // A failed setup must not hide the task from the list.
    expect(core.tasks.list(projectId).some((candidate) => candidate.id === task.id)).toBe(true);
  });

  it('creates a task from a remote-tracking base branch after fetch', async () => {
    if (!core) throw new Error('core was not created');
    git(['commit', '--allow-empty', '-m', 'upstream only'], repoPath);
    git(['push', 'origin', 'main'], repoPath);
    git(['reset', '--hard', 'HEAD~1'], repoPath);

    const task = await core.tasks.create({
      projectId,
      title: 'From origin main',
      baseRef: 'origin/main',
      setupScript: null,
    });

    expect(task.setupError).toBeNull();
    const log = execFileSync('git', ['log', '--format=%s', '-1'], {
      cwd: task.workspacePath,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(log.trim()).toBe('upstream only');
  });

  it('rejects an unknown base branch', async () => {
    if (!core) throw new Error('core was not created');
    await expect(
      core.tasks.create({ projectId, title: 'Bad base', baseRef: 'missing-branch' }),
    ).rejects.toThrow(/does not exist/);
  });

  it('opens the existing main checkout instead of creating a task', async () => {
    if (!core) throw new Error('core was not created');
    const before = core.tasks.list(projectId).length;

    const checkout = core.tasks.ensureCheckout(projectId);
    expect(checkout.kind).toBe('checkout');
    expect(checkout.slug).toBe('@main');
    expect(checkout.workspacePath).toBe(repoPath);

    core.tasks.ensureCheckout(projectId);
    expect(core.tasks.list(projectId)).toHaveLength(before);
  });

  it('reports creation progress in order', async () => {
    if (!core) throw new Error('core was not created');
    const start = events.length;

    await core.tasks.create({ projectId, title: 'Progress steps', setupScript: null });

    const steps = events
      .slice(start)
      .filter((event) => event.type === 'task:progress')
      .map((event) => (event.type === 'task:progress' ? event.step : ''));
    expect(steps).toEqual(['fetch', 'worktree', 'setup']);
  });

  it('removes a clean worktree without force', async () => {
    if (!core) throw new Error('core was not created');
    const task = await core.tasks.create({
      projectId,
      title: 'Clean remove',
      setupScript: null,
    });

    await core.tasks.remove(task.id);

    expect(existsSync(task.workspacePath)).toBe(false);
    expect(core.tasks.list(projectId).some((candidate) => candidate.id === task.id)).toBe(false);
  });

  it('refuses a dirty worktree until the removal is forced', async () => {
    if (!core) throw new Error('core was not created');
    const task = await core.tasks.create({
      projectId,
      title: 'Dirty remove',
      setupScript: null,
    });
    writeFileSync(path.join(task.workspacePath, 'dirty.txt'), 'not committed\n', 'utf8');

    const failure = await core.tasks.remove(task.id).then(
      () => null,
      (error: unknown) => error as { code?: string; details?: string },
    );
    expect(failure).toMatchObject({ code: 'workspace_dirty' });
    expect(failure?.details).toContain('dirty.txt');
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(core.tasks.get(task.id).id).toBe(task.id);

    await core.tasks.remove(task.id, { force: true });
    expect(existsSync(task.workspacePath)).toBe(false);
    expect(() => core!.tasks.get(task.id)).toThrow(/not found/);
  });
});
