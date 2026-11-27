import { describe, expect, it } from 'vitest';
import type { GitStatus, Task } from '@nest/shared';
import { branchLabel, branchSnapshot } from './branch';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    kind: 'worktree',
    slug: 'one',
    title: 'One',
    branch: 'nest/one',
    baseRef: 'main',
    workspacePath: 'C:/worktrees/one',
    status: 'active',
    setupError: null,
    workflowStatus: 'in_progress',
    pinned: false,
    sortOrder: 0,
    notes: null,
    archivedAt: null,
    unread: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function status(branch: string): GitStatus {
  return { branch, upstream: null, ahead: 0, behind: 0, unborn: false, files: [] };
}

describe('header and status bar branch', () => {
  it('shows the git branch, not the stale task mirror', () => {
    const snapshot = branchSnapshot('t1', status('feature'));
    expect(branchLabel(task({ branch: 'nest/one' }), snapshot)).toBe('feature');
  });

  it('keeps the mirror while the first read is in flight', () => {
    expect(branchLabel(task({ branch: 'nest/one' }), null)).toBe('nest/one');
  });

  it('ignores a status read for another task', () => {
    const snapshot = branchSnapshot('t2', status('other'));
    expect(branchLabel(task({ branch: 'nest/one' }), snapshot)).toBe('nest/one');
  });

  it('shows nothing without a task', () => {
    expect(branchLabel(null, branchSnapshot('t1', status('main')))).toBeNull();
  });
});
