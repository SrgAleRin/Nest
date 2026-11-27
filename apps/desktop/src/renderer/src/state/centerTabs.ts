/**
 * Per-task state of the center workbench: which surface is on screen, which
 * tool tabs are open, and what the `Diff` and `Graph` tabs are showing.
 *
 * The terminals are never part of this state: they stay mounted under every
 * surface, so switching here hides a layer with CSS instead of unmounting an
 * xterm. Everything in this module is a pure function of the previous state,
 * so a component can drive a reducer directly and the store below only adds
 * subscribers.
 */

/** Surfaces the center can show. `terminal` is always available. */
export type CenterSurface = 'terminal' | 'diff' | 'graph';

/** A tool tab of the center, which the user can close. */
export type CenterTabId = 'diff' | 'graph';

/** What the graph reads, mirroring the `scope` of `git.log`. */
export type GraphScope = 'all' | 'branches' | 'head' | 'ref';

/** A revision-to-revision diff: the `Diff` tab in read-only compare mode. */
export interface CompareDiffTarget {
  base: string;
  head: string;
  /** One file, or `null` for every file between the two revisions. */
  path: string | null;
}

export interface TaskCenterState {
  /** The surface on screen; always a surface that is open. */
  active: CenterSurface;
  diffOpen: boolean;
  /**
   * `null` = the task's working diff (the selection the panel holds); a target
   * = a comparison of two revisions.
   */
  compareTarget: CompareDiffTarget | null;
  graphOpen: boolean;
  graphScope: GraphScope;
  /** Branch or tag the graph is filtered by; set only with `graphScope === 'ref'`. */
  graphRef: string | null;
  selectedCommitHash: string | null;
}

export const EMPTY_CENTER_STATE: TaskCenterState = {
  active: 'terminal',
  diffOpen: false,
  compareTarget: null,
  graphOpen: false,
  graphScope: 'all',
  graphRef: null,
  selectedCommitHash: null,
};

export type CenterTabsMap = Readonly<Record<string, TaskCenterState>>;

/**
 * What `openGraph` may focus. A ref selects that ref, `scope` picks one of the
 * fixed ranges, and `commitHash` selects the commit a click landed on; the
 * graph opens in every case.
 */
export interface GraphFocus {
  scope?: GraphScope;
  ref?: string | null;
  commitHash?: string | null;
}

/** The working diff: the `Diff` tab shows the task's own changes. */
export function openWorkingDiff(state: TaskCenterState): TaskCenterState {
  const next: TaskCenterState = { ...state, active: 'diff', diffOpen: true, compareTarget: null };
  return sameCenterState(state, next) ? state : next;
}

/** The compare diff: the `Diff` tab shows `base → head`, optionally one file. */
export function openCompareDiff(
  state: TaskCenterState,
  target: CompareDiffTarget,
): TaskCenterState {
  const compareTarget = sameCompareTarget(state.compareTarget, target)
    ? state.compareTarget
    : { ...target };
  const next: TaskCenterState = { ...state, active: 'diff', diffOpen: true, compareTarget };
  return sameCenterState(state, next) ? state : next;
}

/**
 * Opens the graph, or switches the open one to another scope, ref or commit.
 * Without a focus a graph that is already open keeps what it shows, and a fresh
 * one starts on `All branches`.
 */
export function openGraph(state: TaskCenterState, focus: GraphFocus = {}): TaskCenterState {
  const scope = resolvedScope(state, focus);
  const next: TaskCenterState = {
    ...state,
    active: 'graph',
    graphOpen: true,
    graphScope: scope.graphScope,
    graphRef: scope.graphRef,
    selectedCommitHash: focus.commitHash ?? state.selectedCommitHash,
  };
  return sameCenterState(state, next) ? state : next;
}

/**
 * Closes one tool tab. Closing the active one returns to the terminals and the
 * other tab keeps its open state and its payload; the closed tab's own payload
 * is dropped, so reopening it starts from the default.
 */
export function closeCenterTab(state: TaskCenterState, tab: CenterTabId): TaskCenterState {
  if (tab === 'diff') {
    if (!state.diffOpen) return state;
    return {
      ...state,
      active: state.active === 'diff' ? 'terminal' : state.active,
      diffOpen: false,
      compareTarget: null,
    };
  }
  if (!state.graphOpen) return state;
  return {
    ...state,
    active: state.active === 'graph' ? 'terminal' : state.active,
    graphOpen: false,
    graphScope: 'all',
    graphRef: null,
    selectedCommitHash: null,
  };
}

/**
 * Shows a surface that is already open. Activating a closed tab does nothing:
 * `openWorkingDiff`, `openCompareDiff` and `openGraph` are how a tab is opened,
 * so `active` can never point at a tab that is not there.
 */
