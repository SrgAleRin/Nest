import { describe, expect, it } from 'vitest';
import { clearDiffSelection } from './DiffPanel';
import { createGitSnapshotStore } from '../state/gitSnapshot';

function store() {
  return createGitSnapshotStore({
    // Nothing in this file reads git: the selection is memory only.
    invoke: () => new Promise(() => {}),
  });
}

describe('show all files', () => {
  it('clears the single-file selection of the task memory', () => {
    const git = store();
    git.updateMemory('task-a', { selection: { path: 'src/app.ts', mode: 'staged' } });
    git.updateMemory('task-b', { selection: { path: 'src/other.ts', mode: 'unstaged' } });

    clearDiffSelection(git, 'task-a');

    expect(git.getMemory('task-a').selection).toBeNull();
    // The other task keeps its own selection: memory is per task.
    expect(git.getMemory('task-b').selection).toEqual({
      path: 'src/other.ts',
      mode: 'unstaged',
    });
  });

  it('leaves the rest of the memory alone', () => {
    const git = store();
    git.updateMemory('task-a', {
      draft: 'fix: something',
      amend: true,
      filter: 'app',
      view: 'list',
      selection: { path: 'src/app.ts', mode: 'unstaged' },
    });

    clearDiffSelection(git, 'task-a');

    expect(git.getMemory('task-a')).toEqual({
      draft: 'fix: something',
      amend: true,
      filter: 'app',
      view: 'list',
      selection: null,
    });
  });

  it('is a no-op for a task that was never selected in', () => {
    const git = store();
    clearDiffSelection(git, 'task-a');
    expect(git.getMemory('task-a').selection).toBeNull();
  });
});
