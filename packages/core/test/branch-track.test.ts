import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestEvent } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import { migrate, openDatabase } from '../src/index.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-branch-track-')));
const repoPath = path.join(tempRoot, 'repo');
const dbPath = path.join(tempRoot, 'nest.db');
const worktreesRoot = path.join(tempRoot, 'worktrees');
const events: NestEvent[] = [];
let core: Core | null = null;
let taskId = '';
/** A worktree task carries the original base in `base_ref`, unlike a checkout. */
let worktreeTaskId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# branch\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
  git(['branch', 'feature'], repoPath);
  git(['branch', 'release'], repoPath);
  git(['branch', 'hotfix'], repoPath);

  core = createCore({
    dbPath,
    worktreesRoot,
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
    onEvent: (event) => events.push(event),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
  const worktreeTask = await core.tasks.create({ projectId: project.id, title: 'branch base' });
  worktreeTaskId = worktreeTask.id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

/** The three surfaces the user sees: task metadata, git status, branch list. */
async function assertAgree(id: string, expected: string): Promise<void> {
  const [status, branches] = await Promise.all([
    core!.git.status(id),
    core!.git.branches(id),
  ]);
  expect(status.branch).toBe(expected);
  expect(branches.current).toBe(expected);
  expect(core!.tasks.get(id).branch).toBe(expected);
}

describe('current branch follows git', () => {
  it('persists the branch after an in-app checkout', async () => {
    await core!.git.checkout(worktreeTaskId, 'feature');
    await assertAgree(worktreeTaskId, 'feature');

    // The original base stays separate from the branch the workspace is on.
    expect(core!.tasks.get(worktreeTaskId).baseRef).toBe('main');
    expect(events.some((event) => event.type === 'task:updated')).toBe(true);
  });

  it('picks up a branch switched by an external git command on the next read', async () => {
    git(['switch', 'release'], repoPath);
    // Before the status read the row still mirrors the last known branch, so a
    // refresh is what makes the header and the status bar agree with Git again.
    expect(core!.tasks.get(taskId).branch).toBe('main');

    await assertAgree(taskId, 'release');
  });

  it('keeps the checkout status it returns', async () => {
    const status = await core!.git.checkout(taskId, 'main');
    expect(status.branch).toBe('main');
    expect(core!.tasks.get(taskId).branch).toBe('main');
  });

  it('survives a restart with the same branch everywhere', async () => {
    await core!.git.checkout(worktreeTaskId, 'hotfix');
    await assertAgree(worktreeTaskId, 'hotfix');

    core!.close();
    const reopened = openDatabase(dbPath);
    try {
      migrate(reopened);
      const row = reopened
        .prepare('SELECT branch, base_ref FROM tasks WHERE id = ?')
        .get(worktreeTaskId) as { branch: string; base_ref: string | null } | undefined;
      expect(row?.branch).toBe('hotfix');
      expect(row?.base_ref).toBe('main');
    } finally {
      reopened.close();
    }
    core = createCore({
      dbPath,
      worktreesRoot,
      fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
      onEvent: (event) => events.push(event),
    });
    await assertAgree(worktreeTaskId, 'hotfix');
    // Every switch was persisted, so a restart does not need a git read before
    // the header is right.
    expect(core!.tasks.get(taskId).branch).toBe('main');
  });
});
