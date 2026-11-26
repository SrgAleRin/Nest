import type { GitBranches, GitLog, GitStatus, NestClient } from '@nest/shared';
import { errorMessage } from '../utils';

/** The RPC surface the store needs; a `NestClient` satisfies it as is. */
export type GitSnapshotInvoke = NestClient['invoke'];

export interface GitSnapshotDeps {
  invoke: GitSnapshotInvoke;
}

/** Side of a change a diff target points at. */
export type GitSide = 'staged' | 'unstaged';

/**
 * The file and side a list and the diff viewer share. The panel task adds its
 * own `DiffTarget`; this is the renderer state the store remembers per task.
 */
export interface GitSelection {
  path: string;
  mode: GitSide;
}

export type GitFileView = 'tree' | 'list';

/** Per-task UI memory. Memory only: nothing here is persisted. */
export interface GitTaskMemory {
  /** Commit message draft. */
  draft: string;
  /** `Amend` is a deliberate secondary action, so it is remembered too. */
  amend: boolean;
  /** File filter text. */
  filter: string;
  view: GitFileView;
  /** Selected diff target, `null` when the list has no selection. */
  selection: GitSelection | null;
}

export const EMPTY_GIT_MEMORY: GitTaskMemory = {
  draft: '',
  amend: false,
  filter: '',
  view: 'tree',
  selection: null,
};

/** One independently loaded piece of git data. */
export interface GitSlice<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Everything the renderer knows about one task's git state. The status is the
 * single snapshot the header, the status bar, `Source Control` and the diff
 * counters read; branches and the recent log load on their own and fail on
 * their own.
 */
export interface GitSnapshot {
  taskId: string;
  /** Local revision; answers for an older revision are dropped. */
  revision: number;
  /** The snapshot is known to be out of date but is still shown. */
  stale: boolean;
  status: GitSlice<GitStatus>;
  branches: GitSlice<GitBranches>;
  log: GitSlice<GitLog>;
  memory: GitTaskMemory;
}

export type GitSnapshotMap = Readonly<Record<string, GitSnapshot>>;

export interface GitCommitParams {
  message: string;
  stageAll?: boolean;
  amend?: boolean;
}

export interface GitCheckoutParams {
  branch: string;
  create?: boolean;
  from?: string;
}

export interface GitSnapshotStore {
  /** For `useSyncExternalStore`; the map is replaced on every change. */
  subscribe(listener: () => void): () => void;
  getState(): GitSnapshotMap;
  /** The snapshot of a task, `null` when the store never touched it. */
  getTask(taskId: string): GitSnapshot | null;
  /** Per-task memory; a stable empty value when the task has none yet. */
  getMemory(taskId: string): GitTaskMemory;
  updateMemory(taskId: string, patch: Partial<GitTaskMemory>): GitTaskMemory;
  /** Deleting a task's state: its snapshot, its memory and any pending reload. */
  forgetTask(taskId: string): void;
  /**
   * `false` while a panel is not on screen. An invalidation for a hidden task
   * only marks it stale; `true` reads it again (and loads it the first time).
   */
  setVisible(taskId: string, visible: boolean): void;
  requestStatus(taskId: string): Promise<void>;
  requestBranches(taskId: string): Promise<void>;
  requestLog(taskId: string, limit?: number): Promise<void>;
  /**
   * `git:changed` from main: the last snapshot stays readable as `stale` and
   * bursts in the same tick coalesce into one reload for a visible task.
   */
  invalidate(taskId: string): void;
  stage(taskId: string, paths: string[]): Promise<GitStatus>;
  unstage(taskId: string, paths: string[]): Promise<GitStatus>;
  discard(taskId: string, paths: string[]): Promise<GitStatus>;
  commit(taskId: string, params: GitCommitParams): Promise<{ hash: string; summary: string }>;
  checkout(taskId: string, params: GitCheckoutParams): Promise<GitStatus>;
  dispose(): void;
}

function emptySnapshot(taskId: string): GitSnapshot {
  return {
    taskId,
    revision: 0,
    stale: false,
    status: { data: null, loading: false, error: null },
    branches: { data: null, loading: false, error: null },
    log: { data: null, loading: false, error: null },
    memory: EMPTY_GIT_MEMORY,
  };
}

