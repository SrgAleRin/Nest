import type { Project, Session, Task } from '@nest/shared';
import { IconButton } from '@nest/ui';
import { BranchIcon, FolderIcon, FolderOpenIcon, PlusIcon, TerminalIcon, TrashIcon } from './Icons';
import { collectActivity, type ActivityItem, type ActivityKind } from '../activity';
import { STEP_LABELS, type StartFailure } from '../newTask';
import type { TaskOperations } from '../state/taskOperations';
import { relativeTime } from '../utils';

interface SidebarProps {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  /** Finished sessions whose output the user has not opened yet. */
  unread: Record<string, number>;
  /** Creations in flight: a pending row per operation, with its current step. */
  operations: TaskOperations;
  /** Task id → why its harness did not start after the task was created. */
  startFailures: Record<string, StartFailure>;
  profile: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (session: Session) => void;
  onAddProject: () => void;
  onRemoveProject: (project: Project) => void;
  onRevealProject: (project: Project) => void;
  onNewTask: (projectId: string) => void;
  onRemoveTask: (task: Task) => void;
  /** Retry the start step of a task that exists already; never a new worktree. */
  onRetryStart: (taskId: string, harnessId: string) => void;
}

const ACTIVITY_GROUPS: Array<{ kind: ActivityKind; label: string }> = [
  { kind: 'working', label: 'Working' },
  { kind: 'idle', label: 'Idle' },
  { kind: 'finished', label: 'Finished' },
];

