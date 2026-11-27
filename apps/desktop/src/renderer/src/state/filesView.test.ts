import { describe, expect, it, vi } from 'vitest';
import { createFilesViewStore, filesViewActions, filesViewStore } from './filesView';

describe('files view store', () => {
  it('starts on the working tree of every task', () => {
    const store = createFilesViewStore();
    expect(store.getInspectedRef('task-a')).toBeNull();
    expect(store.getInspectedRef(null)).toBeNull();
  });

  it('keeps the inspected revision per task', () => {
    const store = createFilesViewStore();
    store.setInspectedRef('task-a', 'origin/main');
    store.setInspectedRef('task-b', 'feat/other');
    expect(store.getInspectedRef('task-a')).toBe('origin/main');
    expect(store.getInspectedRef('task-b')).toBe('feat/other');
    expect(store.getInspectedRef('task-c')).toBeNull();

    store.setInspectedRef('task-a', 'release/1.2');
    expect(store.getInspectedRef('task-a')).toBe('release/1.2');
    expect(store.getInspectedRef('task-b')).toBe('feat/other');
  });

  it('resets one task to the working tree with a null ref', () => {
    const store = createFilesViewStore();
    store.setInspectedRef('task-a', 'origin/main');
    store.setInspectedRef('task-a', null);
    expect(store.getInspectedRef('task-a')).toBeNull();
  });

  it('notifies only when the value of a task changes', () => {
    const store = createFilesViewStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setInspectedRef('task-a', 'origin/main');
    expect(listener).toHaveBeenCalledTimes(1);

    store.setInspectedRef('task-a', 'origin/main');
    expect(listener).toHaveBeenCalledTimes(1);

    store.setInspectedRef('task-a', null);
    expect(listener).toHaveBeenCalledTimes(2);

    // Already on the working tree: nothing to tell.
    store.setInspectedRef('task-a', null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('forgets a task without touching its neighbours', () => {
    const store = createFilesViewStore();
    store.setInspectedRef('task-a', 'origin/main');
    store.setInspectedRef('task-b', 'origin/dev');
    const listener = vi.fn();
    store.subscribe(listener);

    store.clear('task-a');
    expect(store.getInspectedRef('task-a')).toBeNull();
    expect(store.getInspectedRef('task-b')).toBe('origin/dev');
    expect(listener).toHaveBeenCalledTimes(1);

    store.clear('task-a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes the shared instance through the actions', () => {
    filesViewActions.setInspectedRef('task-shared', 'origin/main');
    expect(filesViewStore.getInspectedRef('task-shared')).toBe('origin/main');
    filesViewActions.clear('task-shared');
    expect(filesViewStore.getInspectedRef('task-shared')).toBeNull();
  });
});
