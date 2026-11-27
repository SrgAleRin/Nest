import type { Project, Session, Task } from '@nest/shared';
import { describe, expect, it } from 'vitest';
import type { StartFailure } from './newTask';
import type { TaskOperation } from './state/taskOperations';
import {
  CREATE_GRACE_MS,
  TASK_CARD_STATUS_RANK,
  WORKFLOW_STATUS_LABELS,
  WORKFLOW_STATUS_ORDER,
  attentionRank,
  buildTaskActivitySummary,
  orderMainCheckoutFirst,
  planSidebarRows,
  sortWorkspaceItems,
  type SidebarPlanInput,
  type SidebarPlanResult,
  type SidebarRow,
  type TaskActivitySummary,
  type TaskCardStatus,
  type WorkspaceItem,
} from './sidebarPlan';
import {
  DEFAULT_SIDEBAR_FILTERS,
  DEFAULT_SIDEBAR_VIEW,
  type SidebarFilters,
  type SidebarViewState,
} from './sidebarView';

/** Every fixture is dated against this instant, so grace windows are stable. */
const NOW = Date.parse('2026-05-01T12:00:00.000Z');

function project(overrides: Partial<Project> & { id: string }): Project {
  const { id, ...rest } = overrides;
  return {
    id,
    name: id,
    path: `C:/repos/${id}`,
    setupScript: null,
    defaultBaseRef: 'main',
    sortOrder: 0,
    hidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...rest,
  };
}

function task(overrides: Partial<Task> & { id: string; projectId: string }): Task {
  const { id, projectId, ...rest } = overrides;
  return {
    id,
    projectId,
    kind: 'worktree',
    slug: id,
    title: id,
    branch: `feature/${id}`,
    baseRef: 'main',
    workspacePath: `C:/repos/${projectId}/${id}`,
    status: 'active',
    setupError: null,
    workflowStatus: 'todo',
    pinned: false,
    sortOrder: 0,
    notes: null,
    archivedAt: null,
    unread: false,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...rest,
  };
}

function session(overrides: Partial<Session> & { id: string; taskId: string }): Session {
  const { id, taskId, ...rest } = overrides;
  return {
    id,
    taskId,
    harnessId: 'claude',
    title: id,
    status: 'running',
    cwd: `C:/repos/${taskId}`,
    exitCode: null,
    harnessSessionId: null,
    resumeMode: 'exact',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...rest,
  };
}

function makeItem(
  taskOverrides: Partial<Task> & { id: string },
  sessionOverrides: Array<Partial<Session>> = [],
): WorkspaceItem {
  const built = task({ projectId: 'p1', ...taskOverrides });
  const sessions = sessionOverrides.map((overrides, index) =>
    session({ id: `${built.id}-s${index}`, taskId: built.id, ...overrides }),
  );
  return {
    task: built,
    project: project({ id: 'p1' }),
    sessions,
    summary: buildTaskActivitySummary({ task: built, sessions, unread: {}, nowMs: NOW }),
  };
}

interface SummaryInput {
  task?: Partial<Task>;
  sessions?: Session[];
  unread?: Record<string, number>;
  startFailure?: StartFailure;
  nowMs?: number;
}

function summaryFor(input: SummaryInput): TaskActivitySummary {
  const built = task({ id: 't1', projectId: 'p1', ...input.task });
  return buildTaskActivitySummary({
    task: built,
    sessions: input.sessions ?? [],
    unread: input.unread ?? {},
    startFailure: input.startFailure,
    nowMs: input.nowMs ?? NOW,
  });
}

function filters(overrides: Partial<SidebarFilters>): SidebarFilters {
  return { ...DEFAULT_SIDEBAR_FILTERS, projectIds: [], ...overrides };
}

function view(overrides: Partial<SidebarViewState>): SidebarViewState {
  return { ...DEFAULT_SIDEBAR_VIEW, filters: filters({}), ...overrides };
}

function plan(overrides: Partial<SidebarPlanInput>): SidebarPlanResult {
  return planSidebarRows({
    projects: [],
    tasks: [],
    sessions: [],
    unread: {},
    operations: [],
    startFailures: {},
    view: view({}),
    searchQuery: '',
    selectedTaskId: null,
    nowMs: NOW,
    ...overrides,
  });
}

