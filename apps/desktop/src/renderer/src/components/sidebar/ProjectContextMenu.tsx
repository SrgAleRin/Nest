import type { Project } from '@nest/shared';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { FolderOpenIcon, GearIcon, PlusIcon, SlidersIcon, TrashIcon } from '../Icons';

export interface ProjectContextMenuProps {
  project: Project;
  /** Viewport position of the right click. */
  anchor: { x: number; y: number };
  onClose: () => void;
  onNewTask: () => void;
  onOpenCheckout: () => void;
  onOpenSettings: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onHideProject: () => void;
  onRemoveProject: () => void;
}

/**
 * The right-click menu of a project header: create work, open the main
 * checkout, change the project's own settings, or take the project out of the
 * sidebar without touching anything on disk.
 */
export function ProjectContextMenu({
  project,
  anchor,
  onClose,
  onNewTask,
  onOpenCheckout,
  onOpenSettings,
  onReveal,
  onCopyPath,
  onHideProject,
  onRemoveProject,
}: ProjectContextMenuProps) {
  const items: ContextMenuItem[] = [
    {
      label: 'New task…',
      icon: <PlusIcon size={12} />,
      shortcut: 'Ctrl+N',
      onSelect: onNewTask,
    },
    {
      label: 'Open main checkout',
      icon: <FolderOpenIcon size={12} />,
      onSelect: onOpenCheckout,
    },
    {
      label: 'Project settings…',
      icon: <SlidersIcon size={12} />,
      onSelect: onOpenSettings,
    },
    { kind: 'separator' },
    {
      label: 'Reveal in Explorer',
      icon: <FolderOpenIcon size={12} />,
      onSelect: onReveal,
    },
    {
      label: 'Copy path',
      detail: project.path,
      onSelect: onCopyPath,
    },
    { kind: 'separator' },
    {
      label: 'Hide project from sidebar',
      icon: <GearIcon size={12} />,
      onSelect: onHideProject,
    },
    {
      label: 'Remove project from Nest…',
      icon: <TrashIcon size={12} />,
      danger: true,
      onSelect: onRemoveProject,
    },
  ];

  return (
    <ContextMenu
      anchor={anchor}
      items={items}
      onClose={onClose}
      label={`${project.name} actions`}
    />
  );
}
