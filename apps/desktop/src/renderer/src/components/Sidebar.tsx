import type { HarnessProfile, Project, Session, Task } from '@nest/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  LEFT_PANEL_MIN_WIDTH,
  leftPanelMaxWidth,
  leftPanelWidthForKey,
  leftPanelWidthFromPointer,
} from '../leftPanelLayout';
import type { StartFailure } from '../newTask';
import {
  buildTaskActivitySummary,
  planSidebarRows,
  type SidebarRow,
  type WorkspaceItem,
} from '../sidebarPlan';
import {
  readSidebarView,
  revealTaskFilters,
  setGroupCollapsed,
  toggleCollapsedGroup,
  writeSidebarView,
  type SidebarCardLayout,
  type SidebarStorage,
  type SidebarViewState,
} from '../sidebarView';
import { useGitSnapshotStore } from '../state/GitSnapshotProvider';
import type { TaskOperations } from '../state/taskOperations';
import { ArchiveIcon, EyeIcon, PanelLeftOpenIcon, PlusIcon } from './Icons';
import { ArchivedTasksDrawer } from './sidebar/ArchivedTasksDrawer';
import { GroupHeaderRow } from './sidebar/GroupHeaderRow';
import { PendingTaskRow } from './sidebar/PendingTaskRow';
import { ProjectContextMenu } from './sidebar/ProjectContextMenu';
import { reorderIds, WorkspaceCard } from './sidebar/WorkspaceCard';
import { WorkspaceContextMenu } from './sidebar/WorkspaceContextMenu';
import { SidebarToolbar } from './sidebar/SidebarToolbar';

export interface SidebarProps {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  harnesses: HarnessProfile[];
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  /** Session id → unread output count. */
  unread: Record<string, number>;
  /** Creations in flight, shown as pending rows until they settle. */
  operations: TaskOperations;
  /** Task id → why its harness did not start after the task was created. */
  startFailures: Record<string, StartFailure>;
  /** The panel is on screen: a column, or the narrow-window drawer. */
  open: boolean;
  /** A narrow window shows the panel over the terminal instead of beside it. */
  drawer: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpenPanel: () => void;
  /** The archive drawer replaces the workspace list inside the panel. */
  archiveOpen: boolean;
  onSetArchiveOpen: (open: boolean) => void;
  /** Bumped when the command palette asks for an inline rename. */
  renameNonce?: number;
  /** Bumped when the command palette asks to show the selected workspace. */
  revealNonce?: number;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (session: Session) => void;
  onStartSession: (taskId: string, harnessId: string) => void;
  onStopTaskSessions: (task: Task) => void;
  onRetryStart: (taskId: string, harnessId: string) => void;
  onAbortOperation: (operationId: string) => void;
  onAddProject: () => void;
  /** A folder dropped on the panel: register it without the picker. */
  onAddProjectPath: (directoryPath: string) => void;
  onOpenCheckout: (projectId: string) => void;
  onUpdateProject: (project: Project, patch: { hidden?: boolean }) => void;
  onOpenProjectSettings: (project: Project) => void;
  onRemoveProject: (project: Project) => void;
  onRevealProject: (project: Project) => void;
  onReorderProjects: (projectIds: string[]) => void;
  onNewTask: (projectId: string, baseRef?: string | null) => void;
  onUpdateTask: (
    task: Task,
    patch: {
      title?: string;
      workflowStatus?: Task['workflowStatus'];
      pinned?: boolean;
      notes?: string | null;
      unread?: boolean;
    },
  ) => void;
  onReorderTasks: (taskIds: string[]) => void;
  onArchiveTask: (task: Task) => void;
  onRestoreTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  onCleanUpArchived: (tasks: Task[]) => void;
  onRevealTask: (task: Task) => void;
  onCopyText: (value: string, label: string) => void;
}

/** Estimated heights; the virtualizer measures the real ones after a paint. */
const ROW_HEIGHT_HEADER = 26;
const ROW_HEIGHT_PENDING = 30;
const ROW_HEIGHT_CARD_COMPACT = 32;
const ROW_HEIGHT_CARD_DETAILED = 58;

