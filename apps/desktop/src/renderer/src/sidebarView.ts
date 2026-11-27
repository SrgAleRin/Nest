import type { Task } from '@nest/shared';

/**
 * Sidebar view settings: how the task list is grouped, sorted and filtered.
 *
 * The settings are a local UI preference (`localStorage`), not a project or
 * task property, so they never travel through the RPC layer or SQLite.
 */
export const SIDEBAR_VIEW_STORAGE_KEY = 'nest.sidebarView';

export type SidebarGroupBy = 'project' | 'status' | 'none';
export type SidebarSortBy = 'smart' | 'recent' | 'name' | 'manual';
export type SidebarProjectOrderBy = 'manual' | 'recent';
export type SidebarCardLayout = 'detailed' | 'compact';

/** Which facts a task card shows; every one is on by default. */
export interface SidebarShownProperties {
  branch: boolean;
  gitChanges: boolean;
  agentActivity: boolean;
  notes: boolean;
}

/** Filter rules; `projectIds` is empty when every project is shown. */
export interface SidebarFilters {
  projectIds: string[];
  hideInactive: boolean;
  /**
   * `hideInactive` keeps the main checkout of each project: it is where the
   * user works by hand, so hiding it by accident feels like a lost task.
   */
  exceptMainCheckout: boolean;
  hideMainCheckout: boolean;
}

export interface SidebarViewState {
  groupBy: SidebarGroupBy;
  sortBy: SidebarSortBy;
  projectOrderBy: SidebarProjectOrderBy;
  cardLayout: SidebarCardLayout;
  shownProperties: SidebarShownProperties;
  /** Group keys the user folded; a missing key means expanded. */
  collapsedGroups: Record<string, boolean>;
  filters: SidebarFilters;
}

export const DEFAULT_SIDEBAR_FILTERS: SidebarFilters = {
  projectIds: [],
  hideInactive: false,
  exceptMainCheckout: true,
  hideMainCheckout: false,
};

export const DEFAULT_SIDEBAR_SHOWN_PROPERTIES: SidebarShownProperties = {
  branch: true,
  gitChanges: true,
  agentActivity: true,
  notes: true,
};

export const DEFAULT_SIDEBAR_VIEW: SidebarViewState = {
  groupBy: 'project',
  sortBy: 'smart',
  projectOrderBy: 'manual',
  cardLayout: 'detailed',
  shownProperties: DEFAULT_SIDEBAR_SHOWN_PROPERTIES,
  collapsedGroups: {},
  filters: DEFAULT_SIDEBAR_FILTERS,
};

const GROUP_BY_VALUES: readonly SidebarGroupBy[] = ['project', 'status', 'none'];
const SORT_BY_VALUES: readonly SidebarSortBy[] = ['smart', 'recent', 'name', 'manual'];
const PROJECT_ORDER_BY_VALUES: readonly SidebarProjectOrderBy[] = ['manual', 'recent'];
const CARD_LAYOUT_VALUES: readonly SidebarCardLayout[] = ['detailed', 'compact'];

/** The subset of `Storage` the preference needs. */
export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface SidebarViewShape {
  groupBy: SidebarGroupBy;
  sortBy: SidebarSortBy;
  projectOrderBy: SidebarProjectOrderBy;
  cardLayout: SidebarCardLayout;
  shownProperties: SidebarShownProperties;
  collapsedGroups: Record<string, boolean>;
  filters: SidebarFilters;
}

/**
 * A stored preference, or `null` when the value is missing, malformed or not an
 * object. A single bad field is not a reason to lose the other settings: it
 * falls back to its default instead.
 */
export function parseSidebarView(raw: string | null): SidebarViewState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const shownProperties = record.shownProperties;
  const filters = record.filters;

  return {
    groupBy: asEnum(record.groupBy, GROUP_BY_VALUES, DEFAULT_SIDEBAR_VIEW.groupBy),
    sortBy: asEnum(record.sortBy, SORT_BY_VALUES, DEFAULT_SIDEBAR_VIEW.sortBy),
    projectOrderBy: asEnum(
      record.projectOrderBy,
      PROJECT_ORDER_BY_VALUES,
      DEFAULT_SIDEBAR_VIEW.projectOrderBy,
    ),
    cardLayout: asEnum(record.cardLayout, CARD_LAYOUT_VALUES, DEFAULT_SIDEBAR_VIEW.cardLayout),
    shownProperties: parseShownProperties(shownProperties),
    collapsedGroups: parseCollapsedGroups(record.collapsedGroups),
    filters: parseFilters(filters),
  };
}

export function serializeSidebarView(view: SidebarViewState): string {
  const shape: SidebarViewShape = {
    groupBy: view.groupBy,
    sortBy: view.sortBy,
    projectOrderBy: view.projectOrderBy,
    cardLayout: view.cardLayout,
    shownProperties: {
      branch: view.shownProperties.branch,
      gitChanges: view.shownProperties.gitChanges,
      agentActivity: view.shownProperties.agentActivity,
      notes: view.shownProperties.notes,
    },
    collapsedGroups: { ...view.collapsedGroups },
    filters: {
      projectIds: [...view.filters.projectIds],
      hideInactive: view.filters.hideInactive,
      exceptMainCheckout: view.filters.exceptMainCheckout,
      hideMainCheckout: view.filters.hideMainCheckout,
    },
  };
  return JSON.stringify(shape);
}

