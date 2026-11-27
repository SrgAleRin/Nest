import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_FILTERS,
  DEFAULT_SIDEBAR_VIEW,
  SIDEBAR_VIEW_STORAGE_KEY,
  activeFilterCount,
  parseSidebarView,
  readSidebarView,
  resetSidebarFilters,
  revealTaskFilters,
  serializeSidebarView,
  setGroupCollapsed,
  toggleCollapsedGroup,
  writeSidebarView,
  type SidebarFilters,
  type SidebarStorage,
  type SidebarViewState,
} from './sidebarView';

function memoryStorage(initial: Record<string, string> = {}): SidebarStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

function filters(overrides: Partial<SidebarFilters>): SidebarFilters {
  return { ...DEFAULT_SIDEBAR_FILTERS, projectIds: [], ...overrides };
}

function view(overrides: Partial<SidebarViewState>): SidebarViewState {
  return { ...DEFAULT_SIDEBAR_VIEW, filters: filters({}), ...overrides };
}

const worktree = { projectId: 'p1', kind: 'worktree' } as const;
const checkout = { projectId: 'p1', kind: 'checkout' } as const;

describe('defaults', () => {
  it('groups by project, sorts smartly and shows every property', () => {
    expect(DEFAULT_SIDEBAR_VIEW.groupBy).toBe('project');
    expect(DEFAULT_SIDEBAR_VIEW.sortBy).toBe('smart');
    expect(DEFAULT_SIDEBAR_VIEW.projectOrderBy).toBe('manual');
    expect(DEFAULT_SIDEBAR_VIEW.cardLayout).toBe('detailed');
    expect(DEFAULT_SIDEBAR_VIEW.collapsedGroups).toEqual({});
    expect(DEFAULT_SIDEBAR_VIEW.shownProperties).toEqual({
      branch: true,
      gitChanges: true,
      agentActivity: true,
      notes: true,
    });
    expect(DEFAULT_SIDEBAR_VIEW.filters).toEqual({
      projectIds: [],
      hideInactive: false,
      exceptMainCheckout: true,
      hideMainCheckout: false,
    });
  });
});

describe('persisted view', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const stored = view({
      groupBy: 'status',
      sortBy: 'recent',
      cardLayout: 'compact',
      collapsedGroups: { 'status:active': true },
      filters: filters({ projectIds: ['p1'], hideInactive: true }),
      shownProperties: { branch: false, gitChanges: true, agentActivity: false, notes: true },
    });

    writeSidebarView(storage, stored);

    expect(readSidebarView(storage)).toEqual(stored);
    expect(readSidebarView(memoryStorage())).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(readSidebarView(null)).toEqual(DEFAULT_SIDEBAR_VIEW);
  });

  it('recovers from malformed storage', () => {
    const storage = memoryStorage({ [SIDEBAR_VIEW_STORAGE_KEY]: '{"groupBy":' });
    expect(readSidebarView(storage)).toEqual(DEFAULT_SIDEBAR_VIEW);

    expect(parseSidebarView(null)).toBeNull();
    expect(parseSidebarView('')).toBeNull();
    expect(parseSidebarView('{')).toBeNull();
    expect(parseSidebarView('null')).toBeNull();
    expect(parseSidebarView('[]')).toBeNull();
    expect(parseSidebarView('"project"')).toBeNull();
  });

  it('keeps valid fields and defaults the invalid ones', () => {
    const parsed = parseSidebarView(
      JSON.stringify({
        groupBy: 'status',
        sortBy: 'sideways',
        projectOrderBy: 'recent',
        cardLayout: 'huge',
        shownProperties: { branch: false, gitChanges: 'yes' },
        collapsedGroups: { 'project:p1': true, 'project:p2': false },
        filters: { projectIds: ['p1', 7, 'p1'], hideInactive: true, hideMainCheckout: 'no' },
      }),
    );

    expect(parsed).toEqual({
      groupBy: 'status',
      sortBy: 'smart',
      projectOrderBy: 'recent',
      cardLayout: 'detailed',
      shownProperties: { branch: false, gitChanges: true, agentActivity: true, notes: true },
      collapsedGroups: { 'project:p1': true },
      filters: {
        projectIds: ['p1'],
        hideInactive: true,
        exceptMainCheckout: true,
        hideMainCheckout: false,
      },
    });
  });

  it('parses a partial object without losing the rest of the defaults', () => {
    expect(parseSidebarView('{"groupBy":"none"}')).toEqual(view({ groupBy: 'none' }));
    expect(serializeSidebarView(DEFAULT_SIDEBAR_VIEW)).toContain('"cardLayout":"detailed"');
  });
});

