import type { Project } from '@nest/shared';
import type { ReactNode } from 'react';
import {
  activeFilterCount,
  resetSidebarFilters,
  type SidebarCardLayout,
  type SidebarFilters,
  type SidebarGroupBy,
  type SidebarProjectOrderBy,
  type SidebarShownProperties,
  type SidebarSortBy,
  type SidebarViewState,
} from '../../sidebarView';

const GROUP_BY_OPTIONS: ReadonlyArray<{ value: SidebarGroupBy; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'status', label: 'Status' },
  { value: 'none', label: 'None' },
];

const SORT_BY_OPTIONS: ReadonlyArray<{ value: SidebarSortBy; label: string }> = [
  { value: 'smart', label: 'Agent Activity' },
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'manual', label: 'Manual' },
];

const PROJECT_ORDER_OPTIONS: ReadonlyArray<{ value: SidebarProjectOrderBy; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'recent', label: 'Recent' },
];

const CARD_LAYOUT_OPTIONS: ReadonlyArray<{ value: SidebarCardLayout; label: string }> = [
  { value: 'detailed', label: 'Detailed' },
  { value: 'compact', label: 'Compact' },
];

const SHOWN_PROPERTY_OPTIONS: ReadonlyArray<{
  key: keyof SidebarShownProperties;
  label: string;
}> = [
  { key: 'branch', label: 'Branch name' },
  { key: 'gitChanges', label: 'Git changes' },
  { key: 'agentActivity', label: 'Agent activity' },
  { key: 'notes', label: 'Notes' },
];

export interface SidebarOptionsMenuProps {
  view: SidebarViewState;
  projects: Project[];
  onUpdateView: (updater: (prev: SidebarViewState) => SidebarViewState) => void;
  onClose: () => void;
}

/** Adds or removes one project id; an empty list means every project shows. */
function toggleProjectId(ids: string[], projectId: string): string[] {
  return ids.includes(projectId) ? ids.filter((id) => id !== projectId) : [...ids, projectId];
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ws-options-section">
      <div className="ws-options-label">{label}</div>
      <div className="ws-options-body">{children}</div>
    </div>
  );
}

interface OptionRowProps<T extends string> {
  name: string;
  value: T;
  current: T;
  label: string;
  onSelect: (value: T) => void;
}

function OptionRow<T extends string>({ name, value, current, label, onSelect }: OptionRowProps<T>) {
  return (
    <label className="ws-option">
      <input
        type="radio"
        name={name}
        checked={value === current}
        onChange={() => onSelect(value)}
      />
      <span>{label}</span>
    </label>
  );
}

interface CheckRowProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

function CheckRow({ label, checked, disabled = false, onChange }: CheckRowProps) {
  return (
    <label className="ws-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * The workspace view options behind the sliders button: grouping, sorting,
 * card layout, the properties a card shows and the filter rules. Every change
 * goes through `onUpdateView`, so the parent stays the single owner of the view
 * preference and its persistence.
 */
export function SidebarOptionsMenu({
  view,
  projects,
  onUpdateView,
  onClose,
}: SidebarOptionsMenuProps) {
  const visibleProjects = projects.filter((project) => !project.hidden);
  const filters = view.filters;
  const filterCount = activeFilterCount(filters);

  const updateFilters = (patch: Partial<SidebarFilters>) =>
    onUpdateView((prev) => ({ ...prev, filters: { ...prev.filters, ...patch } }));

  const setShownProperty = (key: keyof SidebarShownProperties, value: boolean) =>
    onUpdateView((prev) => ({
      ...prev,
      shownProperties: { ...prev.shownProperties, [key]: value },
    }));

  return (
    <div
      className="sidebar-options-popover"
      role="dialog"
      aria-label="Workspace options"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <Section label="Group by">
        {GROUP_BY_OPTIONS.map((option) => (
          <OptionRow
            key={option.value}
            name="sidebar-group-by"
            value={option.value}
            current={view.groupBy}
            label={option.label}
            onSelect={(groupBy) => onUpdateView((prev) => ({ ...prev, groupBy }))}
          />
        ))}
      </Section>

      <Section label="Sort by">
        {SORT_BY_OPTIONS.map((option) => (
          <OptionRow
            key={option.value}
            name="sidebar-sort-by"
            value={option.value}
            current={view.sortBy}
            label={option.label}
            onSelect={(sortBy) => onUpdateView((prev) => ({ ...prev, sortBy }))}
          />
        ))}
      </Section>

      {view.groupBy === 'project' ? (
        <Section label="Project order">
          {PROJECT_ORDER_OPTIONS.map((option) => (
            <OptionRow
              key={option.value}
              name="sidebar-project-order"
              value={option.value}
              current={view.projectOrderBy}
              label={option.label}
              onSelect={(projectOrderBy) => onUpdateView((prev) => ({ ...prev, projectOrderBy }))}
            />
          ))}
        </Section>
      ) : null}

      <Section label="Card layout">
        {CARD_LAYOUT_OPTIONS.map((option) => (
          <OptionRow
            key={option.value}
            name="sidebar-card-layout"
            value={option.value}
            current={view.cardLayout}
            label={option.label}
            onSelect={(cardLayout) => onUpdateView((prev) => ({ ...prev, cardLayout }))}
          />
        ))}
      </Section>

      {view.cardLayout === 'detailed' ? (
        <Section label="Show properties">
          {SHOWN_PROPERTY_OPTIONS.map((option) => (
            <CheckRow
              key={option.key}
              label={option.label}
              checked={view.shownProperties[option.key]}
              onChange={(checked) => setShownProperty(option.key, checked)}
            />
          ))}
        </Section>
      ) : null}

      <Section label="Filters">
        {visibleProjects.length > 1 ? (
          <div className="ws-filter-projects" aria-label="Projects to show">
            {visibleProjects.map((project) => {
              const active = filters.projectIds.includes(project.id);
              return (
                <button
                  key={project.id}
                  type="button"
                  className={`ws-filter-pill ${active ? 'active' : ''}`.trim()}
                  aria-pressed={active}
                  onClick={() =>
                    updateFilters({
                      projectIds: toggleProjectId(filters.projectIds, project.id),
                    })
                  }
                >
                  {project.name}
                </button>
              );
            })}
          </div>
        ) : null}

        <CheckRow
          label="Hide inactive workspaces"
          checked={filters.hideInactive}
          onChange={(hideInactive) => updateFilters({ hideInactive })}
        />

        {filters.hideInactive ? (
          <label className="ws-check ws-check-nested">
            <input
              type="checkbox"
              checked={filters.exceptMainCheckout}
              onChange={(event) => updateFilters({ exceptMainCheckout: event.target.checked })}
            />
            <span>Except main checkout</span>
          </label>
        ) : null}

        <CheckRow
          label="Hide main checkout"
          checked={filters.hideMainCheckout}
          onChange={(hideMainCheckout) => updateFilters({ hideMainCheckout })}
        />

        {filterCount > 0 ? (
          <button
            type="button"
            className="ws-filter-reset"
            onClick={() => onUpdateView((prev) => ({ ...prev, filters: resetSidebarFilters() }))}
          >
            Reset filters
          </button>
        ) : null}
      </Section>
    </div>
  );
}