/** Reads the stored view; anything unusable falls back to the defaults. */
export function readSidebarView(storage: SidebarStorage | null): SidebarViewState {
  const stored = storage ? parseSidebarView(safeGet(storage)) : null;
  return stored ?? copySidebarView(DEFAULT_SIDEBAR_VIEW);
}

export function writeSidebarView(storage: SidebarStorage | null, view: SidebarViewState): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_VIEW_STORAGE_KEY, serializeSidebarView(view));
  } catch {
    // A full or disabled storage is not a reason to break the sidebar.
  }
}

/**
 * How many filter rules are narrowing the list right now; `exceptMainCheckout`
 * only modifies `hideInactive`, so it is not a rule of its own.
 */
export function activeFilterCount(filters: SidebarFilters): number {
  let count = 0;
  if (filters.projectIds.length > 0) count += 1;
  if (filters.hideInactive) count += 1;
  if (filters.hideMainCheckout) count += 1;
  return count;
}

export function resetSidebarFilters(): SidebarFilters {
  return { ...DEFAULT_SIDEBAR_FILTERS, projectIds: [] };
}

/**
 * "Show this task": drop only the filter rules that would hide it, and keep
 * every other rule the user set. An inactive main checkout is not hidden by
 * `hideInactive` while `exceptMainCheckout` holds, so that rule stays.
 */
export function revealTaskFilters(
  view: SidebarViewState,
  task: Pick<Task, 'projectId' | 'kind'>,
  isInactive: boolean,
): SidebarViewState {
  const filters = view.filters;

  let projectIds = filters.projectIds;
  if (projectIds.length > 0 && !projectIds.includes(task.projectId)) {
    projectIds = [...projectIds, task.projectId];
  }

  const hideMainCheckout =
    task.kind === 'checkout' && filters.hideMainCheckout ? false : filters.hideMainCheckout;

  const hiddenByInactive =
    filters.hideInactive && isInactive && !(task.kind === 'checkout' && filters.exceptMainCheckout);
  const hideInactive = hiddenByInactive ? false : filters.hideInactive;

  if (
    projectIds === filters.projectIds &&
    hideMainCheckout === filters.hideMainCheckout &&
    hideInactive === filters.hideInactive
  ) {
    return view;
  }

  return { ...view, filters: { ...filters, projectIds, hideInactive, hideMainCheckout } };
}

export function toggleCollapsedGroup(view: SidebarViewState, groupKey: string): SidebarViewState {
  return setGroupCollapsed(view, groupKey, view.collapsedGroups[groupKey] !== true);
}

export function setGroupCollapsed(
  view: SidebarViewState,
  groupKey: string,
  collapsed: boolean,
): SidebarViewState {
  if ((view.collapsedGroups[groupKey] === true) === collapsed) return view;
  const collapsedGroups = { ...view.collapsedGroups };
  if (collapsed) collapsedGroups[groupKey] = true;
  else delete collapsedGroups[groupKey];
  return { ...view, collapsedGroups };
}

function safeGet(storage: SidebarStorage): string | null {
  try {
    return storage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function copySidebarView(view: SidebarViewState): SidebarViewState {
  return parseSidebarView(serializeSidebarView(view)) ?? { ...DEFAULT_SIDEBAR_VIEW };
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseShownProperties(value: unknown): SidebarShownProperties {
  const defaults = DEFAULT_SIDEBAR_SHOWN_PROPERTIES;
  if (typeof value !== 'object' || value === null) return { ...defaults };
  const record = value as Record<string, unknown>;
  return {
    branch: asBoolean(record.branch, defaults.branch),
    gitChanges: asBoolean(record.gitChanges, defaults.gitChanges),
    agentActivity: asBoolean(record.agentActivity, defaults.agentActivity),
    notes: asBoolean(record.notes, defaults.notes),
  };
}

function parseCollapsedGroups(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const groups: Record<string, boolean> = {};
  for (const [key, collapsed] of Object.entries(value as Record<string, unknown>)) {
    if (collapsed === true) groups[key] = true;
  }
  return groups;
}

function parseFilters(value: unknown): SidebarFilters {
  const defaults = DEFAULT_SIDEBAR_FILTERS;
  if (typeof value !== 'object' || value === null) {
    return { ...defaults, projectIds: [] };
  }
  const record = value as Record<string, unknown>;
  const projectIds = Array.isArray(record.projectIds)
    ? record.projectIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return {
    projectIds: [...new Set(projectIds)],
    hideInactive: asBoolean(record.hideInactive, defaults.hideInactive),
    exceptMainCheckout: asBoolean(record.exceptMainCheckout, defaults.exceptMainCheckout),
    hideMainCheckout: asBoolean(record.hideMainCheckout, defaults.hideMainCheckout),
  };
}
