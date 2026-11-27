import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitBranches, GitFile, GitLog, GitStatus } from '@nest/shared';
import {
  EMPTY_GIT_MEMORY,
  createGitSnapshotStore,
  type GitSnapshotInvoke,
  type GitSnapshotStore,
} from './gitSnapshot';

function file(path: string, overrides: Partial<GitFile> = {}): GitFile {
  return {
    path,
    oldPath: null,
    copied: false,
    indexStatus: ' ',
    worktreeStatus: 'M',
    conflict: false,
    staged: false,
    unstaged: true,
    untracked: false,
    additions: 1,
    deletions: 1,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 1,
    unstagedDeletions: 1,
    ...overrides,
  };
}

function status(branch: string, paths: string[] = []): GitStatus {
  return {
    branch,
    upstream: null,
    ahead: 0,
    behind: 0,
    unborn: false,
    files: paths.map((path) => file(path)),
  };
}

function branches(current: string): GitBranches {
  return {
    current,
    detached: false,
    unborn: false,
    baseRef: 'main',
    remotes: [],
    local: [],
    remote: [],
  };
}

function log(): GitLog {
  return { commits: [], hasMore: false };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** A `NestClient['invoke']` stand-in with a per-test handler and call log. */
function createInvoke(handler: (method: string, params: Record<string, unknown>) => unknown): {
  invoke: GitSnapshotInvoke;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke = ((method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return Promise.resolve(handler(method, params));
  }) as unknown as GitSnapshotInvoke;
  return { invoke, calls };
}

function statusCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'git.status');
}

function branchCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.method === 'git.branches');
}