export function activateCenterSurface(
  state: TaskCenterState,
  surface: CenterSurface,
): TaskCenterState {
  if (state.active === surface) return state;
  if (surface === 'diff' && !state.diffOpen) return state;
  if (surface === 'graph' && !state.graphOpen) return state;
  return { ...state, active: surface };
}

/**
 * The cleanup a removed task needs. Its git snapshot (status, branches, memory)
 * and its center state are per-task caches; both go with the task, so a task id
 * that comes back — or a removed project's tasks — starts from nothing.
 */
export function forgetTaskViews(
  targets: {
    git: { forgetTask(taskId: string): void };
    center: { forgetTaskCenter(taskId: string): void };
  },
  taskId: string,
): void {
  targets.git.forgetTask(taskId);
  targets.center.forgetTaskCenter(taskId);
}

/** Drops a task's center state; the next visit starts from the default. */
export function forgetTaskCenter(states: CenterTabsMap, taskId: string): CenterTabsMap {
  if (!(taskId in states)) return states;
  const next: Record<string, TaskCenterState> = { ...states };
  delete next[taskId];
  return next;
}

function resolvedScope(
  state: TaskCenterState,
  focus: GraphFocus,
): { graphScope: GraphScope; graphRef: string | null } {
  const requested = focus.ref ?? null;
  const scope =
    focus.scope ?? (requested !== null ? 'ref' : state.graphOpen ? state.graphScope : 'all');
  if (scope !== 'ref') return { graphScope: scope, graphRef: null };
  // A ref scope without a name cannot be read; fall back to the whole tree.
  const ref = requested ?? state.graphRef;
  return ref !== null
    ? { graphScope: 'ref', graphRef: ref }
    : { graphScope: 'all', graphRef: null };
}

function sameCompareTarget(
  left: CompareDiffTarget | null,
  right: CompareDiffTarget | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.base === right.base && left.head === right.head && left.path === right.path;
}

function sameCenterState(left: TaskCenterState, right: TaskCenterState): boolean {
  return (
    left.active === right.active &&
    left.diffOpen === right.diffOpen &&
    sameCompareTarget(left.compareTarget, right.compareTarget) &&
    left.graphOpen === right.graphOpen &&
    left.graphScope === right.graphScope &&
    left.graphRef === right.graphRef &&
    left.selectedCommitHash === right.selectedCommitHash
  );
}

/** The center state of every task, with the transitions above as methods. */
export interface CenterTabsStore {
  /** For `useSyncExternalStore`; the map is replaced on every change. */
  subscribe(listener: () => void): () => void;
  getSnapshot(): CenterTabsMap;
  /** A task's state, or the shared default when it was never touched. */
  getTask(taskId: string | null): TaskCenterState;
  openWorkingDiff(taskId: string): void;
  openCompareDiff(taskId: string, target: CompareDiffTarget): void;
  openGraph(taskId: string, focus?: GraphFocus): void;
  closeCenterTab(taskId: string, tab: CenterTabId): void;
  activateCenterSurface(taskId: string, surface: CenterSurface): void;
  forgetTaskCenter(taskId: string): void;
}

/**
 * One center state per task for the whole renderer. A store is used instead of
 * component state because the right panel, the palette and the center itself
 * all move the same task between surfaces, and because A → B → A must land on
 * the surface the user left in A.
 */
export function createCenterTabsStore(): CenterTabsStore {
  let state: CenterTabsMap = {};
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  /** Runs a pure transition; an unchanged result neither writes nor emits. */
  function apply(taskId: string, transition: (current: TaskCenterState) => TaskCenterState): void {
    const current = state[taskId] ?? EMPTY_CENTER_STATE;
    const next = transition(current);
    if (next === current) return;
    state = { ...state, [taskId]: next };
    emit();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state;
    },
    getTask(taskId) {
      return taskId === null ? EMPTY_CENTER_STATE : (state[taskId] ?? EMPTY_CENTER_STATE);
    },
    openWorkingDiff(taskId) {
      apply(taskId, openWorkingDiff);
    },
    openCompareDiff(taskId, target) {
      apply(taskId, (current) => openCompareDiff(current, target));
    },
    openGraph(taskId, focus) {
      apply(taskId, (current) => openGraph(current, focus));
    },
    closeCenterTab(taskId, tab) {
      apply(taskId, (current) => closeCenterTab(current, tab));
    },
    activateCenterSurface(taskId, surface) {
      apply(taskId, (current) => activateCenterSurface(current, surface));
    },
    forgetTaskCenter(taskId) {
      const next = forgetTaskCenter(state, taskId);
      if (next === state) return;
      state = next;
      emit();
    },
  };
}