export function Sidebar(props: SidebarProps) {
  const { projects, tasks, sessions, selectedTaskId, selectedSessionId } = props;
  const activity = collectActivity({ sessions, unread: props.unread, selectedSessionId });
  const groups = ACTIVITY_GROUPS.map((group) => ({
    ...group,
    items: activity[group.kind],
  })).filter((group) => group.items.length > 0);

  const renderActivity = (item: ActivityItem) => {
    const session = item.session;
    const task = tasks.find((candidate) => candidate.id === session.taskId);
    const project = projects.find((candidate) => candidate.id === task?.projectId);
    return (
      <button
        className={`activity-row activity-${item.kind} ${
          session.id === selectedSessionId ? 'selected' : ''
        }`}
        key={`${item.kind}:${session.id}`}
        onClick={() => props.onSelectSession(session)}
        title={`${project?.name ?? ''} · ${task?.branch ?? ''} · ${item.kind}`}
      >
        <span className={`activity-dot activity-dot-${item.kind}`} />
        <span className="activity-name">{session.title}</span>
        {props.unread[session.id] ? (
          <span className="unread-badge" title="Finished while you were away">
            {props.unread[session.id]}
          </span>
        ) : null}
        <span className="activity-context">
          {project?.name ?? '—'}
          {task?.kind === 'checkout' ? ' · main' : task ? ` · ${task.title}` : ''}
        </span>
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="section-label">Projects</span>
        <IconButton label="Add project" onClick={props.onAddProject}>
          <PlusIcon />
        </IconButton>
      </div>

      <div className="sidebar-scroll">
        {groups.length > 0 ? (
          <div className="activity">
            <div className="section-label">Activity</div>
            {groups.map((group) => (
              <div className="activity-group" key={group.kind}>
                <div className="activity-heading">
                  <span>{group.label}</span>
                  <span className="activity-count">{group.items.length}</span>
                </div>
                {group.items.map(renderActivity)}
              </div>
            ))}
          </div>
        ) : null}
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>No projects yet.</p>
            <button className="link-btn" onClick={props.onAddProject}>
              Add a git repository
            </button>
          </div>
        ) : null}

        {projects.map((project) => {
          const projectTasks = tasks.filter((task) => task.projectId === project.id);
          const pendingOperations = props.operations.filter(
            (operation) => operation.projectId === project.id,
          );
          return (
            <div className="project" key={project.id}>
              <div className="project-row">
                <FolderIcon />
                <div className="project-name" title={project.path}>
                  {project.name}
                </div>
                <div className="project-actions">
                  <IconButton
                    label="New task"
                    onClick={() => props.onNewTask(project.id)}
                    className="tiny"
                  >
                    <PlusIcon size={12} />
                  </IconButton>
                  <IconButton
                    label="Reveal in Explorer"
                    onClick={() => props.onRevealProject(project)}
                    className="tiny"
                  >
                    <FolderOpenIcon size={12} />
                  </IconButton>
                  <IconButton
                    label="Remove project"
                    onClick={() => props.onRemoveProject(project)}
                    className="tiny"
                  >
                    <TrashIcon size={12} />
                  </IconButton>
                </div>
              </div>

              <div className="task-list">
                {pendingOperations.map((operation) => (
                  <div
                    className="task-row pending"
                    key={operation.operationId}
                    data-testid="pending-task"
                    title={operation.title}
                  >
                    <span className="task-spinner" aria-hidden="true" />
                    <span className="task-name">{operation.title}</span>
                    <span className="task-step">
                      {operation.step ? STEP_LABELS[operation.step] : 'Starting…'}
                    </span>
                  </div>
                ))}
                {projectTasks.map((task) => {
                  const taskSessions = sessions.filter((session) => session.taskId === task.id);
                  const active = task.id === selectedTaskId;
                  const taskUnread = taskSessions.reduce(
                    (sum, session) => sum + (props.unread[session.id] ?? 0),
                    0,
                  );
                  return (
                    <div className="task-block" key={task.id}>
                      <div className={`task-row ${active ? 'selected' : ''}`}>
                        <button className="task-select" onClick={() => props.onSelectTask(task.id)}>
                          {task.kind === 'checkout' ? (
                            <span className="task-kind task-kind-main">main</span>
                          ) : (
                            <BranchIcon size={12} />
                          )}
                          <span className="task-name" title={task.branch}>
                            {task.kind === 'checkout' ? 'main checkout' : task.title}
                          </span>
                          {task.setupError ? (
                            <span className="task-warn" title={task.setupError}>
                              setup
                            </span>
                          ) : null}

                          {taskSessions.length > 0 ? (
                            <span className="task-count">{taskSessions.length}</span>
                          ) : null}
                          {taskUnread > 0 ? (
                            <span className="unread-badge" title="Unread in this task">
                              {taskUnread}
                            </span>
                          ) : null}
                        </button>
                        {props.startFailures[task.id] ? (
                          <button
                            className="task-warn task-warn-action"
                            title={props.startFailures[task.id]?.message}
                            onClick={() => {
                              const failure = props.startFailures[task.id];
                              if (failure) props.onRetryStart(task.id, failure.harnessId);
                            }}
                          >
                            start failed · retry
                          </button>
                        ) : null}
                        {task.kind === 'worktree' ? (
                          <IconButton
                            label="Remove task"
                            onClick={() => props.onRemoveTask(task)}
                            className="tiny task-remove"
                          >
                            <TrashIcon size={11} />
                          </IconButton>
                        ) : null}
                      </div>

                      {taskSessions.map((session) => (
                        <button
                          className={`session-row ${active ? '' : 'inactive'} ${
                            session.id === selectedSessionId ? 'selected' : ''
                          }`}
                          key={session.id}
                          onClick={() => props.onSelectSession(session)}
                          title={`${session.harnessId} · ${session.status}`}
                        >
                          <span className={`dot dot-${session.status}`} />
                          <TerminalIcon size={11} />
                          <span className="session-name">{session.title}</span>
                          {props.unread[session.id] ? (
                            <span className="unread-badge" title="Finished while you were away">
                              {props.unread[session.id]}
                            </span>
                          ) : null}
                          <span className="session-time">{relativeTime(session.updatedAt)}</span>
                        </button>
                      ))}

                      {active && taskSessions.length === 0 ? (
                        <div className="task-hint">no sessions yet</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <span className="profile-chip">
          {props.profile ? `profile: ${props.profile}` : 'default profile'}
        </span>
      </div>
    </aside>
  );
}
