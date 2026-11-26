import { describe, expect, it } from 'vitest';
import type { DiffFile, DiffMode, GitFile } from '@nest/shared';
import {
  countSides,
  describeDiff,
  DIFF_MODES,
  DIFF_MODE_OPTIONS,
  emptyDiffMessage,
  fileSideBadge,
  fileStageAction,
  isStaleDiff,
} from './diffMode';

function diffFile(patch: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/a.ts',
    oldPath: 'src/a.ts',
    status: 'modified',
    staged: false,
    hunks: [],
    additions: 1,
    deletions: 0,
    raw: '',
    ...patch,
  };
}

function gitFile(patch: Partial<GitFile> = {}): GitFile {
  return {
    path: 'src/a.ts',
    indexStatus: ' ',
    worktreeStatus: ' ',
    staged: false,
    untracked: false,
    additions: 1,
    deletions: 0,
    ...patch,
  };
}

describe('diff mode switch', () => {
  it('offers every mode the server can answer', () => {
    expect(DIFF_MODE_OPTIONS.map((option) => option.mode)).toEqual([...DIFF_MODES]);
    expect(new Set(DIFF_MODES).size).toBe(DIFF_MODES.length);
  });

  it('labels the comparison that was actually returned', () => {
    const descriptor = (mode: DiffMode, baseRef: string | null = null) => ({
      mode,
      baseRef,
      workspaceIncludesIndex: mode === 'base',
      anchorSide: mode === 'staged' ? ('index' as const) : ('worktree' as const),
    });

    expect(describeDiff(descriptor('both'))).toBe('Staged + unstaged');
    expect(describeDiff(descriptor('unstaged'))).toContain('working tree');
    expect(describeDiff(descriptor('staged'))).toContain('index');
    expect(describeDiff(descriptor('base', 'origin/main'))).toBe(
      'vs origin/main · working tree incl. index',
    );
    expect(describeDiff(null)).toBe('Choose what to compare');
  });

  it('drops a response for another mode', () => {
    const stale = { mode: 'unstaged' as DiffMode, baseRef: null, workspaceIncludesIndex: false };
    expect(isStaleDiff({ ...stale, anchorSide: 'worktree' }, 'staged')).toBe(true);
    expect(isStaleDiff({ ...stale, anchorSide: 'worktree' }, 'unstaged')).toBe(false);
    expect(isStaleDiff(null, 'both')).toBe(false);
  });
});

describe('per-file side and stage action', () => {
  it('marks the side each file came from in the mixed view only', () => {
    expect(fileSideBadge(diffFile({ staged: true }), 'both')).toBe('staged');
    expect(fileSideBadge(diffFile({ staged: false }), 'both')).toBe('unstaged');
    expect(fileSideBadge(diffFile({ staged: true }), 'staged')).toBeNull();
  });

  it('offers the action that matches the mode', () => {
    expect(fileStageAction(diffFile({ staged: true }), 'both')).toBe('unstage');
    expect(fileStageAction(diffFile({ staged: false }), 'both')).toBe('stage');
    expect(fileStageAction(diffFile({ staged: false }), 'unstaged')).toBe('stage');
    expect(fileStageAction(diffFile({ staged: true }), 'staged')).toBe('unstage');
    // The base comparison mixes index and worktree, so no single side applies.
    expect(fileStageAction(diffFile({ staged: true }), 'base')).toBeNull();
  });
});

describe('diff side counts and empty states', () => {
  it('counts a partially staged file on both sides', () => {
    const counts = countSides([
      gitFile({ indexStatus: 'M', worktreeStatus: 'M', staged: true }),
      gitFile({ indexStatus: 'A', staged: true }),
      gitFile({ worktreeStatus: 'M' }),
      gitFile({ untracked: true, indexStatus: '?', worktreeStatus: '?' }),
    ]);
    expect(counts).toEqual({ staged: 2, unstaged: 3 });
  });

  it('never claims there is nothing to review while the index has changes', () => {
    const counts = { staged: 2, unstaged: 0 };
    expect(emptyDiffMessage('both', counts)).toBe('No changes to review');
    // In a single-side mode the empty state names the hidden side instead.
    expect(emptyDiffMessage('unstaged', counts)).toContain('2 files staged');
    expect(emptyDiffMessage('staged', { staged: 0, unstaged: 1 })).toContain(
      '1 file with unstaged changes',
    );
    expect(emptyDiffMessage('base', counts, 'origin/main')).toBe('No changes against origin/main');
    expect(emptyDiffMessage('staged', { staged: 0, unstaged: 0 })).toBe('No staged changes');
  });
});
