import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type {
  AppInfo,
  AppSettings,
  HarnessProfile,
  NestClient,
  Project,
  Session,
  SessionStatus,
  Task,
  UpdateStatus,
} from '@nest/shared';
import { DEFAULT_TERMINAL_PREFERENCES, newId } from '@nest/shared';
import { Badge, IconButton } from '@nest/ui';
import { BootSkeleton, FatalScreen } from './components/Boot';
import { CenterPane } from './components/CenterPane';
import { CommandPalette } from './components/CommandPalette';
import type { GraphActions } from './components/GitGraphPanel';
import { GearIcon } from './components/Icons';
import { NewTaskDialog, type NewTaskSubmission } from './components/NewTaskDialog';
import { startFailureMessage, taskToSelect, type StartFailure } from './newTask';
import { LEFT_PANEL_RAIL_WIDTH, useLeftPanelLayout } from './leftPanelLayout';
import { WORKFLOW_STATUS_LABELS } from './sidebarPlan';
import { RIGHT_SECTIONS, RightPanel, type RightTab } from './components/RightPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { DeleteTaskDialog, type DeleteTaskOptions } from './components/sidebar/DeleteTaskDialog';
import { RemoveProjectDialog } from './components/sidebar/RemoveProjectDialog';
import {
  ProjectSettingsDialog,
  type ProjectSettingsPatch,
} from './components/sidebar/ProjectSettingsDialog';
import type { CommandItem } from './commands';
import { createClient } from './rpc/client';
import { branchLabel, branchSnapshot, type BranchSnapshot } from './state/branch';
import {
  createCenterTabsStore,
  forgetTaskViews,
  type CompareDiffTarget,
  type GraphFocus,
} from './state/centerTabs';
import { createGitSnapshotStore, type GitSnapshotStore } from './state/gitSnapshot';
import { GitSnapshotProvider, useGitSnapshotFor } from './state/GitSnapshotProvider';
import {
  applySnapshot,
  emptySessions,
  listSessions,
  removeSession,
  snapshotBaseline,
  upsertSession,
  type SessionsState,
} from './state/sessions';
import {
  forgetSession,
  rememberSession,
  resolveSelectedSession,
  type SessionTabs,
} from './state/sessionTabs';
import {
  applyOperationProgress,
  settleOperation,
  startOperation,
  type TaskOperations,
} from './state/taskOperations';
import {
  RIGHT_PANEL_RAIL_WIDTH,
  revealCenterForTool,
  useRightPanelLayout,
} from './rightPanelLayout';
import { changedPathCount } from './sourceControl';
import { resolveShortcut } from './shortcuts';
import { eventSessionData } from './state/terminalBus';
import { filesViewActions } from './state/filesView';
import { sessionEndEffect, unreadTotal } from './notifications';
import { errorMessage, resumeTone, shortPath, upsert } from './utils';

interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * The task to fall back to: the one that was selected while it still exists and
 * is active, otherwise the main checkout — the place the user works by hand.
 */
function pickTaskId(tasks: Task[], current: string | null): string | null {
  const active = tasks.filter((task) => task.status === 'active');
  if (current && active.some((task) => task.id === current)) return current;
  return active.find((task) => task.kind === 'checkout')?.id ?? active[0]?.id ?? null;
}

export function App() {
  const client = useMemo(createClient, []);
  // One owner for the git status of every task: the header badge, the status
  // bar and the right panel read the same snapshot instead of asking git again.
  const gitStore = useMemo(
    () => createGitSnapshotStore({ invoke: (method, params) => client.invoke(method, params) }),
    [client],
  );

  return (
    <GitSnapshotProvider store={gitStore}>
      <AppShell client={client} gitStore={gitStore} />
    </GitSnapshotProvider>
  );
}