describe('git snapshot store', () => {
  let store: GitSnapshotStore | null = null;

  afterEach(() => {
    store?.dispose();
    store = null;
    vi.useRealTimers();
  });

  function makeStore(invoke: GitSnapshotInvoke): GitSnapshotStore {
    const created = createGitSnapshotStore({ invoke });
    store = created;
    return created;
  }

  it('drops a late status answer for an older revision', async () => {
    const first = deferred<GitStatus>();
    const second = deferred<GitStatus>();
    const queue = [first.promise, second.promise];
    const { invoke } = createInvoke(() => queue.shift());
    const snapshots = makeStore(invoke);

    const slow = snapshots.requestStatus('t1');
    const fresh = snapshots.requestStatus('t1');
    second.resolve(status('fresh', ['b.ts']));
    await fresh;
    expect(snapshots.getTask('t1')?.status.data?.branch).toBe('fresh');

    first.resolve(status('stale', ['a.ts']));
    await slow;
    expect(snapshots.getTask('t1')?.status.data?.branch).toBe('fresh');
    expect(snapshots.getTask('t1')?.status.data?.files.map((entry) => entry.path)).toEqual([
      'b.ts',
    ]);
  });

  it('never writes an answer for another task into the current one', async () => {
    const forA = deferred<GitStatus>();
    const forB = deferred<GitStatus>();
    const { invoke } = createInvoke((_method, params) =>
      params.taskId === 'a' ? forA.promise : forB.promise,
    );
    const snapshots = makeStore(invoke);

    const requestA = snapshots.requestStatus('a');
    const requestB = snapshots.requestStatus('b');
    forB.resolve(status('branch-b', ['b.ts']));
    await requestB;
    forA.resolve(status('branch-a', ['a.ts']));
    await requestA;

    expect(snapshots.getTask('a')?.status.data?.branch).toBe('branch-a');
    expect(snapshots.getTask('b')?.status.data?.branch).toBe('branch-b');
    expect(snapshots.getTask('b')?.status.data?.files.map((entry) => entry.path)).toEqual(['b.ts']);
  });

  it('keeps the last snapshot as stale when invalidated', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main', ['a.ts']));
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.getTask('t1')?.stale).toBe(false);
    expect(statusCalls(calls)).toHaveLength(1);

    snapshots.invalidate('t1');
    const stale = snapshots.getTask('t1');
    expect(stale?.stale).toBe(true);
    expect(stale?.status.data?.branch).toBe('main');
    expect(statusCalls(calls)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('t1')?.stale).toBe(false);
  });

  it('coalesces a burst of invalidations into one reload', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main'));
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);

    snapshots.invalidate('t1');
    snapshots.invalidate('t1');
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);
  });

  it('reloads an already loaded branch slice when the task is invalidated', async () => {
    vi.useFakeTimers();
    let current = 'main';
    const { invoke, calls } = createInvoke((method) =>
      method === 'git.branches' ? branches(current) : status(current),
    );
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    await snapshots.requestBranches('t1');
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('main');
    expect(branchCalls(calls)).toHaveLength(1);

    // `git checkout -b` outside Nest moves both slices: the status names the new
    // branch, and so must the list of branches the head reads.
    current = 'external-branch';
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshots.getTask('t1')?.status.data?.branch).toBe('external-branch');
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('external-branch');
    expect(statusCalls(calls)).toHaveLength(2);
    expect(branchCalls(calls)).toHaveLength(2);
  });

  it('reloads the branch slice once per coalesced burst', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke((method) =>
      method === 'git.branches' ? branches('main') : status('main'),
    );
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    await snapshots.requestBranches('t1');
    expect(statusCalls(calls)).toHaveLength(1);
    expect(branchCalls(calls)).toHaveLength(1);

    snapshots.invalidate('t1');
    snapshots.invalidate('t1');
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(statusCalls(calls)).toHaveLength(2);
    expect(branchCalls(calls)).toHaveLength(2);
  });

  it('still reloads branches when a manual status read took the invalidation', async () => {
    vi.useFakeTimers();
    let current = 'main';
    const { invoke, calls } = createInvoke((method) =>
      method === 'git.branches' ? branches(current) : status(current),
    );
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    await snapshots.requestBranches('t1');
    expect(statusCalls(calls)).toHaveLength(1);
    expect(branchCalls(calls)).toHaveLength(1);

    current = 'external-branch';
    snapshots.invalidate('t1');
    // The panel's own refresh asks for the status before the coalesced reload
    // runs; that direct read must not swallow the branch reload.
    await snapshots.requestStatus('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(statusCalls(calls)).toHaveLength(2);
    expect(branchCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('external-branch');
  });

  it('does not start loading branches an invalidation finds unloaded', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke((method) =>
      method === 'git.branches' ? branches('main') : status('main'),
    );
    const snapshots = makeStore(invoke);

    // Only the status was ever read: nothing asked for the branch list, so a
    // watcher event must not start loading it on its own.
    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(statusCalls(calls)).toHaveLength(2);
    expect(branchCalls(calls)).toHaveLength(0);
    expect(snapshots.getTask('t1')?.branches.data).toBeNull();
  });

  it('defers the branch reload of a hidden task and catches it up when read again', async () => {
    vi.useFakeTimers();
    let current = 'main';
    const { invoke, calls } = createInvoke((method) =>
      method === 'git.branches' ? branches(current) : status(current),
    );
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    await snapshots.requestBranches('t1');
    expect(statusCalls(calls)).toHaveLength(1);
    expect(branchCalls(calls)).toHaveLength(1);

    // The panel is off screen: no slice is refetched, the branches included.
    snapshots.release('t1');
    current = 'external-branch';
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);
    expect(branchCalls(calls)).toHaveLength(1);
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('main');

    // Reading the task again catches up on both slices.
    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);
    expect(branchCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('external-branch');
  });

  it('keeps status, branches and log failures independent', async () => {
    const { invoke } = createInvoke((method) => {
      if (method === 'git.status') return status('main', ['a.ts']);
      if (method === 'git.branches') return branches('main');
      return log();
    });
    const snapshots = makeStore(invoke);

    await snapshots.requestStatus('t1');
    await snapshots.requestBranches('t1');
    await snapshots.requestLog('t1');
    expect(snapshots.getTask('t1')?.status.data?.branch).toBe('main');

    const failing = createInvoke((method) => {
      if (method === 'git.status') throw new Error('status down');
      throw new Error(`${method} down`);
    });
    const failingStore = createGitSnapshotStore({ invoke: failing.invoke });
    await failingStore.requestStatus('t1');
    await failingStore.requestBranches('t1');
    await failingStore.requestLog('t1');
    const snapshot = failingStore.getTask('t1');
    expect(snapshot?.status.error).toBe('status down');
    expect(snapshot?.branches.error).toBe('git.branches down');
    expect(snapshot?.log.error).toBe('git.log down');

    // A branches failure never turns the status into an error, and a status
    // failure never blanks the branches that did load.
    const partial = createInvoke((method) => {
      if (method === 'git.branches') return branches('main');
      if (method === 'git.status') throw new Error('status down');
      return log();
    });
    const partialStore = createGitSnapshotStore({ invoke: partial.invoke });
    await partialStore.requestBranches('t1');
    await partialStore.requestStatus('t1');
    expect(partialStore.getTask('t1')?.branches.data?.current).toBe('main');
    expect(partialStore.getTask('t1')?.branches.error).toBeNull();
    expect(partialStore.getTask('t1')?.status.error).toBe('status down');
    expect(partialStore.getTask('t1')?.status.data).toBeNull();
    partialStore.dispose();
    failingStore.dispose();
  });

  it('applies a mutation under the revision it started with', async () => {
    vi.useFakeTimers();
    const staged = deferred<GitStatus>();
    let statusAnswer: GitStatus = status('main', ['a.ts']);
    const { invoke, calls } = createInvoke((method) => {
      if (method === 'git.stage') return staged.promise;
      return statusAnswer;
    });
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.getTask('t1')?.status.data?.files).toHaveLength(1);

    const mutation = snapshots.stage('t1', ['a.ts']);
    // A watcher event lands while the mutation is in flight; its reload answers
    // with the newer tree, so the mutation's older answer must lose.
    snapshots.invalidate('t1');
    statusAnswer = status('main', ['a.ts', 'b.ts']);
    await vi.advanceTimersByTimeAsync(0);
    staged.resolve(status('main', ['a.ts']));
    await mutation;

    expect(snapshots.getTask('t1')?.status.data?.files.map((entry) => entry.path)).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(statusCalls(calls)).toHaveLength(2);
  });

  it('sends the discarded side through the same mutation guard', async () => {
    vi.useFakeTimers();
    const first = status('main', ['src/login.ts']);
    const late = deferred<GitStatus>();
    const discard = deferred<GitStatus>();
    let statusReads = 0;
    const { invoke, calls } = createInvoke((method) => {
      if (method === 'git.discard') return discard.promise;
      statusReads += 1;
      // The first read loads the task; the second one starts before the discard
      // and answers with the pre-discard tree after it has already completed.
      return statusReads === 1 ? first : late.promise;
    });
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.getTask('t1')?.status.data?.files.map((entry) => entry.path)).toEqual([
      'src/login.ts',
    ]);

    const slowRead = snapshots.requestStatus('t1');
    const mutation = snapshots.discard('t1', ['src/login.ts'], 'unstaged');

    discard.resolve(status('main'));
    await mutation;
    expect(snapshots.getTask('t1')?.status.data?.files).toEqual([]);

    // The read that started before the discard lost to its answer.
    late.resolve(status('main', ['src/login.ts']));
    await slowRead;
    expect(snapshots.getTask('t1')?.status.data?.files).toEqual([]);

    // The side is part of the request, and the mutation read no extra status:
    // its own answer is the one that landed.
    expect(calls.find((call) => call.method === 'git.discard')?.params).toEqual({
      taskId: 't1',
      paths: ['src/login.ts'],
      side: 'unstaged',
    });
    expect(statusCalls(calls)).toHaveLength(2);
  });

  it('applies a mutation answer when nothing invalidated it', async () => {
    const answers: Record<string, unknown> = {
      'git.stage': status('main', ['a.ts']),
      'git.unstage': status('main'),
      'git.discard': status('main', ['b.ts']),
      'git.checkout': status('feature'),
      'git.commit': { hash: 'abc123', summary: 'msg' },
    };
    const { invoke, calls } = createInvoke((method) => answers[method] ?? status('main'));
    const snapshots = makeStore(invoke);

    await snapshots.stage('t1', ['a.ts']);
    expect(snapshots.getTask('t1')?.status.data?.files.map((entry) => entry.path)).toEqual([
      'a.ts',
    ]);
    await snapshots.unstage('t1', ['a.ts']);
    expect(snapshots.getTask('t1')?.status.data?.files).toEqual([]);
    await snapshots.discard('t1', ['b.ts']);
    expect(snapshots.getTask('t1')?.status.data?.files.map((entry) => entry.path)).toEqual([
      'b.ts',
    ]);
    // An absent side keeps the request exactly as it was before sides existed.
    expect(calls.find((call) => call.method === 'git.discard')?.params).toEqual({
      taskId: 't1',
      paths: ['b.ts'],
    });
    await snapshots.checkout('t1', { branch: 'feature' });
    expect(snapshots.getTask('t1')?.status.data?.branch).toBe('feature');

    // A mutation never writes the state of another task.
    expect(snapshots.getTask('other')).toBeNull();

    const before = statusCalls(calls).length;
    const result = await snapshots.commit('t1', { message: 'msg', amend: true });
    expect(result.hash).toBe('abc123');
    // A commit answers with a hash, so the store re-reads the status instead.
    expect(statusCalls(calls).length).toBe(before + 1);
  });

  it('keeps drafts, filters and selections per task', async () => {
    const { invoke } = createInvoke(() => status('main'));
    const snapshots = makeStore(invoke);

    snapshots.updateMemory('a', { draft: 'task a message' });
    snapshots.updateMemory('a', { filter: 'src/', view: 'list' });
    snapshots.updateMemory('a', {
      selection: { path: 'src/a.ts', mode: 'staged' },
    });
    snapshots.updateMemory('b', { draft: 'task b message', amend: true });

    // A → B → A restores A's memory, and B keeps its own draft.
    expect(snapshots.getMemory('a')).toEqual({
      ...EMPTY_GIT_MEMORY,
      draft: 'task a message',
      filter: 'src/',
      view: 'list',
      selection: { path: 'src/a.ts', mode: 'staged' },
    });
    expect(snapshots.getMemory('b')).toEqual({
      ...EMPTY_GIT_MEMORY,
      draft: 'task b message',
      amend: true,
    });

    // The memory is in memory only: forgetting a task drops it.
    snapshots.forgetTask('a');
    expect(snapshots.getMemory('a')).toEqual(EMPTY_GIT_MEMORY);
    expect(snapshots.getTask('a')).toBeNull();
    expect(snapshots.getMemory('b').draft).toBe('task b message');
  });

  it('notifies subscribers on every change', async () => {
    const { invoke } = createInvoke(() => status('main'));
    const snapshots = makeStore(invoke);
    let changes = 0;
    const stop = snapshots.subscribe(() => {
      changes += 1;
    });

    await snapshots.requestStatus('t1');
    // Loading, then the answer.
    expect(changes).toBe(2);
    snapshots.updateMemory('t1', { draft: 'wip' });
    expect(changes).toBe(3);
    stop();
    snapshots.updateMemory('t1', { draft: 'wip 2' });
    expect(changes).toBe(3);
  });

  it('does not refetch a hidden task until it is read again', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main', ['a.ts']));
    const snapshots = makeStore(invoke);

    snapshots.retain('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);

    // The user switched to task B: a watcher event for A is remembered, not
    // fetched, and A's last snapshot stays readable as stale.
    snapshots.release('a');
    snapshots.invalidate('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);
    expect(snapshots.getTask('a')?.stale).toBe(true);
    expect(snapshots.getTask('a')?.status.data?.branch).toBe('main');

    // Reading A again catches up on the missed reload.
    snapshots.retain('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('a')?.stale).toBe(false);
  });

  it('keeps a recorded invalidation for a task that was never loaded', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main'));
    const snapshots = makeStore(invoke);

    snapshots.invalidate('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(0);
    expect(snapshots.getTask('a')).toBeNull();

    snapshots.retain('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);
  });

  it('keeps reloading while another holder of the same task is mounted', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main', ['a.ts']));
    const snapshots = makeStore(invoke);

    // The shell and the panel both read the same task.
    snapshots.retain('t1');
    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    // The second holder joins the task; it does not read it again.
    expect(statusCalls(calls)).toHaveLength(1);

    // Collapsing the panel releases one holder, the shell keeps watching.
    snapshots.release('t1');
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('t1')?.stale).toBe(false);
  });

  it('defers reloads only once the last holder released the task', async () => {
    vi.useFakeTimers();
    const { invoke, calls } = createInvoke(() => status('main', ['a.ts']));
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    snapshots.retain('t1');
    expect(statusCalls(calls)).toHaveLength(1);

    // A balanced pair of releases leaves the task on screen.
    snapshots.release('t1');
    snapshots.release('t1');
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(1);
    expect(snapshots.getTask('t1')?.stale).toBe(true);

    // Reading the task again catches up on the coalesced reload.
    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCalls(calls)).toHaveLength(2);

    // An unbalanced release of a task nobody holds is harmless.
    snapshots.release('gone');
    expect(statusCalls(calls)).toHaveLength(2);
  });

  it('retries the branch slice after its first read failed', async () => {
    vi.useFakeTimers();
    let failing = true;
    let current = 'main';
    const { invoke, calls } = createInvoke((method) => {
      if (method !== 'git.branches') return status(current);
      if (failing) throw new Error('branches down');
      return branches(current);
    });
    const snapshots = makeStore(invoke);

    snapshots.retain('t1');
    await vi.advanceTimersByTimeAsync(0);
    await snapshots.requestBranches('t1');
    expect(snapshots.getTask('t1')?.branches.data).toBeNull();
    expect(snapshots.getTask('t1')?.branches.error).toBe('branches down');

    // The list was asked for and failed: the next invalidation retries it
    // instead of leaving the head on an error until the panel is remounted.
    failing = false;
    current = 'external-branch';
    snapshots.invalidate('t1');
    await vi.advanceTimersByTimeAsync(0);

    expect(branchCalls(calls)).toHaveLength(2);
    expect(snapshots.getTask('t1')?.branches.error).toBeNull();
    expect(snapshots.getTask('t1')?.branches.data?.current).toBe('external-branch');
  });
});
