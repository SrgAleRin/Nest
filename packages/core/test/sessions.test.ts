import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-core-'));
const repoPath = path.join(tempRoot, 'repo');
let core: Core | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('core vertical slice', () => {
  it('registers a project with a main checkout', async () => {
    mkdirSync(repoPath, { recursive: true });
    git(['init', '-b', 'main'], repoPath);
    writeFileSync(path.join(repoPath, 'README.md'), '# demo\n', 'utf8');
    git(['add', '.'], repoPath);
    git(
      ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
      repoPath,
    );

    core = createCore({
      dbPath: path.join(tempRoot, 'nest.db'),
      worktreesRoot: path.join(tempRoot, 'worktrees'),
      fakeHarnessScript,
    });

    const { project, checkout } = await core.projects.add(repoPath);
    expect(project.name).toBe('repo');
    expect(checkout.kind).toBe('checkout');
    expect(checkout.slug).toBe('@main');
    expect(checkout.branch).toBe('main');
    expect(checkout.workspacePath).toBe(repoPath);

    await expect(core.projects.add(repoPath)).rejects.toThrow(/already added/);
  });

  it('creates a worktree task and commits through the git service', async () => {
    if (!core) throw new Error('core was not created');
    const project = core.projects.list()[0];
    if (!project) throw new Error('project missing');

    const task = await core.tasks.create({ projectId: project.id, title: 'Feature one' });
    expect(task.kind).toBe('worktree');
    expect(task.branch).toBe('nest/feature-one');
    expect(task.workspacePath).toContain('feature-one');

    writeFileSync(path.join(task.workspacePath, 'feature.txt'), 'hello\n', 'utf8');
    const status = await core.git.status(task.id);
    expect(status.files.some((file) => file.path === 'feature.txt')).toBe(true);

    const diff = await core.git.diff(task.id);
    expect(diff.files.some((file) => file.path === 'feature.txt')).toBe(true);

    await core.git.stage(task.id, ['feature.txt']);
    const commit = await core.git.commit(task.id, 'add feature', false);
    expect(commit.hash.length).toBeGreaterThan(3);
  });

  it('runs the fake harness over a real PTY and stores scrollback', async () => {
    if (!core) throw new Error('core was not created');
    const checkout = core.tasks.list().find((task) => task.kind === 'checkout');
    if (!checkout) throw new Error('checkout missing');

    const session = await core.sessions.start({
      taskId: checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });

    await waitFor(() => core!.sessions.scrollback(session.id).includes('FakeHarness'));
    core.sessions.write(session.id, 'echo hello-core\r');
    await waitFor(() => core!.sessions.scrollback(session.id).includes('hello-core'));

    core.sessions.stop(session.id);
    await waitFor(() => core!.sessions.get(session.id).status !== 'running', 20_000);

    const stored = core.sessions.scrollback(session.id);
    expect(stored).toContain('hello-core');
    expect(core.sessions.activeForTask(checkout.id)).toBeNull();
  });

  it('resumes an ended session in the same row without creating a tab', async () => {
    if (!core) throw new Error('core was not created');
    const sessions = core.sessions.list();
    const previous = sessions[sessions.length - 1];
    if (!previous) throw new Error('session missing');
    expect(previous.status).toBe('exited');

    const resumed = await core.sessions.resume(previous.id);
    expect(resumed.id).toBe(previous.id);
    expect(resumed.title).toBe(previous.title);

    await waitFor(() => ['running', 'idle'].includes(core!.sessions.get(previous.id).status));
    await waitFor(() => core!.sessions.scrollback(previous.id).includes('resume Fake harness'));

    expect(core.sessions.list()).toHaveLength(sessions.length);

    core.sessions.stop(previous.id);
    await waitFor(() => core!.sessions.get(previous.id).status !== 'running', 20_000);
  });
});