/** Background git reads wait for the panel to settle, never for the first paint. */
const GIT_BATCH_DELAY_MS = 250;
/** Statuses fetched in one deferred batch. */
const GIT_BATCH_SIZE = 4;

type WorkspaceRow = Extract<SidebarRow, { kind: 'workspace-card' }>;

type SidebarContextMenu = {
  /** Where the menu opened; the menu itself is portalled and clamped. */
  anchor: { x: number; y: number };
} & ({ kind: 'workspace'; item: WorkspaceItem } | { kind: 'project'; project: Project });

/** Manual drag and drop: a card carries its group, a header carries its id. */
type SidebarDragState =
  | { kind: 'task'; taskId: string; groupKey: string }
  | { kind: 'project'; projectId: string }
  | null;

function browserStorage(): SidebarStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function rowHeight(row: SidebarRow | undefined, layout: SidebarCardLayout): number {
  if (!row) return ROW_HEIGHT_CARD_COMPACT;
  if (row.kind === 'pending-task') return ROW_HEIGHT_PENDING;
  if (row.kind !== 'workspace-card') return ROW_HEIGHT_HEADER;
  return layout === 'compact' ? ROW_HEIGHT_CARD_COMPACT : ROW_HEIGHT_CARD_DETAILED;
}

/** Attribute selectors need quotes and backslashes escaped; row keys hold neither. */
function escapeSelectorValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** `file:///D:/work/repo` → `D:\work\repo` on Windows, `/home/me/repo` elsewhere. */
function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    const parsed = new URL(uri);
    const decoded = decodeURIComponent(parsed.pathname);
    return decoded.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    return null;
  }
}

/**
 * The folder a drop carries. Electron exposes the real path on `File.path`, the
 * URI list is what an OS drag provides first, and a plain text drag may hold a
 * path the user copied from a terminal.
 */
function droppedDirectoryPath(data: DataTransfer): string | null {
  const uriList = data.getData('text/uri-list');
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith('#')) continue;
      const path = fileUriToPath(entry);
      if (path) return path;
    }
  }

  const file = data.files[0] as (File & { path?: string }) | undefined;
  if (file?.path) return file.path;

  const plain = data.getData('text/plain').trim();
  return plain.length > 0 ? plain : null;
}

/**
 * The left panel: a virtualized list of workspace cards grouped by project or
 * workflow stage, with search, view options, inline editors, context menus,
 * manual reordering, drag-and-drop of folders and an archive drawer.
 *
 * The row list is computed by `planSidebarRows`; this component only renders it
 * and routes every mutation back to the app, which owns projects and tasks.
 */
