import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitCommit } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-wide-')));
const repoPath = path.join(tempRoot, 'repo');
const remotePath = path.join(tempRoot, 'remote.git');
const clonePath = path.join(tempRoot, 'clone');
const heldWorktreePath = path.join(tempRoot, 'held-wt');

let core: Core | null = null;
let taskId = '';
/** Commit only `origin/release` would reach if it were a local branch. */
let remoteOnlyHash = '';

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

function configure(cwd: string): void {
  git(['config', 'user.name', 'Nest'], cwd);
  git(['config', 'user.email', 'nest@example.com'], cwd);
  git(['config', 'core.autocrlf', 'false'], cwd);
}

function write(name: string, content: string | Buffer): void {
  const target = path.join(repoPath, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commitAll(message: string, ...extra: string[]): string {
  git(['add', '-A']);
  git(['commit', ...extra, '-m', message]);
  return git(['rev-parse', 'HEAD']);
}

/** Paths come back from git with forward slashes; compare them case-insensitively. */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function subjects(commits: GitCommit[]): string[] {
  return commits.map((commit) => commit.subject).sort();
}

beforeAll(async () => {
  mkdirSync(path.join(repoPath, 'src'), { recursive: true });
  git(['init', '-b', 'main']);
  configure(repoPath);

  // A seed with a subdirectory, a binary blob and a file big enough to truncate.
  write('seed.txt', 'seed\n');
  write('src/app.ts', 'export const answer = 42;\n');
  write('blob.bin', Buffer.from([0, 1, 2, 3, 0]));
  write('large.txt', 'x'.repeat(600 * 1024));
  commitAll('seed commit');

  // A side branch merged back into main, so the history has a real merge commit.
  git(['switch', '-c', 'side']);
  write('side.txt', 'side work\n');
  commitAll('side work');
  git(['switch', 'main']);
  write('main.txt', 'main work\n');
  commitAll('main: add file');
  git(['merge', '--no-ff', 'side', '-m', 'merge side']);

  // `other` forks after the merge, so its merge base with main is stable.
  git(['switch', '-c', 'other']);
  write('other-only.txt', 'other only\n');
  commitAll('other: add file');
  git(['switch', 'main']);

  // A commit by another author, to search the author fields.
  write('docs.md', '# docs\n');
  git(['add', '-A']);
  git(['commit', '--author', 'Ada Lovelace <ada@example.com>', '-m', 'docs: update']);

  // A commit reachable only through a tag: the temporary branch is deleted.
  git(['switch', '-c', 'temp']);
  write('tagged.txt', 'tagged\n');
  git(['add', '-A']);
  git(['commit', '-m', 'tagged work', '-m', 'Body mentions zebra']);
  git(['tag', 'v1.0']);
  git(['switch', 'main']);
  git(['branch', '-D', 'temp']);

  // A remote whose main is ahead of the local one, so `origin/main` has a
  // commit no local branch reaches.
  git(['clone', '--bare', repoPath, remotePath], tempRoot);
  git(['remote', 'add', 'origin', remotePath]);
  git(['push', '-u', 'origin', 'main']);
  git(['clone', remotePath, clonePath], tempRoot);
  configure(clonePath);
  writeFileSync(path.join(clonePath, 'remote-only.txt'), 'remote work\n', 'utf8');
  git(['add', '-A'], clonePath);
  git(['commit', '-m', 'remote only'], clonePath);
  git(['push'], clonePath);
  git(['fetch', 'origin']);
  remoteOnlyHash = git(['rev-parse', 'origin/main']);

  // `held` is checked out in a second worktree; `other` stays free.
  git(['branch', 'held', 'main']);
  git(['worktree', 'add', heldWorktreePath, 'held']);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('git.log scopes', () => {
  it('walks every branch, remote-tracking ref and tag for scope all', async () => {
    const log = await core!.git.log(taskId, { scope: 'all', limit: 300 });

    expect(subjects(log.commits)).toEqual(
      expect.arrayContaining([
        'seed commit',
        'side work',
        'main: add file',
        'merge side',
        'other: add file',
        'docs: update',
        'tagged work',
        'remote only',
      ]),
    );
    expect(log.commits.map((commit) => commit.hash)).toContain(remoteOnlyHash);
  });

  it('leaves the remote-only commit out of scope branches', async () => {
    const log = await core!.git.log(taskId, { scope: 'branches', limit: 300 });

    // The tag and the free local branch are both walked, the remote ref is not.
    expect(subjects(log.commits)).toEqual(
      expect.arrayContaining(['tagged work', 'other: add file', 'merge side']),
    );
    expect(subjects(log.commits)).not.toContain('remote only');
  });

  it('keeps the single HEAD walk for scope head and for the default', async () => {
    const expected = ['docs: update', 'main: add file', 'merge side', 'seed commit', 'side work'];
    const head = await core!.git.log(taskId, { scope: 'head', limit: 300 });
    const fallback = await core!.git.log(taskId, { limit: 300 });

    expect(subjects(head.commits)).toEqual(expected);
    expect(subjects(fallback.commits)).toEqual(expected);
  });

  it('walks an explicit ref alone even when a scope is set', async () => {
    // `other` forked at the merge commit: no remote-only, tagged or docs commit.
    const log = await core!.git.log(taskId, { ref: 'other', scope: 'all', limit: 300 });

    expect(subjects(log.commits)).toEqual([
      'main: add file',
      'merge side',
      'other: add file',
      'seed commit',
      'side work',
    ]);
  });

  it('pages the scope walk', async () => {
    const page = await core!.git.log(taskId, { scope: 'all', limit: 2, skip: 1 });

    expect(page.commits).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});

describe('git.log search', () => {
  it('matches the subject case-insensitively', async () => {
    const log = await core!.git.log(taskId, { scope: 'branches', search: 'TAGGED WORK' });

    expect(subjects(log.commits)).toEqual(['tagged work']);
    expect(log.hasMore).toBe(false);
  });

  it('matches the commit body', async () => {
    const log = await core!.git.log(taskId, { scope: 'all', search: 'zebra' });

    expect(subjects(log.commits)).toEqual(['tagged work']);
  });

  it('matches the author name and the author email', async () => {
    const byName = await core!.git.log(taskId, { scope: 'all', search: 'lovelace' });
    const byEmail = await core!.git.log(taskId, { scope: 'all', search: 'ada@example.com' });

    expect(subjects(byName.commits)).toEqual(['docs: update']);
    expect(subjects(byEmail.commits)).toEqual(['docs: update']);
  });

  it('matches a hash prefix', async () => {
    const prefix = remoteOnlyHash.slice(0, 8);
    const log = await core!.git.log(taskId, { scope: 'all', search: prefix });

    expect(log.commits.map((commit) => commit.hash)).toEqual([remoteOnlyHash]);
  });

  it('applies skip and limit to the matches and reports hasMore honestly', async () => {
    // `main: add file` and `other: add file` both match; nothing else does.
    const first = await core!.git.log(taskId, { scope: 'all', search: 'add file', limit: 1 });
    const second = await core!.git.log(taskId, {
      scope: 'all',
      search: 'add file',
      limit: 1,
      skip: 1,
    });
    const roomy = await core!.git.log(taskId, { scope: 'all', search: 'add file', limit: 5 });
    const missing = await core!.git.log(taskId, { scope: 'all', search: 'no such message' });

    expect(subjects(first.commits)).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(subjects(second.commits)).toHaveLength(1);
    expect(second.commits[0]?.hash).not.toBe(first.commits[0]?.hash);
    expect(second.hasMore).toBe(false);
    expect(subjects(roomy.commits)).toEqual(['main: add file', 'other: add file']);
    expect(roomy.hasMore).toBe(false);
    expect(missing.commits).toEqual([]);
    expect(missing.hasMore).toBe(false);
  });
});

describe('git.branches worktree ownership', () => {
  it('reports the worktree that holds a branch and null for a free one', async () => {
    const branches = await core!.git.branches(taskId);
    const held = branches.local.find((branch) => branch.name === 'held');
    const free = branches.local.find((branch) => branch.name === 'other');
    const current = branches.local.find((branch) => branch.name === 'main');
    const remote = branches.remote.find((branch) => branch.name === 'origin/main');

    expect(normalizePath(held?.worktreePath ?? '')).toBe(normalizePath(heldWorktreePath));
    expect(free?.worktreePath).toBeNull();
    expect(normalizePath(current?.worktreePath ?? '')).toBe(normalizePath(repoPath));
    expect(remote?.worktreePath).toBeNull();
  });
});

describe('git.compareDiff', () => {
  it('returns the patch of the file that only the other branch changed', async () => {
    const compare = await core!.git.compareDiff(taskId, { base: 'main', head: 'other' });

    expect(compare).toMatchObject({ base: 'main', head: 'other' });
    expect(compare.mergeBase).toBe(git(['merge-base', 'main', 'other']));
    expect(compare.files.map((file) => file.path)).toEqual(['other-only.txt']);
    expect(compare.files[0]).toMatchObject({ status: 'added' });
    expect(compare.files[0]?.hunks.length).toBeGreaterThan(0);
  });

  it('narrows the patch to one path and defaults the head to HEAD', async () => {
    const narrowed = await core!.git.compareDiff(taskId, {
      base: 'main',
      head: 'other',
      path: 'other-only.txt',
    });
    const unrelated = await core!.git.compareDiff(taskId, {
      base: 'main',
      head: 'other',
      path: 'main.txt',
    });
    const withHead = await core!.git.compareDiff(taskId, { base: 'main' });

    expect(narrowed.files.map((file) => file.path)).toEqual(['other-only.txt']);
    expect(unrelated.files).toEqual([]);
    expect(withHead.head).toBe('HEAD');
    expect(withHead.files).toEqual([]);
  });

  it('reads revisions without touching the worktree', async () => {
    await core!.git.compareDiff(taskId, { base: 'main', head: 'other' });

    expect(git(['status', '--porcelain'])).toBe('');
    expect(existsSync(path.join(repoPath, 'other-only.txt'))).toBe(false);
  });

  it('rejects a traversal path and an unknown revision', async () => {
    await expect(
      core!.git.compareDiff(taskId, { base: 'main', head: 'other', path: '../x' }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(
      core!.git.compareDiff(taskId, { base: 'main', head: 'other', path: '/etc/passwd' }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(
      core!.git.compareDiff(taskId, { base: 'main', head: 'no-such-branch' }),
    ).rejects.toMatchObject({ code: 'ref_missing' });
  });
});

describe('files of a revision', () => {
  it('lists the tree of another branch without a checkout', async () => {
    const other = await core!.files.list(taskId, 'other');
    const worktree = await core!.files.list(taskId);
    const remote = await core!.files.list(taskId, 'origin/main');

    expect(other.files.map((file) => file.path)).toContain('other-only.txt');
    expect(other.files.map((file) => file.path)).not.toContain('docs.md');
    expect(other.files.map((file) => file.path)).toEqual(
      [...other.files.map((file) => file.path)].sort(),
    );
    expect(worktree.files.map((file) => file.path)).not.toContain('other-only.txt');
    // The remote-tracking ref is a revision like any other.
    expect(remote.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['docs.md', 'remote-only.txt']),
    );
  });

  it('reads a blob of another branch while the worktree stays clean', async () => {
    const content = await core!.files.read(taskId, 'other-only.txt', 'other');

    expect(content).toMatchObject({
      path: 'other-only.txt',
      size: Buffer.byteLength('other only\n'),
      text: 'other only\n',
      binary: false,
      truncated: false,
    });
    expect(git(['status', '--porcelain'])).toBe('');
    expect(existsSync(path.join(repoPath, 'other-only.txt'))).toBe(false);
  });

  it('detects a binary blob and truncates a large one', async () => {
    const binary = await core!.files.read(taskId, 'blob.bin', 'main');
    const large = await core!.files.read(taskId, 'large.txt', 'main');

    expect(binary).toMatchObject({ binary: true, text: '', truncated: false });
    expect(large.binary).toBe(false);
    expect(large.size).toBe(600 * 1024);
    expect(large.truncated).toBe(true);
    expect(Buffer.byteLength(large.text, 'utf8')).toBe(512 * 1024);
  });

  it('rejects traversal, unknown paths and unknown revisions', async () => {
    await expect(core!.files.read(taskId, '../seed.txt', 'other')).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(core!.files.read(taskId, '/seed.txt', 'other')).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(core!.files.read(taskId, 'nope.txt', 'other')).rejects.toMatchObject({
      code: 'file_missing',
    });
    await expect(core!.files.read(taskId, 'src', 'other')).rejects.toMatchObject({
      code: 'not_a_file',
    });
    await expect(core!.files.list(taskId, 'no-such-branch')).rejects.toMatchObject({
      code: 'ref_missing',
    });
    await expect(core!.files.read(taskId, 'seed.txt', 'no-such-branch')).rejects.toMatchObject({
      code: 'ref_missing',
    });
  });
});
