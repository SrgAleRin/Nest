import type { GitFile, GitStatus } from '@nest/shared';
import { describe, expect, it } from 'vitest';
import {
  formatGitBadge,
  nextWorkflowStatus,
  reorderIds,
  WORKFLOW_STATUS_CYCLE,
} from './WorkspaceCard';

/** The helpers have one home in the card module; the test re-exports them for callers. */
export { formatGitBadge, nextWorkflowStatus, reorderIds, WORKFLOW_STATUS_CYCLE };

function gitFile(overrides: Partial<GitFile> = {}): GitFile {
  return {
    path: 'src/a.ts',
    oldPath: null,
    copied: false,
    indexStatus: '',
    worktreeStatus: 'M',
    conflict: false,
    staged: false,
    unstaged: true,
    untracked: false,
    additions: null,
    deletions: null,
    stagedAdditions: null,
    stagedDeletions: null,
    unstagedAdditions: null,
    unstagedDeletions: null,
    ...overrides,
  };
}

function gitStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    unborn: false,
    files: [],
    ...overrides,
  };
}

describe('formatGitBadge', () => {
  it('has no badge without a status', () => {
    expect(formatGitBadge(null)).toBeNull();
    expect(formatGitBadge(undefined)).toBeNull();
  });

  it('counts unique changed paths and keeps the upstream distance', () => {
    const status = gitStatus({
      ahead: 2,
      behind: 1,
      files: [
        gitFile({ path: 'src/a.ts', staged: true, unstaged: true }),
        gitFile({ path: 'src/a.ts', staged: true }),
        gitFile({ path: 'src/b.ts', worktreeStatus: 'A' }),
      ],
    });

    expect(formatGitBadge(status)).toEqual({ files: 2, ahead: 2, behind: 1 });
  });

  it('reports zeroes for a clean worktree', () => {
    expect(formatGitBadge(gitStatus())).toEqual({ files: 0, ahead: 0, behind: 0 });
  });
});

describe('reorderIds', () => {
  it('moves an id down onto the target position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an id up onto the target position', () => {
    expect(reorderIds(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('leaves the list alone when the drag does not change the order', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderIds(ids, 'b', 'b')).toBe(ids);
    expect(reorderIds(ids, 'b', 'missing')).toBe(ids);
    expect(reorderIds(ids, 'missing', 'b')).toBe(ids);
  });

  it('never mutates the given list', () => {
    const ids = ['a', 'b', 'c'];
    reorderIds(ids, 'c', 'a');
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});

describe('nextWorkflowStatus', () => {
  it('cycles through every stage and back to todo', () => {
    expect(nextWorkflowStatus('todo')).toBe('in_progress');
    expect(nextWorkflowStatus('in_progress')).toBe('in_review');
    expect(nextWorkflowStatus('in_review')).toBe('done');
    expect(nextWorkflowStatus('done')).toBe('todo');
  });

  it('matches the cycle the workflow picker shows', () => {
    expect(WORKFLOW_STATUS_CYCLE).toEqual(['todo', 'in_progress', 'in_review', 'done']);
  });
});
