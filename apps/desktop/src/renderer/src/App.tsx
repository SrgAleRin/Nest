import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo, HarnessProfile, Project, Session, Task, TaskProgressStep } from '@nest/shared';
import { Badge, Button, Spinner } from '@nest/ui';
import { NewTaskDialog, type NewTaskSubmission } from './components/NewTaskDialog';
import { RightPanel } from './components/RightPanel';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { createClient } from './rpc/client';
import { emitSessionData } from './state/terminalBus';
import { errorMessage, shortPath, upsert } from './utils';

interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

function pickTaskId(tasks: Task[], current: string | null): string | null {
  if (current && tasks.some((task) => task.id === current)) return current;
  return tasks.find((task) => task.kind === 'checkout')?.id ?? tasks[0]?.id ?? null;
}

export function App() {
  const client = useMemo(createClient, []);

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessProfile[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [gitVersions, setGitVersions] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [taskProgress, setTaskProgress] = useState<{
    projectId: string;
    step: TaskProgressStep;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => {
      setToast({ id: Date.now(), level, message });
    },
    [],
  );

  const reportError = useCallback(
    (message: string) => notify('error', message),
    [notify],
  );

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const gitVersion = selectedTaskId ? (gitVersions[selectedTaskId] ?? 0) : 0;
  const selectedProject =
    projects.find((project) => project.id === selectedTask?.projectId) ?? null;
  const selectedSessions = useMemo(
    () => sessions.filter((session) => session.taskId === selectedTaskId),
    [sessions, selectedTaskId],
  );
  const newTaskProject = projects.find((project) => project.id === newTaskProjectId) ?? null;
  const resumableHarnesses = useMemo(
    () =>
      new Set(
        harnesses.filter((harness) => harness.resumeArgs.length > 0).map((harness) => harness.id),
      ),
    [harnesses],
  );

  const refreshAll = useCallback(async () => {
    try {
      const [nextProjects, nextTasks, nextSessions] = await Promise.all([
        client.invoke('projects.list', {}),
        client.invoke('tasks.list', {}),
        client.invoke('sessions.list', {}),
      ]);
      setProjects(nextProjects);
      setTasks(nextTasks);
      setSessions(nextSessions);
      setSelectedTaskId((current) => pickTaskId(nextTasks, current));
    } catch (error) {
      notify('error', errorMessage(error));
    }
  }, [client, notify]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextInfo, nextHarnesses] = await Promise.all([
          client.invoke('app.info', {}),
          client.invoke('harness.list', {}),
        ]);
        const [nextProjects, nextTasks, nextSessions] = await Promise.all([
          client.invoke('projects.list', {}),
          client.invoke('tasks.list', {}),
          client.invoke('sessions.list', {}),
        ]);
        if (cancelled) return;
        setInfo(nextInfo);
        setHarnesses(nextHarnesses);
        setProjects(nextProjects);
        setTasks(nextTasks);
        setSessions(nextSessions);
        setSelectedTaskId((current) => pickTaskId(nextTasks, current));
      } catch (error) {
        if (!cancelled) notify('error', errorMessage(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, notify]);

  useEffect(() => {
    return client.on((event) => {
      switch (event.type) {
        case 'session:data':
          emitSessionData(event.sessionId, event.data);
          return;
        case 'session:status':
          setSessions((prev) => upsert(prev, event.session));
          return;
        case 'task:updated':
          setTasks((prev) => upsert(prev, event.task));
          return;
        case 'task:progress':
          setTaskProgress({ projectId: event.projectId, step: event.step });
          return;
        case 'git:changed':
          // Changes are reported per task: watching every workspace must not
          // refetch the panels of the task the user is looking at.
          setGitVersions((prev) => ({
            ...prev,
            [event.taskId]: (prev[event.taskId] ?? 0) + 1,
          }));
          return;
        case 'notification':
          notify(event.level, event.message);
          return;
        default:
          return;
      }
    });
  }, [client, notify]);

  useEffect(() => {
    setSelectedSessionId((current) => {
      const list = sessions.filter((session) => session.taskId === selectedTaskId);
      if (current && list.some((session) => session.id === current)) return current;
      const live = list.filter(
        (session) => session.status === 'running' || session.status === 'idle',
      );
      return live[live.length - 1]?.id ?? list[list.length - 1]?.id ?? null;
    });
  }, [selectedTaskId, sessions]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const addProject = useCallback(async () => {
    try {
      const directory = await client.invoke('dialog.pickDirectory', {});
      if (!directory) return;
      const { project, checkout } = await client.invoke('projects.add', { path: directory });
      setProjects((prev) => upsert(prev, project));
      setTasks((prev) => upsert(prev, checkout));
      setSelectedTaskId(checkout.id);
      notify('info', `Added ${project.name}`);
    } catch (error) {
      notify('error', errorMessage(error));
    }
  }, [client, notify]);

  const removeProject = useCallback(
    async (project: Project) => {
      if (!window.confirm(`Remove ${project.name} from Nest? Worktrees stay on disk.`)) return;
      try {
        await client.invoke('projects.remove', { projectId: project.id });
        setProjects((prev) => prev.filter((candidate) => candidate.id !== project.id));
        await refreshAll();
      } catch (error) {
        notify('error', errorMessage(error));
      }
    },
    [client, notify, refreshAll],
  );

  const createTask = useCallback(
    async (submission: NewTaskSubmission) => {
      if (!newTaskProjectId) return;
      setBusy(true);
      try {
        if (submission.location === 'checkout') {
          const task = await client.invoke('tasks.openCheckout', { projectId: newTaskProjectId });
          setTasks((prev) => upsert(prev, task));
          setSelectedTaskId(task.id);
          setNewTaskProjectId(null);
          notify('info', `Opened main checkout of ${shortPath(task.workspacePath, 48)}`);
          return;
        }

        const task = await client.invoke('tasks.create', {
          projectId: newTaskProjectId,
          title: submission.title ?? '',
          ...(submission.baseBranch ? { baseBranch: submission.baseBranch } : {}),
          ...(submission.setupScript !== undefined
            ? { setupScript: submission.setupScript }
            : {}),
        });
        setTasks((prev) => upsert(prev, task));
        setProjects((prev) =>
          prev.map((project) =>
            project.id === newTaskProjectId && submission.setupScript !== undefined
              ? { ...project, setupScript: submission.setupScript || null }
              : project,
          ),
        );
        setSelectedTaskId(task.id);
        setNewTaskProjectId(null);
        if (task.setupError) {
          notify('warn', `Created ${task.branch}, but setup failed: ${task.setupError}`);
        } else {
          notify('info', `Created ${task.branch} in ${shortPath(task.workspacePath, 48)}`);
        }
      } catch (error) {
        notify('error', errorMessage(error));
      } finally {
        setBusy(false);
        setTaskProgress(null);
      }
    },
    [client, newTaskProjectId, notify],
  );

  const removeTask = useCallback(
    async (task: Task) => {
      let changes: string[] = [];
      try {
        const status = await client.invoke('git.status', { taskId: task.id });
        changes = status.files.map((file) => file.path);
      } catch {
        // The workspace may already be gone; removeTask still has to work.
      }

      const preview =
        changes.slice(0, 15).join('\n') +
        (changes.length > 15 ? `\n…and ${changes.length - 15} more` : '');
      const message =
        changes.length > 0
          ? `Worktree of "${task.title}" has ${changes.length} uncommitted ` +
            `change${changes.length === 1 ? '' : 's'}:\n\n${preview}\n\n` +
            'Remove the task and discard these changes?'
          : `Remove task "${task.title}" and its worktree?`;
      if (!window.confirm(message)) return;

      const remove = async (force: boolean) => {
        await client.invoke('tasks.remove', { taskId: task.id, force });
        setTasks((prev) => prev.filter((candidate) => candidate.id !== task.id));
        await refreshAll();
      };

      try {
        await remove(changes.length > 0);
      } catch (error) {
        // The status may have changed between the check and the removal.
        if (error instanceof Error && error.name === 'workspace_dirty') {
          if (
            window.confirm(
              `${error.message}\n\nDelete anyway? The worktree and its uncommitted changes will be lost.`,
            )
          ) {
            try {
              await remove(true);
            } catch (forceError) {
              notify('error', errorMessage(forceError));
            }
          }
          return;
        }
        notify('error', errorMessage(error));
      }
    },
    [client, notify, refreshAll],
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
        setSessions((prev) => upsert(prev, session));
        setSelectedTaskId(targetTaskId);
        setSelectedSessionId(session.id);
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
        setSessions((prev) => upsert(prev, resumed));
        setSelectedTaskId(session.taskId);
        setSelectedSessionId(session.id);
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

  const selectSession = useCallback(
    (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session) setSelectedTaskId(session.taskId);
      setSelectedSessionId(sessionId);
    },
    [sessions],
  );

  const bumpGit = useCallback(() => {
    if (!selectedTaskId) return;
    setGitVersions((prev) => ({
      ...prev,
      [selectedTaskId]: (prev[selectedTaskId] ?? 0) + 1,
    }));
  }, [selectedTaskId]);

  if (loading) {
    return (
      <div className="boot">
        <div className="logo large">n</div>
        <div className="boot-row">
          <Spinner /> Starting Nest…
        </div>
      </div>
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
              {selectedTask.branch}
            </Badge>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={!selectedProject || busy}
            onClick={() => selectedProject && setNewTaskProjectId(selectedProject.id)}
          >
            New task
          </Button>
        </div>
      </header>

      <main className="columns">
        <Sidebar
          projects={projects}
          tasks={tasks}
          sessions={sessions}
          selectedTaskId={selectedTaskId}
          selectedSessionId={selectedSessionId}
          profile={info?.profile ?? null}
          onSelectTask={setSelectedTaskId}
          onSelectSession={(session) => selectSession(session.id)}
          onAddProject={() => void addProject()}
          onRemoveProject={(project) => void removeProject(project)}
          onRevealProject={(project) =>
            void client.invoke('projects.reveal', { projectId: project.id }).catch((error) => {
              notify('error', errorMessage(error));
            })
          }
          onNewTask={setNewTaskProjectId}
          onRemoveTask={(task) => void removeTask(task)}
        />

        <TerminalPane
          client={client}
          task={selectedTask}
          sessions={selectedSessions}
          selectedSessionId={selectedSessionId}
          harnesses={harnesses}
          busy={busy}
          onSelectSession={setSelectedSessionId}
          onStart={(harnessId) => void startSession(harnessId)}
          onResume={(session) => void resumeSession(session)}
          onNewSession={restartSession}
          resumableHarnesses={resumableHarnesses}
          onError={reportError}
        />

        <RightPanel
          client={client}
          task={selectedTask}
          sessions={selectedSessions}
          selectedSessionId={selectedSessionId}
          refreshKey={gitVersion}
          onGitChanged={bumpGit}
          onNotify={notify}
          onSelectSession={selectSession}
          onStopSession={(sessionId) => void stopSession(sessionId)}
          onResumeSession={(session) => void resumeSession(session)}
          onNewSession={restartSession}
          resumableHarnesses={resumableHarnesses}
        />
      </main>

      <footer className="statusbar">
        <span className="status-item">
          <span className="status-key">branch</span>
          {selectedTask?.branch ?? '—'}
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
        {info ? (
          <span className="status-item muted">
            Electron {info.electron} · {info.profile ? `profile ${info.profile}` : 'default profile'} ·
            v{info.version}
          </span>
        ) : null}
      </footer>

      {newTaskProject ? (
        <NewTaskDialog
          project={newTaskProject}
          busy={busy}
          step={
            taskProgress && taskProgress.projectId === newTaskProject.id
              ? taskProgress.step
              : null
          }
          onClose={() => setNewTaskProjectId(null)}
          onSubmit={(submission) => void createTask(submission)}
        />
      ) : null}

      {toast ? (
        <div className={`toast toast-${toast.level}`} key={toast.id} role="status">
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}
