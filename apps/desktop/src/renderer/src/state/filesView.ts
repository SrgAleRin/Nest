import { useSyncExternalStore } from 'react';

/**
 * Which revision the `Files` panel of a task shows. `null` is the working tree
 * on disk; any other value is a local or remote branch read from git objects,
 * without touching the workspace the session runs in.
 *
 * The inspected revision lives per task and outside React, so the center
 * workbench can send a task to `Browse files` for a branch while the right
 * panel is mounted or not yet mounted. The panel reads the same store, so the
 * handoff needs no prop drilling through components this store cannot see.
 */
export interface FilesViewStore {
  subscribe(listener: () => void): () => void;
  /** The revision a task's `Files` panel shows; `null` is the working tree. */
  getInspectedRef(taskId: string | null): string | null;
  /** Sets the inspected revision; `null` resets the panel to the working tree. */
  setInspectedRef(taskId: string, ref: string | null): void;
  /** Forgets a task, e.g. when it is removed. */
  clear(taskId: string): void;
}

export function createFilesViewStore(): FilesViewStore {
  const listeners = new Set<() => void>();
  /** Only tasks whose panel was pointed at a revision have an entry. */
  let refs: ReadonlyMap<string, string> = new Map();

  function write(next: ReadonlyMap<string, string>): void {
    refs = next;
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getInspectedRef(taskId) {
      if (!taskId) return null;
      return refs.get(taskId) ?? null;
    },
    setInspectedRef(taskId, ref) {
      const current = refs.get(taskId) ?? null;
      if (current === ref) return;
      const next = new Map(refs);
      if (ref === null) next.delete(taskId);
      else next.set(taskId, ref);
      write(next);
    },
    clear(taskId) {
      if (!refs.has(taskId)) return;
      const next = new Map(refs);
      next.delete(taskId);
      write(next);
    },
  };
}

/** The one store the panel and the center workbench share. */
export const filesViewStore = createFilesViewStore();

/**
 * Actions on the shared store, for call sites that only send a task to a
 * revision and never read it (`Browse files` in the graph or the inspector).
 */
export const filesViewActions = {
  setInspectedRef(taskId: string, ref: string | null): void {
    filesViewStore.setInspectedRef(taskId, ref);
  },
  clear(taskId: string): void {
    filesViewStore.clear(taskId);
  },
};

/** The revision this task's `Files` panel shows; `null` is the working tree. */
export function useInspectedRef(taskId: string | null): string | null {
  return useSyncExternalStore(filesViewStore.subscribe, () =>
    filesViewStore.getInspectedRef(taskId),
  );
}
