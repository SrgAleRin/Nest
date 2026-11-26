import { describe, expect, it } from 'vitest';
import type { GitFile } from '@nest/shared';
import {
  changedPathCount,
  countPaths,
  discardWarning,
  filterSections,
  matchesFilter,
  projectChanges,
  rowTone,
  sideLetter,
  stageablePaths,
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
    expect(discardWarning(row!, { hasHead: false })).toContain('no HEAD to restore from');

    const [untracked] = projectChanges([
      file({ path: 'notes.md', indexStatus: '?', worktreeStatus: '?', untracked: true }),
    ]).untracked;
    expect(discardWarning(untracked!, { hasHead: true })).toContain('deletes the untracked file');
  });
});