function isCard(row: SidebarRow): row is Extract<SidebarRow, { kind: 'workspace-card' }> {
  return row.kind === 'workspace-card';
}

type GroupHeader = Extract<SidebarRow, { kind: 'group-header' }>;

function headerFor(result: SidebarPlanResult, key: string): GroupHeader | undefined {
  const row = result.rows.find(
    (candidate) => candidate.kind === 'group-header' && candidate.key === key,
  );
  return row?.kind === 'group-header' ? row : undefined;
}

function cardIds(result: SidebarPlanResult): string[] {
  return result.rows.filter(isCard).map((row) => row.item.task.id);
}

function visibleIds(result: SidebarPlanResult): string[] {
  return result.visibleItems.map((item) => item.task.id);
}

function operation(overrides: Partial<TaskOperation> & { operationId: string }): TaskOperation {
  const { operationId, ...rest } = overrides;
  return { operationId, projectId: 'p1', title: operationId, step: null, ...rest };
}

describe('constants', () => {
  it('holds a new task at its creation position for five minutes', () => {
    expect(CREATE_GRACE_MS).toBe(300_000);
    expect(CREATE_GRACE_MS).toBe(5 * 60_000);
  });

  it('orders workflow statuses by what the user acts on first', () => {
    expect(WORKFLOW_STATUS_ORDER).toEqual(['in_progress', 'in_review', 'todo', 'done']);
    expect(WORKFLOW_STATUS_LABELS).toEqual({
      todo: 'Todo',
      in_progress: 'In progress',
      in_review: 'In review',
      done: 'Done',
    });
  });

  it('ranks card statuses from failed to inactive', () => {
    expect(TASK_CARD_STATUS_RANK).toEqual({
      failed: 0,
      working: 1,
      idle: 2,
      unread: 3,
      inactive: 4,
    });
  });

  it('puts failed and unread cards above working ones in Agent Activity', () => {
    expect(attentionRank('failed')).toBe(0);
    expect(attentionRank('unread')).toBe(0);
    expect(attentionRank('working')).toBe(1);
    expect(attentionRank('idle')).toBe(2);
    expect(attentionRank('inactive')).toBe(3);
    expect(attentionRank('unread')).toBeLessThan(attentionRank('working'));
    expect(attentionRank('failed')).toBeLessThan(attentionRank('working'));
  });
});

