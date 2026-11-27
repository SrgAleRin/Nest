import type { Project, Session, Task, TaskWorkflowStatus } from '@nest/shared';
import type { StartFailure } from './newTask';
import type { TaskOperation, TaskOperations } from './state/taskOperations';
import {
  activeFilterCount,
  type SidebarProjectOrderBy,
  type SidebarSortBy,
  type SidebarViewState,
} from './sidebarView';

/**
 * A task created seconds ago has no session output yet, so a plain
 * `updatedAt` comparison would sink it below older tasks that merely received
 * background output. Within this window a new task keeps the position its
 * creation deserves.
 */
export const CREATE_GRACE_MS = 5 * 60_000;

/** Review flow order in the `Status` grouping; the one the user acts on first. */
export const WORKFLOW_STATUS_ORDER: readonly TaskWorkflowStatus[] = [
  'in_progress',
  'in_review',
  'todo',
  'done',
];

export const WORKFLOW_STATUS_LABELS: Record<TaskWorkflowStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

/** What a task card leads with; the first matching kind wins. */
export type TaskCardStatus = 'failed' | 'working' | 'idle' | 'unread' | 'inactive';

/** Severity of a card status, used for plain ranking and stable ties. */
export const TASK_CARD_STATUS_RANK: Record<TaskCardStatus, number> = {
  failed: 0,
  working: 1,
  idle: 2,
  unread: 3,
  inactive: 4,
};

/**
 * Everything a card and its group badges need to know about a task's agent
 * activity. Derived once per task, never recomputed in the render pass.
 */
export interface TaskActivitySummary {
  status: TaskCardStatus;
  /** Sessions that still own a process: `starting`, `running` or `idle`. */
  liveSessions: Session[];
  /** `starting` + `running` sessions. */
  workingCount: number;
  /** `idle` sessions driven by an agent; a quiet shell is not waiting on anyone. */
  idleAgentCount: number;
  /** Unread output reported per session. */
  sessionUnreadCount: number;
  /** The task-level "new activity" flag the user set or that a watcher raised. */
  manualUnread: boolean;
  /** Badge number: session unread output, or 1 for a manually unread task. */
  unreadCount: number;
  hasUnread: boolean;
  isInactive: boolean;
  /** Newest of the task and its sessions, in ms. */
  lastActivityAt: number;
  /**
   * `lastActivityAt`, but a task created inside `CREATE_GRACE_MS` is held at
   * least at its creation time plus the window.
   */
  effectiveRecentActivityAt: number;
  /** `claude · working`, `2 working · 1 idle`, `shell`, or null without sessions. */
  agentLabel: string | null;
}

