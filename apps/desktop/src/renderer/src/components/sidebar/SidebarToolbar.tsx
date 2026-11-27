import type { Project } from '@nest/shared';
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { SidebarViewState } from '../../sidebarView';
import { PanelLeftCloseIcon, PlusIcon, SearchIcon, SlidersIcon } from '../Icons';
import { SidebarOptionsMenu } from './SidebarOptionsMenu';

export interface SidebarToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  view: SidebarViewState;
  projects: Project[];
  /** Number of active filter rules; drives the corner badge. */
  activeFilters: number;
  onUpdateView: (updater: (prev: SidebarViewState) => SidebarViewState) => void;
  onCollapse: () => void;
  /** Default project new task, or `Add project` while no project exists. */
  onNewTaskDefault: () => void;
  onNewTaskForProject: (projectId: string) => void;
  onAddProject: () => void;
}

/**
 * The sidebar head: collapse, search, view options and the split create button.
 * The two popovers are local to the toolbar and close on an outside pointer
 * down or Escape, so they never obey a shortcut meant for the list behind them.
 */
export function SidebarToolbar({
  searchQuery,
  onSearchChange,
  searchInputRef,
  view,
  projects,
  activeFilters,
  onUpdateView,
  onCollapse,
  onNewTaskDefault,
  onNewTaskForProject,
  onAddProject,
}: SidebarToolbarProps) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const newMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!optionsOpen && !newMenuOpen) return;

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (optionsOpen && optionsRef.current?.contains(target)) return;
      if (newMenuOpen && newMenuRef.current?.contains(target)) return;
      setOptionsOpen(false);
      setNewMenuOpen(false);
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOptionsOpen(false);
      setNewMenuOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [optionsOpen, newMenuOpen]);

  const visibleProjects = projects.filter((project) => !project.hidden);

  const closeMenus = () => {
    setOptionsOpen(false);
    setNewMenuOpen(false);
  };

  return (
    <div className="sidebar-toolbar">
      <button
        type="button"
        className="sidebar-collapse-btn"
        title="Collapse sidebar (Ctrl+Shift+B)"
        aria-label="Collapse sidebar"
        onClick={onCollapse}
      >
        <PanelLeftCloseIcon size={14} />
      </button>

      <div className="sidebar-search">
        <SearchIcon size={12} />
        <input
          ref={searchInputRef}
          type="search"
          placeholder="Search workspaces…"
          aria-label="Search workspaces"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || searchQuery.length === 0) return;
            // Escape in a filled search box clears it instead of collapsing the panel.
            event.preventDefault();
            event.stopPropagation();
            onSearchChange('');
          }}
        />
        {searchQuery.length > 0 ? (
          <button
            type="button"
            className="sidebar-search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => {
              onSearchChange('');
              searchInputRef?.current?.focus();
            }}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="sidebar-options" ref={optionsRef}>
        <button
          type="button"
          className="sidebar-options-btn"
          title="Workspace options"
          aria-label="Workspace options"
          aria-expanded={optionsOpen}
          onClick={() => {
            setNewMenuOpen(false);
            setOptionsOpen((open) => !open);
          }}
        >
          <SlidersIcon size={13} />
          {activeFilters > 0 ? (
            <span className="sidebar-filter-badge">
              {activeFilters > 9 ? '9+' : String(activeFilters)}
            </span>
          ) : null}
        </button>
        {optionsOpen ? (
          <SidebarOptionsMenu
            view={view}
            projects={projects}
            onUpdateView={onUpdateView}
            onClose={() => setOptionsOpen(false)}
          />
        ) : null}
      </div>

      <div className="sidebar-new-split" ref={newMenuRef}>
        <button
          type="button"
          className="sidebar-new-primary"
          title="New task"
          aria-label="New task"
          onClick={onNewTaskDefault}
        >
          <PlusIcon size={13} />
        </button>
        <button
          type="button"
          className="sidebar-new-caret"
          title="New task options"
          aria-label="New task options"
          aria-expanded={newMenuOpen}
          onClick={() => {
            setOptionsOpen(false);
            setNewMenuOpen((open) => !open);
          }}
        >
          ▾
        </button>
        {newMenuOpen ? (
          <div className="sidebar-new-menu" role="menu" aria-label="New task">
            <button
              type="button"
              role="menuitem"
              className="sidebar-new-item"
              onClick={() => {
                closeMenus();
                onNewTaskDefault();
              }}
            >
              <span>New task…</span>
              <span className="sidebar-new-shortcut">Ctrl+N</span>
            </button>
            {visibleProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="sidebar-new-item"
                onClick={() => {
                  closeMenus();
                  onNewTaskForProject(project.id);
                }}
              >
                {project.name}
              </button>
            ))}
            <div className="sidebar-new-separator" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="sidebar-new-item"
              onClick={() => {
                closeMenus();
                onAddProject();
              }}
            >
              Add project…
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
