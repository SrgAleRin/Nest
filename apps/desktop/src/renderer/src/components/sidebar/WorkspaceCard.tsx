import type { GitStatus, HarnessProfile, Session, Task, TaskWorkflowStatus } from '@nest/shared';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { StartFailure } from '../../newTask';
import { WORKFLOW_STATUS_LABELS, type WorkspaceItem } from '../../sidebarPlan';
import type { SidebarShownProperties } from '../../sidebarView';
import { changedPathCount } from '../../sourceControl';
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TerminalIcon,
} from '../Icons';
import { TaskNotesPopover } from './TaskNotesPopover';
import { WorkflowStatusIcon, WorkspaceStatusSlot } from './WorkspaceStatusSlot';

export interface GitBadge {
  files: number;
  ahead: number;
  behind: number;
}

/**
 * Compact git facts of a card: unique changed paths plus the upstream distance.
 * A task without a fetched status simply has no chip.
 */
export function formatGitBadge(status: GitStatus | null | undefined): GitBadge | null {
  if (!status) return null;
  return {
    files: changedPathCount(status.files),
    ahead: status.ahead,
    behind: status.behind,
  };
}

/**
 * Array move for manual drag and drop: the dragged id lands on the target's
 * index and everything between shifts by one. Unknown ids leave the list alone.
 */
export function reorderIds(ids: string[], draggedId: string, targetId: string): string[] {
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return ids;
  const next = [...ids];
  const moved = next.splice(from, 1)[0];
  if (moved === undefined) return ids;
  next.splice(to, 0, moved);
  return next;
}

/** Review flow order of the workflow picker and of a status cycle. */
export const WORKFLOW_STATUS_CYCLE: readonly TaskWorkflowStatus[] = [
  'todo',
  'in_progress',
  'in_review',
  'done',
];

/** The next stage in `todo -> in progress -> in review -> done -> todo`. */
export function nextWorkflowStatus(current: TaskWorkflowStatus): TaskWorkflowStatus {
  const index = WORKFLOW_STATUS_CYCLE.indexOf(current);
  return WORKFLOW_STATUS_CYCLE[(index + 1) % WORKFLOW_STATUS_CYCLE.length] ?? 'todo';
}

export interface WorkspaceCardProps {
  item: WorkspaceItem;
  selected: boolean;
  focused: boolean;
  compact: boolean;
  shownProperties: SidebarShownProperties;
  showProjectPrefix: boolean;
  /** Manual sorting is the only mode where a card can be dragged. */
  manualSortable: boolean;
  harnesses: HarnessProfile[];
  startFailure?: StartFailure;
  gitStatus?: GitStatus | null;
  selectedSessionId: string | null;
  renaming: boolean;
  editingNotes: boolean;
  onSelectTask: (taskId: string) => void;
  onSelectSession: (session: Session) => void;
  onStartSession: (taskId: string, harnessId: string) => void;
  onRetryStart: (taskId: string, harnessId: string) => void;
  onToggleUnread: (task: Task) => void;
  onSetWorkflowStatus: (task: Task, status: TaskWorkflowStatus) => void;
  onBeginRename: (taskId: string) => void;
  onCommitRename: (task: Task, title: string) => void;
  onCancelRename: () => void;
  onEditNotes: (taskId: string) => void;
  onSaveNotes: (task: Task, notes: string | null) => void;
  onCancelNotes: () => void;
  onOpenContextMenu: (item: WorkspaceItem, anchor: { x: number; y: number }) => void;
  onDragStartCard?: (taskId: string) => void;
  onDragOverCard?: (taskId: string) => void;
  onDropCard?: (targetTaskId: string) => void;
  onDragEndCard?: () => void;
  dragOver?: boolean;
}

interface RenameInputProps {
  task: Task;
  onCommit: (title: string) => void;
  onCancel: () => void;
}

