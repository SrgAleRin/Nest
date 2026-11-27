import { describe, expect, it } from 'vitest';
import type { GitBranches, GitBranch, GitCommit, GitLog } from '@nest/shared';
import {
  GRAPH_PAGE_LIMIT,
  graphLogParams,
  mergeLogPage,
  pickerRefs,
  refKind,
  refName,
} from './GitGraphPanel';

function commit(hash: string): GitCommit {
  return {
    hash,
    parents: [],
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: '2026-01-01T00:00:00Z',
    committedAt: '2026-01-01T00:00:00Z',
    subject: `commit ${hash}`,
    body: '',
    refs: [],
  };
}

function page(hashes: string[], hasMore: boolean): GitLog {
  return { commits: hashes.map(commit), hasMore };
}

function branch(name: string, extra: Partial<GitBranch> = {}): GitBranch {
  return {
    name,
    remote: false,
    current: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    tip: 'aaaaaaa',
    subject: `tip of ${name}`,
    committedAt: '2026-01-01T00:00:00Z',
    worktreePath: null,
    ...extra,
  };
}

function branches(): GitBranches {
  return {
    current: 'main',
    detached: false,
    unborn: false,
    baseRef: 'origin/main',
    remotes: [],
    local: [
      branch('main', { current: true }),
      branch('nest/a', { worktreePath: 'D:/nest/a' }),
      branch('nest/b'),
    ],
    remote: [branch('origin/main', { remote: true })],
  };
}

describe('graph log parameters', () => {
  it('asks for the scope of the switch, with the graph page size', () => {
    expect(graphLogParams('all', null, '', 0)).toEqual({
      scope: 'all',
      skip: 0,
      limit: GRAPH_PAGE_LIMIT,
    });
    expect(graphLogParams('branches', null, '  ', 300)).toEqual({
      scope: 'branches',
      skip: 300,
      limit: GRAPH_PAGE_LIMIT,
    });
    expect(graphLogParams('head', null, '', 0).scope).toBe('head');
  });

  it('walks one named ref on its own, never through a scope', () => {
    const params = graphLogParams('ref', 'origin/main', '', 0);
    expect(params.ref).toBe('origin/main');
    expect(params).not.toHaveProperty('scope');
  });

  it('falls back to the whole tree when a ref scope has no ref', () => {
    const params = graphLogParams('ref', null, '', 0);
    expect(params.scope).toBe('all');
    expect(params).not.toHaveProperty('ref');
  });

  it('sends a trimmed search only when there is one', () => {
    expect(graphLogParams('all', null, '  fix ', 0).search).toBe('fix');
    expect(graphLogParams('all', null, '   ', 0)).not.toHaveProperty('search');
  });
});

describe('paging the graph', () => {
  it('replaces the list on a reset and appends an older page', () => {
    const first = mergeLogPage(null, page(['a', 'b'], true), true);
    expect(first.commits.map((item) => item.hash)).toEqual(['a', 'b']);
    expect(first.hasMore).toBe(true);

    const older = mergeLogPage(first, page(['c', 'd'], false), false);
    expect(older.commits.map((item) => item.hash)).toEqual(['a', 'b', 'c', 'd']);
    expect(older.hasMore).toBe(false);

    const reset = mergeLogPage(older, page(['z'], false), true);
    expect(reset.commits.map((item) => item.hash)).toEqual(['z']);
    expect(reset.hasMore).toBe(false);
  });

  it('never draws a commit twice when the pages overlap', () => {
    const first = mergeLogPage(null, page(['a', 'b'], true), true);
    const older = mergeLogPage(first, page(['b', 'c'], false), false);
    expect(older.commits.map((item) => item.hash)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the page it was given untouched', () => {
    const first = mergeLogPage(null, page(['a'], true), true);
    const older = mergeLogPage(first, page(['b'], false), false);
    expect(first.commits.map((item) => item.hash)).toEqual(['a']);
    expect(older.commits).not.toBe(first.commits);
  });
});

describe('ref badges', () => {
  it('reads the kind of every decoration git log prints', () => {
    expect(refKind('HEAD')).toBe('head');
    expect(refKind('HEAD -> main')).toBe('head');
    expect(refKind('main')).toBe('local');
    expect(refKind('origin/main')).toBe('remote');
    expect(refKind('tag: v1.2.0')).toBe('tag');
  });

  it('drops the decorations from the name it inspects', () => {
    expect(refName('tag: v1.2.0')).toBe('v1.2.0');
    expect(refName('HEAD -> main')).toBe('main');
    expect(refName('origin/main')).toBe('origin/main');
  });
});

describe('ref picker', () => {
  it('offers every local and remote branch, local first', () => {
    expect(pickerRefs(branches(), '').map((entry) => entry.name)).toEqual([
      'main',
      'nest/a',
      'nest/b',
      'origin/main',
    ]);
  });

  it('filters by name and by upstream, case-insensitively', () => {
    expect(pickerRefs(branches(), 'NEST').map((entry) => entry.name)).toEqual(['nest/a', 'nest/b']);
    expect(pickerRefs(branches(), 'origin/')).toHaveLength(1);
    expect(pickerRefs(branches(), 'nothing')).toEqual([]);
    expect(pickerRefs(null, '')).toEqual([]);
  });

  it('keeps the worktree a branch is already checked out in', () => {
    const taken = pickerRefs(branches(), 'nest/a');
    expect(taken[0]?.worktreePath).toBe('D:/nest/a');
  });
});