function AppShell({ client, gitStore }: { client: NestClient; gitStore: GitSnapshotStore }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // Session rows live in a reducer: every update is applied to the latest
  // state, so a late RPC answer cannot overwrite newer events (A14).
  const [sessionState, setSessionState] = useState<SessionsState>(emptySessions);
  const sessions = useMemo(() => listSessions(sessionState), [sessionState]);
  const [sessionTabs, setSessionTabs] = useState<SessionTabs>({});
  const [harnesses, setHarnesses] = useState<HarnessProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [gitVersions, setGitVersions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  // Creations in flight, keyed by the operation id the renderer generated. The
  // tree renders them as pending rows, so progress survives a closed dialog.
  const [operations, setOperations] = useState<TaskOperations>([]);
  const [newTaskBusy, setNewTaskBusy] = useState(false);
  const [newTaskError, setNewTaskError] = useState<string | null>(null);
  /** The task exists but its harness did not start: retry without a new worktree. */
  const [newTaskRetry, setNewTaskRetry] = useState<{ taskId: string; harnessId: string } | null>(
    null,
  );
  /** Failed start steps per task, so a closed dialog does not hide them. */
  const [startFailures, setStartFailures] = useState<Record<string, StartFailure>>({});
  const newTaskOperationRef = useRef<string | null>(null);
  const newTaskCancelledRef = useRef(false);
  const newTaskModalOpenRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The right column has three top-level sections; `compare` is a view inside
  // `Source Control`. Patches and history live in the center workbench.
  const [rightTab, setRightTab] = useState<RightTab>('source-control');
  const rightLayout = useRightPanelLayout();
  // The left column is a preference, not project data: width, collapsed rail and
  // the narrow-window drawer all live in this layout hook.
  const leftLayout = useLeftPanelLayout();
  /** The archive drawer replaces the workspace list inside the left panel. */
  const [archiveOpen, setArchiveOpen] = useState(false);
  /** Palette triggers: an inline rename, and showing the selected workspace. */
  const [renameNonce, setRenameNonce] = useState(0);
  const [revealNonce, setRevealNonce] = useState(0);
  /** Non-blocking replacements for `window.confirm`. */
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<Task | null>(null);
  const [deleteTaskBusy, setDeleteTaskBusy] = useState(false);
  const [removeProjectTarget, setRemoveProjectTarget] = useState<Project | null>(null);
  const [removeProjectBusy, setRemoveProjectBusy] = useState(false);
  const [projectSettingsTarget, setProjectSettingsTarget] = useState<Project | null>(null);
  const [projectSettingsBusy, setProjectSettingsBusy] = useState(false);
  const [projectSettingsError, setProjectSettingsError] = useState<string | null>(null);
  // Which surface of the center workbench each task shows. The terminals are
  // never part of it: they stay mounted under every surface.
  const centerTabs = useMemo(createCenterTabsStore, []);
  const centerState = useSyncExternalStore(centerTabs.subscribe, () =>
    centerTabs.getTask(selectedTaskId),
  );
  /** `Inspect branch…` from the palette focuses the graph's ref picker. */
  const [graphPickerNonce, setGraphPickerNonce] = useState(0);
  /** Branch the `New task` dialog starts from, when a branch inspector opened it. */
  const [newTaskBaseRef, setNewTaskBaseRef] = useState<string | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [activateSessionId, setActivateSessionId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // The selected tab is the one remembered for this task. A global id would
  // forget task A as soon as task B opens.
  const selectedSessionId = useMemo(
    () => resolveSelectedSession(sessionTabs, sessions, selectedTaskId),
    [sessionTabs, sessions, selectedTaskId],
  );

  // The status event handler runs outside the render cycle, so it reads the
  // selected session, tasks and previous statuses from refs.
  const selectedSessionIdRef = useRef<string | null>(null);
  const tasksRef = useRef<Task[]>([]);
  const sessionStatusRef = useRef<Map<string, SessionStatus>>(new Map());
  const sessionStateRef = useRef<SessionsState>(emptySessions);
  selectedSessionIdRef.current = selectedSessionId;
  tasksRef.current = tasks;
  sessionStateRef.current = sessionState;

  const notify = useCallback((level: 'info' | 'warn' | 'error', message: string) => {
    setToast({ id: Date.now(), level, message });
  }, []);

  const reportError = useCallback((message: string) => notify('error', message), [notify]);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const gitVersion = selectedTaskId ? (gitVersions[selectedTaskId] ?? 0) : 0;
  // Header badge and status bar read the store's snapshot; the persisted task
  // branch stays as the fallback while the first read is in flight or when the
  // workspace is gone.
  const gitSnapshot = useGitSnapshotFor(gitStore, selectedTaskId);
  const gitStatus = gitSnapshot?.status.data ?? null;
  const gitBranch: BranchSnapshot | null =
    selectedTaskId && gitStatus ? branchSnapshot(selectedTaskId, gitStatus) : null;
  const currentBranch = branchLabel(selectedTask, gitBranch);
  // The `Source Control` badge counts changed paths, not rows: a partially
  // staged file is one path with two rows.
  const changeCount = changedPathCount(gitStatus?.files ?? []);
  const selectedProject =
    projects.find((project) => project.id === selectedTask?.projectId) ?? null;
  const selectedSessions = useMemo(
    () => sessions.filter((session) => session.taskId === selectedTaskId),
    [sessions, selectedTaskId],
  );
  const selectedSession =
    selectedSessions.find((session) => session.id === selectedSessionId) ?? null;
  const newTaskProject = projects.find((project) => project.id === newTaskProjectId) ?? null;
  newTaskModalOpenRef.current = Boolean(newTaskProjectId);
  const newTaskStep = useMemo(() => {
    const operationId = newTaskOperationRef.current;
    if (!operationId) return null;
    return operations.find((operation) => operation.operationId === operationId)?.step ?? null;
  }, [operations]);
  // Full harness list drives resume support, while disabled profiles stay out
  // of the start pickers. Both come from the same cached registry.
  const visibleHarnesses = useMemo(
    () =>
      settings
        ? harnesses.filter((harness) => !settings.disabledHarnesses.includes(harness.id))
        : harnesses,
    [harnesses, settings],
  );
  const resumableHarnesses = useMemo(
    () =>
      new Set(
        harnesses.filter((harness) => harness.resumeArgs.length > 0).map((harness) => harness.id),
      ),
    [harnesses],
  );
  const unreadCount = useMemo(() => Math.min(999, unreadTotal(unread)), [unread]);
  const allHarnessesDisabled = harnesses.length > 0 && visibleHarnesses.length === 0;

  const openPalette = useCallback(() => {
    // Another modal owns the keyboard while it is open.
    if (settingsOpen || newTaskProject) return;
    setPaletteOpen(true);
  }, [newTaskProject, settingsOpen]);

  const refreshAll = useCallback(async () => {
    // The revision is read before the request: on arrival, rows touched after
    // it keep their newer value and rows closed meanwhile stay closed.
    const baseline = snapshotBaseline(sessionStateRef.current);
    try {
      const [nextProjects, nextTasks, nextSessions] = await Promise.all([
        client.invoke('projects.list', {}),
        client.invoke('tasks.list', {}),
        client.invoke('sessions.list', {}),
      ]);
      setProjects(nextProjects);
      setTasks(nextTasks);
      setSessionState((prev) => applySnapshot(prev, nextSessions, baseline));
      setSelectedTaskId((current) => pickTaskId(nextTasks, current));
    } catch (error) {
      notify('error', errorMessage(error));
    }
  }, [client, notify]);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextInfo, nextHarnesses, nextSettings] = await Promise.all([
        client.invoke('app.info', {}),
        client.invoke('harness.list', { includeDisabled: true }),
        client.invoke('settings.get', {}),
      ]);
      const baseline = snapshotBaseline(sessionStateRef.current);
      const [nextProjects, nextTasks, nextSessions] = await Promise.all([
        client.invoke('projects.list', {}),
        client.invoke('tasks.list', {}),
        client.invoke('sessions.list', {}),
      ]);
      setInfo(nextInfo);
      setHarnesses(nextHarnesses);
      setSettings(nextSettings);
      setProjects(nextProjects);
      setTasks(nextTasks);
      setSessionState((prev) => applySnapshot(prev, nextSessions, baseline));
      setSelectedTaskId((current) => pickTaskId(nextTasks, current));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    void client
      .invoke('updates.status', {})
      .then(setUpdateStatus)
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    return client.on((event) => {
      switch (event.type) {
        case 'session:data':
          eventSessionData(event);
          return;
        case 'session:status': {
          const session = event.session;
          const previous = sessionStatusRef.current.get(session.id);
          sessionStatusRef.current.set(session.id, session.status);
          setSessionState((prev) => upsertSession(prev, session));

          const ended = session.status === 'exited' || session.status === 'failed';
          const wasLive = previous === 'starting' || previous === 'running' || previous === 'idle';
          if (ended && wasLive) {
            const effect = sessionEndEffect({
              session,
              task: tasksRef.current.find((task) => task.id === session.taskId) ?? null,
              viewingSessionId: selectedSessionIdRef.current,
              focused: document.hasFocus() && !document.hidden,
            });
            if (effect.markUnread) {
              setUnread((prev) => ({
                ...prev,
                [session.id]: (prev[session.id] ?? 0) + 1,
              }));
            }
            if (effect.notification) {
              void client
                .invoke('notifications.show', {
                  ...effect.notification,
                  sessionId: session.id,
                })
                .catch(() => {});
            }
          }
          return;
        }
        case 'task:updated':
          setTasks((prev) => upsert(prev, event.task));
          return;
        case 'project:updated':
          setProjects((prev) => upsert(prev, event.project));
          return;
        case 'task:progress':
          setOperations((prev) => applyOperationProgress(prev, event));
          return;
        case 'task:operation':
          setOperations((prev) => settleOperation(prev, event.operationId));
          // A cancelled operation that had already created its task removes it
          // again; the row goes away with the worktree.
          if (event.state === 'aborted' && event.taskId) {
            const taskId = event.taskId;
            setTasks((prev) => prev.filter((task) => task.id !== taskId));
            forgetTaskViews({ git: gitStore, center: centerTabs, files: filesViewActions }, taskId);
          }
          return;
        case 'git:changed':
          // Changes are reported per task: watching every workspace must not
          // refetch the panels of the task the user is looking at. The store
          // marks the task stale and coalesces the reload; the version keeps the
          // panel's own refresh working unchanged.
          gitStore.invalidate(event.taskId);
          setGitVersions((prev) => ({
            ...prev,
            [event.taskId]: (prev[event.taskId] ?? 0) + 1,
          }));
          return;
        case 'notification':
          notify(event.level, event.message);
          return;
        case 'notification:activated':
          if (event.sessionId) setActivateSessionId(event.sessionId);
          return;
        case 'updates:status':
          setUpdateStatus(event.status);
          return;
        default:
          return;
      }
    });
  }, [centerTabs, client, gitStore, notify]);

  // Keep the transition map in sync with sessions loaded from the database, so
  // a session that was already running when the window opened still reports its
  // exit once.
  useEffect(() => {
    const statuses = sessionStatusRef.current;
    const known = new Set<string>();
    for (const session of sessions) {
      statuses.set(session.id, session.status);
      known.add(session.id);
    }
    for (const id of statuses.keys()) {
      if (!known.has(id)) statuses.delete(id);
    }
  }, [sessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnread((prev) => {
      if (!prev[selectedSessionId]) return prev;
      const next = { ...prev };
      delete next[selectedSessionId];
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    const clearSelected = () => {
      const sessionId = selectedSessionIdRef.current;
      if (!sessionId) return;
      setUnread((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    };
    const onVisibility = () => {
      if (!document.hidden) clearSelected();
    };
    window.addEventListener('focus', clearSelected);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', clearSelected);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // A clicked notification brings the window forward and opens its session.
  useEffect(() => {
    if (!activateSessionId) return;
    const session = sessions.find((candidate) => candidate.id === activateSessionId);
    if (!session) return;
    setSelectedTaskId(session.taskId);
    setSessionTabs((prev) => rememberSession(prev, session.taskId, session.id));
    setActivateSessionId(null);
  }, [activateSessionId, sessions]);

  useEffect(() => {
    void client.invoke('notifications.badge', { count: unreadCount }).catch(() => {});
  }, [client, unreadCount]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** Registers a folder: the picker and a dropped directory share this path. */
  const addProjectPath = useCallback(
    async (path: string) => {
      try {
        const { project, checkout } = await client.invoke('projects.add', { path });
        setProjects((prev) => upsert(prev, project));
        setTasks((prev) => upsert(prev, checkout));
        setSelectedTaskId(checkout.id);
        notify('info', `Added ${project.name}`);
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const addProject = useCallback(async () => {
    try {
      const directory = await client.invoke('dialog.pickDirectory', {});
      if (!directory) return;
      await addProjectPath(directory);
    } catch (error) {
      notify('error', errorMessage(error));
    }
  }, [addProjectPath, client, notify]);

  /** Removal is asked for by a dialog, never by `window.confirm`. */
  const confirmRemoveProject = useCallback(async () => {
    const project = removeProjectTarget;
    if (!project) return;
    setRemoveProjectBusy(true);
    try {
      const removed = tasksRef.current.filter((task) => task.projectId === project.id);
      await client.invoke('projects.remove', { projectId: project.id });
      setProjects((prev) => prev.filter((candidate) => candidate.id !== project.id));
      // Every task of the project is gone, so its caches are dead weight.
      for (const task of removed) {
        forgetTaskViews({ git: gitStore, center: centerTabs, files: filesViewActions }, task.id);
      }
      setRemoveProjectTarget(null);
      await refreshAll();
    } catch (error) {
      notify('error', errorMessage(error));
    } finally {
      setRemoveProjectBusy(false);
    }
  }, [centerTabs, client, gitStore, notify, refreshAll, removeProjectTarget]);

  const saveProjectSettings = useCallback(
    async (patch: ProjectSettingsPatch) => {
      const project = projectSettingsTarget;
      if (!project) return;
      setProjectSettingsBusy(true);
      setProjectSettingsError(null);
      try {
        const updated = await client.invoke('projects.update', {
          projectId: project.id,
          name: patch.name,
          defaultBaseRef: patch.defaultBaseRef,
          setupScript: patch.setupScript,
        });
        setProjects((prev) => upsert(prev, updated));
        setProjectSettingsTarget(null);
        notify('info', 'Project settings saved');
      } catch (error) {
        setProjectSettingsError(errorMessage(error));
      } finally {
        setProjectSettingsBusy(false);
      }
    },
    [client, notify, projectSettingsTarget],
  );

  /**
   * Opens the dialog for a project, clearing the state of a previous creation.
   * `baseRef` prefills the branch a new task starts from (a branch inspector
   * hands its own ref in), and is dropped when the dialog closes.
   */
  const openNewTask = useCallback(
    (projectId: string, baseRef: string | null = null) => {
      // Reopening while a creation runs keeps its progress (and its cancel).
      if (!newTaskBusy) {
        newTaskOperationRef.current = null;
        newTaskCancelledRef.current = false;
      }
      setNewTaskError(null);
      setNewTaskRetry(null);
      setNewTaskBaseRef(baseRef);
      setNewTaskProjectId(projectId);
    },
    [newTaskBusy],
  );

  /** Hides the dialog. A running creation keeps going and stays in the tree. */
  const closeNewTask = useCallback(() => {
    setNewTaskProjectId(null);
    setNewTaskError(null);
    setNewTaskRetry(null);
    setNewTaskBaseRef(null);
  }, []);

  /** Cancels the running creation in core, then closes. Never starts a session. */
  const cancelNewTask = useCallback(() => {
    const operationId = newTaskOperationRef.current;
    newTaskCancelledRef.current = true;
    setNewTaskProjectId(null);
    setNewTaskError(null);
    setNewTaskRetry(null);
    setNewTaskBusy(false);
    if (!operationId) return;
    setOperations((prev) => settleOperation(prev, operationId));
    void client
      .invoke('tasks.abort', { operationId })
      .then((result) => {
        if (result.aborted) notify('info', 'Task creation cancelled');
      })
      .catch(() => {
        // The operation already finished; its promise handles the outcome.
      });
  }, [client, notify]);

  const createTask = useCallback(
    async (submission: NewTaskSubmission) => {
      const project = newTaskProject;
      if (!project) return;
      setNewTaskError(null);
      setNewTaskRetry(null);

      if (submission.location === 'checkout') {
        try {
          const task = await client.invoke('tasks.openCheckout', { projectId: project.id });
          setTasks((prev) => upsert(prev, task));
          setSelectedTaskId(task.id);
          setNewTaskProjectId(null);
          notify('info', `Opened main checkout of ${shortPath(task.workspacePath, 48)}`);
        } catch (error) {
          setNewTaskError(errorMessage(error));
        }
        return;
      }

      const operationId = newId();
      // Focus must not be stolen: only a user still on the task they had when
      // they submitted gets the new one.
      const selectedAtSubmit = selectedTaskId;
      newTaskOperationRef.current = operationId;
      newTaskCancelledRef.current = false;
      setOperations((prev) =>
        startOperation(prev, {
          operationId,
          projectId: project.id,
          title: submission.title?.trim() || 'New task',
          step: null,
        }),
      );
      setNewTaskBusy(true);
      try {
        const task = await client.invoke('tasks.create', {
          projectId: project.id,
          title: submission.title ?? '',
          operationId,
          ...(submission.baseRef ? { baseRef: submission.baseRef } : {}),
          ...(submission.setupScript !== undefined ? { setupScript: submission.setupScript } : {}),
        });
        // Cancelled meanwhile: core removed (or is removing) these artefacts, so
        // nothing is selected and no session is started.
        if (newTaskCancelledRef.current) return;

        setTasks((prev) => upsert(prev, task));
        setProjects((prev) =>
          prev.map((candidate) =>
            candidate.id === project.id && submission.setupScript !== undefined
              ? { ...candidate, setupScript: submission.setupScript || null }
              : candidate,
          ),
        );
        setSelectedTaskId((current) => taskToSelect(current, selectedAtSubmit, task.id));
        if (task.setupError) {
          notify('warn', `Created ${task.branch}, but setup failed: ${task.setupError}`);
        } else {
          notify('info', `Created ${task.branch} in ${shortPath(task.workspacePath, 48)}`);
        }

        const harnessId = submission.harnessId;
        if (!submission.start || !harnessId) {
          setNewTaskProjectId(null);
          return;
        }

        try {
          const session = await client.invoke('sessions.start', {
            taskId: task.id,
            harnessId,
            cols: 120,
            rows: 30,
          });
          setSessionState((prev) => upsertSession(prev, session));
          setSessionTabs((prev) => rememberSession(prev, task.id, session.id));
          setNewTaskProjectId(null);
        } catch (error) {
          // The worktree and the row stay: retrying must not create a second one.
          const message = `${task.branch} was created, but ${startFailureMessage(
            harnessId,
            errorMessage(error),
          )}`;
          setStartFailures((prev) => ({ ...prev, [task.id]: { harnessId, message } }));
          if (newTaskModalOpenRef.current) {
            setNewTaskError(message);
            setNewTaskRetry({ taskId: task.id, harnessId });
          } else {
            notify('error', message);
          }
        }
      } catch (error) {
        if (newTaskCancelledRef.current) return;
        const message = errorMessage(error);
        if (newTaskModalOpenRef.current) setNewTaskError(message);
        else notify('error', message);
      } finally {
        setNewTaskBusy(false);
      }
    },
    [client, newTaskProject, notify, selectedTaskId],
  );

  /** Retry of the start step only: the task and its worktree already exist. */
  const retryNewTaskStart = useCallback(async () => {
    const retry = newTaskRetry;
    if (!retry) return;
    setNewTaskBusy(true);
    try {
      const session = await client.invoke('sessions.start', {
        taskId: retry.taskId,
        harnessId: retry.harnessId,
        cols: 120,
        rows: 30,
      });
      setSessionState((prev) => upsertSession(prev, session));
      setSessionTabs((prev) => rememberSession(prev, retry.taskId, session.id));
      setStartFailures((prev) => {
        if (!(retry.taskId in prev)) return prev;
        const next = { ...prev };
        delete next[retry.taskId];
        return next;
      });
      setNewTaskRetry(null);
      setNewTaskError(null);
      setNewTaskProjectId(null);
    } catch (error) {
      setNewTaskError(startFailureMessage(retry.harnessId, errorMessage(error)));
    } finally {
      setNewTaskBusy(false);
    }
  }, [client, newTaskRetry]);

  /** Retry of the start step from the tree, with the dialog closed. */
  const retryStartInTask = useCallback(
    async (taskId: string, harnessId: string) => {
      try {
        const session = await client.invoke('sessions.start', {
          taskId,
          harnessId,
          cols: 120,
          rows: 30,
        });
        setSessionState((prev) => upsertSession(prev, session));
        setSessionTabs((prev) => rememberSession(prev, taskId, session.id));
        setStartFailures((prev) => {
          if (!(taskId in prev)) return prev;
          const next = { ...prev };
          delete next[taskId];
          return next;
        });
        setSelectedTaskId(taskId);
      } catch (error) {
        const message = startFailureMessage(harnessId, errorMessage(error));
        setStartFailures((prev) => ({ ...prev, [taskId]: { harnessId, message } }));
        notify('error', message);
      }
    },
    [client, notify],
  );

  /** The deletion dialog already named what would be lost; this runs it. */
  const confirmDeleteTask = useCallback(
    async (options: DeleteTaskOptions) => {
      const task = deleteTaskTarget;
      if (!task) return;
      setDeleteTaskBusy(true);

      const remove = async (force: boolean) => {
        await client.invoke('tasks.remove', {
          taskId: task.id,
          force,
          deleteBranch: options.deleteBranch,
        });
        setTasks((prev) => prev.filter((candidate) => candidate.id !== task.id));
        // The task's caches go with it: its git snapshot and its center state.
        forgetTaskViews({ git: gitStore, center: centerTabs, files: filesViewActions }, task.id);
        setStartFailures((prev) => {
          if (!(task.id in prev)) return prev;
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
        setDeleteTaskTarget(null);
        await refreshAll();
      };

      try {
        await remove(options.force);
      } catch (error) {
        // A change may have appeared between the dialog's status read and the
        // removal; the user already agreed to lose the worktree.
        if (error instanceof Error && error.name === 'workspace_dirty') {
          try {
            await remove(true);
          } catch (forceError) {
            notify('error', errorMessage(forceError));
          }
        } else {
          notify('error', errorMessage(error));
        }
      } finally {
        setDeleteTaskBusy(false);
      }
    },
    [centerTabs, client, deleteTaskTarget, gitStore, notify, refreshAll],
  );

  /** Selecting a workspace also clears the "new activity" flag it carries. */
  const selectTask = useCallback(
    (taskId: string) => {
      setSelectedTaskId(taskId);
      const task = tasksRef.current.find((candidate) => candidate.id === taskId);
      if (!task?.unread) return;
      setTasks((prev) =>
        prev.map((candidate) =>
          candidate.id === taskId ? { ...candidate, unread: false } : candidate,
        ),
      );
      void client
        .invoke('tasks.update', { taskId, unread: false })
        .then((updated) => setTasks((prev) => upsert(prev, updated)))
        .catch((error) => notify('error', errorMessage(error)));
    },
    [client, notify],
  );

  /** One patch of a task row: the state answers first, the row confirms it. */
  const updateTask = useCallback(
    async (
      task: Task,
      patch: {
        title?: string;
        workflowStatus?: Task['workflowStatus'];
        pinned?: boolean;
        notes?: string | null;
        unread?: boolean;
      },
    ) => {
      setTasks((prev) =>
        prev.map((candidate) =>
          candidate.id === task.id ? { ...candidate, ...patch } : candidate,
        ),
      );
      try {
        const updated = await client.invoke('tasks.update', { taskId: task.id, ...patch });
        setTasks((prev) => upsert(prev, updated));
      } catch (error) {
        setTasks((prev) => upsert(prev, task));
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const archiveTask = useCallback(
    async (task: Task) => {
      try {
        const archived = await client.invoke('tasks.archive', { taskId: task.id });
        const remaining = tasksRef.current.filter(
          (candidate) => candidate.id !== task.id && candidate.status === 'active',
        );
        setTasks((prev) => upsert(prev, archived));
        setStartFailures((prev) => {
          if (!(task.id in prev)) return prev;
          const next = { ...prev };
          delete next[task.id];
          return next;
        });
        setSelectedTaskId((current) => {
          if (current !== task.id) return current;
          return (
            remaining.find(
              (candidate) =>
                candidate.projectId === task.projectId && candidate.kind === 'checkout',
            )?.id ??
            remaining.find((candidate) => candidate.projectId === task.projectId)?.id ??
            remaining.find((candidate) => candidate.kind === 'checkout')?.id ??
            remaining[0]?.id ??
            null
          );
        });
        notify('info', `Archived ${task.title}`);
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const restoreTask = useCallback(
    async (task: Task) => {
      try {
        const restored = await client.invoke('tasks.restore', { taskId: task.id });
        setTasks((prev) => upsert(prev, restored));
        setSelectedTaskId(restored.id);
        notify('info', `Restored ${restored.title}`);
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  /**
   * Clean up of the archive: only worktrees that git reports clean are removed,
   * one after another, and the summary says how many were left alone.
   */
  const cleanUpArchived = useCallback(
    async (targets: Task[]) => {
      let removed = 0;
      let skipped = 0;
      for (const task of targets) {
        if (task.kind !== 'worktree') {
          skipped += 1;
          continue;
        }
        try {
          const status = await client.invoke('git.status', { taskId: task.id });
          if (status.files.length > 0 || status.ahead > 0) {
            skipped += 1;
            continue;
          }
        } catch {
          // A workspace whose status cannot be read is never cleaned up blindly.
          skipped += 1;
          continue;
        }
        try {
          await client.invoke('tasks.remove', {
            taskId: task.id,
            force: false,
            deleteBranch: false,
          });
          removed += 1;
          setTasks((prev) => prev.filter((candidate) => candidate.id !== task.id));
          forgetTaskViews({ git: gitStore, center: centerTabs, files: filesViewActions }, task.id);
        } catch {
          skipped += 1;
        }
      }
      notify(
        skipped > 0 ? 'warn' : 'info',
        `Removed ${removed} archived workspace${removed === 1 ? '' : 's'}` +
          (skipped > 0 ? `, skipped ${skipped} with local changes` : ''),
      );
    },
    [centerTabs, client, gitStore, notify],
  );

  const stopTaskSessions = useCallback(
    async (task: Task) => {
      const live = sessions.filter(
        (session) =>
          session.taskId === task.id &&
          (session.status === 'starting' ||
            session.status === 'running' ||
            session.status === 'idle'),
      );
      for (const session of live) {
        try {
          await client.invoke('sessions.stop', { sessionId: session.id });
        } catch (error) {
          notify('error', errorMessage(error));
        }
      }
    },
    [client, notify, sessions],
  );

  const reorderTasks = useCallback(
    (taskIds: string[]) => {
      const order = new Map(taskIds.map((taskId, index) => [taskId, index]));
      setTasks((prev) =>
        prev.map((task) => {
          const position = order.get(task.id);
          return position === undefined ? task : { ...task, sortOrder: position };
        }),
      );
      void client
        .invoke('tasks.reorder', { taskIds })
        .catch((error) => notify('error', errorMessage(error)));
    },
    [client, notify],
  );

  const reorderProjects = useCallback(
    (projectIds: string[]) => {
      const order = new Map(projectIds.map((projectId, index) => [projectId, index]));
      setProjects((prev) =>
        prev.map((project) => {
          const position = order.get(project.id);
          return position === undefined ? project : { ...project, sortOrder: position };
        }),
      );
      void client
        .invoke('projects.reorder', { projectIds })
        .catch((error) => notify('error', errorMessage(error)));
    },
    [client, notify],
  );

  const updateProject = useCallback(
    async (project: Project, patch: { hidden?: boolean }) => {
      try {
        const updated = await client.invoke('projects.update', { projectId: project.id, ...patch });
        setProjects((prev) => upsert(prev, updated));
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const openCheckout = useCallback(
    async (projectId: string) => {
      try {
        const task = await client.invoke('tasks.openCheckout', { projectId });
        setTasks((prev) => upsert(prev, task));
        setSelectedTaskId(task.id);
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const revealTask = useCallback(
    (task: Task) => {
      void client.invoke('tasks.reveal', { taskId: task.id }).catch((error) => {
        notify('error', errorMessage(error));
      });
    },
    [client, notify],
  );

  const copyText = useCallback(
    (value: string, label: string) => {
      void navigator.clipboard
        .writeText(value)
        .then(() => notify('info', `${label} copied`))
        .catch((error: unknown) => notify('error', errorMessage(error)));
    },
    [notify],
  );

  /** Cancels a pending creation from its row, without opening the dialog. */
  const abortOperation = useCallback(
    (operationId: string) => {
      setOperations((prev) => settleOperation(prev, operationId));
      void client
        .invoke('tasks.abort', { operationId })
        .then((result) => {
          if (result.aborted) notify('info', 'Task creation cancelled');
        })
        .catch(() => {
          // The operation already finished; its own promise reports the result.
        });
    },
    [client, notify],
  );

  const startSession = useCallback(
    async (harnessId: string, taskId?: string) => {
      const targetTaskId = taskId ?? selectedTaskId;
      if (!targetTaskId) return;
      setBusy(true);
      try {
        const session = await client.invoke('sessions.start', {
          taskId: targetTaskId,
          harnessId,
          cols: 120,
          rows: 30,
        });
        setSessionState((prev) => upsertSession(prev, session));
        setSelectedTaskId(targetTaskId);
        setSessionTabs((prev) => rememberSession(prev, targetTaskId, session.id));
      } catch (error) {
        notify('error', errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [client, notify, selectedTaskId],
  );

  const restartSession = useCallback(
    (session: Session) => {
      void startSession(session.harnessId, session.taskId);
    },
    [startSession],
  );

  const resumeSession = useCallback(
    async (session: Session) => {
      setBusy(true);
      try {
        const resumed = await client.invoke('sessions.resume', { sessionId: session.id });
        setSessionState((prev) => upsertSession(prev, resumed));
        setSelectedTaskId(session.taskId);
        setSessionTabs((prev) => rememberSession(prev, session.taskId, session.id));
      } catch (error) {
        notify('error', errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [client, notify],
  );

  const stopSession = useCallback(
    async (sessionId: string) => {
      try {
        await client.invoke('sessions.stop', { sessionId });
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const closeSession = useCallback(
    async (session: Session) => {
      try {
        await client.invoke('sessions.close', { sessionId: session.id });
        // Functional updates: the row and the tab go away exactly once, no
        // matter what the render cycle saw before the await returned.
        setSessionState((prev) => removeSession(prev, session.id));
        setSessionTabs((prev) => forgetSession(prev, session.taskId, session.id));
        setUnread((prev) => {
          if (!(session.id in prev)) return prev;
          const next = { ...prev };
          delete next[session.id];
          return next;
        });
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify],
  );

  const selectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) return;
      setSelectedTaskId(session.taskId);
      setSessionTabs((prev) => rememberSession(prev, session.taskId, session.id));
      centerTabs.activateCenterSurface(session.taskId, 'terminal');
    },
    [centerTabs, sessions],
  );

  // A click inside the terminal pane stays in the current task, so the tab is
  // remembered under the task the pane belongs to.
  const selectSessionTab = useCallback(
    (sessionId: string) => {
      if (!selectedTaskId) return;
      setSessionTabs((prev) => rememberSession(prev, selectedTaskId, sessionId));
    },
    [selectedTaskId],
  );

  /**
   * Puts the caret back into the selected terminal (Ctrl + backtick). The terminal
   * layer may be behind a tool tab, so the surface switches first and the focus
   * lands after the layer is on screen again.
   */
  const focusTerminal = useCallback(() => {
    if (selectedTaskId) centerTabs.activateCenterSurface(selectedTaskId, 'terminal');
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.terminal-view.active .xterm-helper-textarea')?.focus();
    });
  }, [centerTabs, selectedTaskId]);

  // Shortcut actions are read from a ref: the listener is registered once, yet
  // it always sees the current tab, task and modal state.
  const shortcutsRef = useRef({
    openPalette,
    focusTerminal,
    toggleLeftPanel: leftLayout.toggle,
    modalOpen: false,
    selectedProjectId: selectedProject?.id ?? null,
    selectedSessionId,
    tabs: selectedSessions,
    closeSession,
    selectSession,
    openNewTask,
  });
  shortcutsRef.current = {
    openPalette,
    focusTerminal,
    toggleLeftPanel: leftLayout.toggle,
    // Any dialog owns the keyboard while it is on screen.
    modalOpen:
      settingsOpen ||
      paletteOpen ||
      Boolean(newTaskProjectId) ||
      Boolean(deleteTaskTarget) ||
      Boolean(removeProjectTarget) ||
      Boolean(projectSettingsTarget),
    selectedProjectId: selectedProject?.id ?? null,
    selectedSessionId,
    tabs: selectedSessions,
    closeSession,
    selectSession,
    openNewTask,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The terminal owns its shell bindings: Ctrl+N and Ctrl+W stay with the
      // PTY while focus is inside xterm (see shortcuts.ts).
      const terminalFocused = Boolean(
        (document.activeElement as HTMLElement | null)?.closest('.terminal-view'),
      );
      const shortcut = resolveShortcut(event, { terminalFocused });
      if (!shortcut) return;
      const actions = shortcutsRef.current;

      if (shortcut === 'palette') {
        event.preventDefault();
        actions.openPalette();
        return;
      }
      // Every other shortcut belongs to the app only while no modal owns the
      // keyboard.
      if (actions.modalOpen) return;

      switch (shortcut) {
        case 'toggle-left-panel':
          event.preventDefault();
          actions.toggleLeftPanel();
          return;
        case 'new-task':
          if (!actions.selectedProjectId) return;
          event.preventDefault();
          actions.openNewTask(actions.selectedProjectId);
          return;
        case 'close-tab': {
          const session = actions.tabs.find(
            (candidate) => candidate.id === actions.selectedSessionId,
          );
          if (!session) return;
          event.preventDefault();
          void actions.closeSession(session);
          return;
        }
        case 'next-tab':
        case 'previous-tab': {
          if (actions.tabs.length < 2) return;
          event.preventDefault();
          const step = shortcut === 'next-tab' ? 1 : -1;
          const index = actions.tabs.findIndex(
            (candidate) => candidate.id === actions.selectedSessionId,
          );
          const next = actions.tabs[(index + step + actions.tabs.length) % actions.tabs.length];
          if (next) actions.selectSession(next.id);
          return;
        }
        case 'focus-terminal':
          event.preventDefault();
          actions.focusTerminal();
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const refreshHarnesses = useCallback(async () => {
    try {
      setHarnesses(await client.invoke('harness.list', { includeDisabled: true }));
    } catch (error) {
      notify('error', errorMessage(error));
    }
  }, [client, notify]);

  const bumpGit = useCallback(() => {
    if (!selectedTaskId) return;
    setGitVersions((prev) => ({
      ...prev,
      [selectedTaskId]: (prev[selectedTaskId] ?? 0) + 1,
    }));
    // A local operation re-reads the same snapshot the header and the panel
    // show; invalidate coalesces it with a watcher event for the same tick.
    gitStore.invalidate(selectedTaskId);
  }, [gitStore, selectedTaskId]);

  /**
   * Opens a center tool. A wide column keeps its width and its tab; in a narrow
   * window the right panel is a drawer over the center, so it closes and the
   * tool is visible at once.
   */
  const showCenterTool = useCallback(() => {
    revealCenterForTool(rightLayout);
  }, [rightLayout]);

  /** The task's own patch, on the file the change list selected. */
  const openWorkingDiff = useCallback(() => {
    if (!selectedTaskId) return;
    centerTabs.openWorkingDiff(selectedTaskId);
    showCenterTool();
  }, [centerTabs, selectedTaskId, showCenterTool]);

  /**
   * `Open diff` and the palette mean the whole patch of the task: the file the
   * list remembered is dropped, so the click always opens every changed file.
   */
  const openWholeDiff = useCallback(() => {
    if (!selectedTaskId) return;
    gitStore.updateMemory(selectedTaskId, { selection: null });
    openWorkingDiff();
  }, [gitStore, openWorkingDiff, selectedTaskId]);

  /** The git graph, optionally focused on a range, a ref or one commit. */
  const openGraph = useCallback(
    (focus?: GraphFocus) => {
      if (!selectedTaskId) return;
      centerTabs.openGraph(selectedTaskId, focus);
      showCenterTool();
    },
    [centerTabs, selectedTaskId, showCenterTool],
  );

  /** A read-only comparison of two revisions, in the center patch. */
  const openCompareDiff = useCallback(
    (target: CompareDiffTarget) => {
      if (!selectedTaskId) return;
      centerTabs.openCompareDiff(selectedTaskId, target);
      showCenterTool();
    },
    [centerTabs, selectedTaskId, showCenterTool],
  );

  /**
   * `Inspect branch…`: the graph opens with the ref picker focused, so the user
   * chooses a branch without checking anything out.
   */
  const inspectBranch = useCallback(() => {
    setGraphPickerNonce((nonce) => nonce + 1);
    openGraph();
  }, [openGraph]);

  const graphActions = useMemo<GraphActions>(
    () => ({
      onScope: (scope) => {
        if (selectedTaskId) centerTabs.openGraph(selectedTaskId, { scope });
      },
      onOpenRef: (ref) => {
        if (selectedTaskId) centerTabs.openGraph(selectedTaskId, { ref });
      },
      onSelectCommit: (hash) => {
        if (selectedTaskId) centerTabs.openGraph(selectedTaskId, { commitHash: hash });
      },
      onCompareWithHead: (ref) => openCompareDiff({ base: 'HEAD', head: ref, path: null }),
      onBrowseFiles: (ref) => {
        // The `Files` panel reads the revision from the shared store, so setting
        // it and showing the panel is the whole handoff; no checkout happens.
        if (selectedTaskId) filesViewActions.setInspectedRef(selectedTaskId, ref);
        setRightTab('files');
        rightLayout.openPanel();
      },
      onNewTaskFromRef: (ref) => {
        if (selectedTask) openNewTask(selectedTask.projectId, ref);
      },
    }),
    [centerTabs, openCompareDiff, openNewTask, rightLayout, selectedTask, selectedTaskId],
  );

  const paletteCommands: CommandItem[] = [];
  for (const task of tasks) {
    // The palette switches between live workspaces; archived ones are restored
    // from the archive drawer instead.
    if (task.status !== 'active') continue;
    const project = projects.find((candidate) => candidate.id === task.projectId);
    paletteCommands.push({
      id: `task:${task.id}`,
      title: task.kind === 'checkout' ? 'main checkout' : task.title,
      detail: `${project?.name ?? 'project'} · ${task.branch}`,
      keywords: 'switch task project workspace',
      kind: 'task',
      run: () => selectTask(task.id),
    });
  }
  for (const session of sessions) {
    const task = tasks.find((candidate) => candidate.id === session.taskId);
    paletteCommands.push({
      id: `session:${session.id}`,
      title: session.title,
      detail: `${task?.kind === 'checkout' ? 'main checkout' : (task?.title ?? 'task')} · ${session.status}`,
      keywords: 'open session terminal',
      kind: 'session',
      run: () => selectSession(session.id),
    });
  }
  if (selectedTask) {
    for (const harness of visibleHarnesses) {
      if (!harness.available) continue;
      paletteCommands.push({
        id: `harness:${harness.id}`,
        title: `Start ${harness.label}`,
        detail: selectedTask.kind === 'checkout' ? 'main checkout' : selectedTask.title,
        keywords: 'run launch harness new session',
        kind: 'harness',
        run: () => void startSession(harness.id),
      });
    }
    const live =
      selectedSession?.status === 'starting' ||
      selectedSession?.status === 'running' ||
      selectedSession?.status === 'idle';
    if (selectedSession && live) {
      paletteCommands.push({
        id: 'session:stop',
        title: `Stop ${selectedSession.title}`,
        detail: 'kill the running harness',
        keywords: 'kill terminate',
        kind: 'action',
        run: () => void stopSession(selectedSession.id),
      });
    }
    if (selectedSession && !live && resumableHarnesses.has(selectedSession.harnessId)) {
      paletteCommands.push({
        id: 'session:resume',
        title: `Resume ${selectedSession.title}`,
        detail: `${resumeTone(selectedSession)} conversation`,
        keywords: 'continue session',
        kind: 'action',
        run: () => void resumeSession(selectedSession),
      });
    }
    paletteCommands.push({
      id: 'task:reveal',
      title: 'Reveal workspace in Explorer',
      detail: shortPath(selectedTask.workspacePath, 48),
      keywords: 'open folder finder',
      kind: 'action',
      run: () => {
        void client.invoke('tasks.reveal', { taskId: selectedTask.id }).catch((error) => {
          notify('error', errorMessage(error));
        });
      },
    });
    paletteCommands.push({
      id: 'git:refresh',
      title: 'Refresh git status',
      detail: currentBranch ?? selectedTask.branch,
      keywords: 'reload changes diff',
      kind: 'action',
      run: bumpGit,
    });
    const gitAction = (
      id: string,
      title: string,
      keywords: string,
      run: () => Promise<{ output: string }>,
    ) => {
      paletteCommands.push({
        id,
        title,
        detail: currentBranch ?? selectedTask.branch,
        keywords,
        kind: 'action',
        run: () => {
          void run()
            .then((result) => notify('info', result.output || title))
            .catch((error) => notify('error', errorMessage(error)));
        },
      });
    };
    if (selectedTask) {
      gitAction('git:fetch', 'Fetch from remote', 'prune update origin', () =>
        client.invoke('git.fetch', { taskId: selectedTask.id }),
      );
      gitAction('git:pull', 'Pull (fast-forward only)', 'update upstream pull', () =>
        client.invoke('git.pull', { taskId: selectedTask.id }),
      );
    }
    paletteCommands.push({
      id: 'git:compare',
      title: 'Compare branches',
      detail: 'base, head and upstream',
      keywords: 'diff branches remote origin compare',
      kind: 'action',
      run: () => {
        rightLayout.openPanel();
        setRightTab('compare');
      },
    });
    paletteCommands.push({
      id: 'git:history',
      title: 'Show commit history',
      detail: currentBranch ?? selectedTask.branch,
      keywords: 'log commits past graph',
      kind: 'action',
      run: () => openGraph({ scope: 'head' }),
    });
  }
  if (selectedProject) {
    paletteCommands.push({
      id: 'task:new',
      title: 'New task',
      detail: selectedProject.name,
      keywords: 'create worktree branch',
      kind: 'action',
      run: () => openNewTask(selectedProject.id),
    });
  }
  paletteCommands.push({
    id: 'project:add',
    title: 'Add project',
    detail: 'register a git repository',
    keywords: 'open folder repository',
    kind: 'action',
    run: () => void addProject(),
  });
  paletteCommands.push({
    id: 'app:settings',
    title: 'Settings',
    detail: 'terminal appearance, harness commands and updates',
    keywords: 'preferences config options',
    kind: 'action',
    run: () => setSettingsOpen(true),
  });
  if (updateStatus?.state === 'downloaded') {
    paletteCommands.push({
      id: 'app:update',
      title: `Install Nest ${updateStatus.availableVersion ?? ''} and restart`,
      detail: 'downloaded update',
      keywords: 'upgrade update restart',
      kind: 'action',
      run: () => {
        void client.invoke('updates.install', {}).catch((error) => {
          notify('error', errorMessage(error));
        });
      },
    });
  }
  for (const section of RIGHT_SECTIONS) {
    paletteCommands.push({
      id: `panel:${section.id}`,
      title: `Show ${section.label} panel`,
      detail: 'right column',
      keywords: 'tab switch right column changes files sessions git',
      kind: 'action',
      run: () => {
        rightLayout.openPanel();
        setRightTab(section.id);
      },
    });
  }
  paletteCommands.push({
    id: 'panel:compare',
    title: 'Show Compare panel',
    detail: 'right column',
    keywords: 'tab switch right column branches diff',
    kind: 'action',
    run: () => {
      rightLayout.openPanel();
      setRightTab('compare');
    },
  });
  if (selectedTask) {
    paletteCommands.push({
      id: 'center:diff',
      title: 'Show diff in the center',
      detail: currentBranch ?? selectedTask.branch,
      keywords: 'patch changes working diff center',
      kind: 'action',
      run: openWholeDiff,
    });
    paletteCommands.push({
      id: 'center:graph',
      title: 'Show Git graph (all branches)',
      detail: currentBranch ?? selectedTask.branch,
      keywords: 'graph branches tree dag log commits history center',
      kind: 'action',
      run: () => openGraph({ scope: 'all' }),
    });
    paletteCommands.push({
      id: 'center:inspect-branch',
      title: 'Inspect branch…',
      detail: 'read another branch without checking it out',
      keywords: 'branch inspect browse compare remote tag',
      kind: 'action',
      run: inspectBranch,
    });
  }
  paletteCommands.push({
    id: 'panel:toggle',
    title: rightLayout.open ? 'Collapse right panel' : 'Expand right panel',
    detail: 'right column',
    keywords: 'hide show side panel layout',
    kind: 'action',
    run: () => rightLayout.toggle(),
  });
  paletteCommands.push({
    id: 'sidebar:toggle',
    title: 'Toggle left sidebar',
    detail: 'Ctrl+Shift+B',
    keywords: 'hide show left panel sidebar workspaces layout',
    kind: 'action',
    run: () => leftLayout.toggle(),
  });
  paletteCommands.push({
    id: 'sidebar:archive',
    title: 'Show archived workspaces',
    detail: 'left sidebar',
    keywords: 'archive restore deleted workspaces sidebar',
    kind: 'action',
    run: () => {
      leftLayout.openPanel();
      setArchiveOpen(true);
    },
  });
  if (selectedTask && selectedTask.status === 'active') {
    paletteCommands.push({
      id: 'sidebar:reveal',
      title: 'Reveal current workspace in sidebar',
      detail: selectedTask.kind === 'checkout' ? 'main checkout' : selectedTask.title,
      keywords: 'show find locate filter search sidebar workspace',
      kind: 'action',
      run: () => {
        leftLayout.openPanel();
        setArchiveOpen(false);
        setRevealNonce((nonce) => nonce + 1);
      },
    });
    paletteCommands.push({
      id: 'task:pin',
      title: selectedTask.pinned ? 'Unpin workspace' : 'Pin workspace',
      detail: selectedTask.kind === 'checkout' ? 'main checkout' : selectedTask.title,
      keywords: 'pin unpin keep top sidebar workspace',
      kind: 'action',
      run: () => void updateTask(selectedTask, { pinned: !selectedTask.pinned }),
    });
    for (const status of ['todo', 'in_progress', 'in_review', 'done'] as const) {
      paletteCommands.push({
        id: `task:status:${status}`,
        title: `Set workspace status: ${WORKFLOW_STATUS_LABELS[status]}`,
        detail: selectedTask.kind === 'checkout' ? 'main checkout' : selectedTask.title,
        keywords: 'workflow status stage review todo progress done',
        kind: 'action',
        run: () => void updateTask(selectedTask, { workflowStatus: status }),
      });
    }
    if (selectedTask.kind === 'worktree') {
      paletteCommands.push({
        id: 'task:rename',
        title: 'Rename workspace',
        detail: selectedTask.title,
        keywords: 'rename title workspace task',
        kind: 'action',
        run: () => {
          leftLayout.openPanel();
          setArchiveOpen(false);
          setRenameNonce((nonce) => nonce + 1);
        },
      });
      paletteCommands.push({
        id: 'task:archive',
        title: 'Archive workspace',
        detail: selectedTask.title,
        keywords: 'archive hide park workspace',
        kind: 'action',
        run: () => void archiveTask(selectedTask),
      });
    }
  }
  paletteCommands.push({
    id: 'app:palette',
    title: 'Command palette',
    detail: 'Ctrl+Shift+P',
    keywords: 'search commands',
    kind: 'action',
    run: () => setPaletteOpen(true),
  });

  if (loading) {
    return <BootSkeleton />;
  }

  if (loadError) {
    return (
      <FatalScreen
        title="Nest could not start"
        message={loadError}
        hint="Check that the data directory is readable and that another copy of Nest is not holding the database."
        actionLabel="Try again"
        onAction={() => void loadInitial()}
      />
    );
  }

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <div className="logo">n</div>
          <span className="brand-name">Nest</span>
        </div>

        <div className="breadcrumb">
          {selectedProject ? (
            <>
              <span className="crumb">{selectedProject.name}</span>
              <span className="crumb-sep">/</span>
            </>
          ) : null}
          <span className="crumb current">
            {selectedTask
              ? selectedTask.kind === 'checkout'
                ? 'main checkout'
                : selectedTask.title
              : 'no task'}
          </span>
        </div>

        <div className="titlebar-actions">
          {selectedTask ? (
            <Badge tone={selectedTask.kind === 'checkout' ? 'accent' : 'neutral'}>
              {currentBranch ?? '—'}
            </Badge>
          ) : null}
          <IconButton label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
            <GearIcon size={14} />
          </IconButton>
        </div>
      </header>

      <main
        className={[
          'columns',
          rightLayout.narrow ? 'columns-narrow' : '',
          leftLayout.narrow ? 'columns-left-narrow' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          gridTemplateColumns: `${
            leftLayout.open && !leftLayout.drawer
              ? `${leftLayout.width}px`
              : `${LEFT_PANEL_RAIL_WIDTH}px`
          } minmax(0, 1fr) ${
            rightLayout.open && !rightLayout.narrow
              ? `${rightLayout.width}px`
              : `${RIGHT_PANEL_RAIL_WIDTH}px`
          }`,
        }}
      >
        <Sidebar
          projects={projects}
          tasks={tasks}
          sessions={sessions}
          harnesses={visibleHarnesses}
          selectedTaskId={selectedTaskId}
          selectedSessionId={selectedSessionId}
          unread={unread}
          operations={operations}
          startFailures={startFailures}
          open={leftLayout.open}
          drawer={leftLayout.drawer}
          width={leftLayout.width}
          onWidthChange={leftLayout.setWidth}
          onClose={leftLayout.close}
          onOpenPanel={leftLayout.openPanel}
          archiveOpen={archiveOpen}
          onSetArchiveOpen={setArchiveOpen}
          renameNonce={renameNonce}
          revealNonce={revealNonce}
          onSelectTask={selectTask}
          onSelectSession={(session) => selectSession(session.id)}
          onStartSession={(taskId, harnessId) => void startSession(harnessId, taskId)}
          onStopTaskSessions={(task) => void stopTaskSessions(task)}
          onRetryStart={(taskId, harnessId) => void retryStartInTask(taskId, harnessId)}
          onAbortOperation={abortOperation}
          onAddProject={() => void addProject()}
          onAddProjectPath={(path) => void addProjectPath(path)}
          onOpenCheckout={(projectId) => void openCheckout(projectId)}
          onUpdateProject={(project, patch) => void updateProject(project, patch)}
          onOpenProjectSettings={(project) => {
            setProjectSettingsError(null);
            setProjectSettingsTarget(project);
          }}
          onRemoveProject={setRemoveProjectTarget}
          onRevealProject={(project) =>
            void client.invoke('projects.reveal', { projectId: project.id }).catch((error) => {
              notify('error', errorMessage(error));
            })
          }
          onReorderProjects={reorderProjects}
          onNewTask={openNewTask}
          onUpdateTask={(task, patch) => void updateTask(task, patch)}
          onReorderTasks={reorderTasks}
          onArchiveTask={(task) => void archiveTask(task)}
          onRestoreTask={(task) => void restoreTask(task)}
          onDeleteTask={setDeleteTaskTarget}
          onCleanUpArchived={(targets) => void cleanUpArchived(targets)}
          onRevealTask={revealTask}
          onCopyText={copyText}
        />

        <CenterPane
          client={client}
          task={selectedTask}
          hasProjects={projects.length > 0}
          sessions={selectedSessions}
          selectedSessionId={selectedSessionId}
          unread={unread}
          harnesses={visibleHarnesses}
          allHarnessesDisabled={allHarnessesDisabled}
          terminal={settings?.terminal ?? DEFAULT_TERMINAL_PREFERENCES}
          busy={busy}
          newSessionDefault={settings?.newSessionDefault ?? 'ask'}
          resumableHarnesses={resumableHarnesses}
          refreshKey={gitVersion}
          center={centerState}
          graphPickerNonce={graphPickerNonce}
          onSelectSession={selectSessionTab}
          onStart={(harnessId) => void startSession(harnessId)}
          onCloseSession={(session) => void closeSession(session)}
          onResume={(session) => void resumeSession(session)}
          onNewSession={restartSession}
          onError={reportError}
          onOpenPalette={openPalette}
          onOpenSettings={() => setSettingsOpen(true)}
          onAddProject={() => void addProject()}
          onGitChanged={bumpGit}
          onNotify={notify}
          onActivateSurface={(surface) => {
            if (!selectedTaskId) return;
            centerTabs.activateCenterSurface(selectedTaskId, surface);
          }}
          onCloseTab={(tab) => {
            if (!selectedTaskId) return;
            centerTabs.closeCenterTab(selectedTaskId, tab);
          }}
          graph={graphActions}
        />

        <RightPanel
          client={client}
          task={selectedTask}
          sessions={selectedSessions}
          selectedSessionId={selectedSessionId}
          unread={unread}
          tab={rightTab}
          onTabChange={setRightTab}
          refreshKey={gitVersion}
          onGitChanged={bumpGit}
          onNotify={notify}
          onSelectSession={selectSession}
          onStopSession={(sessionId) => void stopSession(sessionId)}
          onResumeSession={(session) => void resumeSession(session)}
          onNewSession={restartSession}
          resumableHarnesses={resumableHarnesses}
          changeCount={changeCount}
          open={rightLayout.open}
          drawer={rightLayout.drawer}
          width={rightLayout.width}
          onWidthChange={rightLayout.setWidth}
          onClose={rightLayout.close}
          onOpenPanel={rightLayout.openPanel}
          onOpenWorkingDiff={openWorkingDiff}
          onOpenWholeDiff={openWholeDiff}
          onOpenGraph={openGraph}
          onOpenCompareDiff={openCompareDiff}
        />
      </main>

      <footer className="statusbar">
        <span className="status-item">
          <span className="status-key">branch</span>
          {currentBranch ?? '—'}
        </span>
        <span className="status-item">
          <span className="status-key">workspace</span>
          {selectedTask ? shortPath(selectedTask.workspacePath, 60) : '—'}
        </span>
        <span className="status-item">
          <span className="status-key">sessions</span>
          {selectedSessions.length}
        </span>
        <span className="status-spacer" />
        {updateStatus?.state === 'downloaded' ? (
          <span className="status-item">
            <button
              className="status-update"
              onClick={() => setSettingsOpen(true)}
              title={updateStatus.message ?? 'Update ready'}
            >
              Update {updateStatus.availableVersion ?? ''} ready
            </button>
          </span>
        ) : null}
        {updateStatus?.state === 'error' ? (
          <span className="status-item">
            <button
              className="status-update error"
              onClick={() => setSettingsOpen(true)}
              title={updateStatus.message ?? 'Update check failed'}
            >
              Update check failed
            </button>
          </span>
        ) : null}
        {info ? (
          <span className="status-item muted">
            Electron {info.electron} ·{' '}
            {info.profile ? `profile ${info.profile}` : 'default profile'} · v{info.version}
          </span>
        ) : null}
      </footer>

      {newTaskProject ? (
        <NewTaskDialog
          client={client}
          project={newTaskProject}
          harnesses={visibleHarnesses}
          newSessionDefault={settings?.newSessionDefault ?? 'ask'}
          busy={newTaskBusy}
          step={newTaskStep}
          error={newTaskError}
          retryStart={newTaskRetry}
          initialBaseRef={newTaskBaseRef}
          onCreate={(submission) => void createTask(submission)}
          onCancel={cancelNewTask}
          onClose={closeNewTask}
          onRetryStart={() => void retryNewTaskStart()}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsDialog
          client={client}
          onClose={() => setSettingsOpen(false)}
          onSaved={(nextSettings) => {
            setSettings(nextSettings);
            setSettingsOpen(false);
            notify('info', 'Settings saved');
            void refreshHarnesses();
          }}
        />
      ) : null}

      {deleteTaskTarget ? (
        <DeleteTaskDialog
          client={client}
          task={deleteTaskTarget}
          project={projects.find((project) => project.id === deleteTaskTarget.projectId) ?? null}
          busy={deleteTaskBusy}
          onConfirm={(options) => void confirmDeleteTask(options)}
          onCancel={() => {
            if (!deleteTaskBusy) setDeleteTaskTarget(null);
          }}
        />
      ) : null}

      {removeProjectTarget ? (
        <RemoveProjectDialog
          project={removeProjectTarget}
          busy={removeProjectBusy}
          onConfirm={() => void confirmRemoveProject()}
          onCancel={() => {
            if (!removeProjectBusy) setRemoveProjectTarget(null);
          }}
        />
      ) : null}

      {projectSettingsTarget ? (
        <ProjectSettingsDialog
          project={projectSettingsTarget}
          busy={projectSettingsBusy}
          error={projectSettingsError}
          onSave={(patch) => void saveProjectSettings(patch)}
          onCancel={() => {
            if (projectSettingsBusy) return;
            setProjectSettingsTarget(null);
            setProjectSettingsError(null);
          }}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette items={paletteCommands} onClose={() => setPaletteOpen(false)} />
      ) : null}

      {toast ? (
        <div className={`toast toast-${toast.level}`} key={toast.id} role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
