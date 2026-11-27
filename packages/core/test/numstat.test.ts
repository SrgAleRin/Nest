import { describe, expect, it } from 'vitest';
import { mergeNumstat, parseNumstat, sumNumstat } from '../src/git/numstat.js';

describe('parseNumstat', () => {
  it('parses additions and deletions per file', () => {
    const stats = parseNumstat('12\t3\tsrc/app.ts\0' + '4\t0\tsrc/new.ts\0');
    expect(stats.get('src/app.ts')).toEqual({ additions: 12, deletions: 3 });
    expect(stats.get('src/new.ts')).toEqual({ additions: 4, deletions: 0 });
  });

  it('keeps binary files without line counts', () => {
    const stats = parseNumstat('-\t-\tassets/logo.png\0');
    expect(stats.get('assets/logo.png')).toEqual({ additions: null, deletions: null });
  });

  it('maps a rename to its new path', () => {
    const stats = parseNumstat('0\t0\t\0src/old.ts\0src/new.ts\0');
    expect(stats.has('src/old.ts')).toBe(false);
    expect(stats.get('src/new.ts')).toEqual({ additions: 0, deletions: 0 });
  });

  it('ignores trailing empty records and malformed lines', () => {
    const stats = parseNumstat('1\t1\ta.ts\0' + '\0' + 'not-a-record\0');
    expect(stats.size).toBe(1);
  });
});

describe('mergeNumstat', () => {
  it('sums staged and unstaged counts for the same file', () => {
    const target = parseNumstat('2\t1\ta.ts\0');
    mergeNumstat(target, parseNumstat('3\t4\ta.ts\0'));
    expect(target.get('a.ts')).toEqual({ additions: 5, deletions: 5 });
  });

  it('keeps null when either side is binary', () => {
    const target = parseNumstat('2\t1\ta.ts\0');
    mergeNumstat(target, parseNumstat('-\t-\ta.ts\0'));
    expect(target.get('a.ts')).toEqual({ additions: null, deletions: null });
  });
});

describe('sumNumstat', () => {
  it('adds the two sides into the aggregate counters', () => {
    const total = sumNumstat({
      staged: parseNumstat('10\t0\ta.ts\0'),
      unstaged: parseNumstat('1\t0\ta.ts\0'),
    });
    expect(total.get('a.ts')).toEqual({ additions: 11, deletions: 0 });
  });

  it('keeps a file changed on one side only', () => {
    const total = sumNumstat({
      staged: parseNumstat('10\t0\ta.ts\0'),
      unstaged: parseNumstat(''),
    });
    expect(total.get('a.ts')).toEqual({ additions: 10, deletions: 0 });
  });

  it('sums a staged addition reverted in the worktree to zero net lines', () => {
    const total = sumNumstat({
      staged: parseNumstat('10\t0\ta.ts\0'),
      unstaged: parseNumstat('0\t10\ta.ts\0'),
    });
    expect(total.get('a.ts')).toEqual({ additions: 10, deletions: 10 });
  });
});
