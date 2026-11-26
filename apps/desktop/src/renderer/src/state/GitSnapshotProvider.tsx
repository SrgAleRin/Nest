import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { GitSnapshot, GitSnapshotStore, GitTaskMemory } from './gitSnapshot';

const GitSnapshotContext = createContext<GitSnapshotStore | null>(null);

/**
 * Puts one store above the panel. `App` owns the store so the header branch
 * badge and the status bar read the same snapshot the right panel reads.
 */
export function GitSnapshotProvider({
  store,
  children,
}: {
  store: GitSnapshotStore;
  children: ReactNode;
}) {
  return <GitSnapshotContext.Provider value={store}>{children}</GitSnapshotContext.Provider>;
}

/** The store a component was given; throws when the provider is missing. */
export function useGitSnapshotStore(): GitSnapshotStore {
  const store = useContext(GitSnapshotContext);
  if (!store) throw new Error('useGitSnapshotStore needs a GitSnapshotProvider');
  return store;
}

/**
 * The task's git snapshot, and the task's own view of it: mounting marks the
 * task visible (so it loads, and catches up on an invalidation it missed while
 * hidden), unmounting marks it hidden (so a `git:changed` for it no longer
 * refetches).
 */
export function useGitSnapshotFor(
  store: GitSnapshotStore,
  taskId: string | null,
): GitSnapshot | null {
  const snapshot = useSyncExternalStore(store.subscribe, () =>
    taskId ? store.getTask(taskId) : null,
  );
  useEffect(() => {
    if (!taskId) return;
    store.setVisible(taskId, true);
    return () => store.setVisible(taskId, false);
  }, [store, taskId]);
  return snapshot;
}

/** The same read for a component under `GitSnapshotProvider`. */
export function useGitSnapshot(taskId: string | null): GitSnapshot | null {
  return useGitSnapshotFor(useGitSnapshotStore(), taskId);
}

/** Per-task commit draft, filter, view and selection. */
export function useGitTaskMemory(taskId: string | null): GitTaskMemory {
  const store = useGitSnapshotStore();
  return useSyncExternalStore(store.subscribe, () => store.getMemory(taskId ?? ''));
}
