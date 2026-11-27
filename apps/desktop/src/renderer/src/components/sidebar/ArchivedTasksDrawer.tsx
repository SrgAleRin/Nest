import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project, Task } from '@nest/shared';
import { ArchiveIcon, RestoreIcon, SearchIcon, TrashIcon } from '../Icons';
import { relativeTime } from '../../utils';

/**
 * Archived tasks, filtered by anything the user remembers about them: the
 * title, the branch or the project name. An empty query keeps the list as is.
 */
export function filterArchivedTasks(tasks: Task[], projects: Project[], query: string): Task[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tasks;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return tasks.filter((task) => {
    const projectName = projectNames.get(task.projectId) ?? '';
    return [task.title, task.branch, projectName].some((value) =>
      value.toLowerCase().includes(needle),
    );
  });
}

interface ArchivedTasksDrawerProps {
  /** Archived tasks, newest first. */
  tasks: Task[];
  projects: Project[];
  /** The task whose restore or delete is running. */
  busyTaskId?: string | null;
  /** The clean-up of every archived task is running. */
  cleaningAll?: boolean;
  onBack: () => void;
  onRestore: (task: Task) => void;
  onDelete: (task: Task) => void;
  onCleanUpAll: () => void;
}

/**
 * The archive view replaces the workspace list inside the sidebar instead of
 * opening a separate window: restoring a task is one click away from the list
 * it returns to, and the terminal stays where it is.
 */
export function ArchivedTasksDrawer({
  tasks,
  projects,
  busyTaskId = null,
  cleaningAll = false,
  onBack,
  onRestore,
  onDelete,
  onCleanUpAll,
}: ArchivedTasksDrawerProps) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const visible = filterArchivedTasks(tasks, projects, query);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // A dialog opened from the archive owns Escape while it is on screen.
      if (document.querySelector('.modal-overlay')) return;
      event.preventDefault();
      event.stopPropagation();
      // The first Escape clears a search, the second leaves the archive; a
      // search the user typed is never thrown away by the same key press.
      if (query) setQuery('');
      else onBack();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [query, onBack]);

  return (
    <section className="archived-drawer" aria-label="Archived workspaces">
      <header className="archived-head">
        <button type="button" className="archived-back" onClick={onBack}>
          <span aria-hidden="true">←</span> Back to workspaces
        </button>
        <span className="archived-title">Archived ({tasks.length})</span>
        {tasks.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm archived-clean"
            disabled={cleaningAll}
            onClick={onCleanUpAll}
          >
            {cleaningAll ? 'Cleaning up…' : 'Clean up all archived…'}
          </button>
        ) : null}
      </header>

      <div className="archived-search">
        <SearchIcon size={12} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search archived workspaces"
          aria-label="Search archived workspaces"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="archived-list">
        {visible.length === 0 ? (
          <p className="archived-empty">
            {tasks.length === 0
              ? 'No archived workspaces yet.'
              : `No archived workspace matches “${query.trim()}”.`}
          </p>
        ) : (
          visible.map((task) => {
            const busy = busyTaskId === task.id;
            return (
              <article className="archived-row" key={task.id}>
                <div className="archived-row-main">
                  <div className="archived-row-title" title={task.title}>
                    <ArchiveIcon size={12} />
                    <span>{task.title}</span>
                  </div>
                  <div className="archived-row-meta">
                    <span className="archived-project">
                      {projectNames.get(task.projectId) ?? '—'}
                    </span>
                    <span className="archived-branch" title={task.branch}>
                      {task.branch}
                    </span>
                    {task.archivedAt ? (
                      <span className="archived-time">{relativeTime(task.archivedAt)}</span>
                    ) : null}
                  </div>
                </div>
                <div className="archived-row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    title="Restore this workspace"
                    onClick={() => onRestore(task)}
                  >
                    <RestoreIcon size={11} /> Restore
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm danger"
                    disabled={busy}
                    title="Delete the worktree of this archived workspace"
                    onClick={() => onDelete(task)}
                  >
                    <TrashIcon size={11} /> Delete worktree…
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