describe('buildTaskActivitySummary', () => {
  it('marks a task failed when its harness did not start', () => {
    const summary = summaryFor({
      startFailure: { harnessId: 'claude', message: 'claude did not start: spawn failed' },
    });
    expect(summary.status).toBe('failed');
  });

  it('marks a task failed when its setup script failed', () => {
    expect(summaryFor({ task: { setupError: 'pnpm install failed' } }).status).toBe('failed');
  });

  it('marks a task failed when its newest session failed', () => {
    const summary = summaryFor({
      sessions: [
        session({
          id: 'old',
          taskId: 't1',
          status: 'exited',
          updatedAt: '2026-04-02T00:00:00.000Z',
        }),
        session({
          id: 'new',
          taskId: 't1',
          status: 'failed',
          updatedAt: '2026-04-03T00:00:00.000Z',
        }),
      ],
    });
    expect(summary.status).toBe('failed');
  });

  it('puts a working agent above an idle one and above unread output', () => {
    const summary = summaryFor({
      task: { unread: true },
      sessions: [
        session({ id: 'busy', taskId: 't1', status: 'running' }),
        session({ id: 'quiet', taskId: 't1', status: 'idle', harnessId: 'codex' }),
      ],
      unread: { busy: 2 },
    });
    expect(summary.status).toBe('working');
    expect(summary.workingCount).toBe(1);
    expect(summary.idleAgentCount).toBe(1);
    expect(summary.liveSessions).toHaveLength(2);
    expect(summary.hasUnread).toBe(true);
  });

  it('puts an idle agent above unread output', () => {
    const summary = summaryFor({
      task: { unread: true },
      sessions: [session({ id: 'quiet', taskId: 't1', status: 'idle' })],
    });
    expect(summary.status).toBe('idle');
    expect(summary.hasUnread).toBe(true);
  });

  it('does not treat a quiet shell as an idle agent', () => {
    const quietShell = summaryFor({
      sessions: [session({ id: 'shell', taskId: 't1', status: 'idle', harnessId: 'shell' })],
    });
    expect(quietShell.idleAgentCount).toBe(0);
    expect(quietShell.status).toBe('inactive');
    expect(quietShell.isInactive).toBe(false);
    expect(quietShell.agentLabel).toBe('shell');

    const unreadShell = summaryFor({
      task: { unread: true },
      sessions: [session({ id: 'shell', taskId: 't1', status: 'idle', harnessId: 'shell' })],
    });
    expect(unreadShell.status).toBe('unread');
  });

  it('sums unread output across the task sessions', () => {
    const summary = summaryFor({
      sessions: [
        session({ id: 'a', taskId: 't1', status: 'exited' }),
        session({ id: 'b', taskId: 't1', status: 'exited' }),
      ],
      unread: { a: 2, b: 3 },
    });
    expect(summary.sessionUnreadCount).toBe(5);
    expect(summary.manualUnread).toBe(false);
    expect(summary.unreadCount).toBe(5);
    expect(summary.hasUnread).toBe(true);
    expect(summary.status).toBe('unread');
  });

  it('counts a manually unread task as one when no session reported output', () => {
    const summary = summaryFor({ task: { unread: true } });
    expect(summary.sessionUnreadCount).toBe(0);
    expect(summary.manualUnread).toBe(true);
    expect(summary.unreadCount).toBe(1);
    expect(summary.hasUnread).toBe(true);
    expect(summary.status).toBe('unread');
    expect(summary.isInactive).toBe(false);
  });

  it('is inactive without live sessions and without unread output', () => {
    const summary = summaryFor({});
    expect(summary.status).toBe('inactive');
    expect(summary.isInactive).toBe(true);
    expect(summary.unreadCount).toBe(0);
    expect(summary.hasUnread).toBe(false);
    expect(summary.agentLabel).toBeNull();
    expect(summary.liveSessions).toEqual([]);
  });

  it('takes the newest of the task and its sessions as last activity', () => {
    const summary = summaryFor({
      task: {
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      sessions: [
        session({ id: 'a', taskId: 't1', updatedAt: '2026-04-03T00:00:00.000Z' }),
        session({ id: 'b', taskId: 't1', updatedAt: '2026-04-02T12:00:00.000Z' }),
      ],
    });
    expect(summary.lastActivityAt).toBe(Date.parse('2026-04-03T00:00:00.000Z'));
  });

  it('holds a freshly created task at creation time plus the grace window', () => {
    const createdAt = '2026-05-01T11:58:00.000Z';
    const summary = summaryFor({
      task: { createdAt, updatedAt: createdAt },
    });
    expect(summary.lastActivityAt).toBe(Date.parse(createdAt));
    expect(summary.effectiveRecentActivityAt).toBe(Date.parse('2026-05-01T12:03:00.000Z'));
  });

  it('leaves a task older than the grace window alone', () => {
    const createdAt = '2026-05-01T11:50:00.000Z';
    const summary = summaryFor({
      task: { createdAt, updatedAt: '2026-05-01T11:51:00.000Z' },
    });
    expect(summary.effectiveRecentActivityAt).toBe(summary.lastActivityAt);
  });

  it('labels a single live session by harness and activity', () => {
    expect(
      summaryFor({ sessions: [session({ id: 'a', taskId: 't1', status: 'running' })] }).agentLabel,
    ).toBe('claude · working');
    expect(
      summaryFor({ sessions: [session({ id: 'a', taskId: 't1', status: 'idle' })] }).agentLabel,
    ).toBe('claude · idle');
    expect(
      summaryFor({
        sessions: [session({ id: 'a', taskId: 't1', status: 'running', harnessId: 'shell' })],
      }).agentLabel,
    ).toBe('shell');
  });

  it('summarises several live sessions by count', () => {
    const twoWorking = summaryFor({
      sessions: [
        session({ id: 'a', taskId: 't1', status: 'running' }),
        session({ id: 'b', taskId: 't1', status: 'starting' }),
      ],
    });
    expect(twoWorking.agentLabel).toBe('2 working');

    const mixed = summaryFor({
      sessions: [
        session({ id: 'a', taskId: 't1', status: 'running' }),
        session({ id: 'b', taskId: 't1', status: 'idle' }),
      ],
    });
    expect(mixed.agentLabel).toBe('1 working · 1 idle');
  });
});

describe('sortWorkspaceItems', () => {
  function mixedItems(): WorkspaceItem[] {
    return [
      makeItem({ id: 'inactive' }),
      makeItem({ id: 'idle' }, [{ status: 'idle' }]),
      makeItem({ id: 'working' }, [{ status: 'running' }]),
      makeItem({ id: 'unread', unread: true }),
      makeItem({ id: 'failed', setupError: 'setup failed' }),
    ];
  }

  it('sorts Agent Activity by failed and unread, then working, idle, inactive', () => {
    const sorted = sortWorkspaceItems(mixedItems(), 'smart');
    const ids = sorted.map((item) => item.task.id);
    expect(ids.slice(0, 2).sort()).toEqual(['failed', 'unread']);
    expect(ids.slice(2)).toEqual(['working', 'idle', 'inactive']);
  });

  it('breaks Agent Activity ties by newest activity, then title', () => {
    const sorted = sortWorkspaceItems(
      [
        makeItem({ id: 'a', title: 'Bravo', setupError: 'boom' }),
        makeItem({ id: 'b', title: 'Alpha', setupError: 'boom' }),
        makeItem({
          id: 'c',
          title: 'Charlie',
          setupError: 'boom',
          updatedAt: '2026-04-09T00:00:00.000Z',
        }),
      ],
      'smart',
    );
    expect(sorted.map((item) => item.task.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts Recent by newest effective activity', () => {
    const sorted = sortWorkspaceItems(
      [
        makeItem({ id: 'old', updatedAt: '2026-04-02T00:00:00.000Z' }),
        makeItem({ id: 'new', updatedAt: '2026-04-05T00:00:00.000Z' }),
      ],
      'recent',
    );
    expect(sorted.map((item) => item.task.id)).toEqual(['new', 'old']);
  });

  it('keeps a brand new task above an older one that got background output', () => {
    const sorted = sortWorkspaceItems(
      [
        makeItem({
          id: 'old',
          createdAt: '2026-04-30T12:00:00.000Z',
          updatedAt: '2026-05-01T11:59:50.000Z',
        }),
        makeItem({
          id: 'new',
          createdAt: '2026-05-01T11:59:00.000Z',
          updatedAt: '2026-05-01T11:59:00.000Z',
        }),
      ],
      'recent',
    );
    expect(sorted.map((item) => item.task.id)).toEqual(['new', 'old']);
  });

  it('sorts by name with numeric awareness', () => {
    const sorted = sortWorkspaceItems(
      [
        makeItem({ id: 'ten', title: 'Task 10' }),
        makeItem({ id: 'two', title: 'Task 2' }),
        makeItem({ id: 'alpha', title: 'alpha' }),
      ],
      'name',
    );
    expect(sorted.map((item) => item.task.title)).toEqual(['alpha', 'Task 2', 'Task 10']);
  });

  it('sorts Manual by sortOrder, then creation time', () => {
    const sorted = sortWorkspaceItems(
      [
        makeItem({ id: 'b', sortOrder: 1, createdAt: '2026-04-02T00:00:00.000Z' }),
        makeItem({ id: 'c', sortOrder: 1, createdAt: '2026-04-01T00:00:00.000Z' }),
        makeItem({ id: 'a', sortOrder: 0 }),
      ],
      'manual',
    );
    expect(sorted.map((item) => item.task.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not reorder the input array', () => {
    const items = mixedItems();
    const before = items.map((item) => item.task.id);
    sortWorkspaceItems(items, 'smart');
    expect(items.map((item) => item.task.id)).toEqual(before);
  });
});

describe('orderMainCheckoutFirst', () => {
  it('moves the main checkout ahead of every worktree, keeping order inside each part', () => {
    const items = [
      makeItem({ id: 'w1' }),
      makeItem({ id: 'main', kind: 'checkout' }),
      makeItem({ id: 'w2' }),
      makeItem({ id: 'other-main', kind: 'checkout' }),
    ];
    expect(orderMainCheckoutFirst(items).map((item) => item.task.id)).toEqual([
      'main',
      'other-main',
      'w1',
      'w2',
    ]);
  });
});

describe('planSidebarRows', () => {
  const alpha = project({ id: 'p1', name: 'Alpha', sortOrder: 0 });
  const beta = project({ id: 'p2', name: 'Beta', sortOrder: 1 });

  const mainCheckout = task({
    id: 't-main',
    projectId: 'p1',
    kind: 'checkout',
    title: 'main checkout',
    branch: 'main',
    sortOrder: 5,
  });
  const feature = task({
    id: 't-feature',
    projectId: 'p1',
    title: 'Feature',
    sortOrder: 0,
    workflowStatus: 'in_progress',
  });
  const betaTask = task({
    id: 't-beta',
    projectId: 'p2',
    title: 'Beta task',
    workflowStatus: 'done',
  });
  const featureSession = session({ id: 's-feature', taskId: 't-feature', status: 'running' });

  const base = {
    projects: [alpha, beta],
    tasks: [mainCheckout, feature, betaTask],
    sessions: [featureSession],
  };

  it('groups by project with the main checkout first in its group', () => {
    const result = plan(base);

    const rows = result.rows;
    expect(rows[0]).toMatchObject({
      kind: 'group-header',
      key: 'project:p1',
      groupType: 'project',
      label: 'Alpha',
      count: 2,
      collapsed: false,
      activeCount: 1,
      unreadCount: 0,
      failedCount: 0,
    });
    expect(rows[1]).toMatchObject({
      kind: 'workspace-card',
      key: 'card:t-main',
      section: 'group',
      showProjectPrefix: false,
    });
    expect(rows[2]).toMatchObject({ kind: 'workspace-card', key: 'card:t-feature' });
    expect(rows[3]).toMatchObject({
      kind: 'group-header',
      key: 'project:p2',
      label: 'Beta',
      count: 1,
    });
    expect(rows[4]).toMatchObject({ kind: 'workspace-card', key: 'card:t-beta' });
    expect(cardIds(result)).toEqual(['t-main', 't-feature', 't-beta']);
    expect(visibleIds(result)).toEqual(['t-main', 't-feature', 't-beta']);
    expect(result.archivedCount).toBe(0);
    expect(result.hiddenProjects).toEqual([]);
    expect(result.activeFilterCount).toBe(0);
    expect(result.isSelectedTaskHidden).toBe(false);
    expect(result.selectedTaskHiddenReason).toBeNull();
  });

  it('shows empty projects when nothing narrows the list', () => {
    const gamma = project({ id: 'p3', name: 'Gamma', sortOrder: 2 });
    const result = plan({ ...base, projects: [...base.projects, gamma] });
    expect(headerFor(result, 'project:p3')).toMatchObject({ label: 'Gamma', count: 0 });
    expect(cardIds(result)).toEqual(['t-main', 't-feature', 't-beta']);
  });

  it('orders projects manually and by recent activity', () => {
    const manualProjects = [
      project({ id: 'p1', name: 'Alpha', sortOrder: 1 }),
      project({ id: 'p2', name: 'Beta', sortOrder: 0 }),
    ];
    const manualResult = plan({ ...base, projects: manualProjects });
    expect(
      manualResult.rows.filter((row) => row.kind === 'group-header').map((row) => row.key),
    ).toEqual(['project:p2', 'project:p1']);

    const recentResult = plan({
      ...base,
      projects: manualProjects,
      sessions: [
        session({
          id: 's-feature',
          taskId: 't-feature',
          status: 'running',
          updatedAt: '2026-04-09T00:00:00.000Z',
        }),
      ],
      view: view({ projectOrderBy: 'recent' }),
    });
    expect(
      recentResult.rows.filter((row) => row.kind === 'group-header').map((row) => row.key),
    ).toEqual(['project:p1', 'project:p2']);
  });

  it('groups by status in review-flow order and skips empty groups', () => {
    const review = task({
      id: 't-review',
      projectId: 'p1',
      title: 'Review me',
      workflowStatus: 'in_review',
    });
    const result = plan({
      ...base,
      tasks: [mainCheckout, feature, betaTask, review],
      view: view({ groupBy: 'status' }),
    });

    const headers = result.rows.filter((row) => row.kind === 'group-header');
    expect(headers.map((row) => row.key)).toEqual([
      'status:in_progress',
      'status:in_review',
      'status:todo',
      'status:done',
    ]);
    expect(headers.map((row) => (row.kind === 'group-header' ? row.label : ''))).toEqual([
      'In progress',
      'In review',
      'Todo',
      'Done',
    ]);
    expect(headers[0]).toMatchObject({ groupType: 'status', workflowStatus: 'in_progress' });
    expect(
      result.rows
        .filter(isCard)
        .map((row) => [row.item.task.id, row.section, row.showProjectPrefix]),
    ).toEqual([
      ['t-feature', 'group', true],
      ['t-review', 'group', true],
      ['t-main', 'group', true],
      ['t-beta', 'group', true],
    ]);
  });

  it('renders a flat list without headers', () => {
    const result = plan({ ...base, view: view({ groupBy: 'none' }) });
    expect(result.rows.every(isCard)).toBe(true);
    expect(result.rows.filter(isCard).map((row) => row.section)).toEqual(['flat', 'flat', 'flat']);
    expect(cardIds(result)).toEqual(['t-feature', 't-beta', 't-main']);
  });

  it('collects pinned tasks into their own section without duplicates', () => {
    const pinned = task({
      id: 't-pinned',
      projectId: 'p1',
      title: 'Pinned feature',
      pinned: true,
    });
    const result = plan({ ...base, tasks: [mainCheckout, feature, betaTask, pinned] });

    expect(result.rows[0]).toMatchObject({
      kind: 'pinned-header',
      key: 'pinned',
      count: 1,
      collapsed: false,
    });
    expect(result.rows[1]).toMatchObject({
      kind: 'workspace-card',
      key: 'card:t-pinned',
      section: 'pinned',
      showProjectPrefix: true,
    });
    expect(cardIds(result).filter((id) => id === 't-pinned')).toHaveLength(1);
    expect(headerFor(result, 'project:p1')).toMatchObject({ count: 2 });
    expect(visibleIds(result)).toEqual(['t-pinned', 't-main', 't-feature', 't-beta']);

    const statusResult = plan({
      ...base,
      tasks: [mainCheckout, feature, betaTask, pinned],
      view: view({ groupBy: 'status' }),
    });
    expect(cardIds(statusResult).filter((id) => id === 't-pinned')).toHaveLength(1);
  });

  it('keeps a collapsed project group folded but reports its badges', () => {
    const unreadTask = task({ id: 't-unread', projectId: 'p1', title: 'Unread', unread: true });
    const failedTask = task({
      id: 't-fail',
      projectId: 'p1',
      title: 'Broken',
      setupError: 'pnpm install failed',
    });
    const result = plan({
      projects: [alpha],
      tasks: [mainCheckout, feature, unreadTask, failedTask],
      sessions: [featureSession],
      view: view({ collapsedGroups: { 'project:p1': true } }),
    });

    expect(headerFor(result, 'project:p1')).toMatchObject({
      count: 4,
      collapsed: true,
      activeCount: 1,
      unreadCount: 1,
      failedCount: 1,
    });
    expect(result.rows.some(isCard)).toBe(false);
    expect(visibleIds(result)).toEqual(['t-main', 't-fail', 't-unread', 't-feature']);
  });

  it('temporarily expands a collapsed group while searching', () => {
    const result = plan({
      ...base,
      view: view({ collapsedGroups: { 'project:p1': true } }),
      searchQuery: '  main checkout  ',
    });

    expect(headerFor(result, 'project:p1')).toMatchObject({ collapsed: false, count: 1 });
    expect(cardIds(result)).toEqual(['t-main']);
    expect(result.rows.some((row) => row.kind === 'group-header' && row.key === 'project:p2')).toBe(
      false,
    );
  });

  it('counts archived tasks and collects hidden projects', () => {
    const hiddenProject = project({ id: 'p2', name: 'Beta', sortOrder: 1, hidden: true });
    const archived = task({
      id: 't-archived',
      projectId: 'p1',
      title: 'Archived',
      status: 'archived',
      archivedAt: '2026-04-10T00:00:00.000Z',
    });
    const result = plan({
      projects: [alpha, hiddenProject],
      tasks: [mainCheckout, feature, betaTask, archived],
      sessions: [featureSession],
    });

    expect(result.archivedCount).toBe(1);
    expect(result.hiddenProjects.map((item) => item.id)).toEqual(['p2']);
    expect(cardIds(result)).toEqual(['t-main', 't-feature']);
  });

  it('applies the project filter', () => {
    const result = plan({ ...base, view: view({ filters: filters({ projectIds: ['p2'] }) }) });
    expect(cardIds(result)).toEqual(['t-beta']);
    expect(headerFor(result, 'project:p1')).toBeUndefined();
    expect(result.activeFilterCount).toBe(1);
  });

  it('hides the main checkout when asked', () => {
    const result = plan({ ...base, view: view({ filters: filters({ hideMainCheckout: true }) }) });
    expect(cardIds(result)).toEqual(['t-feature', 't-beta']);
    expect(result.activeFilterCount).toBe(1);
  });

  it('hides inactive worktrees but keeps the inactive main checkout by default', () => {
    const result = plan({
      ...base,
      tasks: [...base.tasks, task({ id: 't-idle', projectId: 'p2', title: 'Quiet' })],
      view: view({ filters: filters({ hideInactive: true }) }),
    });
    expect(cardIds(result)).toEqual(['t-main', 't-feature']);
    expect(result.activeFilterCount).toBe(1);
  });

  it('hides the inactive main checkout too when exceptMainCheckout is off', () => {
    const result = plan({
      ...base,
      view: view({ filters: filters({ hideInactive: true, exceptMainCheckout: false }) }),
    });
    expect(cardIds(result)).toEqual(['t-feature']);
  });

  it('searches title, branch, project, notes, session title and harness', () => {
    const widget = project({ id: 'p3', name: 'Widget', sortOrder: 2 });
    const tasks = [
      task({ id: 't-title', projectId: 'p1', title: 'Nightly build' }),
      task({ id: 't-branch', projectId: 'p1', branch: 'feat/parsing' }),
      task({ id: 't-notes', projectId: 'p1', notes: 'needs design review' }),
      task({ id: 't-project', projectId: 'p3' }),
    ];
    const sessions = [
      session({ id: 's-title', taskId: 't-title', title: 'Refactor pass', harnessId: 'codex' }),
    ];
    const search = (searchQuery: string): string[] =>
      visibleIds(plan({ projects: [alpha, widget], tasks, sessions, searchQuery }));

    expect(search('nightly')).toEqual(['t-title']);
    expect(search('parsing')).toEqual(['t-branch']);
    expect(search('design')).toEqual(['t-notes']);
    expect(search('widget')).toEqual(['t-project']);
    expect(search('refactor')).toEqual(['t-title']);
    expect(search('codex')).toEqual(['t-title']);
  });

  it('reports why the selected task is hidden', () => {
    const bySearch = plan({
      ...base,
      searchQuery: 'nothing matches this',
      selectedTaskId: 't-feature',
    });
    expect(bySearch.isSelectedTaskHidden).toBe(true);
    expect(bySearch.selectedTaskHiddenReason).toBe('search');

    const byFilters = plan({
      ...base,
      selectedTaskId: 't-feature',
      view: view({ filters: filters({ projectIds: ['p2'] }) }),
    });
    expect(byFilters.isSelectedTaskHidden).toBe(true);
    expect(byFilters.selectedTaskHiddenReason).toBe('filters');

    const byBoth = plan({
      ...base,
      searchQuery: 'zzz',
      selectedTaskId: 't-feature',
      view: view({ filters: filters({ projectIds: ['p2'] }) }),
    });
    expect(byBoth.selectedTaskHiddenReason).toBe('both');

    const visible = plan({ ...base, searchQuery: 'Feature', selectedTaskId: 't-feature' });
    expect(visible.isSelectedTaskHidden).toBe(false);
    expect(visible.selectedTaskHiddenReason).toBeNull();
  });

  it('does not report an archived or hidden-project selection as search-hidden', () => {
    const archived = task({ id: 't-archived', projectId: 'p1', status: 'archived' });
    const hiddenProject = project({ id: 'p2', name: 'Beta', hidden: true });
    const result = plan({
      projects: [alpha, hiddenProject],
      tasks: [mainCheckout, archived, betaTask],
      searchQuery: 'zzz',
      selectedTaskId: 't-archived',
    });
    expect(result.selectedTaskHiddenReason).toBeNull();
    expect(result.isSelectedTaskHidden).toBe(false);
  });

  it('places pending creations inside their project group', () => {
    const result = plan({
      ...base,
      operations: [
        operation({ operationId: 'op-1', projectId: 'p1', title: 'Brand new' }),
        operation({ operationId: 'op-2', projectId: 'p2' }),
      ],
    });
    const kinds = result.rows.map((row) => row.kind);
    expect(kinds).toEqual([
      'group-header',
      'pending-task',
      'workspace-card',
      'workspace-card',
      'group-header',
      'pending-task',
      'workspace-card',
    ]);
    const pending = result.rows.find((row) => row.kind === 'pending-task');
    expect(pending).toMatchObject({ key: 'pending:op-1' });
  });

  it('emits pending creations first in status and flat grouping', () => {
    const ops = [operation({ operationId: 'op-1', projectId: 'p2' })];
    const statusRows = plan({ ...base, operations: ops, view: view({ groupBy: 'status' }) }).rows;
    expect(statusRows[0]).toMatchObject({ kind: 'pending-task', key: 'pending:op-1' });

    const flatRows = plan({ ...base, operations: ops, view: view({ groupBy: 'none' }) }).rows;
    expect(flatRows[0]).toMatchObject({ kind: 'pending-task', key: 'pending:op-1' });
  });

  it('shows a project that only has a pending creation', () => {
    const gamma = project({ id: 'p3', name: 'Gamma', sortOrder: 2 });
    const result = plan({
      ...base,
      projects: [...base.projects, gamma],
      operations: [operation({ operationId: 'op-3', projectId: 'p3' })],
      view: view({ filters: filters({ projectIds: ['p3'] }) }),
    });
    expect(headerFor(result, 'project:p3')).toMatchObject({ label: 'Gamma', count: 0 });
    expect(result.rows.filter((row) => row.kind === 'pending-task')).toHaveLength(1);
  });

  it('drops pending creations of hidden projects', () => {
    const hiddenProject = project({ id: 'p2', name: 'Beta', hidden: true });
    const result = plan({
      projects: [alpha, hiddenProject],
      tasks: [mainCheckout, betaTask],
      operations: [operation({ operationId: 'op-2', projectId: 'p2' })],
    });
    expect(result.rows.some((row) => row.kind === 'pending-task')).toBe(false);
  });

  it('marks a failed task from startFailures', () => {
    const result = plan({
      ...base,
      startFailures: { 't-feature': { harnessId: 'claude', message: 'boom' } },
    });
    expect(headerFor(result, 'project:p1')).toMatchObject({ failedCount: 1, activeCount: 0 });
  });

  it('counts unread across a group', () => {
    const unreadTask = task({ id: 't-unread', projectId: 'p1', unread: true });
    const result = plan({
      projects: [alpha],
      tasks: [mainCheckout, unreadTask],
      sessions: [session({ id: 's1', taskId: 't-main', status: 'exited' })],
      unread: { s1: 2 },
    });
    expect(headerFor(result, 'project:p1')).toMatchObject({ unreadCount: 3 });
  });
});

describe('TaskCardStatus typing', () => {
  it('covers every status rank', () => {
    const statuses: TaskCardStatus[] = ['failed', 'working', 'idle', 'unread', 'inactive'];
    expect(statuses.map((status) => TASK_CARD_STATUS_RANK[status])).toEqual([0, 1, 2, 3, 4]);
  });
});