/** A task as the sidebar shows it: task, its project, its sessions, its activity. */
export interface WorkspaceItem {
  task: Task;
  project: Project;
  sessions: Session[];
  summary: TaskActivitySummary;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Milliseconds for an ISO timestamp; unparseable values sort as the epoch. */
function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isLiveStatus(status: Session['status']): boolean {
  return status === 'starting' || status === 'running' || status === 'idle';
}

function isWorkingStatus(status: Session['status']): boolean {
  return status === 'starting' || status === 'running';
}

function agentLabelFor(liveSessions: Session[], workingCount: number): string | null {
  if (liveSessions.length === 0) return null;

  const idleCount = liveSessions.filter((session) => session.status === 'idle').length;

  if (liveSessions.length === 1) {
    const session = liveSessions[0];
    if (!session) return null;
    const harness = session.harnessId.toLowerCase();
    if (session.harnessId === 'shell') return harness;
    return `${harness} · ${session.status === 'idle' ? 'idle' : 'working'}`;
  }

  const parts: string[] = [];
  if (workingCount > 0) parts.push(`${workingCount} working`);
  if (idleCount > 0) parts.push(`${idleCount} idle`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Card status and badges for one task.
 *
 * Priority is `failed > working > idle > unread > inactive`: a broken start
 * outranks everything, a live agent outranks unread output, and a task with no
 * live session and no unread output is inactive.
 */
export function buildTaskActivitySummary(input: {
  task: Task;
  sessions: Session[];
  unread: Record<string, number>;
  startFailure?: StartFailure;
  nowMs?: number;
}): TaskActivitySummary {
  const nowMs = input.nowMs ?? Date.now();
  const { task, sessions } = input;

  const liveSessions = sessions.filter((session) => isLiveStatus(session.status));
  const workingCount = liveSessions.filter((session) => isWorkingStatus(session.status)).length;
  const idleAgentCount = liveSessions.filter(
    (session) => session.status === 'idle' && session.harnessId !== 'shell',
  ).length;

  const sessionUnreadCount = sessions.reduce(
    (sum, session) => sum + (input.unread[session.id] ?? 0),
    0,
  );
  const manualUnread = task.unread;
  const hasUnread = sessionUnreadCount > 0 || manualUnread;
  const unreadCount = sessionUnreadCount > 0 ? sessionUnreadCount : manualUnread ? 1 : 0;

  let latestSession: Session | null = null;
  for (const session of sessions) {
    if (!latestSession || timeOf(session.updatedAt) > timeOf(latestSession.updatedAt)) {
      latestSession = session;
    }
  }

  const isFailed =
    Boolean(input.startFailure) || Boolean(task.setupError) || latestSession?.status === 'failed';

  const status: TaskCardStatus = isFailed
    ? 'failed'
    : workingCount > 0
      ? 'working'
      : idleAgentCount > 0
        ? 'idle'
        : hasUnread
          ? 'unread'
          : 'inactive';

  const isInactive = liveSessions.length === 0 && !hasUnread;

  let lastActivityAt = Math.max(timeOf(task.createdAt), timeOf(task.updatedAt));
  for (const session of sessions) {
    lastActivityAt = Math.max(lastActivityAt, timeOf(session.updatedAt));
  }

  const createdAtMs = timeOf(task.createdAt);
  const inCreateGrace = createdAtMs > 0 && nowMs - createdAtMs < CREATE_GRACE_MS;
  const effectiveRecentActivityAt = inCreateGrace
    ? Math.max(lastActivityAt, createdAtMs + CREATE_GRACE_MS)
    : lastActivityAt;

  return {
    status,
    liveSessions,
    workingCount,
    idleAgentCount,
    sessionUnreadCount,
    manualUnread,
    unreadCount,
    hasUnread,
    isInactive,
    lastActivityAt,
    effectiveRecentActivityAt,
    agentLabel: agentLabelFor(liveSessions, workingCount),
  };
}

/**
 * `Agent Activity` rank: what needs the user first.
 *
 * Failed and unread cards come before working ones — a finished or broken task
 * is waiting on a decision, while a working agent needs nothing yet.
 */
export function attentionRank(status: TaskCardStatus): number {
  switch (status) {
    case 'failed':
    case 'unread':
      return 0;
    case 'working':
      return 1;
    case 'idle':
      return 2;
    case 'inactive':
      return 3;
  }
}

function compareTitle(left: WorkspaceItem, right: WorkspaceItem): number {
  return collator.compare(left.task.title, right.task.title);
}

function compareRecent(left: WorkspaceItem, right: WorkspaceItem): number {
  return right.summary.effectiveRecentActivityAt - left.summary.effectiveRecentActivityAt;
}

/** Sorts a copy of `items`; the input array is never reordered in place. */
export function sortWorkspaceItems(items: WorkspaceItem[], sortBy: SidebarSortBy): WorkspaceItem[] {
  const sorted = [...items];
  switch (sortBy) {
    case 'smart':
      sorted.sort(
        (left, right) =>
          attentionRank(left.summary.status) - attentionRank(right.summary.status) ||
          compareRecent(left, right) ||
          compareTitle(left, right),
      );
      break;
    case 'recent':
      sorted.sort((left, right) => compareRecent(left, right) || compareTitle(left, right));
      break;
    case 'name':
      sorted.sort(compareTitle);
      break;
    case 'manual':
      sorted.sort(
        (left, right) =>
          left.task.sortOrder - right.task.sortOrder ||
          timeOf(left.task.createdAt) - timeOf(right.task.createdAt),
      );
      break;
  }
  return sorted;
}

/**
 * The main checkout is where the user works by hand: it leads its project
 * group whatever the sort does with the rest. Order inside each partition is
 * preserved.
 */
export function orderMainCheckoutFirst(items: WorkspaceItem[]): WorkspaceItem[] {
  const checkouts: WorkspaceItem[] = [];
  const worktrees: WorkspaceItem[] = [];
  for (const item of items) {
    if (item.task.kind === 'checkout') checkouts.push(item);
    else worktrees.push(item);
  }
  return [...checkouts, ...worktrees];
}

/** One row of the sidebar: a header, a pending creation, or a task card. */
export type SidebarRow =
  | {
      kind: 'pinned-header';
      key: 'pinned';
      count: number;
      collapsed: boolean;
      activeCount: number;
      unreadCount: number;
      failedCount: number;
    }
  | {
      kind: 'group-header';
      key: string;
      groupType: 'project' | 'status';
      project?: Project;
      workflowStatus?: TaskWorkflowStatus;
      label: string;
      count: number;
      collapsed: boolean;
      activeCount: number;
      unreadCount: number;
      failedCount: number;
    }
  | { kind: 'pending-task'; key: string; operation: TaskOperation }
  | {
      kind: 'workspace-card';
      key: string;
      item: WorkspaceItem;
      section: 'pinned' | 'group' | 'flat';
      showProjectPrefix: boolean;
    };

export interface SidebarPlanResult {
  rows: SidebarRow[];
  /** Items that survived filters and search, in display order, folded or not. */
  visibleItems: WorkspaceItem[];
  archivedCount: number;
  hiddenProjects: Project[];
  activeFilterCount: number;
  isSelectedTaskHidden: boolean;
  selectedTaskHiddenReason: 'search' | 'filters' | 'both' | null;
}

export interface SidebarPlanInput {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  /** Session id → unread output count. */
  unread: Record<string, number>;
  /** Creations in flight, shown as pending rows until they settle. */
  operations?: TaskOperations;
  /** Task id → why its harness did not start after the task was created. */
  startFailures?: Record<string, StartFailure>;
  view: SidebarViewState;
  searchQuery: string;
  selectedTaskId: string | null;
  nowMs?: number;
}

interface GroupBadges {
  activeCount: number;
  unreadCount: number;
  failedCount: number;
}

/** Badges count every item of a group, collapsed or not. */
function groupBadges(items: WorkspaceItem[]): GroupBadges {
  let activeCount = 0;
  let unreadCount = 0;
  let failedCount = 0;
  for (const item of items) {
    const status = item.summary.status;
    if (status === 'working' || status === 'idle') activeCount += 1;
    if (status === 'failed') failedCount += 1;
    unreadCount += item.summary.unreadCount;
  }
  return { activeCount, unreadCount, failedCount };
}

function orderProjects(
  projects: Project[],
  items: WorkspaceItem[],
  orderBy: SidebarProjectOrderBy,
): Project[] {
  const recentByProject = new Map<string, number>();
  for (const item of items) {
    const current = recentByProject.get(item.task.projectId) ?? 0;
    recentByProject.set(
      item.task.projectId,
      Math.max(current, item.summary.effectiveRecentActivityAt),
    );
  }

  const sorted = [...projects];
  sorted.sort((left, right) => {
    if (orderBy === 'recent') {
      const recent = (recentByProject.get(right.id) ?? 0) - (recentByProject.get(left.id) ?? 0);
      if (recent !== 0) return recent;
    }
    const order = left.sortOrder - right.sortOrder;
    if (order !== 0) return order;
    return collator.compare(left.name, right.name);
  });
  return sorted;
}

/**
 * Turns projects, tasks, sessions and the view settings into the flat row list
 * the sidebar renders. Pure and deterministic: no React, no time-of-day reads
 * beyond the injected `nowMs`.
 */
export function planSidebarRows(input: SidebarPlanInput): SidebarPlanResult {
  const nowMs = input.nowMs ?? Date.now();
  const view = input.view;
  const filters = view.filters;
  const searchQuery = input.searchQuery.trim().toLowerCase();
  const hasSearch = searchQuery.length > 0;

  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const sessionsByTask = new Map<string, Session[]>();
  for (const session of input.sessions) {
    const list = sessionsByTask.get(session.taskId);
    if (list) list.push(session);
    else sessionsByTask.set(session.taskId, [session]);
  }

  let archivedCount = 0;
  const candidates: WorkspaceItem[] = [];
  for (const task of input.tasks) {
    if (task.status === 'archived') {
      archivedCount += 1;
      continue;
    }
    const project = projectsById.get(task.projectId);
    if (!project || project.hidden) continue;
    const taskSessions = sessionsByTask.get(task.id) ?? [];
    candidates.push({
      task,
      project,
      sessions: taskSessions,
      summary: buildTaskActivitySummary({
        task,
        sessions: taskSessions,
        unread: input.unread,
        startFailure: input.startFailures?.[task.id],
        nowMs,
      }),
    });
  }

  const hiddenProjects = input.projects.filter((project) => project.hidden);

  const matchesSearch = (item: WorkspaceItem): boolean => {
    if (!hasSearch) return true;
    if (item.task.title.toLowerCase().includes(searchQuery)) return true;
    if (item.task.branch.toLowerCase().includes(searchQuery)) return true;
    if (item.project.name.toLowerCase().includes(searchQuery)) return true;
    if ((item.task.notes ?? '').toLowerCase().includes(searchQuery)) return true;
    return item.sessions.some(
      (session) =>
        session.title.toLowerCase().includes(searchQuery) ||
        session.harnessId.toLowerCase().includes(searchQuery),
    );
  };

  const passesFilters = (item: WorkspaceItem): boolean => {
    if (filters.projectIds.length > 0 && !filters.projectIds.includes(item.task.projectId)) {
      return false;
    }
    if (filters.hideMainCheckout && item.task.kind === 'checkout') return false;
    if (filters.hideInactive && item.summary.isInactive) {
      const keptCheckout = filters.exceptMainCheckout && item.task.kind === 'checkout';
      if (!keptCheckout) return false;
    }
    return true;
  };

  let selectedTaskHiddenReason: SidebarPlanResult['selectedTaskHiddenReason'] = null;
  if (input.selectedTaskId) {
    const selected = candidates.find((item) => item.task.id === input.selectedTaskId);
    if (selected) {
      const hiddenByFilters = !passesFilters(selected);
      const hiddenBySearch = !matchesSearch(selected);
      if (hiddenByFilters && hiddenBySearch) selectedTaskHiddenReason = 'both';
      else if (hiddenBySearch) selectedTaskHiddenReason = 'search';
      else if (hiddenByFilters) selectedTaskHiddenReason = 'filters';
    }
  }

  const pendingOperations = (input.operations ?? []).filter((operation) => {
    const project = projectsById.get(operation.projectId);
    if (!project || project.hidden) return false;
    return filters.projectIds.length === 0 || filters.projectIds.includes(operation.projectId);
  });
  const pendingFor = (projectId: string): TaskOperation[] =>
    pendingOperations.filter((operation) => operation.projectId === projectId);

  const items = candidates.filter((item) => passesFilters(item) && matchesSearch(item));
  const pinnedItems = sortWorkspaceItems(
    items.filter((item) => item.task.pinned === true),
    view.sortBy,
  );
  const unpinnedItems = items.filter((item) => item.task.pinned !== true);

  const rows: SidebarRow[] = [];
  const visibleItems: WorkspaceItem[] = [];

  const pushPending = (operations: TaskOperation[]): void => {
    for (const operation of operations) {
      rows.push({
        kind: 'pending-task',
        key: `pending:${operation.operationId}`,
        operation,
      });
    }
  };

  const pushCards = (
    groupItems: WorkspaceItem[],
    section: 'pinned' | 'group' | 'flat',
    showProjectPrefix: boolean,
  ): void => {
    for (const item of groupItems) {
      rows.push({
        kind: 'workspace-card',
        key: `card:${item.task.id}`,
        item,
        section,
        showProjectPrefix,
      });
    }
  };

  if (pinnedItems.length > 0) {
    const collapsed = hasSearch ? false : view.collapsedGroups.pinned === true;
    rows.push({
      kind: 'pinned-header',
      key: 'pinned',
      count: pinnedItems.length,
      collapsed,
      ...groupBadges(pinnedItems),
    });
    visibleItems.push(...pinnedItems);
    if (!collapsed) pushCards(pinnedItems, 'pinned', true);
  }

  if (view.groupBy === 'project') {
    const showEmptyProjects = !hasSearch && activeFilterCount(filters) === 0;
    const groupProjects = input.projects.filter((project) => {
      if (project.hidden) return false;
      if (pendingFor(project.id).length > 0) return true;
      if (unpinnedItems.some((item) => item.task.projectId === project.id)) return true;
      return showEmptyProjects;
    });

    for (const project of orderProjects(groupProjects, unpinnedItems, view.projectOrderBy)) {
      const projectItems = orderMainCheckoutFirst(
        sortWorkspaceItems(
          unpinnedItems.filter((item) => item.task.projectId === project.id),
          view.sortBy,
        ),
      );
      const key = `project:${project.id}`;
      const collapsed = hasSearch ? false : view.collapsedGroups[key] === true;
      rows.push({
        kind: 'group-header',
        key,
        groupType: 'project',
        project,
        label: project.name,
        count: projectItems.length,
        collapsed,
        ...groupBadges(projectItems),
      });
      visibleItems.push(...projectItems);
      if (collapsed) continue;
      pushPending(pendingFor(project.id));
      pushCards(projectItems, 'group', false);
    }
  } else if (view.groupBy === 'status') {
    pushPending(pendingOperations);
    for (const status of WORKFLOW_STATUS_ORDER) {
      const statusItems = sortWorkspaceItems(
        unpinnedItems.filter((item) => item.task.workflowStatus === status),
        view.sortBy,
      );
      if (statusItems.length === 0) continue;
      const key = `status:${status}`;
      const collapsed = hasSearch ? false : view.collapsedGroups[key] === true;
      rows.push({
        kind: 'group-header',
        key,
        groupType: 'status',
        workflowStatus: status,
        label: WORKFLOW_STATUS_LABELS[status],
        count: statusItems.length,
        collapsed,
        ...groupBadges(statusItems),
      });
      visibleItems.push(...statusItems);
      if (!collapsed) pushCards(statusItems, 'group', true);
    }
  } else {
    pushPending(pendingOperations);
    const flatItems = sortWorkspaceItems(unpinnedItems, view.sortBy);
    visibleItems.push(...flatItems);
    pushCards(flatItems, 'flat', true);
  }

  return {
    rows,
    visibleItems,
    archivedCount,
    hiddenProjects,
    activeFilterCount: activeFilterCount(filters),
    isSelectedTaskHidden: selectedTaskHiddenReason !== null,
    selectedTaskHiddenReason,
  };
}