describe('filters', () => {
  it('counts the rules that are narrowing the list', () => {
    expect(activeFilterCount(filters({}))).toBe(0);
    // `exceptMainCheckout` only modifies `hideInactive`, so it is not a rule.
    expect(activeFilterCount(filters({ exceptMainCheckout: false }))).toBe(0);
    expect(activeFilterCount(filters({ projectIds: ['p1'] }))).toBe(1);
    expect(activeFilterCount(filters({ hideInactive: true }))).toBe(1);
    expect(activeFilterCount(filters({ hideMainCheckout: true }))).toBe(1);
    expect(
      activeFilterCount(
        filters({ projectIds: ['p1', 'p2'], hideInactive: true, hideMainCheckout: true }),
      ),
    ).toBe(3);
  });

  it('resets every rule', () => {
    const reset = resetSidebarFilters();
    expect(reset).toEqual(DEFAULT_SIDEBAR_FILTERS);
    expect(activeFilterCount(reset)).toBe(0);
    // A fresh object, so the caller can keep mutating its copy.
    expect(reset.projectIds).not.toBe(DEFAULT_SIDEBAR_FILTERS.projectIds);
  });

  describe('revealing a hidden task', () => {
    it('leaves a visible task alone and returns the same view', () => {
      const current = view({});
      expect(revealTaskFilters(current, worktree, false)).toBe(current);
      expect(revealTaskFilters(view({}), checkout, false)).toEqual(view({}));
    });

    it('adds the project to a project filter instead of clearing it', () => {
      const current = view({ filters: filters({ projectIds: ['p2'], hideInactive: true }) });
      const revealed = revealTaskFilters(current, worktree, false);

      expect(revealed.filters.projectIds).toEqual(['p2', 'p1']);
      // The unrelated rule survives.
      expect(revealed.filters.hideInactive).toBe(true);
      expect(current.filters.projectIds).toEqual(['p2']);
      expect(revealTaskFilters(revealed, worktree, false)).toBe(revealed);
    });

    it('unhides the main checkout but keeps the other checkout rules', () => {
      const current = view({ filters: filters({ hideMainCheckout: true }) });
      const revealed = revealTaskFilters(current, checkout, false);

      expect(revealed.filters.hideMainCheckout).toBe(false);
      expect(revealed.filters.hideInactive).toBe(false);
      // A worktree is not hidden by the main-checkout rule.
      const worktreeView = view({ filters: filters({ hideMainCheckout: true }) });
      expect(revealTaskFilters(worktreeView, worktree, false)).toBe(worktreeView);
    });

    it('unhides an inactive task only when hideInactive blocks it', () => {
      const current = view({ filters: filters({ hideInactive: true, exceptMainCheckout: false }) });
      expect(revealTaskFilters(current, worktree, true).filters.hideInactive).toBe(false);

      // Active tasks and the excepted main checkout are not blocked by the rule.
      const active = view({ filters: filters({ hideInactive: true }) });
      expect(revealTaskFilters(active, worktree, false)).toBe(active);
      expect(revealTaskFilters(active, checkout, true)).toBe(active);

      const noException = view({
        filters: filters({ hideInactive: true, exceptMainCheckout: false }),
      });
      expect(revealTaskFilters(noException, checkout, true).filters.hideInactive).toBe(false);
    });
  });
});

describe('collapsed groups', () => {
  it('toggles a group key without touching the others', () => {
    const current = view({ collapsedGroups: { 'project:p2': true } });
    const collapsed = toggleCollapsedGroup(current, 'project:p1');

    expect(collapsed.collapsedGroups).toEqual({ 'project:p2': true, 'project:p1': true });
    expect(current.collapsedGroups).toEqual({ 'project:p2': true });
    expect(toggleCollapsedGroup(collapsed, 'project:p1').collapsedGroups).toEqual({
      'project:p2': true,
    });
  });

  it('sets a known state and ignores a no-op', () => {
    const current = view({});
    expect(setGroupCollapsed(current, 'project:p1', true).collapsedGroups).toEqual({
      'project:p1': true,
    });
    expect(setGroupCollapsed(current, 'project:p1', false)).toBe(current);

    const collapsed = setGroupCollapsed(current, 'project:p1', true);
    expect(setGroupCollapsed(collapsed, 'project:p1', true)).toBe(collapsed);
    expect(setGroupCollapsed(collapsed, 'project:p1', false).collapsedGroups).toEqual({});
  });
});