/** In-place rename field: selects the current title and settles exactly once. */
function RenameInput({ task, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(task.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  const finish = (keep: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const title = value.trim();
    if (keep && title.length > 0 && title !== task.title) onCommit(title);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="ws-rename-input"
      value={value}
      aria-label="Task title"
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(true)}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(true);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

/**
 * One workspace row: status, title, attention badges, the workflow stage, the
 * meta facts the view asks for, and the inline editors for rename and notes.
 * Purely presentational: every mutation leaves through a prop.
 */
export function WorkspaceCard({
  item,
  selected,
  focused,
  compact,
  shownProperties,
  showProjectPrefix,
  manualSortable,
  harnesses,
  startFailure,
  gitStatus,
  selectedSessionId,
  renaming,
  editingNotes,
  onSelectTask,
  onSelectSession,
  onStartSession,
  onRetryStart,
  onToggleUnread,
  onSetWorkflowStatus,
  onBeginRename,
  onCommitRename,
  onCancelRename,
  onEditNotes,
  onSaveNotes,
  onCancelNotes,
  onOpenContextMenu,
  onDragStartCard,
  onDragOverCard,
  onDropCard,
  onDragEndCard,
  dragOver = false,
}: WorkspaceCardProps) {
  const { task, project, summary } = item;
  const [workflowPickerOpen, setWorkflowPickerOpen] = useState(false);
  const [harnessPickerOpen, setHarnessPickerOpen] = useState(false);
  const [liveSessionsOpen, setLiveSessionsOpen] = useState(false);
  const workflowRef = useRef<HTMLSpanElement | null>(null);
  const harnessRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!workflowPickerOpen && !harnessPickerOpen) return;

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (workflowRef.current?.contains(target)) return;
      if (harnessRef.current?.contains(target)) return;
      setWorkflowPickerOpen(false);
      setHarnessPickerOpen(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setWorkflowPickerOpen(false);
      setHarnessPickerOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [workflowPickerOpen, harnessPickerOpen]);

  const dragProps = manualSortable
    ? {
        draggable: true,
        onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
          event.dataTransfer.setData('text/plain', task.id);
          event.dataTransfer.effectAllowed = 'move';
          onDragStartCard?.(task.id);
        },
        onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
          event.preventDefault();
          onDragOverCard?.(task.id);
        },
        onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
          event.preventDefault();
          onDropCard?.(task.id);
        },
        onDragEnd: () => {
          onDragEndCard?.();
        },
      }
    : {};

  const availableHarnesses = harnesses.filter((harness) => harness.available);
  const gitBadge = shownProperties.gitChanges ? formatGitBadge(gitStatus) : null;
  const hasGitFacts =
    gitBadge !== null && (gitBadge.files > 0 || gitBadge.ahead > 0 || gitBadge.behind > 0);

  const cardClass = [
    'ws-card',
    selected ? 'selected' : '',
    focused ? 'focused' : '',
    compact ? 'compact' : '',
    dragOver ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cardClass}
      data-testid="workspace-card"
      data-task-id={task.id}
      data-task-kind={task.kind}
      data-status={summary.status}
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      onClick={() => onSelectTask(task.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenContextMenu(item, { x: event.clientX, y: event.clientY });
      }}
      {...dragProps}
    >
      <div className="ws-card-top">
        <WorkspaceStatusSlot
          status={summary.status}
          workflowStatus={task.workflowStatus}
          unreadCount={summary.unreadCount}
          onToggleUnread={() => onToggleUnread(task)}
        />

        <div className="ws-card-title">
          {showProjectPrefix ? <span className="ws-project-prefix">{project.name} /</span> : null}
          {task.kind === 'checkout' ? <span className="task-kind task-kind-main">main</span> : null}
          {renaming ? (
            <RenameInput
              task={task}
              onCommit={(title) => onCommitRename(task, title)}
              onCancel={onCancelRename}
            />
          ) : (
            <span
              className="ws-title"
              title={task.title}
              onDoubleClick={() => {
                if (selected && task.kind === 'worktree') onBeginRename(task.id);
              }}
            >
              {task.kind === 'checkout' ? 'main checkout' : task.title}
            </span>
          )}
        </div>

        <div className="ws-card-badges">
          {summary.unreadCount > 0 ? (
            <span className="unread-badge">{summary.unreadCount}</span>
          ) : null}
          {task.setupError ? (
            <span className="task-warn" title={task.setupError}>
              setup
            </span>
          ) : null}
          {startFailure ? (
            <button
              type="button"
              className="task-warn task-warn-action"
              title={startFailure.message}
              onClick={(event) => {
                event.stopPropagation();
                onRetryStart(task.id, startFailure.harnessId);
              }}
            >
              retry
            </button>
          ) : null}

          <span className="ws-wf-chip-wrap" ref={workflowRef}>
            <button
              type="button"
              className="ws-wf-chip"
              title={WORKFLOW_STATUS_LABELS[task.workflowStatus]}
              aria-label={`Workflow status: ${WORKFLOW_STATUS_LABELS[task.workflowStatus]}`}
              aria-expanded={workflowPickerOpen}
              onClick={(event) => {
                event.stopPropagation();
                setHarnessPickerOpen(false);
                setWorkflowPickerOpen((open) => !open);
              }}
            >
              <WorkflowStatusIcon status={task.workflowStatus} size={14} />
            </button>
            {workflowPickerOpen ? (
              <div
                className="ws-wf-picker"
                role="menu"
                aria-label="Workflow status"
                onClick={(event) => event.stopPropagation()}
              >
                {WORKFLOW_STATUS_CYCLE.map((status) => (
                  <button
                    key={status}
                    type="button"
                    role="menuitemradio"
                    aria-checked={status === task.workflowStatus}
                    className={`ws-wf-option ${status === task.workflowStatus ? 'active' : ''}`.trim()}
                    onClick={() => {
                      setWorkflowPickerOpen(false);
                      onSetWorkflowStatus(task, status);
                    }}
                  >
                    <WorkflowStatusIcon status={status} size={13} />
                    <span>{WORKFLOW_STATUS_LABELS[status]}</span>
                    {status === task.workflowStatus ? <CheckIcon size={13} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        </div>

        <div className="ws-card-actions" ref={harnessRef}>
          <button
            type="button"
            className="ws-card-action"
            aria-label="New session in workspace"
            title="New session in workspace"
            onClick={(event) => {
              event.stopPropagation();
              setWorkflowPickerOpen(false);
              setHarnessPickerOpen((open) => !open);
            }}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="ws-card-action"
            aria-label="Workspace actions"
            title="Workspace actions"
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenContextMenu(item, { x: rect.left, y: rect.bottom });
            }}
          >
            <MoreHorizontalIcon size={14} />
          </button>
          {harnessPickerOpen ? (
            <div
              className="ws-harness-picker"
              role="menu"
              aria-label="New session in workspace"
              onClick={(event) => event.stopPropagation()}
            >
              {availableHarnesses.length > 0 ? (
                availableHarnesses.map((harness) => (
                  <button
                    key={harness.id}
                    type="button"
                    role="menuitem"
                    className="ws-harness-option"
                    title={harness.description}
                    onClick={() => {
                      setHarnessPickerOpen(false);
                      onStartSession(task.id, harness.id);
                    }}
                  >
                    <TerminalIcon size={13} />
                    <span>{harness.label}</span>
                  </button>
                ))
              ) : (
                <div className="ws-harness-empty">No harness available</div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {!compact ? (
        <div className="ws-card-meta">
          {shownProperties.branch ? (
            <span className="ws-branch" title={task.branch}>
              <BranchIcon size={10} />
              <span>{task.branch}</span>
            </span>
          ) : null}

          {hasGitFacts && gitBadge ? (
            <span className="ws-git" title={`${gitBadge.files} changed files`}>
              {gitBadge.files > 0 ? (
                <span className="ws-git-files">{`• ${gitBadge.files}`}</span>
              ) : null}
              {gitBadge.ahead > 0 ? (
                <span className="ws-git-ahead">{`↑${gitBadge.ahead}`}</span>
              ) : null}
              {gitBadge.behind > 0 ? (
                <span className="ws-git-behind">{`↓${gitBadge.behind}`}</span>
              ) : null}
            </span>
          ) : null}

          {shownProperties.agentActivity && summary.agentLabel ? (
            <span className="ws-agents" title={summary.agentLabel}>
              <span className="ws-agents-label">{summary.agentLabel}</span>
              {summary.liveSessions.length > 1 ? (
                <button
                  type="button"
                  className="ws-agents-toggle"
                  aria-label="Toggle live sessions"
                  aria-expanded={liveSessionsOpen}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLiveSessionsOpen((open) => !open);
                  }}
                >
                  <ChevronIcon size={13} />
                </button>
              ) : null}
            </span>
          ) : null}

          {shownProperties.notes && task.notes ? (
            <button
              type="button"
              className="ws-notes-chip"
              title={task.notes}
              aria-label="Edit notes"
              onClick={(event) => {
                event.stopPropagation();
                onEditNotes(task.id);
              }}
            >
              <FileTextIcon size={12} />
            </button>
          ) : null}
        </div>
      ) : null}

      {liveSessionsOpen && summary.liveSessions.length > 1 ? (
        <div className="ws-live-sessions">
          {summary.liveSessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`ws-live-session ${session.id === selectedSessionId ? 'selected' : ''}`.trim()}
              title={`${session.harnessId} · ${session.status}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelectSession(session);
              }}
            >
              <span className={`dot dot-${session.status}`} />
              <span className="ws-live-session-title">{session.title}</span>
            </button>
          ))}
        </div>
      ) : null}

      {editingNotes ? (
        <TaskNotesPopover
          task={task}
          onSave={(notes) => onSaveNotes(task, notes)}
          onCancel={onCancelNotes}
        />
      ) : null}
    </div>
  );
}
