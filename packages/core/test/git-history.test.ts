import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-git-history-'));
const repoPath = path.join(tempRoot, 'repo');
const remotePath = path.join(tempRoot, 'remote.git');
const clonePath = path.join(tempRoot, 'clone');

let core: Core | null = null;
let taskId = '';

function runGit(args: string[], cwd = repoPath): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function configure(cwd: string): void {
  runGit(['config', 'user.name', 'Nest'], cwd);
  runGit(['config', 'user.email', 'nest@example.com'], cwd);
}

function commitAll(message: string): string {
  runGit(['add', '-A']);
  runGit(['commit', '-m', message]);
  return runGit(['rev-parse', 'HEAD']);
}

function write(name: string, content: string): void {
  writeFileSync(path.join(repoPath, name), content, 'utf8');
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  runGit(['init', '-b', 'main'], repoPath);
  configure(repoPath);

  write('a.txt', 'one\n');
  commitAll('first commit');

  write('a.txt', 'one\ntwo\n');
  write('b.txt', 'bee\n');
  commitAll('second commit');

  // A bare remote with main pushed, so upstream tracking and comparison with
  // origin have something real to talk to.
  runGit(['clone', '--bare', repoPath, remotePath], tempRoot);
  runGit(['remote', 'add', 'origin', remotePath], repoPath);
  runGit(['push', '-u', 'origin', 'main'], repoPath);

  runGit(['switch', '-c', 'feature'], repoPath);
  write('feature.txt', 'feature work\n');
  commitAll('feature: add file');
  write('a.txt', 'one\ntwo\nfeature line\n');
  commitAll('feature: touch a.txt');
  runGit(['switch', 'main'], repoPath);

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

describe('git history and branches', () => {
  it('pages the commit log', async () => {
    const page = await core!.git.log(taskId, { limit: 2 });
    expect(page.commits.map((commit) => commit.subject)).toEqual(['second commit', 'first commit']);
    expect(page.hasMore).toBe(false);

    const first = await core!.git.log(taskId, { limit: 1 });
    expect(first.commits).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const second = await core!.git.log(taskId, { limit: 1, skip: 1 });
    expect(second.commits[0]?.subject).toBe('first commit');
  });

  it('logs an arbitrary branch and rejects unknown refs', async () => {
    const log = await core!.git.log(taskId, { ref: 'feature' });
    expect(log.commits.map((commit) => commit.subject)).toEqual([
      'feature: touch a.txt',
      'feature: add file',
      'second commit',
      'first commit',
    ]);

    await expect(core!.git.log(taskId, { ref: 'no-such-branch' })).rejects.toMatchObject({
      code: 'ref_missing',
    });
  });

  it('returns commit metadata plus a patch against the first parent', async () => {
    const log = await core!.git.log(taskId, { ref: 'feature', limit: 1 });
    const head = log.commits[0]!;
    const detail = await core!.git.commitDetail(taskId, head.hash);

    expect(detail.commit.subject).toBe('feature: touch a.txt');
    expect(detail.files.map((file) => file.path)).toContain('a.txt');
    expect(detail.files[0]?.hunks.length).toBeGreaterThan(0);

    const root = (await core!.git.log(taskId, { ref: 'main', limit: 50 })).commits.at(-1)!;
    const rootDetail = await core!.git.commitDetail(taskId, root.hash);
    expect(rootDetail.commit.parents).toEqual([]);
    expect(rootDetail.files.some((file) => file.path === 'a.txt' && file.status === 'added')).toBe(
      true,
    );
  });

  it('lists local and remote branches with tracking data', async () => {
    const branches = await core!.git.branches(taskId);
    expect(branches).toMatchObject({
      current: 'main',
      detached: false,
      unborn: false,
      baseRef: 'origin/main',
    });
    expect(branches.local.map((branch) => branch.name)).toEqual(['main', 'feature']);
    expect(branches.local[0]).toMatchObject({
      current: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      gone: false,
    });
    expect(branches.remote.map((branch) => branch.name)).toEqual(['origin/main']);
    expect(branches.remotes).toEqual([
      { name: 'origin', fetchUrl: remotePath, pushUrl: remotePath },
    ]);
  });

  it('compares a branch with its base', async () => {
    const compare = await core!.git.compare(taskId, 'origin/main', 'feature');
    expect(compare.ahead).toBe(2);
    expect(compare.behind).toBe(0);
    expect(compare.commits.map((commit) => commit.subject)).toEqual([
      'feature: touch a.txt',
      'feature: add file',
    ]);
    expect(compare.commitsTruncated).toBe(false);
    expect(compare.files.map((file) => file.path).sort()).toEqual(['a.txt', 'feature.txt']);
    const added = compare.files.find((file) => file.path === 'feature.txt');
    expect(added).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
  });
});

describe('git remotes', () => {
  it('fetches, reports divergence and fast-forwards with pull', async () => {
    // A second clone pushes a commit the Nest checkout has not seen yet.
    runGit(['clone', remotePath, clonePath], tempRoot);
    configure(clonePath);
    writeFileSync(path.join(clonePath, 'c.txt'), 'remote work\n', 'utf8');
    runGit(['add', '-A'], clonePath);
    runGit(['commit', '-m', 'remote commit'], clonePath);
    runGit(['push'], clonePath);

    const stale = await core!.git.compare(taskId, 'main', 'origin/main');
    expect(stale.ahead).toBe(0);

    await core!.git.fetch(taskId);
    const branches = await core!.git.branches(taskId);
    expect(branches.local.find((branch) => branch.name === 'main')).toMatchObject({ behind: 1 });

    const refreshed = await core!.git.compare(taskId, 'main', 'origin/main');
    expect(refreshed.ahead).toBe(1);
    expect(refreshed.commits[0]?.subject).toBe('remote commit');

    await core!.git.pull(taskId);
    const status = await core!.git.status(taskId);
    expect(status).toMatchObject({ branch: 'main', ahead: 0, behind: 0 });
    expect((await core!.git.log(taskId, { limit: 1 })).commits[0]?.subject).toBe('remote commit');
  });
});

describe('git working branch actions', () => {
  it('switches branches and creates new ones', async () => {
    const switched = await core!.git.checkout(taskId, 'feature');
    expect(switched.branch).toBe('feature');

    const created = await core!.git.checkout(taskId, 'topic', { create: true, from: 'feature' });
    expect(created.branch).toBe('topic');

    await core!.git.checkout(taskId, 'main');
    expect((await core!.git.status(taskId)).branch).toBe('main');

    await expect(core!.git.checkout(taskId, 'missing')).rejects.toMatchObject({
      code: 'branch_missing',
    });
    await expect(core!.git.checkout(taskId, 'main', { create: true })).rejects.toMatchObject({
      code: 'branch_exists',
    });
    await expect(core!.git.checkout(taskId, 'bad..name', { create: true })).rejects.toMatchObject({
      code: 'invalid_ref',
    });
  });

  it('discards tracked and untracked changes by path', async () => {
    write('a.txt', 'one\ntwo\nlocal edit\n');
    write('scratch.txt', 'temporary\n');

    const dirty = await core!.git.status(taskId);
    expect(dirty.files.map((file) => file.path).sort()).toEqual(['a.txt', 'scratch.txt']);

    const cleaned = await core!.git.discard(taskId, ['a.txt', 'scratch.txt']);
    expect(cleaned.files).toEqual([]);

    await expect(core!.git.discard(taskId, ['a.txt'])).rejects.toMatchObject({
      code: 'path_not_changed',
    });
    await expect(core!.git.discard(taskId, ['../outside.txt'])).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('amends the last commit and force-pushes it with a lease', async () => {
    write('b.txt', 'bee\nmore\n');
    await core!.git.stage(taskId, ['b.txt']);
    const created = await core!.git.commit(taskId, 'pushed message');
    await core!.git.push(taskId);

    const amended = await core!.git.commit(taskId, 'amended message', false, true);
    expect(amended.hash).not.toBe(created.hash);
    expect((await core!.git.log(taskId, { limit: 1 })).commits[0]?.subject).toBe('amended message');

    // The rewritten commit is already on the remote, so a plain push is
    // rejected until it is explicitly forced.
    await expect(core!.git.push(taskId)).rejects.toMatchObject({ code: 'git_failed' });
    const forced = await core!.git.push(taskId, true);
    expect(forced.output.length).toBeGreaterThan(0);
    expect((await core!.git.status(taskId)).ahead).toBe(0);
  });
});
