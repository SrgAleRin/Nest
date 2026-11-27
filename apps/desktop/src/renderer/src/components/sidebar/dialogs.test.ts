import { describe, expect, it } from 'vitest';
import type { GitFile, GitStatus, Project, Task } from '@nest/shared';
import { summarizeDeleteRisk } from './DeleteTaskDialog';
import { filterArchivedTasks } from './ArchivedTasksDrawer';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'nest',
    path: 'D:/GIT/nest',
    setupScript: null,
    defaultBaseRef: 'origin/main',
    sortOrder: 0,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    projectId: 'p1',
    kind: 'worktree',
    slug: 'login-form',
    title: 'Login form',
    branch: 'nest/login-form',
    baseRef: 'origin/main',
    workspacePath: 'D:/GIT/nest-worktrees/login-form',
    status: 'active',
    setupError: null,
    workflowStatus: 'todo',
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

function file(path: string): GitFile {
  return {
    path,
    oldPath: null,
    copied: false,
    indexStatus: ' ',
    worktreeStatus: 'M',
    conflict: false,
    staged: false,
    unstaged: true,
    untracked: false,
    additions: 3,
    deletions: 1,
    stagedAdditions: null,
    stagedDeletions: null,
    unstagedAdditions: 3,
    unstagedDeletions: 1,
  };
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'nest/login-form',
    upstream: 'origin/nest/login-form',
    ahead: 0,
    behind: 0,
    unborn: false,
    files: [],
    ...overrides,
  };
}

describe('summarizeDeleteRisk', () => {
  it('calls a clean worktree a plain delete and allows deleting the branch', () => {
    const risk = summarizeDeleteRisk(status(), project(), task());
    expect(risk.dirtyFiles).toEqual([]);
    expect(risk.confirmLabel).toBe('Delete worktree');
    expect(risk.canDeleteBranch).toBe(true);
    expect(risk.branchBlockedReason).toBeNull();
    expect(risk.warning).toBeNull();
    expect(risk.statusUnknown).toBe(false);
  });

  it('forces the deletion when files are uncommitted', () => {
    const dirty = [file('src/login.ts'), file('src/theme.css')];
    const risk = summarizeDeleteRisk(status({ files: dirty }), project(), task());
    expect(risk.dirtyFiles).toHaveLength(2);
    expect(risk.confirmLabel).toBe('Force delete worktree');
  });

  it('warns about local commits that are not pushed', () => {
    const risk = summarizeDeleteRisk(status({ ahead: 2 }), project(), task());
    expect(risk.unpushed).toBe(2);
    expect(risk.warning).toContain('2 local commits not pushed');
  });

  it('warns about a branch with no upstream at all', () => {
    const risk = summarizeDeleteRisk(status({ upstream: null }), project(), task());
    expect(risk.localOnlyBranch).toBe(true);
    expect(risk.warning).toContain('no upstream');
  });

  it('does not warn about a branch without commits yet', () => {
    const risk = summarizeDeleteRisk(status({ upstream: null, unborn: true }), project(), task());
    expect(risk.localOnlyBranch).toBe(false);
    expect(risk.warning).toBeNull();
  });

  it('never deletes the main checkout branch', () => {
    const risk = summarizeDeleteRisk(
      status(),
      project(),
      task({ kind: 'checkout', branch: 'main', title: 'main checkout' }),
    );
    expect(risk.canDeleteBranch).toBe(false);
    expect(risk.branchBlockedReason).toBe('The main checkout has no worktree branch to delete');
  });

  it('never deletes the project base branch', () => {
    const risk = summarizeDeleteRisk(
      status({ branch: 'origin/main' }),
      project({ defaultBaseRef: 'origin/main' }),
      task({ branch: 'origin/main' }),
    );
    expect(risk.canDeleteBranch).toBe(false);
    expect(risk.branchBlockedReason).toBe('This is the project base branch');
  });

  it('keeps the branch checkbox available when the project is gone', () => {
    const risk = summarizeDeleteRisk(status(), null, task());
    expect(risk.canDeleteBranch).toBe(true);
  });

  it('reports an unreadable status without blocking the deletion', () => {
    const risk = summarizeDeleteRisk(null, project(), task());
    expect(risk.statusUnknown).toBe(true);
    expect(risk.dirtyFiles).toEqual([]);
    expect(risk.confirmLabel).toBe('Delete worktree');
    expect(risk.warning).toBeNull();
  });
});

describe('filterArchivedTasks', () => {
  const projects = [project(), project({ id: 'p2', name: 'sidebar' })];
  const archived = [
    task({
      id: 'a1',
      projectId: 'p1',
      title: 'Login form',
      branch: 'nest/login-form',
      status: 'archived',
      archivedAt: '2026-01-02T00:00:00.000Z',
    }),
    task({
      id: 'a2',
      projectId: 'p2',
      title: 'Dialog cleanup',
      branch: 'nest/dialog-cleanup',
      status: 'archived',
      archivedAt: '2026-01-03T00:00:00.000Z',
    }),
  ];

  it('keeps every archived task for an empty query', () => {
    expect(filterArchivedTasks(archived, projects, '')).toEqual(archived);
    expect(filterArchivedTasks(archived, projects, '   ')).toEqual(archived);
  });

  it('matches the title case-insensitively', () => {
    expect(filterArchivedTasks(archived, projects, 'LOGIN')).toEqual([archived[0]]);
  });

  it('matches the branch', () => {
    expect(filterArchivedTasks(archived, projects, 'dialog-clean')).toEqual([archived[1]]);
  });

  it('matches the project name', () => {
    expect(filterArchivedTasks(archived, projects, 'sidebar')).toEqual([archived[1]]);
  });

  it('returns nothing when no field matches', () => {
    expect(filterArchivedTasks(archived, projects, 'right panel')).toEqual([]);
  });

  it('ignores a task whose project is missing from the list', () => {
    expect(filterArchivedTasks([archived[0]!], [], 'nest')).toEqual([archived[0]]);
  });
});
