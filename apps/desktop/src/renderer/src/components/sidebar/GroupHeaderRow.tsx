import type { Project } from '@nest/shared';
import type { DragEvent as ReactDragEvent } from 'react';
import type { SidebarRow } from '../../sidebarPlan';
import { ChevronIcon, FolderIcon, MoreHorizontalIcon, PinIcon, PlusIcon } from '../Icons';
import { WorkflowStatusIcon } from './WorkspaceStatusSlot';

export type GroupHeaderRowData = Extract<SidebarRow, { kind: 'pinned-header' | 'group-header' }>;

export interface GroupHeaderRowProps {
  row: GroupHeaderRowData;
  focused: boolean;
  /** Project headers can be dragged only while the order is manual. */
  manualProjectSortable?: boolean;
  onToggleCollapse: (key: string) => void;
  onNewTask?: (projectId: string) => void;
  onOpenProjectMenu?: (project: Project, anchor: { x: number; y: number }) => void;
  onDragStartProject?: (projectId: string) => void;
  onDragOverProject?: (projectId: string) => void;
  onDropProject?: (projectId: string) => void;
  onDragEndProject?: () => void;
  dragOver?: boolean;
}

/**
 * A section header: pinned tasks, a project or a workflow status. The whole row
 * toggles its group; the row keeps its own actions for a project, and while a
 * group is folded it still shows what is waiting inside.
 */
export function GroupHeaderRow({
  row,
  focused,
  manualProjectSortable = false,
  onToggleCollapse,
  onNewTask,
  onOpenProjectMenu,
  onDragStartProject,
  onDragOverProject,
  onDropProject,
  onDragEndProject,
  dragOver = false,
}: GroupHeaderRowProps) {
  const project =
    row.kind === 'group-header' && row.groupType === 'project' ? row.project : undefined;
  const workflowStatus = row.kind === 'group-header' ? row.workflowStatus : undefined;

  const dragProps =
    project && manualProjectSortable
      ? {
          draggable: true,
          onDragStart: (event: ReactDragEvent<HTMLDivElement>) => {
            event.dataTransfer.setData('text/plain', project.id);
            event.dataTransfer.effectAllowed = 'move';
            onDragStartProject?.(project.id);
          },
          onDragOver: (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            onDragOverProject?.(project.id);
          },
          onDrop: (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            onDropProject?.(project.id);
          },
          onDragEnd: () => {
            onDragEndProject?.();
          },
        }
      : {};

  const className = [
    'ws-group-header',
    row.collapsed ? 'collapsed' : 'expanded',
    focused ? 'focused' : '',
    dragOver ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      role="button"
      tabIndex={focused ? 0 : -1}
      aria-expanded={!row.collapsed}
      onClick={() => onToggleCollapse(row.key)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggleCollapse(row.key);
      }}
      onContextMenu={
        project
          ? (event) => {
              event.preventDefault();
              onOpenProjectMenu?.(project, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
      {...dragProps}
    >
      <span className="ws-group-chevron" aria-hidden="true">
        <ChevronIcon size={11} />
      </span>
      <span className="ws-group-icon" aria-hidden="true">
        {row.kind === 'pinned-header' ? (
          <PinIcon size={12} />
        ) : workflowStatus ? (
          <WorkflowStatusIcon status={workflowStatus} size={12} />
        ) : (
          <FolderIcon size={12} />
        )}
      </span>
      <span className="ws-group-label">
        {row.kind === 'pinned-header' ? (
          'Pinned'
        ) : row.groupType === 'project' ? (
          <span className="project-name">{row.label}</span>
        ) : (
          row.label
        )}
      </span>
      <span className="ws-group-count">{row.count}</span>

      {row.collapsed ? (
        <span className="ws-group-summary">
          {row.failedCount > 0 ? (
            <span className="ws-group-dot ws-dot-failed" title="Failed" />
          ) : null}
          {row.activeCount > 0 ? (
            <span className="ws-group-active" title="Active">
              <span className="ws-group-dot ws-dot-working" />
              {row.activeCount}
            </span>
          ) : null}
          {row.unreadCount > 0 ? <span className="unread-badge">{row.unreadCount}</span> : null}
        </span>
      ) : null}

      {project ? (
        <span className="ws-group-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="ws-group-action"
            aria-label="New task"
            title="New task"
            onClick={() => onNewTask?.(project.id)}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="ws-group-action"
            aria-label="Project actions"
            title="Project actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenProjectMenu?.(project, { x: rect.left, y: rect.bottom });
            }}
          >
            <MoreHorizontalIcon size={14} />
          </button>
        </span>
      ) : null}
    </div>
  );
}
