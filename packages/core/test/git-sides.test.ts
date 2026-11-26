import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-sides-')));
const repoPath = path.join(tempRoot, 'repo');
const conflictPath = path.join(tempRoot, 'conflict');
const conflictClonePath = path.join(tempRoot, 'conflict-clone');
let core: Core | null = null;
let taskId = '';
let conflictTaskId = '';

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

function file(name: string): string {
  return path.join(repoPath, name);
}

function write(name: string, content: Buffer | string): void {
  const target = file(name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function configure(cwd: string): void {
  git(['config', 'user.name', 'Nest'], cwd);
  git(['config', 'user.email', 'nest@example.com'], cwd);
  // Restored and counted files keep their bytes instead of the platform ending.
  git(['config', 'core.autocrlf', 'false'], cwd);
}

/** A merge conflict, built from two clones so no file is edited by hand. */
function buildConflict(): void {
  mkdirSync(conflictPath, { recursive: true });
  git(['init', '-b', 'main'], conflictPath);
  configure(conflictPath);
  writeFileSync(path.join(conflictPath, 'shared.txt'), 'one\n', 'utf8');
  git(['add', '.'], conflictPath);
  git(['commit', '-m', 'init'], conflictPath);

  execFileSync('git', ['clone', conflictPath, conflictClonePath], {
    cwd: tempRoot,
    stdio: 'pipe',
    windowsHide: true,
  });
  configure(conflictClonePath);
  writeFileSync(path.join(conflictClonePath, 'shared.txt'), 'clone side\n', 'utf8');
  git(['commit', '-am', 'clone edit'], conflictClonePath);

  writeFileSync(path.join(conflictPath, 'shared.txt'), 'main side\n', 'utf8');
  git(['commit', '-am', 'main edit'], conflictPath);
  git(['remote', 'add', 'clone', conflictClonePath], conflictPath);
  git(['fetch', 'clone'], conflictPath);
  // Merging different content on both sides leaves an unmerged entry.
  expect(gitOrNull(['merge', 'clone/main'], conflictPath)).toBeNull();
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main']);
  configure(repoPath);
  // Copy detection only happens for a modified source unless it is enabled.
  git(['config', 'status.renames', 'copies']);
  writeFileSync(file('a.txt'), 'one\ntwo\n', 'utf8');
  writeFileSync(file('rename-a.txt'), 'rename me\n', 'utf8');
  writeFileSync(file('gone.txt'), 'delete me\n', 'utf8');
  writeFileSync(file('copy-source.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  buildConflict();

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
  const conflictProject = await core.projects.add(conflictPath);
  conflictTaskId = core.tasks.ensureCheckout(conflictProject.project.id).id;
});

beforeEach(() => {
  // Every test starts from the base commit; the merge conflict stays in place.
  git(['reset', '--hard', 'HEAD']);
  git(['clean', '-fd']);
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('status projection of the two sides', () => {
  it('reports a partially staged file once with staged and unstaged both set', async () => {
    write('a.txt', 'one\nTWO\n');
    git(['add', '--', 'a.txt']);
    write('a.txt', 'one\nTWO\nthree\nfour\n');

    const status = await core!.git.status(taskId);
    const entries = status.files.filter((entry) => entry.path === 'a.txt');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'a.txt',
      oldPath: null,
      copied: false,
      indexStatus: 'M',
      worktreeStatus: 'M',
      conflict: false,
      staged: true,
      unstaged: true,
      untracked: false,
      // Against HEAD: one line changed and three lines added on the two sides.
      additions: 3,
      deletions: 1,
    });
    expect(status.files).toHaveLength(1);
  });

  it('reports an unmerged file as a conflict, neither staged nor unstaged', async () => {
    const status = await core!.git.status(conflictTaskId);

    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({
      path: 'shared.txt',
      oldPath: null,
      copied: false,
      indexStatus: 'U',
      worktreeStatus: 'U',
      conflict: true,
      staged: false,
      unstaged: false,
      untracked: false,
    });
  });

  it('keeps the source path of a rename and unstages both halves', async () => {
    git(['mv', 'rename-a.txt', 'rename-b.txt']);

    const renamed = (await core!.git.status(taskId)).files.find(
      (entry) => entry.path === 'rename-b.txt',
    );
    expect(renamed).toMatchObject({
      oldPath: 'rename-a.txt',
      copied: false,
      indexStatus: 'R',
      conflict: false,
      staged: true,
      unstaged: false,
    });

    const unstaged = await core!.git.unstage(taskId, ['rename-b.txt']);
    const byPath = new Map(unstaged.files.map((entry) => [entry.path, entry]));
    expect(unstaged.files.some((entry) => entry.staged)).toBe(false);
    expect(byPath.get('rename-a.txt')).toMatchObject({
      indexStatus: ' ',
      worktreeStatus: 'D',
      staged: false,
      unstaged: true,
    });
    expect(byPath.get('rename-b.txt')).toMatchObject({
      untracked: true,
      oldPath: null,
      staged: false,
      unstaged: true,
    });
    // Unstaging never deletes the file from the workspace.
    expect(existsSync(file('rename-b.txt'))).toBe(true);
  });

  it('keeps the source path of a copy and unstages only the copy', async () => {
    // Copy detection compares the new file with the source's committed content,
    // so the source is edited in one line and the copy keeps the edit.
    write('copy-source.txt', 'alpha\nBETA\ngamma\ndelta\n');
    write('copy.txt', 'alpha\nBETA\ngamma\ndelta\n');
    git(['add', '--', 'copy-source.txt', 'copy.txt']);

    const copied = (await core!.git.status(taskId)).files.find(
      (entry) => entry.path === 'copy.txt',
    );
    expect(copied).toMatchObject({
      oldPath: 'copy-source.txt',
      copied: true,
      indexStatus: 'C',
      conflict: false,
      staged: true,
      unstaged: false,
    });

    const unstaged = await core!.git.unstage(taskId, ['copy.txt']);
    const byPath = new Map(unstaged.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('copy.txt')).toMatchObject({ untracked: true, oldPath: null });
    // A copy's source was never part of the change, so it stays staged.
    expect(byPath.get('copy-source.txt')).toMatchObject({
      indexStatus: 'M',
      staged: true,
      unstaged: false,
    });
    expect(existsSync(file('copy.txt'))).toBe(true);
  });

  it('handles a binary file, a staged delete, an untracked file and non-ascii paths', async () => {
    write('blob.bin', Buffer.from([0, 1, 2, 3, 0]));
    unlinkSync(file('gone.txt'));
    git(['add', '--', 'blob.bin', 'gone.txt']);
    write('dir with space/file name.txt', 'one line\n');
    write('кириллица.txt', 'строка\n');

    const status = await core!.git.status(taskId);
    const byPath = new Map(status.files.map((entry) => [entry.path, entry]));

    expect(byPath.get('blob.bin')).toMatchObject({
      indexStatus: 'A',
      conflict: false,
      staged: true,
      unstaged: false,
      additions: null,
      deletions: null,
    });
    expect(byPath.get('gone.txt')).toMatchObject({
      indexStatus: 'D',
      worktreeStatus: ' ',
      staged: true,
      unstaged: false,
    });
    expect(byPath.get('dir with space/file name.txt')).toMatchObject({
      untracked: true,
      staged: false,
      unstaged: true,
      additions: 1,
      deletions: 0,
    });
    expect(byPath.get('кириллица.txt')).toMatchObject({
      untracked: true,
      staged: false,
      unstaged: true,
      additions: 1,
      deletions: 0,
    });
    expect(status.files).toHaveLength(4);
  });

  it('leaves the index identical when the status is only read', async () => {
    write('a.txt', 'one\nTWO\n');
    git(['add', '--', 'a.txt']);
    write('a.txt', 'one\nTWO\nthree\n');
    write('notes.md', 'a\nb\n');
    git(['add', '--', 'notes.md']);

    const before = git(['ls-files', '-s']);
    expect(before).not.toBe('');

    await core!.git.status(taskId);
    await core!.git.status(taskId);

    expect(git(['ls-files', '-s'])).toBe(before);
  });
});

describe('git error separation', () => {
  it('answers status while a history read fails on its own code', async () => {
    await expect(core!.git.log(taskId, { ref: 'no-such-branch' })).rejects.toMatchObject({
      code: 'ref_missing',
    });

    // The failed history read is not re-thrown from the status path.
    const status = await core!.git.status(taskId);
    expect(status).toMatchObject({ branch: 'main', files: [] });
  });

  it('keeps the workspace code of a status failure instead of a history code', async () => {
    const moved = `${repoPath}-moved`;
    renameSync(repoPath, moved);
    try {
      const failure = await core!.git.status(taskId).then(
        () => null,
        (error: unknown) => error,
      );
      // A missing workspace stays a workspace failure: it is not reported as a
      // git failure or as the missing ref a history read would produce.
      expect(failure).toMatchObject({ code: 'workspace_missing' });
    } finally {
      renameSync(moved, repoPath);
    }
  });
});
