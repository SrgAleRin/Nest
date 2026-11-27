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
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-discard-')));
const repoPath = path.join(tempRoot, 'repo');
const unbornPath = path.join(tempRoot, 'unborn');
let core: Core | null = null;
let taskId = '';
let unbornTaskId = '';

const BASE = 'base 1\nbase 2\nbase 3\n';
const PARTIAL_INDEX = `${BASE}${'staged 1\nstaged 2\nstaged 3\nstaged 4\nstaged 5\n'}`;
const PARTIAL_WORKTREE = `${PARTIAL_INDEX}worktree 1\n`;

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

function read(name: string, cwd = repoPath): string {
  return readFileSync(file(name, cwd), 'utf8');
}

function initRepo(cwd: string): void {
  mkdirSync(cwd, { recursive: true });
  git(['init', '-b', 'main'], cwd);
  git(['config', 'user.name', 'Nest'], cwd);
  git(['config', 'user.email', 'nest@example.com'], cwd);
  git(['config', 'core.autocrlf', 'false'], cwd);
  write('partial.txt', BASE, cwd);
  write('a.txt', 'a 1\n', cwd);
  write('b.txt', 'b 1\n', cwd);
  write('clean.txt', 'clean 1\n', cwd);
  git(['add', '.'], cwd);
  git(['commit', '-m', 'seed'], cwd);
}

/**
 * Nest registers projects only when they have a commit, so the repository is
 * registered first and then taken back to an unborn branch.
 */
function shedCommit(cwd: string): void {
  git(['update-ref', '-d', 'refs/heads/main'], cwd);
  git(['rm', '-r', '--cached', '--quiet', '--', '.'], cwd);
  for (const name of ['partial.txt', 'a.txt', 'b.txt', 'clean.txt']) {
    rmSync(file(name, cwd), { force: true });
  }
}

beforeAll(async () => {
  initRepo(repoPath);
  initRepo(unbornPath);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
  const unbornProject = await core.projects.add(unbornPath);
  unbornTaskId = core.tasks.ensureCheckout(unbornProject.project.id).id;

  shedCommit(unbornPath);
  expect(gitOrNull(['rev-parse', '--verify', '-q', 'HEAD'], unbornPath)).toBeNull();
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('discard', () => {
  it('restores only the worktree of a partially staged file and keeps the index', async () => {
    write('partial.txt', PARTIAL_INDEX);
    git(['add', '--', 'partial.txt']);
    write('partial.txt', PARTIAL_WORKTREE);

    const status = await core!.git.discard(taskId, ['partial.txt'], 'unstaged');
    const entry = status.files.find((candidate) => candidate.path === 'partial.txt');

    expect(entry).toMatchObject({
      staged: true,
      unstaged: false,
      stagedAdditions: 5,
      stagedDeletions: 0,
      unstagedAdditions: null,
      additions: 5,
      deletions: 0,
    });
    // The staged content survived in the index and now matches the worktree.
    expect(git(['diff', '--cached', '--numstat'])).toBe('5\t0\tpartial.txt');
    expect(git(['diff', '--numstat'])).toBe('');
    expect(read('partial.txt')).toBe(PARTIAL_INDEX);
  });

  it('drops a tracked file back to HEAD for the staged and both sides', async () => {
    const status = await core!.git.discard(taskId, ['partial.txt'], 'both');
    const entry = status.files.find((candidate) => candidate.path === 'partial.txt');

    expect(entry).toBeUndefined();
    expect(git(['status', '--porcelain', '--', 'partial.txt'])).toBe('');
    expect(read('partial.txt')).toBe(BASE);
  });

  it('deletes an untracked file on an unborn branch', async () => {
    write('scratch.md', 'scratch\n', unbornPath);
    const status = await core!.git.status(unbornTaskId);
    expect(status.unborn).toBe(true);
    expect(status.files.map((entry) => entry.path)).toContain('scratch.md');

    const discarded = await core!.git.discard(unbornTaskId, ['scratch.md']);

    expect(discarded.files).toHaveLength(0);
    expect(existsSync(file('scratch.md', unbornPath))).toBe(false);
  });

  it('deletes an untracked file for the unstaged side as well', async () => {
    write('other.md', 'other\n', unbornPath);

    await core!.git.discard(unbornTaskId, ['other.md'], 'unstaged');

    expect(existsSync(file('other.md', unbornPath))).toBe(false);
  });

  it('refuses to restore a tracked file on an unborn branch and names the reason', async () => {
    write('in-index.txt', 'one\ntwo\n', unbornPath);
    git(['add', '--', 'in-index.txt'], unbornPath);

    const failure = await core!.git.discard(unbornTaskId, ['in-index.txt'], 'both').then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: 'no_head' });
    // Nothing was restored or deleted: the file is still staged on disk.
    expect(git(['status', '--porcelain', '--', 'in-index.txt'], unbornPath)).toBe(
      'A  in-index.txt',
    );
    expect(read('in-index.txt', unbornPath)).toBe('one\ntwo\n');
  });

  it('restores the worktree of a staged file on an unborn branch from the index', async () => {
    write('in-index.txt', 'one\ntwo\nthree\n', unbornPath);

    const status = await core!.git.discard(unbornTaskId, ['in-index.txt'], 'unstaged');
    const entry = status.files.find((candidate) => candidate.path === 'in-index.txt');

    expect(entry).toMatchObject({ staged: true, unstaged: false, stagedAdditions: 2 });
    expect(read('in-index.txt', unbornPath)).toBe('one\ntwo\n');
    expect(git(['status', '--porcelain', '--', 'in-index.txt'], unbornPath)).toBe(
      'A  in-index.txt',
    );
  });

  it('serializes concurrent mutations of one workspace', async () => {
    write('a.txt', 'a 1\na 2\n');
    write('b.txt', 'b 1\nb 2\n');

    const staged = await Promise.all([
      core!.git.stage(taskId, ['a.txt']),
      core!.git.stage(taskId, ['b.txt']),
    ]);
    expect(staged).toHaveLength(2);
    expect(git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)).toEqual([
      'a.txt',
      'b.txt',
    ]);

    const unstaged = await Promise.all([
      core!.git.unstage(taskId, ['a.txt']),
      core!.git.unstage(taskId, ['b.txt']),
    ]);
    expect(unstaged).toHaveLength(2);
    expect(git(['diff', '--cached', '--name-only', '-z'])).toBe('');
    expect(git(['diff', '--name-only', '-z']).split('\0').filter(Boolean)).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('keeps the queue usable after a failed mutation', async () => {
    await expect(core!.git.discard(taskId, ['clean.txt'], 'both')).rejects.toMatchObject({
      code: 'path_not_changed',
    });

    const status = await core!.git.stage(taskId, ['a.txt']);

    expect(status.files.find((entry) => entry.path === 'a.txt')).toMatchObject({ staged: true });
  });
});
