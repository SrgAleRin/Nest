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
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-unborn-')));
const repoPath = path.join(tempRoot, 'repo');
const amendPath = path.join(tempRoot, 'amend');
let core: Core | null = null;
let taskId = '';
let amendTaskId = '';

function git(args: string[], cwd = repoPath): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
    .replace(/\r\n/g, '\n')
    .trim();
}

function gitOrNull(args: string[], cwd = repoPath): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function file(name: string, cwd = repoPath): string {
  return path.join(cwd, name);
}

function write(name: string, content: string, cwd = repoPath): void {
  writeFileSync(file(name, cwd), content, 'utf8');
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(['init', '-b', 'main'], cwd);
  git(['config', 'user.name', 'Nest'], cwd);
  git(['config', 'user.email', 'nest@example.com'], cwd);
  git(['config', 'core.autocrlf', 'false'], cwd);
  writeFileSync(file('seed.txt', cwd), 'seed\n', 'utf8');
  git(['add', '.'], cwd);
  git(['commit', '-m', 'seed'], cwd);
}

/**
 * Nest registers projects only when they have a commit, so the repositories are
 * registered first and then taken back to an unborn branch: the commit is
 * dropped, the index cleared and the worktree file removed.
 */
function shedCommit(cwd: string): void {
  git(['update-ref', '-d', 'refs/heads/main'], cwd);
  git(['rm', '-r', '--cached', '--quiet', '--', '.'], cwd);
  rmSync(file('seed.txt', cwd), { force: true });
}

beforeAll(async () => {
  initRepo(repoPath);
  initRepo(amendPath);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
  const amendProject = await core.projects.add(amendPath);
  amendTaskId = core.tasks.ensureCheckout(amendProject.project.id).id;

  shedCommit(repoPath);
  shedCommit(amendPath);
  expect(gitOrNull(['rev-parse', '--verify', '-q', 'HEAD'])).toBeNull();
  expect(git(['status', '--porcelain'])).toBe('');
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('a branch without commits', () => {
  it('unstages the first staged file and leaves it untracked on disk', async () => {
    write('first.txt', 'one\n');
    git(['add', '--', 'first.txt']);

    const staged = await core!.git.status(taskId);
    expect(staged.branch).toBe('main');
    expect(staged.files[0]).toMatchObject({ path: 'first.txt', staged: true, untracked: false });

    const unstaged = await core!.git.unstage(taskId, ['first.txt']);
    expect(unstaged.files).toHaveLength(1);
    expect(unstaged.files[0]).toMatchObject({
      path: 'first.txt',
      indexStatus: '?',
      worktreeStatus: '?',
      staged: false,
      unstaged: true,
      untracked: true,
    });
    expect(git(['status', '--porcelain'])).toBe('?? first.txt');
    // The file is still in the workspace.
    expect(existsSync(file('first.txt'))).toBe(true);
    expect(readFileSync(file('first.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses to amend when there is no commit yet', async () => {
    write('pending.txt', 'pending\n', amendPath);

    const failure = await core!.git.commit(amendTaskId, 'amend nothing', false, true).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'amend_without_head' });
    expect((failure as Error).message).toContain('no commit to amend');
    // Nothing was created: the branch is still unborn.
    expect(gitOrNull(['rev-parse', '--verify', '-q', 'HEAD'], amendPath)).toBeNull();
  });

  it('creates the first commit on an unborn branch', async () => {
    git(['add', '--', 'first.txt']);

    const created = await core!.git.commit(taskId, 'first commit');

    expect(created.summary).toBe('first commit');
    expect(created.hash).toBe(git(['rev-parse', '--short', 'HEAD']));
    expect(git(['log', '--format=%s'])).toBe('first commit');
    expect(git(['status', '--porcelain'])).toBe('');
  });

  it('commits only the index and keeps unstaged and untracked work', async () => {
    write('staged.txt', 'staged\n');
    git(['add', '--', 'staged.txt']);
    write('first.txt', 'one\nworktree edit\n');
    write('notes.md', '# notes\n');

    const created = await core!.git.commit(taskId, 'staged only');

    // The commit holds the staged path and nothing else.
    expect(git(['show', '--name-status', '--format=', created.hash])).toBe('A\tstaged.txt');
    const status = await core!.git.status(taskId);
    const byPath = new Map(status.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('first.txt')).toMatchObject({ staged: false, unstaged: true });
    expect(byPath.get('notes.md')).toMatchObject({ untracked: true, unstaged: true });
    expect(readFileSync(file('first.txt'), 'utf8')).toBe('one\nworktree edit\n');
    expect(existsSync(file('notes.md'))).toBe(true);
  });

  it('reports nothing_staged when only unstaged and untracked work exists', async () => {
    write('first.txt', 'one\nanother edit\n');
    write('scratch.md', 'scratch\n');
    const head = git(['rev-parse', 'HEAD']);

    await expect(core!.git.commit(taskId, 'nothing to commit')).rejects.toMatchObject({
      code: 'nothing_staged',
    });
    // No empty commit was created: newest first, the refused commit is absent.
    expect(git(['rev-parse', 'HEAD'])).toBe(head);
    expect(git(['log', '--format=%s'])).toBe('staged only\nfirst commit');
  });
});
