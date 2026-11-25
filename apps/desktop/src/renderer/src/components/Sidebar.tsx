import type { Project, Session, Task } from '@nest/shared';
import { IconButton } from '@nest/ui';
import {
  BranchIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  TerminalIcon,
  TrashIcon,
} from './Icons';
import { relativeTime } from '../utils';

interface SidebarProps {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  profile: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (session: Session) => void;
  onAddProject: () => void;
  onRemoveProject: (project: Project) => void;
  onRevealProject: (project: Project) => void;
  onNewTask: (projectId: string) => void;
  onRemoveTask: (task: Task) => void;
}

export function Sidebar(props: SidebarProps) {
  const { projects, tasks, sessions, selectedTaskId, selectedSessionId } = props;
  const live = sessions.filter(
    (session) => session.status === 'running' || session.status === 'idle',
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="section-label">Projects</span>
        <IconButton label="Add project" onClick={props.onAddProject}>
          <PlusIcon />
        </IconButton>
      </div>

      <div className="sidebar-scroll">
        {live.length > 0 ? (
          <div className="running">
            <div className="section-label">Running</div>
            {live.map((session) => {
              const task = tasks.find((candidate) => candidate.id === session.taskId);
              const project = projects.find((candidate) => candidate.id === task?.projectId);
              return (
                <button
                  className={`running-row ${
                    session.id === selectedSessionId ? 'selected' : ''
                  }`}
                  key={session.id}
                  onClick={() => props.onSelectSession(session)}
                  title={`${project?.name ?? ''} · ${task?.branch ?? ''} · ${session.status}`}
                >
                  <span className={`dot dot-${session.status}`} />
                  <span className="running-name">{session.title}</span>
                  <span className="running-context">
                    {project?.name ?? '—'}
                    {task?.kind === 'checkout' ? ' · main' : task ? ` · ${task.title}` : ''}
                  </span>
                </button>
              );
            })}
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
                {projectTasks.map((task) => {
                  const taskSessions = sessions.filter((session) => session.taskId === task.id);
                  const active = task.id === selectedTaskId;
                  return (
                    <div className="task-block" key={task.id}>
                      <div className={`task-row ${active ? 'selected' : ''}`}>
                        <button
                          className="task-select"
                          onClick={() => props.onSelectTask(task.id)}
                        >
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
                        </button>
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

                      {active
                        ? taskSessions.map((session) => (
                            <button
                              className={`session-row ${
                                session.id === selectedSessionId ? 'selected' : ''
                              }`}
                              key={session.id}
                              onClick={() => props.onSelectSession(session)}
                              title={`${session.harnessId} · ${session.status}`}
                            >
                              <span className={`dot dot-${session.status}`} />
                              <TerminalIcon size={11} />
                              <span className="session-name">{session.title}</span>
                              <span className="session-time">{relativeTime(session.updatedAt)}</span>
                            </button>
                          ))
                        : null}

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
        <span className="profile-chip">{props.profile ? `profile: ${props.profile}` : 'default profile'}</span>
      </div>
    </aside>
  );
}
