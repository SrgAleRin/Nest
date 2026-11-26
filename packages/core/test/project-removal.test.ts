import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestEvent, Project } from '@nest/shared';
import { createCore, NestError, type Core } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-project-removal-')));
const events: NestEvent[] = [];
let core: Core | null = null;
let repoPath = '';
let project: Project | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
    .replace(/\r\n/g, '\n')
    .trim();
}

function gitPath(value: string): string {
  return value.replace(/\\/g, '/');
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

function countRows(sql: string, ...params: string[]): number {
  if (!core) throw new Error('core was not created');
  const row = core.db.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

beforeAll(async () => {
  repoPath = path.join(tempRoot, 'repo');
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
    onEvent: (event) => events.push(event),
  });
  ({ project } = await core.projects.add(repoPath));
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('project removal', () => {
  it('stops every live PTY, drops the rows and leaves the checkouts on disk', async () => {
    if (!core || !project) throw new Error('core was not created');
    const projectId = project.id;
    const checkout = core.tasks.ensureCheckout(projectId);
    const task = await core.tasks.create({
      projectId,
      title: 'Api work',
      setupScript: null,
    });
    const comment = await core.comments.create({
      taskId: task.id,
      filePath: 'README.md',
      line: 1,
      side: 'new',
      body: 'deleted with the project',
    });

    const checkoutSession = await core.sessions.start({
      taskId: checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    const taskSession = await core.sessions.start({
      taskId: task.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(
      () =>
        core!.sessions.scrollback(checkoutSession.id).includes('FakeHarness') &&
        core!.sessions.scrollback(taskSession.id).includes('FakeHarness'),
    );
    expect(core.sessions.liveSessions([checkout.id, task.id]).sort()).toEqual(
      [checkoutSession.id, taskSession.id].sort(),
    );

    const watched = new Set([checkoutSession.id, taskSession.id]);
    const beforeDelete = events.length;
    await core.projects.remove(projectId);

    // Confirmed process exit came first: no runtime is left after the call.
    expect(core.sessions.liveSessions([checkout.id, task.id])).toEqual([]);
    const exitedBeforeDelete = events
      .slice(beforeDelete)
      .flatMap((event) =>
        event.type === 'session:status' &&
        watched.has(event.session.id) &&
        event.session.status === 'exited'
          ? [event.session.id]
          : [],
      );
    expect(new Set(exitedBeforeDelete)).toEqual(watched);

    // Rows are gone: project, tasks, sessions, comments.
    expect(core.projects.list().some((candidate) => candidate.id === projectId)).toBe(false);
    expect(core.tasks.list(projectId)).toEqual([]);
    expect(core.sessions.list().filter((session) => watched.has(session.id))).toEqual([]);
    expect(countRows('SELECT COUNT(*) AS count FROM review_comments WHERE id = ?', comment.id)).toBe(
      0,
    );

    // Checkouts stay on disk and git still registers the worktree: Nest never
    // runs `git worktree remove` for a project deletion.
    expect(existsSync(repoPath)).toBe(true);
    expect(existsSync(task.workspacePath)).toBe(true);
    expect(git(['worktree', 'list', '--porcelain'], repoPath)).toContain(
      gitPath(task.workspacePath),
    );

    // No late session events for the removed project reach the renderer.
    const quietFrom = events.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const late = events.slice(quietFrom).filter((event) => {
      if (event.type === 'session:data') return watched.has(event.sessionId);
      if (event.type === 'session:status') return watched.has(event.session.id);
      return false;
    });
    expect(late).toEqual([]);
  });

  it('keeps the project and its rows when a session does not confirm exit', async () => {
    if (!core) throw new Error('core was not created');
    const other = await core.projects.add(
      (() => {
        const repo = path.join(tempRoot, 'other');
        mkdirSync(repo, { recursive: true });
        git(['init', '-b', 'main'], repo);
        writeFileSync(path.join(repo, 'README.md'), '# other\n', 'utf8');
        git(['add', '.'], repo);
        git(
          ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
          repo,
        );
        return repo;
      })(),
    );
    const task = await core.tasks.create({
      projectId: other.project.id,
      title: 'Stuck session',
      setupScript: null,
    });

    // A fake PTY that ignores SIGTERM: it never reports exit, so the removal
    // must not report success. Injecting it avoids a real unkillable process.
    const runtimes = (
      core.sessions as unknown as { runtimes: Map<string, Record<string, unknown>> }
    ).runtimes;
    runtimes.set('stuck-session', {
      taskId: task.id,
      stopping: false,
      discovery: null,
      idleTimer: null,
      pty: { kill: () => {} },
    });

    const failure = await core.projects.remove(other.project.id).then(
      () => null,
      (error: unknown) => error,
    );
    runtimes.delete('stuck-session');

    expect(failure).toBeInstanceOf(NestError);
    const error = failure as NestError;
    expect(error.code).toBe('sessions_not_stopped');
    expect(error.details ?? '').toContain('stuck-session');
    expect(error.message).toMatch(/kept/);

    // Everything is still registered: project, task, worktree.
    expect(core.projects.get(other.project.id).id).toBe(other.project.id);
    expect(core.tasks.get(task.id).id).toBe(task.id);
    expect(existsSync(task.workspacePath)).toBe(true);
  });
});
