import type { HarnessProfile, Project, Task, TaskWorkflowStatus } from '@nest/shared';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import {
  ArchiveIcon,
  BranchIcon,
  CircleIcon,
  EyeIcon,
  FileTextIcon,
  FolderOpenIcon,
  PinIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from '../Icons';

const STATUS_ITEMS: Array<{ status: TaskWorkflowStatus; label: string }> = [
  { status: 'todo', label: 'Todo' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
];

export interface WorkspaceContextMenuProps {
  task: Task;
  project: Project | null;
  /** Profiles the picker may offer; unavailable ones stay visible but disabled. */
  harnesses: HarnessProfile[];
  /** A session of this task is running right now. */
  hasLiveSessions: boolean;
  /** The task has activity the user has not opened yet. */
  hasUnread: boolean;
  /** Viewport position of the right click. */
  anchor: { x: number; y: number };
  onClose: () => void;
  onNewSession: (harnessId: string) => void;
  onTogglePin: () => void;
  onSetStatus: (status: TaskWorkflowStatus) => void;
  onToggleUnread: () => void;
  onRename: () => void;
  onEditNotes: () => void;
  onNewTaskFromBranch: () => void;
  onStopSessions: () => void;
  onReveal: () => void;
  onCopy: (value: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}

/**
 * The right-click menu of a workspace row. Every action is also reachable from
 * the row itself or the command palette; the menu exists so a pointer user does
 * not have to hunt for the one tiny button that does what they need.
 */
export function WorkspaceContextMenu({
  task,
  project,
  harnesses,
  hasLiveSessions,
  hasUnread,
  anchor,
  onClose,
  onNewSession,
  onTogglePin,
  onSetStatus,
  onToggleUnread,
  onRename,
  onEditNotes,
  onNewTaskFromBranch,
  onStopSessions,
  onReveal,
  onCopy,
  onArchive,
  onDelete,
}: WorkspaceContextMenuProps) {
  const isCheckout = task.kind === 'checkout';

  const sessionItems: ContextMenuItem[] =
    harnesses.length > 0
      ? harnesses.map((harness) => ({
          label: harness.label,
          detail: harness.available ? harness.description : 'Not available on this machine',
          disabled: !harness.available,
          onSelect: () => onNewSession(harness.id),
        }))
      : [{ label: 'No harnesses available', disabled: true }];

  const items: ContextMenuItem[] = [
    {
      label: 'New session',
      icon: <PlusIcon size={12} />,
      submenu: sessionItems,
    },
    {
      label: task.pinned ? 'Unpin' : 'Pin',
      icon: <PinIcon size={12} />,
      checked: task.pinned,
      onSelect: onTogglePin,
    },
    {
      label: 'Status',
      icon: <CircleIcon size={12} />,
      submenu: STATUS_ITEMS.map((entry) => ({
        label: entry.label,
        checked: task.workflowStatus === entry.status,
        onSelect: () => onSetStatus(entry.status),
      })),
    },
    {
      label: hasUnread ? 'Mark as read' : 'Mark as unread',
      icon: <EyeIcon size={12} />,
      onSelect: onToggleUnread,
    },
    { kind: 'separator' },
    {
      label: 'Rename…',
      icon: <FileTextIcon size={12} />,
      shortcut: 'F2',
      disabled: isCheckout,
      detail: isCheckout ? 'The main checkout cannot be renamed' : undefined,
      onSelect: onRename,
    },
    {
      label: 'Edit notes…',
      icon: <FileTextIcon size={12} />,
      onSelect: onEditNotes,
    },
    {
      label: 'New task from this branch…',
      icon: <BranchIcon size={12} />,
      onSelect: onNewTaskFromBranch,
    },
    { kind: 'separator' },
    ...(hasLiveSessions
      ? [
          {
            label: 'Stop running sessions',
            icon: <StopIcon size={12} />,
            onSelect: onStopSessions,
          } satisfies ContextMenuItem,
        ]
      : []),
    {
      label: 'Reveal in Explorer',
      icon: <FolderOpenIcon size={12} />,
      onSelect: onReveal,
    },
    {
      label: 'Copy',
      submenu: [
        {
          label: 'Workspace path',
          detail: task.workspacePath,
          onSelect: () => onCopy(task.workspacePath),
        },
        {
          label: 'Branch name',
          detail: task.branch,
          onSelect: () => onCopy(task.branch),
        },
        {
          label: 'Task name',
          detail: task.title,
          onSelect: () => onCopy(task.title),
        },
      ],
    },
    { kind: 'separator' },
    {
      label: 'Archive workspace',
      icon: <ArchiveIcon size={12} />,
      disabled: isCheckout,
      detail: isCheckout ? 'Main checkout cannot be archived' : undefined,
      onSelect: onArchive,
    },
    {
      label: 'Delete worktree…',
      icon: <TrashIcon size={12} />,
      danger: true,
      disabled: isCheckout,
      detail: isCheckout
        ? 'Main checkout cannot be deleted — remove the project instead'
        : undefined,
      onSelect: onDelete,
    },
  ];

  return (
    <ContextMenu
      anchor={anchor}
      items={items}
      onClose={onClose}
      label={`${project?.name ?? 'Workspace'} actions`}
    />
  );
}
