import type { TaskWorkflowStatus } from '@nest/shared';
import type { ComponentType } from 'react';
import { WORKFLOW_STATUS_LABELS, type TaskCardStatus } from '../../sidebarPlan';
import { CheckCircleIcon, CircleIcon, ClockIcon, EyeIcon } from '../Icons';

const WORKFLOW_ICONS: Record<TaskWorkflowStatus, ComponentType<{ size?: number }>> = {
  todo: CircleIcon,
  in_progress: ClockIcon,
  in_review: EyeIcon,
  done: CheckCircleIcon,
};

export interface WorkflowStatusIconProps {
  status: TaskWorkflowStatus;
  size?: number;
}

/** Stage icon shared by the status slot, the workflow chip and a status header. */
export function WorkflowStatusIcon({ status, size = 12 }: WorkflowStatusIconProps) {
  const Icon = WORKFLOW_ICONS[status];
  return <Icon size={size} />;
}

export interface WorkspaceStatusSlotProps {
  status: TaskCardStatus;
  workflowStatus: TaskWorkflowStatus;
  unreadCount: number;
  onToggleUnread?: () => void;
}

/**
 * The leading status column of a workspace card. Unread output is the only
 * interactive state; every other state is a dot, and an inactive task shows the
 * stage it sits in.
 */
export function WorkspaceStatusSlot({
  status,
  workflowStatus,
  unreadCount,
  onToggleUnread,
}: WorkspaceStatusSlotProps) {
  if (status === 'unread') {
    return (
      <span className="ws-status-slot">
        <button
          type="button"
          className="ws-status-btn ws-status-unread"
          title="Mark as read"
          aria-label={unreadCount > 1 ? `Mark as read (${unreadCount} unread)` : 'Mark as read'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleUnread?.();
          }}
        >
          <span className="ws-status-dot ws-dot-unread" />
        </button>
      </span>
    );
  }

  if (status === 'inactive') {
    return (
      <span className="ws-status-slot">
        <span
          className={`ws-workflow-icon ws-wf-${workflowStatus}`}
          title={WORKFLOW_STATUS_LABELS[workflowStatus]}
        >
          <WorkflowStatusIcon status={workflowStatus} />
        </span>
      </span>
    );
  }

  const dot =
    status === 'failed'
      ? { className: 'ws-dot-failed', title: 'Failed' }
      : status === 'working'
        ? { className: 'ws-dot-working', title: 'Working' }
        : { className: 'ws-dot-idle', title: 'Waiting / idle' };

  return (
    <span className="ws-status-slot">
      <span className={`ws-status-dot ${dot.className}`} title={dot.title} />
    </span>
  );
}