/**
 * One `git.status` snapshot per task for the whole renderer.
 *
 * Every read of the status is tagged with a per-task revision; an answer is
 * applied only if that revision is still current, so a late answer for an older
 * request — or for another task — can never be written into state. Mutations
 * capture the revision they started with, so a mutation that began before an
 * invalidation loses to the newer snapshot. Branches and the log are separate
 * slices: their failures never touch the status and the status never blanks
 * them.
 */
export function createGitSnapshotStore(deps: GitSnapshotDeps): GitSnapshotStore {
  let state: GitSnapshotMap = {};
  const listeners = new Set<() => void>();
  /** Tasks currently on screen; only these refetch on invalidation. */
  const visible = new Set<string>();
  /** Invalidations that arrived while the task was hidden, coalesced. */
  const pendingReload = new Set<string>();
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function entryOf(taskId: string): GitSnapshot | null {
    return state[taskId] ?? null;
  }

  function write(taskId: string, next: (entry: GitSnapshot) => GitSnapshot): GitSnapshot {
    const entry = next(entryOf(taskId) ?? emptySnapshot(taskId));
    state = { ...state, [taskId]: entry };
    emit();
    return entry;
  }

  function currentRevision(taskId: string): number {
    return entryOf(taskId)?.revision ?? 0;
  }

  /**
   * The revision a mutation starts under. A mutation that runs before the first
   * status read still materializes the entry, so its own answer has a snapshot
   * to land in and an invalidation that arrives meanwhile still wins.
   */
  function beginMutation(taskId: string): number {
    if (!entryOf(taskId)) write(taskId, (entry) => entry);
    return currentRevision(taskId);
  }

  /** True while the answer belongs to the newest request for that task. */
  function isCurrent(taskId: string, revision: number): boolean {
    const entry = entryOf(taskId);
    return entry !== null && entry.revision === revision;
  }

  async function requestStatus(taskId: string): Promise<void> {
    pendingReload.delete(taskId);
    // The revision is bumped before the request: whoever invalidates or mutates
    // meanwhile wins, and this answer is dropped.
    const revision = write(taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      status: { ...entry.status, loading: true, error: null },
    })).revision;
    try {
      const status = await deps.invoke('git.status', { taskId });
      if (!isCurrent(taskId, revision)) return;
      write(taskId, (entry) => ({
        ...entry,
        stale: false,
        status: { data: status, loading: false, error: null },
      }));
    } catch (error) {
      // A failed read keeps the previous data and only reports itself: the
      // branches and the log are separate slices.
      if (!isCurrent(taskId, revision)) return;
      write(taskId, (entry) => ({
        ...entry,
        status: { ...entry.status, loading: false, error: errorMessage(error) },
      }));
    }
  }

  async function requestBranches(taskId: string): Promise<void> {
    write(taskId, (entry) => ({
      ...entry,
      branches: { ...entry.branches, loading: true, error: null },
    }));
    try {
      const branches = await deps.invoke('git.branches', { taskId });
      // The task was forgotten meanwhile: a late answer must not resurrect it.
      if (!entryOf(taskId)) return;
      write(taskId, (entry) => ({
        ...entry,
        branches: { data: branches, loading: false, error: null },
      }));
    } catch (error) {
      if (!entryOf(taskId)) return;
      write(taskId, (entry) => ({
        ...entry,
        branches: { ...entry.branches, loading: false, error: errorMessage(error) },
      }));
    }
  }

  async function requestLog(taskId: string, limit = 5): Promise<void> {
    write(taskId, (entry) => ({
      ...entry,
      log: { ...entry.log, loading: true, error: null },
    }));
    try {
      const log = await deps.invoke('git.log', { taskId, limit });
      if (!entryOf(taskId)) return;
      write(taskId, (entry) => ({ ...entry, log: { data: log, loading: false, error: null } }));
    } catch (error) {
      if (!entryOf(taskId)) return;
      write(taskId, (entry) => ({
        ...entry,
        log: { ...entry.log, loading: false, error: errorMessage(error) },
      }));
    }
  }

  /**
   * A mutation's own status answer, applied only under the revision it started
   * with. Applying it bumps the revision again, so a status read that was in
   * flight when the mutation finished cannot overwrite the newer result.
   */
  async function mutated(
    taskId: string,
    startedRevision: number,
    run: () => Promise<GitStatus>,
  ): Promise<GitStatus> {
    const status = await run();
    if (!isCurrent(taskId, startedRevision)) return status;
    write(taskId, (entry) => ({
      ...entry,
      revision: entry.revision + 1,
      stale: false,
      status: { data: status, loading: false, error: null },
    }));
    return status;
  }

  async function requestAfterMutation<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const result = await run();
    // The answer carries no status (commit, push-like operations), so any read
    // that started before it is out of date.
    write(taskId, (entry) => ({ ...entry, revision: entry.revision + 1 }));
    await requestStatus(taskId);
    return result;
  }

  function flushReloads(): void {
    reloadTimer = null;
    const tasks = [...pendingReload];
    pendingReload.clear();
    for (const taskId of tasks) {
      if (visible.has(taskId)) {
        void requestStatus(taskId);
      } else {
        // Hidden panels do not refetch; the read that shows the task reloads it.
        pendingReload.add(taskId);
      }
    }
  }

  function invalidate(taskId: string): void {
    if (entryOf(taskId)) {
      write(taskId, (entry) => ({
        ...entry,
        revision: entry.revision + 1,
        // Keep showing the last snapshot, named as stale until the reload lands.
        stale: entry.status.data !== null ? true : entry.stale,
      }));
    }
    pendingReload.add(taskId);
    if (reloadTimer !== null) return;
    reloadTimer = setTimeout(flushReloads, 0);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState() {
      return state;
    },
    getTask(taskId) {
      return entryOf(taskId);
    },
    getMemory(taskId) {
      return entryOf(taskId)?.memory ?? EMPTY_GIT_MEMORY;
    },
    updateMemory(taskId, patch) {
      let memory = EMPTY_GIT_MEMORY;
      write(taskId, (entry) => {
        memory = { ...entry.memory, ...patch };
        return { ...entry, memory };
      });
      return memory;
    },
    forgetTask(taskId) {
      pendingReload.delete(taskId);
      visible.delete(taskId);
      if (!entryOf(taskId)) return;
      const next: Record<string, GitSnapshot> = { ...state };
      delete next[taskId];
      state = next;
      emit();
    },
    setVisible(taskId, isVisible) {
      if (!isVisible) {
        visible.delete(taskId);
        return;
      }
      visible.add(taskId);
      // Reading a task loads it, and a reload missed while it was hidden
      // happens now instead of while the panel was off screen. Revision 0
      // means no status was ever requested for it.
      const missed = pendingReload.delete(taskId);
      if (missed || currentRevision(taskId) === 0) void requestStatus(taskId);
    },
    requestStatus,
    requestBranches,
    requestLog,
    invalidate,
    stage(taskId, paths) {
      const started = beginMutation(taskId);
      return mutated(taskId, started, () => deps.invoke('git.stage', { taskId, paths }));
    },
    unstage(taskId, paths) {
      const started = beginMutation(taskId);
      return mutated(taskId, started, () => deps.invoke('git.unstage', { taskId, paths }));
    },
    discard(taskId, paths) {
      const started = beginMutation(taskId);
      return mutated(taskId, started, () => deps.invoke('git.discard', { taskId, paths }));
    },
    commit(taskId, params) {
      return requestAfterMutation(taskId, () =>
        deps.invoke('git.commit', {
          taskId,
          message: params.message,
          stageAll: params.stageAll,
          amend: params.amend,
        }),
      );
    },
    checkout(taskId, params) {
      const started = beginMutation(taskId);
      return mutated(taskId, started, () =>
        deps.invoke('git.checkout', {
          taskId,
          branch: params.branch,
          create: params.create,
          from: params.from,
        }),
      );
    },
    dispose() {
      if (reloadTimer !== null) clearTimeout(reloadTimer);
      reloadTimer = null;
      pendingReload.clear();
      visible.clear();
      listeners.clear();
    },
  };
}
