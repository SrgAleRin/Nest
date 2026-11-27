import { describe, expect, it } from 'vitest';
import type { GitFile } from '@nest/shared';
import {
  canDiscardRow,
  changedPathCount,
  countPaths,
  discardConfirmation,
  discardWarning,
  filterSections,
  matchesFilter,
  projectChanges,
  rowStillChanged,
  rowTone,
  sideLetter,
  stageablePaths,
  staleAbortNote,
} from './sourceControl';

function file(overrides: Partial<GitFile> = {}): GitFile {
  return {
    path: 'src/app.ts',
    oldPath: null,
    copied: false,
    indexStatus: ' ',
    worktreeStatus: ' ',
    conflict: false,
    staged: false,
    unstaged: false,
    untracked: false,
    additions: 1,
    deletions: 0,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 1,
    unstagedDeletions: 0,
    ...overrides,
  };
}

/** M on the index and M in the worktree: both sides hold different changes. */
const partiallyStaged = file({
  path: 'src/login.ts',
  indexStatus: 'M',
  worktreeStatus: 'M',
  staged: true,
  unstaged: true,
});

describe('section projection', () => {
  it('puts a partially staged file in both sections with the side letters', () => {
    const sections = projectChanges([partiallyStaged]);
    expect(sections.staged.map((row) => [row.path, row.side, row.letter])).toEqual([
      ['src/login.ts', 'staged', 'M'],
    ]);
    expect(sections.unstaged.map((row) => [row.path, row.side, row.letter])).toEqual([
      ['src/login.ts', 'unstaged', 'M'],
    ]);
    expect(sections.untracked).toEqual([]);
    expect(sections.conflicts).toEqual([]);
  });

  it('counts unique paths, not rows', () => {
    const sections = projectChanges([partiallyStaged]);
    expect(sections.staged.length + sections.unstaged.length).toBe(2);
    expect(sections.total).toBe(1);
  });

  it('keeps a conflict out of staged and unstaged', () => {
    const conflict = file({
      path: 'src/merge.ts',
      indexStatus: 'U',
      worktreeStatus: 'U',
      conflict: true,
      // Git reports both sides of an unmerged entry; the section must not.
      staged: true,
      unstaged: true,
    });
    const sections = projectChanges([conflict, partiallyStaged]);
    expect(sections.conflicts).toEqual([
      {
        path: 'src/merge.ts',
        oldPath: null,
        copied: false,
        letter: 'UU',
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(sections.staged).toHaveLength(1);
    expect(sections.unstaged).toHaveLength(1);
    expect(sections.total).toBe(2);
  });

  it('reports an untracked file in its own section, not in unstaged', () => {
    const sections = projectChanges([
      file({
        path: 'notes.md',
        indexStatus: '?',
        worktreeStatus: '?',
        untracked: true,
        unstaged: true,
      }),
    ]);
    expect(sections.untracked.map((row) => [row.letter, row.side])).toEqual([['?', 'unstaged']]);
    expect(sections.unstaged).toEqual([]);
    expect(sections.total).toBe(1);
  });

  it('separates a staged-only file from an unstaged-only one', () => {
    const sections = projectChanges([
      file({ path: 'a.ts', indexStatus: 'A', staged: true }),
      file({ path: 'b.ts', worktreeStatus: 'D', unstaged: true }),
    ]);
    expect(sections.staged.map((row) => row.path)).toEqual(['a.ts']);
    expect(sections.unstaged.map((row) => row.path)).toEqual(['b.ts']);
  });

  it('sorts each section by path and keeps both sides of a rename', () => {
    const sections = projectChanges([
      file({ path: 'z.ts', indexStatus: 'M', worktreeStatus: 'M', staged: true, unstaged: true }),
      file({
        path: 'new/name.ts',
        oldPath: 'old/name.ts',
        indexStatus: 'R',
        staged: true,
      }),
      file({ path: 'a.ts', worktreeStatus: 'M', unstaged: true }),
    ]);
    expect(sections.staged.map((row) => row.path)).toEqual(['new/name.ts', 'z.ts']);
    expect(sections.unstaged.map((row) => row.path)).toEqual(['a.ts', 'z.ts']);
    const rename = sections.staged[0];
    expect(rename?.oldPath).toBe('old/name.ts');
  });

  it('falls back to a dot letter when a side has no change', () => {
    expect(sideLetter(file({ indexStatus: 'M', worktreeStatus: ' ' }), 'unstaged')).toBe('·');
    expect(sideLetter(file({ indexStatus: 'M', worktreeStatus: 'M' }), 'staged')).toBe('M');
  });

  it('takes the counters of each row from its own side', () => {
    const sections = projectChanges([
      file({
        path: 'src/login.ts',
        indexStatus: 'M',
        worktreeStatus: 'M',
        staged: true,
        unstaged: true,
        additions: 11,
        deletions: 0,
        stagedAdditions: 10,
        stagedDeletions: 0,
        unstagedAdditions: 1,
        unstagedDeletions: 0,
      }),
    ]);
    expect([sections.staged[0]?.additions, sections.staged[0]?.deletions]).toEqual([10, 0]);
    expect([sections.unstaged[0]?.additions, sections.unstaged[0]?.deletions]).toEqual([1, 0]);
  });

  it('keeps a null side null instead of inventing counters', () => {
    const sections = projectChanges([
      file({
        path: 'image.png',
        indexStatus: 'M',
        staged: true,
        stagedAdditions: null,
        stagedDeletions: null,
        unstagedAdditions: null,
        unstagedDeletions: null,
      }),
    ]);
    expect(sections.staged[0]?.additions).toBeNull();
    expect(sections.staged[0]?.deletions).toBeNull();
  });

  it('gives an untracked row the worktree counters', () => {
    const sections = projectChanges([
      file({
        path: 'notes.md',
        indexStatus: '?',
        worktreeStatus: '?',
        untracked: true,
        unstaged: true,
        stagedAdditions: null,
        stagedDeletions: null,
        unstagedAdditions: 4,
        unstagedDeletions: 2,
      }),
    ]);
    expect([sections.untracked[0]?.additions, sections.untracked[0]?.deletions]).toEqual([4, 2]);
  });
});

describe('filter', () => {
  const sections = projectChanges([
    partiallyStaged,
    file({
      path: 'docs/Read me.md',
      untracked: true,
      unstaged: true,
      indexStatus: '?',
      worktreeStatus: '?',
    }),
    file({ path: 'src/util.ts', oldPath: 'lib/Util.ts', indexStatus: 'R', staged: true }),
  ]);

  it('matches the file name and the path case-insensitively', () => {
    expect(matchesFilter({ path: 'SRC/Login.ts' }, 'login')).toBe(true);
    expect(matchesFilter({ path: 'docs/Deep/Path.md' }, 'deep/path')).toBe(true);
    expect(matchesFilter({ path: 'src/app.ts' }, 'nope')).toBe(false);
    expect(matchesFilter({ path: 'src/app.ts' }, '   ')).toBe(true);
  });

  it('matches the source path of a rename', () => {
    expect(matchesFilter({ path: 'src/util.ts', oldPath: 'lib/Util.ts' }, 'lib/')).toBe(true);
  });

  it('filters every section and re-counts the visible paths', () => {
    const filtered = filterSections(sections, 'src/');
    expect(filtered.staged.map((row) => row.path)).toEqual(['src/login.ts', 'src/util.ts']);
    expect(filtered.unstaged.map((row) => row.path)).toEqual(['src/login.ts']);
    expect(filtered.total).toBe(2);
    expect(filterSections(sections, '  ').total).toBe(sections.total);
    expect(filterSections(sections, 'nothing-here').total).toBe(0);
  });

  it('counts unique paths across sections', () => {
    expect(countPaths([...sections.staged, ...sections.unstaged])).toBe(2);
  });
});

describe('row helpers', () => {
  it('tones a conflict row apart from a modified one', () => {
    const sections = projectChanges([
      file({ path: 'a.ts', indexStatus: 'A', staged: true }),
      file({ path: 'c.ts', indexStatus: 'U', worktreeStatus: 'U', conflict: true }),
      file({ path: 'u.ts', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]);
    expect(rowTone(sections.staged[0]!)).toBe('tone-added');
    expect(rowTone(sections.conflicts[0]!)).toBe('tone-conflict');
    expect(rowTone(sections.untracked[0]!)).toBe('tone-untracked');
  });

  it('stages everything but conflicts', () => {
    const all = [
      partiallyStaged,
      file({ path: 'notes.md', untracked: true, unstaged: true }),
      file({ path: 'docs/x.md', staged: true }),
    ];
    expect(stageablePaths(all)).toEqual(['src/login.ts', 'notes.md']);
    expect(changedPathCount(all)).toBe(3);
  });

  it('names the real scope of Discard', () => {
    const [row] = projectChanges([partiallyStaged]).unstaged;
    const message = discardWarning(row!, { hasHead: true });
    expect(message).toContain('git restore --source=HEAD --staged --worktree');
    expect(message).toContain('staged and the unstaged');
    expect(discardWarning(row!, { hasHead: false })).toContain(
      'Unstage the file first; there is no HEAD commit to restore from',
    );

    const [untracked] = projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked;
    expect(discardWarning(untracked!, { hasHead: true })).toContain('deletes the untracked file');
  });

  it('names the smaller scope of the unstaged side of a partially staged file', () => {
    const [row] = projectChanges([partiallyStaged]).unstaged;
    const message = discardWarning(row!, { hasHead: true, hasStagedSide: true });
    expect(message).toContain('git restore --worktree');
    expect(message).toContain('staged part of this path stays staged');
    expect(message).not.toContain('drops the staged and the unstaged');
  });
});

describe('discard permission', () => {
  const tracked = (): ReturnType<typeof projectChanges>['staged'][number] =>
    projectChanges([partiallyStaged]).staged[0]!;
  const untracked = (): ReturnType<typeof projectChanges>['untracked'][number] =>
    projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked[0]!;

  it('refuses a tracked row on an unborn branch with the unstage hint', () => {
    expect(canDiscardRow(tracked(), { hasHead: false })).toEqual({
      allowed: false,
      reason: 'Unstage the file first; there is no HEAD commit to restore from',
    });
    expect(canDiscardRow(tracked(), { hasHead: true })).toEqual({ allowed: true, reason: null });
  });

  it('allows an untracked file even on an unborn branch', () => {
    expect(canDiscardRow(untracked(), { hasHead: false })).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('discard confirmation', () => {
  it('names the path and the restore-from-HEAD scope of a tracked change', () => {
    const [row] = projectChanges([partiallyStaged]).unstaged;
    const request = discardConfirmation(row!, { hasHead: true });
    expect(request.title).toBe('Discard src/login.ts');
    expect(request.title).not.toContain('you sure');
    expect(request.body.join(' ')).toContain('git restore --source=HEAD --staged --worktree');
    expect(request.body.join(' ')).toContain('staged and the unstaged');
    expect(request.destructive).toBe(true);
    expect(request.acceptLabel).toBe('Discard changes');
  });

  it('names a rename by both paths', () => {
    const [row] = projectChanges([
      file({
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        indexStatus: 'R',
        worktreeStatus: ' ',
        staged: true,
      }),
    ]).staged;
    expect(discardConfirmation(row!, { hasHead: true }).title).toBe(
      'Discard src/old.ts → src/new.ts',
    );
  });

  it('says an untracked file is deleted', () => {
    const [row] = projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked;
    const request = discardConfirmation(row!, { hasHead: true });
    expect(request.title).toBe('Delete notes.md');
    expect(request.body.join(' ')).toContain('deletes the untracked file from disk');
  });

  it('says a tracked row cannot be discarded without a HEAD', () => {
    const [row] = projectChanges([partiallyStaged]).staged;
    const request = discardConfirmation(row!, { hasHead: false });
    expect(request.body.join(' ')).toContain(
      'Unstage the file first; there is no HEAD commit to restore from',
    );
    // The old text claimed the action would fail; it never offers that run.
    expect(request.body.join(' ')).not.toContain('fails and nothing on disk changes');
  });

  it('deletes an untracked file on an unborn branch instead of promising a failure', () => {
    const [row] = projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked;
    const request = discardConfirmation(row!, { hasHead: false });
    expect(request.title).toBe('Delete notes.md');
    expect(request.acceptLabel).toBe('Delete file');
    expect(request.body.join(' ')).toContain('deletes the untracked file from disk');
  });

  it('keeps the staged part when the unstaged side of a partial file is discarded', () => {
    const [row] = projectChanges([partiallyStaged]).unstaged;
    const request = discardConfirmation(row!, { hasHead: true, hasStagedSide: true });
    expect(request.body.join(' ')).toContain('git restore --worktree');
    expect(request.body.join(' ')).toContain('stays staged');
  });
});

describe('stale guard', () => {
  it('accepts a row that still holds its own side', () => {
    const files = [partiallyStaged];
    const sections = projectChanges(files);
    expect(rowStillChanged(sections.staged[0]!, files)).toBe(true);
    expect(rowStillChanged(sections.unstaged[0]!, files)).toBe(true);
  });

  it('refuses a row that moved to another side or lost its change', () => {
    const [unstagedRow] = projectChanges([partiallyStaged]).unstaged;
    // The worktree side was staged while the confirmation was open.
    const nowStagedOnly = [file({ path: 'src/login.ts', indexStatus: 'M', staged: true })];
    expect(rowStillChanged(unstagedRow!, nowStagedOnly)).toBe(false);
    expect(rowStillChanged(unstagedRow!, [])).toBe(false);
    expect(staleAbortNote(unstagedRow!)).toContain('Nothing was discarded');
    expect(staleAbortNote(unstagedRow!)).toContain('src/login.ts');
  });

  it('refuses an untracked row that became tracked', () => {
    const [untrackedRow] = projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked;
    expect(
      rowStillChanged(untrackedRow!, [file({ path: 'notes.md', indexStatus: 'A', staged: true })]),
    ).toBe(false);
  });
});