export function Sidebar(props: SidebarProps) {
  const {
    projects,
    tasks,
    sessions,
    harnesses,
    selectedTaskId,
    selectedSessionId,
    unread,
    operations,
    startFailures,
    open,
    drawer,
    width,
    archiveOpen,
    renameNonce,
    revealNonce,
    onClose,
    onOpenPanel,
    onSetArchiveOpen,
  } = props;

  const [view, setView] = useState<SidebarViewState>(() => readSidebarView(browserStorage()));
  useEffect(() => {
    writeSidebarView(browserStorage(), view);
  }, [view]);

  const [searchQuery, setSearchQuery] = useState('');
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [editingNotesTaskId, setEditingNotesTaskId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const [hiddenMenuOpen, setHiddenMenuOpen] = useState(false);
  const [dragState, setDragState] = useState<SidebarDragState>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  /** A workspace that must be scrolled to as soon as its row exists. */
  const [pendingScrollTaskId, setPendingScrollTaskId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const railButtonRef = useRef<HTMLButtonElement | null>(null);
  const hiddenMenuRef = useRef<HTMLDivElement | null>(null);
  const previousOpen = useRef(open);
  const handledRevealNonce = useRef(0);
  const handledRenameNonce = useRef(0);

  const gitStore = useGitSnapshotStore();
  const gitState = useSyncExternalStore(gitStore.subscribe, gitStore.getState);

  const plan = useMemo(
    () =>
      planSidebarRows({
        projects,
        tasks,
        sessions,
        unread,
        operations,
        startFailures,
        view,
        searchQuery,
        selectedTaskId,
      }),
    [
      operations,
      projects,
      searchQuery,
      selectedTaskId,
      sessions,
      startFailures,
      tasks,
      unread,
      view,
    ],
  );

  const rows = plan.rows;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const hiddenProjects = plan.hiddenProjects;
  const maxWidth = leftPanelMaxWidth(typeof window === 'undefined' ? 1440 : window.innerWidth);

  const archivedTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status === 'archived')
        .sort((left, right) =>
          (right.archivedAt ?? right.updatedAt).localeCompare(left.archivedAt ?? left.updatedAt),
        ),
    [tasks],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rowHeight(rows[index], view.cardLayout),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
  });

  const updateView = useCallback(
    (updater: (previous: SidebarViewState) => SidebarViewState) => setView(updater),
    [],
  );

  const defaultProject =
    projects.find((project) => project.id === selectedTask?.projectId) ??
    projects.find((project) => !project.hidden) ??
    projects[0] ??
    null;

  const newTaskDefault = useCallback(() => {
    if (defaultProject) props.onNewTask(defaultProject.id);
    else props.onAddProject();
  }, [defaultProject, props]);

  const selectTask = useCallback(
    (taskId: string) => {
      setFocusedKey(`card:${taskId}`);
      props.onSelectTask(taskId);
      if (drawer) onClose();
    },
    [drawer, onClose, props],
  );

  const selectSession = useCallback(
    (session: Session) => {
      props.onSelectSession(session);
      if (drawer) onClose();
    },
    [drawer, onClose, props],
  );

  // Closing the panel puts the focus on the rail button that opens it again.
  useEffect(() => {
    if (previousOpen.current && !open && !drawer) railButtonRef.current?.focus();
    previousOpen.current = open;
  }, [drawer, open]);

  // A drawer is dismissed with Escape, unless a menu, a dialog or an inline
  // editor is the thing that should close first.
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (contextMenu || archiveOpen || hiddenMenuOpen || renamingTaskId || editingNotesTaskId) {
        return;
      }
      if (document.querySelector('.modal-overlay')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    archiveOpen,
    contextMenu,
    drawer,
    editingNotesTaskId,
    hiddenMenuOpen,
    onClose,
    renamingTaskId,
  ]);

  useEffect(() => {
    if (!hiddenMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (hiddenMenuRef.current?.contains(event.target as Node)) return;
      setHiddenMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setHiddenMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [hiddenMenuOpen]);

  // Git facts of the list are a background nicety: only a detailed list that
  // actually shows them asks for statuses, and only after the first paint.
  useEffect(() => {
    if (!open || archiveOpen) return;
    if (view.cardLayout !== 'detailed' || !view.shownProperties.gitChanges) return;

    const missing: string[] = [];
    for (const item of plan.visibleItems) {
      const slice = gitState[item.task.id]?.status;
      if (slice?.data || slice?.loading || slice?.error) continue;
      missing.push(item.task.id);
      if (missing.length >= GIT_BATCH_SIZE) break;
    }
    if (missing.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const taskId of missing) void gitStore.requestStatus(taskId);
    }, GIT_BATCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    archiveOpen,
    gitState,
    gitStore,
    open,
    plan.visibleItems,
    view.cardLayout,
    view.shownProperties.gitChanges,
  ]);

  const isTaskInactive = useCallback(
    (task: Task): boolean =>
      buildTaskActivitySummary({
        task,
        sessions: sessions.filter((session) => session.taskId === task.id),
        unread,
        startFailure: startFailures[task.id],
      }).isInactive,
    [sessions, startFailures, unread],
  );

  const groupKeyForTask = useCallback(
    (task: Task): string => {
      if (task.pinned) return 'pinned';
      if (view.groupBy === 'project') return `project:${task.projectId}`;
      if (view.groupBy === 'status') return `status:${task.workflowStatus}`;
      return 'flat';
    },
    [view.groupBy],
  );

  /**
   * Drops whatever hides a task: the search text, the filter rules, and the
   * folded group it sits in. The row is scrolled to once it exists again.
   */
  const revealTask = useCallback(
    (task: Task, clearSearch = true) => {
      if (clearSearch) setSearchQuery('');
      updateView((previous) => {
        const unfiltered = revealTaskFilters(previous, task, isTaskInactive(task));
        return setGroupCollapsed(unfiltered, groupKeyForTask(task), false);
      });
      setPendingScrollTaskId(task.id);
    },
    [groupKeyForTask, isTaskInactive, updateView],
  );

  // The palette asks for the selected workspace: drop whatever hides it. The
  // nonce is consumed once, so later task updates do not reveal it again.
  useEffect(() => {
    if (!revealNonce || revealNonce === handledRevealNonce.current || !selectedTask) return;
    handledRevealNonce.current = revealNonce;
    revealTask(selectedTask);
  }, [revealNonce, revealTask, selectedTask]);

  // The palette asks for an inline rename of the selected worktree.
  useEffect(() => {
    if (!renameNonce || renameNonce === handledRenameNonce.current) return;
    handledRenameNonce.current = renameNonce;
    if (!selectedTask || selectedTask.kind !== 'worktree') return;
    setRenamingTaskId(selectedTask.id);
    setPendingScrollTaskId(selectedTask.id);
  }, [renameNonce, selectedTask]);

  useEffect(() => {
    if (!pendingScrollTaskId) return;
    const index = rows.findIndex(
      (row) => row.kind === 'workspace-card' && row.item.task.id === pendingScrollTaskId,
    );
    if (index === -1) return;
    setPendingScrollTaskId(null);
    virtualizer.scrollToIndex(index, { align: 'auto' });
  }, [pendingScrollTaskId, rows, virtualizer]);

  /** Moves the roving focus to a row, scrolling it into view first. */
  const focusRow = useCallback(
    (key: string) => {
      setFocusedKey(key);
      const index = rows.findIndex((row) => row.key === key);
      if (index === -1) return;
      virtualizer.scrollToIndex(index, { align: 'auto' });
      requestAnimationFrame(() => {
        const selector = `[data-row-key="${escapeSelectorValue(key)}"]`;
        scrollRef.current?.querySelector<HTMLElement>(selector)?.focus();
      });
    },
    [rows, virtualizer],
  );

  const cardGroupKeyOf = useCallback(
    (item: WorkspaceItem): string => {
      if (item.task.pinned) return 'pinned';
      if (view.groupBy === 'project') return `project:${item.task.projectId}`;
      if (view.groupBy === 'status') return `status:${item.task.workflowStatus}`;
      return 'flat';
    },
    [view.groupBy],
  );

  /** The displayed order of the group a card belongs to, for manual moves. */
  const taskIdsInGroup = useCallback(
    (item: WorkspaceItem): string[] => {
      const groupKey = cardGroupKeyOf(item);
      return plan.visibleItems
        .filter((other) => cardGroupKeyOf(other) === groupKey)
        .map((other) => other.task.id);
    },
    [cardGroupKeyOf, plan.visibleItems],
  );

  const endDrag = useCallback(() => {
    setDragState(null);
    setDragOverKey(null);
  }, []);

  const dropOnCard = useCallback(
    (row: WorkspaceRow, targetTaskId: string) => {
      const dragged = dragState;
      endDrag();
      if (!dragged || dragged.kind !== 'task') return;
      if (dragged.groupKey !== cardGroupKeyOf(row.item)) return;
      const ordered = taskIdsInGroup(row.item);
      const next = reorderIds(ordered, dragged.taskId, targetTaskId);
      if (next !== ordered) props.onReorderTasks(next);
    },
    [cardGroupKeyOf, dragState, endDrag, props, taskIdsInGroup],
  );

  const projectIdsInOrder = useMemo(
    () =>
      rows.flatMap((row) => (row.kind === 'group-header' && row.project ? [row.project.id] : [])),
    [rows],
  );

  const dropOnProject = useCallback(
    (targetProjectId: string) => {
      const dragged = dragState;
      endDrag();
      if (!dragged || dragged.kind !== 'project') return;
      const next = reorderIds(projectIdsInOrder, dragged.projectId, targetProjectId);
      if (next !== projectIdsInOrder) props.onReorderProjects(next);
    },
    [dragState, endDrag, projectIdsInOrder, props],
  );

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // A header toggles itself with Enter; handling it here as well would undo it.
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    // An inline editor or a focused control owns its own keys; the list only
    // navigates while the row itself (or the row wrapper) has the focus.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (target !== event.currentTarget && target.closest('button, a, select, [role="menu"]')) {
      return;
    }

    const effectiveFocusedKey = focusedKey ?? (selectedTaskId ? `card:${selectedTaskId}` : null);
    const navigable = rows.flatMap((row, index) => (row.kind === 'pending-task' ? [] : [index]));
    const currentIndex =
      effectiveFocusedKey === null ? -1 : rows.findIndex((row) => row.key === effectiveFocusedKey);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (navigable.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const position = navigable.indexOf(currentIndex);
      const next =
        position === -1
          ? delta === 1
            ? 0
            : navigable.length - 1
          : Math.min(navigable.length - 1, Math.max(0, position + delta));
      const index = navigable[next];
      if (index === undefined) return;
      event.preventDefault();
      const row = rows[index];
      if (row) focusRow(row.key);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      const index = event.key === 'Home' ? navigable[0] : navigable[navigable.length - 1];
      if (index === undefined) return;
      event.preventDefault();
      const row = rows[index];
      if (row) focusRow(row.key);
      return;
    }

    const row = rows.find((candidate) => candidate.key === effectiveFocusedKey);
    if (!row) return;

    if (event.key === 'ArrowLeft') {
      if (row.kind === 'pending-task') return;
      if (row.kind === 'workspace-card') {
        const parentKey =
          row.section === 'pinned'
            ? 'pinned'
            : view.groupBy === 'project'
              ? `project:${row.item.task.projectId}`
              : view.groupBy === 'status'
                ? `status:${row.item.task.workflowStatus}`
                : null;
        if (!parentKey) return;
        event.preventDefault();
        focusRow(parentKey);
        return;
      }
      if (row.collapsed) return;
      event.preventDefault();
      updateView((previous) => setGroupCollapsed(previous, row.key, true));
      return;
    }

    if (event.key === 'ArrowRight') {
      if (row.kind === 'pending-task' || row.kind === 'workspace-card') return;
      if (!row.collapsed) return;
      event.preventDefault();
      updateView((previous) => setGroupCollapsed(previous, row.key, false));
      return;
    }

    if (event.key === 'Enter') {
      if (row.kind === 'pending-task') return;
      event.preventDefault();
      if (row.kind === 'workspace-card') selectTask(row.item.task.id);
      else updateView((previous) => toggleCollapsedGroup(previous, row.key));
      return;
    }

    if (event.key === 'F2') {
      if (row.kind !== 'workspace-card' || row.item.task.kind !== 'worktree') return;
      event.preventDefault();
      setRenamingTaskId(row.item.task.id);
      return;
    }

    if (event.key === 'Delete') {
      if (row.kind !== 'workspace-card' || row.item.task.kind !== 'worktree') return;
      event.preventDefault();
      props.onDeleteTask(row.item.task);
    }
  };

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const next = leftPanelWidthForKey(width, event.key, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    props.onWidthChange(next);
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      props.onWidthChange(leftPanelWidthFromPointer(moveEvent.clientX, window.innerWidth));
    };
    const stop = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  const onFolderDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    const types = event.dataTransfer.types;
    if (!types.includes('Files') && !types.includes('text/uri-list')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setFileDragOver(true);
  };

  const onFolderDrop = (event: ReactDragEvent<HTMLElement>): void => {
    setFileDragOver(false);
    const types = event.dataTransfer.types;
    const isFolderDrop = types.includes('Files') || types.includes('text/uri-list');
    const path = droppedDirectoryPath(event.dataTransfer);
    if (!isFolderDrop && !path) return;
    // The panel owns the drop: the window must never navigate to the folder.
    event.preventDefault();
    if (path) props.onAddProjectPath(path);
  };

  const renderContextMenu = () => {
    if (!contextMenu) return null;
    if (contextMenu.kind === 'project') {
      const project = contextMenu.project;
      return (
        <ProjectContextMenu
          project={project}
          anchor={contextMenu.anchor}
          onClose={() => setContextMenu(null)}
          onNewTask={() => props.onNewTask(project.id)}
          onOpenCheckout={() => props.onOpenCheckout(project.id)}
          onOpenSettings={() => props.onOpenProjectSettings(project)}
          onReveal={() => props.onRevealProject(project)}
          onCopyPath={() => props.onCopyText(project.path, 'Path')}
          onHideProject={() => props.onUpdateProject(project, { hidden: true })}
          onRemoveProject={() => props.onRemoveProject(project)}
        />
      );
    }

    const { item } = contextMenu;
    const task = item.task;
    return (
      <WorkspaceContextMenu
        task={task}
        project={item.project}
        harnesses={harnesses}
        hasLiveSessions={item.summary.liveSessions.length > 0}
        hasUnread={item.summary.hasUnread}
        anchor={contextMenu.anchor}
        onClose={() => setContextMenu(null)}
        onNewSession={(harnessId) => props.onStartSession(task.id, harnessId)}
        onTogglePin={() => props.onUpdateTask(task, { pinned: !task.pinned })}
        onSetStatus={(workflowStatus) => props.onUpdateTask(task, { workflowStatus })}
        onToggleUnread={() => props.onUpdateTask(task, { unread: !item.summary.hasUnread })}
        onRename={() => setRenamingTaskId(task.id)}
        onEditNotes={() => setEditingNotesTaskId(task.id)}
        onNewTaskFromBranch={() => props.onNewTask(task.projectId, task.branch)}
        onStopSessions={() => props.onStopTaskSessions(task)}
        onReveal={() => props.onRevealTask(task)}
        onCopy={(value) => props.onCopyText(value, 'Copied')}
        onArchive={() => props.onArchiveTask(task)}
        onDelete={() => props.onDeleteTask(task)}
      />
    );
  };

  const renderRow = (row: SidebarRow) => {
    if (row.kind === 'pending-task') {
      return <PendingTaskRow operation={row.operation} onAbort={props.onAbortOperation} />;
    }

    if (row.kind === 'workspace-card') {
      const item = row.item;
      const task = item.task;
      const groupKey = cardGroupKeyOf(item);
      return (
        <WorkspaceCard
          item={item}
          selected={task.id === selectedTaskId}
          focused={focusedKey === row.key}
          compact={view.cardLayout === 'compact'}
          shownProperties={view.shownProperties}
          showProjectPrefix={row.showProjectPrefix}
          manualSortable={view.sortBy === 'manual'}
          harnesses={harnesses}
          startFailure={startFailures[task.id]}
          gitStatus={gitState[task.id]?.status.data ?? null}
          selectedSessionId={selectedSessionId}
          renaming={renamingTaskId === task.id}
          editingNotes={editingNotesTaskId === task.id}
          onSelectTask={selectTask}
          onSelectSession={selectSession}
          onStartSession={props.onStartSession}
          onRetryStart={props.onRetryStart}
          onToggleUnread={(target) =>
            props.onUpdateTask(target, { unread: !item.summary.hasUnread })
          }
          onSetWorkflowStatus={(target, workflowStatus) =>
            props.onUpdateTask(target, { workflowStatus })
          }
          onBeginRename={(taskId) => setRenamingTaskId(taskId)}
          onCommitRename={(target, title) => {
            setRenamingTaskId(null);
            props.onUpdateTask(target, { title });
          }}
          onCancelRename={() => setRenamingTaskId(null)}
          onEditNotes={(taskId) => {
            setRenamingTaskId(null);
            setEditingNotesTaskId(taskId);
          }}
          onSaveNotes={(target, notes) => {
            setEditingNotesTaskId(null);
            props.onUpdateTask(target, { notes });
          }}
          onCancelNotes={() => setEditingNotesTaskId(null)}
          onOpenContextMenu={(target, anchor) =>
            setContextMenu({ kind: 'workspace', item: target, anchor })
          }
          onDragStartCard={(taskId) => {
            setDragState({ kind: 'task', taskId, groupKey });
            setDragOverKey(null);
          }}
          onDragOverCard={(targetTaskId) => {
            if (dragState?.kind !== 'task') return;
            if (dragState.groupKey !== groupKey || dragState.taskId === targetTaskId) return;
            setDragOverKey(row.key);
          }}
          onDropCard={(targetTaskId) => dropOnCard(row, targetTaskId)}
          onDragEndCard={endDrag}
          dragOver={dragOverKey === row.key}
        />
      );
    }

    return (
      <GroupHeaderRow
        row={row}
        focused={focusedKey === row.key}
        manualProjectSortable={view.groupBy === 'project' && view.projectOrderBy === 'manual'}
        onToggleCollapse={(key) => {
          setFocusedKey(key);
          updateView((previous) => toggleCollapsedGroup(previous, key));
        }}
        onNewTask={(projectId) => props.onNewTask(projectId)}
        onOpenProjectMenu={(project, anchor) =>
          setContextMenu({ kind: 'project', project, anchor })
        }
        onDragStartProject={(projectId) => {
          setDragState({ kind: 'project', projectId });
          setDragOverKey(null);
        }}
        onDragOverProject={(projectId) => {
          if (dragState?.kind !== 'project' || dragState.projectId === projectId) return;
          setDragOverKey(row.key);
        }}
        onDropProject={(projectId) => dropOnProject(projectId)}
        onDragEndProject={endDrag}
        dragOver={dragOverKey === row.key}
      />
    );
  };

  // Collapsed column: a rail with the controls that still make sense there.
  const railWorking = plan.visibleItems.filter((item) => item.summary.workingCount > 0).length;
  const railIdle = plan.visibleItems.filter(
    (item) => item.summary.status === 'idle' || item.summary.status === 'failed',
  ).length;
  const railUnread = plan.visibleItems.reduce((sum, item) => sum + item.summary.unreadCount, 0);

  const rail = (
    <aside className="sidebar sidebar-rail" aria-label="Workspaces collapsed">
      <button
        ref={railButtonRef}
        type="button"
        className="left-rail-toggle"
        title="Expand sidebar (Ctrl+Shift+B)"
        aria-label="Expand sidebar"
        aria-expanded={false}
        onClick={onOpenPanel}
      >
        <PanelLeftOpenIcon size={15} />
      </button>
      <button
        type="button"
        className="rail-action"
        title="New task"
        aria-label="New task"
        onClick={newTaskDefault}
      >
        <PlusIcon size={15} />
      </button>
      {railWorking > 0 || railIdle > 0 || railUnread > 0 ? (
        <span
          className="rail-status"
          title={`${railWorking} working · ${railIdle} idle · ${railUnread} unread`}
        >
          {railWorking > 0 ? <span className="ws-status-dot ws-dot-working" /> : null}
          {railIdle > 0 ? <span className="ws-status-dot ws-dot-idle" /> : null}
          {railUnread > 0 ? (
            <span className="rail-badge">{railUnread > 99 ? '99+' : railUnread}</span>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        className="rail-action"
        title="Archived workspaces"
        aria-label="Archived workspaces"
        onClick={() => {
          onSetArchiveOpen(true);
          onOpenPanel();
        }}
      >
        <ArchiveIcon size={15} />
      </button>
    </aside>
  );

  if (!open) return rail;

  const panel = (
    <aside
      className={['sidebar', drawer ? 'left-drawer' : '', fileDragOver ? 'sidebar-drop-active' : '']
        .filter(Boolean)
        .join(' ')}
      aria-label="Workspaces"
      onDragOver={onFolderDragOver}
      onDragLeave={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        setFileDragOver(false);
      }}
      onDrop={onFolderDrop}
    >
      {drawer ? null : (
        <div
          className="left-resizer"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize left sidebar"
          aria-valuemin={LEFT_PANEL_MIN_WIDTH}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          title="Drag or use the arrow keys to resize"
          onPointerDown={startResize}
          onKeyDown={onResizeKeyDown}
        />
      )}

      {archiveOpen ? (
        <ArchivedTasksDrawer
          tasks={archivedTasks}
          projects={projects}
          onBack={() => onSetArchiveOpen(false)}
          onRestore={props.onRestoreTask}
          onDelete={props.onDeleteTask}
          onCleanUpAll={() => props.onCleanUpArchived(archivedTasks)}
        />
      ) : (
        <>
          <SidebarToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchInputRef={searchInputRef}
            view={view}
            projects={projects}
            activeFilters={plan.activeFilterCount}
            onUpdateView={updateView}
            onCollapse={onClose}
            onNewTaskDefault={newTaskDefault}
            onNewTaskForProject={(projectId) => props.onNewTask(projectId)}
            onAddProject={props.onAddProject}
          />

          {plan.isSelectedTaskHidden && selectedTask ? (
            <div className="ws-hidden-banner" role="status">
              <span>
                {plan.selectedTaskHiddenReason === 'search'
                  ? 'Current workspace is hidden by search'
                  : plan.selectedTaskHiddenReason === 'filters'
                    ? 'Current workspace is hidden by filters'
                    : 'Current workspace is hidden by search and filters'}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  revealTask(
                    selectedTask,
                    plan.selectedTaskHiddenReason === 'search' ||
                      plan.selectedTaskHiddenReason === 'both',
                  )
                }
              >
                Reveal
              </button>
            </div>
          ) : null}

          <div
            className="sidebar-scroll"
            ref={scrollRef}
            role="listbox"
            aria-label="Workspaces"
            tabIndex={0}
            onKeyDown={onListKeyDown}
          >
            {rows.length === 0 ? (
              <p className="sidebar-empty">
                {projects.length === 0
                  ? 'No projects yet. Add a git repository to start.'
                  : 'No workspace matches the current search and filters.'}
              </p>
            ) : (
              <div className="sidebar-rows" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                {virtualizer.getVirtualItems().map((virtualRow) => {
                  const row = rows[virtualRow.index];
                  if (!row) return null;
                  return (
                    <div
                      key={virtualRow.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-row-key={row.key}
                      className={[
                        'ws-virtual-row',
                        row.kind === 'workspace-card' &&
                        (row.item.task.id === editingNotesTaskId || focusedKey === row.key)
                          ? 'ws-virtual-row-raised'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ transform: `translateY(${virtualRow.start}px)` }}
                      tabIndex={-1}
                    >
                      {renderRow(row)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <footer className="sidebar-foot">
            <button type="button" className="sidebar-foot-btn" onClick={props.onAddProject}>
              <PlusIcon size={14} /> Add project
            </button>
            <button
              type="button"
              className="sidebar-foot-btn"
              title="Archived workspaces"
              onClick={() => onSetArchiveOpen(true)}
            >
              <ArchiveIcon size={14} />{' '}
              {archivedTasks.length > 0 ? `Archived · ${archivedTasks.length}` : 'Archived'}
            </button>
            {hiddenProjects.length > 0 ? (
              <div className="sidebar-hidden-wrap" ref={hiddenMenuRef}>
                <button
                  type="button"
                  className="sidebar-foot-btn"
                  aria-expanded={hiddenMenuOpen}
                  title="Projects hidden from the sidebar"
                  onClick={() => setHiddenMenuOpen((previous) => !previous)}
                >
                  <EyeIcon size={14} /> Hidden · {hiddenProjects.length}
                </button>
                {hiddenMenuOpen ? (
                  <div
                    className="sidebar-hidden-popover"
                    role="dialog"
                    aria-label="Hidden projects"
                  >
                    {hiddenProjects.map((project) => (
                      <div className="sidebar-hidden-row" key={project.id}>
                        <span className="sidebar-hidden-name" title={project.path}>
                          {project.name}
                        </span>
                        <button
                          type="button"
                          className="sidebar-hidden-show"
                          onClick={() => props.onUpdateProject(project, { hidden: false })}
                        >
                          Show
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </footer>
        </>
      )}
    </aside>
  );

  if (!drawer) {
    return (
      <>
        {panel}
        {renderContextMenu()}
      </>
    );
  }

  // A drawer floats over the terminal; the rail stays in the column behind it,
  // so closing the drawer lands the focus back on the button that opened it.
  return (
    <>
      {rail}
      <div className="left-drawer-layer">
        <div
          className="left-drawer-backdrop"
          role="presentation"
          data-testid="left-drawer-backdrop"
          onClick={onClose}
        />
        {panel}
      </div>
      {renderContextMenu()}
    </>
  );
}
