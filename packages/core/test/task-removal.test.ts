import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@nest/shared';
import { createCore, NestError, type Core } from '../src/index.js';
import './gitEnv.js';
import { spawnPipedPty } from './pipedPty.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-remove-')));
let core: Core | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
    .replace(/\r\n/g, '\n')
    .trim();
}

/** Git prints worktree paths with forward slashes on every platform. */
function gitPath(value: string): string {
  return value.replace(/\\/g, '/');
}

/** A fresh repository with one commit on main. */
function makeRepo(name: string): string {
  const repo = path.join(tempRoot, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n', 'utf8');
  git(['add', '.'], repo);
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'], repo);
  return repo;
}

async function addProject(name: string): Promise<{ project: Project; repoPath: string }> {
  if (!core) throw new Error('core was not created');
  const repoPath = makeRepo(name);
  const { project } = await core.projects.add(repoPath);
  return { project, repoPath };
}

async function failureOf(promise: Promise<unknown>): Promise<NestError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  if (!(error instanceof NestError)) throw error ?? new Error('expected an error, got success');
  return error;
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

beforeAll(() => {
  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
    sessions: { spawnPty: spawnPipedPty },
  });
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('task removal', () => {
  it('keeps the task, its session, its comment and the worktree when git refuses to remove it', async () => {
    if (!core) throw new Error('core was not created');
    const { project, repoPath } = await addProject('locked');
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'Locked worktree',
      setupScript: null,
    });
    const comment = await core.comments.create({
      taskId: task.id,
      filePath: 'README.md',
      line: 1,
      side: 'new',
      body: 'keep me while removal fails',
    });

    // A live session must be stopped before Git is touched, so start one.
    const session = await core.sessions.start({
      taskId: task.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => core!.sessions.scrollback(session.id).includes('FakeHarness'));

    git(['worktree', 'lock', task.workspacePath], repoPath);

    const failure = await failureOf(core.tasks.remove(task.id));
    expect(failure.code).toBe('worktree_remove_failed');
    expect(failure.message).toContain(task.workspacePath);
    expect(failure.details ?? '').toMatch(/lock/i);
    expect(failure.details ?? '').toMatch(/retry|unlock/i);

    // Nothing disappeared: the worktree, the task, the session and the comment.
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(core.tasks.get(task.id).id).toBe(task.id);
    expect(core.sessions.get(session.id).id).toBe(session.id);
    expect(core.comments.get(comment.id).body).toBe('keep me while removal fails');
    expect(git(['worktree', 'list', '--porcelain'], repoPath)).toContain(gitPath(task.workspacePath));
    // Stopping the PTY still happened: the row reports the confirmed exit.
    expect(core.sessions.liveSessions([task.id])).toEqual([]);

    // A retry after unlocking succeeds, and the branch survives.
    git(['worktree', 'unlock', task.workspacePath], repoPath);
    await core.tasks.remove(task.id);

    expect(existsSync(task.workspacePath)).toBe(false);
    expect(() => core!.tasks.get(task.id)).toThrow(/not found/);
    expect(git(['worktree', 'list', '--porcelain'], repoPath)).not.toContain(gitPath(task.workspacePath));
    expect(git(['branch', '--list', 'nest/locked-worktree'], repoPath)).toContain(
      'nest/locked-worktree',
    );
  });

  it('does not treat force as a way around a locked worktree', async () => {
    if (!core) throw new Error('core was not created');
    const { project, repoPath } = await addProject('locked-force');
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'Locked force',
      setupScript: null,
    });

    git(['worktree', 'lock', '--reason', 'test', task.workspacePath], repoPath);
    const failure = await failureOf(core.tasks.remove(task.id, { force: true }));

    expect(failure.code).toBe('worktree_remove_failed');
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(core.tasks.get(task.id).id).toBe(task.id);

    git(['worktree', 'unlock', task.workspacePath], repoPath);
    await core.tasks.remove(task.id, { force: true });
    expect(existsSync(task.workspacePath)).toBe(false);
  });

  it('cleans the row of a missing workspace only after git stops registering it', async () => {
    if (!core) throw new Error('core was not created');
    const { project, repoPath } = await addProject('missing-registered');
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'Missing registered',
      setupScript: null,
    });

    // Enough to make the path vanish while git still knows the worktree.
    rmSync(task.workspacePath, { recursive: true, force: true });
    expect(git(['worktree', 'list', '--porcelain'], repoPath)).toContain(gitPath(task.workspacePath));

    await core.tasks.remove(task.id);

    expect(() => core!.tasks.get(task.id)).toThrow(/not found/);
    expect(git(['worktree', 'list', '--porcelain'], repoPath)).not.toContain(gitPath(task.workspacePath));
  });

  it('cleans the row of a missing workspace that git no longer registers', async () => {
    if (!core) throw new Error('core was not created');
    const { project, repoPath } = await addProject('missing-clean');
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'Missing clean',
      setupScript: null,
    });

    rmSync(task.workspacePath, { recursive: true, force: true });
    git(['worktree', 'prune'], repoPath);

    await core.tasks.remove(task.id);

    expect(() => core!.tasks.get(task.id)).toThrow(/not found/);
    expect(core.tasks.list(project.id).some((candidate) => candidate.id === task.id)).toBe(false);
  });

  it('never reads a failing git status as a clean worktree', async () => {
    if (!core) throw new Error('core was not created');
    const { project } = await addProject('status-fails');
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'Status fails',
      setupScript: null,
    });

    // Without its .git file the worktree is not a repository any more, so
    // `git status` fails. That must not be mistaken for "no changes".
    rmSync(path.join(task.workspacePath, '.git'), { force: true });

    const failure = await failureOf(core.tasks.remove(task.id));
    expect(failure.code).toBe('worktree_status_failed');
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(core.tasks.get(task.id).id).toBe(task.id);
  });

  it('refuses to remove the main checkout', async () => {
    if (!core) throw new Error('core was not created');
    const { project } = await addProject('immutable-checkout');
    const checkout = core.tasks.ensureCheckout(project.id);

    const failure = await failureOf(core.tasks.remove(checkout.id));
    expect(failure.code).toBe('checkout_immutable');
    expect(core.tasks.get(checkout.id).kind).toBe('checkout');
  });
});
