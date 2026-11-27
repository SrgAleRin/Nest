import { describe, expect, it } from 'vitest';
import {
  EMPTY_CENTER_STATE,
  activateCenterSurface,
  closeCenterTab,
  createCenterTabsStore,
  forgetTaskCenter,
  forgetTaskViews,
  openCompareDiff,
  openGraph,
  openWorkingDiff,
  type CenterTabsStore,
} from './centerTabs';

describe('center tabs', () => {
  describe('pure transitions', () => {
    it('opens the working diff and drops a compare target it replaced', () => {
      const compared = openCompareDiff(EMPTY_CENTER_STATE, {
        base: 'main',
        head: 'nest/a',
        path: 'app.ts',
      });
      expect(compared.active).toBe('diff');
      expect(compared.diffOpen).toBe(true);
      expect(compared.compareTarget).toEqual({ base: 'main', head: 'nest/a', path: 'app.ts' });

      const working = openWorkingDiff(compared);
      expect(working).toEqual({
        ...EMPTY_CENTER_STATE,
        active: 'diff',
        diffOpen: true,
        compareTarget: null,
      });
      // The input is untouched: the reducers never mutate what they are given.
      expect(compared.compareTarget).not.toBeNull();
    });

    it('opens a compare diff without closing the graph tab', () => {
      const graph = openGraph(EMPTY_CENTER_STATE, { ref: 'origin/main' });
      const compared = openCompareDiff(graph, { base: 'main', head: 'origin/main', path: null });

      expect(compared.active).toBe('diff');
      expect(compared.graphOpen).toBe(true);
      expect(compared.graphRef).toBe('origin/main');
    });

    it('opens the graph on all branches by default and on a ref when asked', () => {
      const all = openGraph(EMPTY_CENTER_STATE);
      expect(all.active).toBe('graph');
      expect(all.graphOpen).toBe(true);
      expect(all.graphScope).toBe('all');
      expect(all.graphRef).toBeNull();

      const onRef = openGraph(EMPTY_CENTER_STATE, { ref: 'nest/b' });
      expect(onRef.graphScope).toBe('ref');
      expect(onRef.graphRef).toBe('nest/b');

      const onHead = openGraph(onRef, { scope: 'head' });
      expect(onHead.graphScope).toBe('head');
      // A scope that is not a ref cannot carry a ref name.
      expect(onHead.graphRef).toBeNull();

      // Reopening an open graph keeps what it shows, unless the focus says else.
      expect(openGraph(onHead)).toEqual(onHead);
      expect(openGraph(onHead, { scope: 'branches' }).graphScope).toBe('branches');
    });

    it('selects a commit in the graph it opens', () => {
      const focused = openGraph(EMPTY_CENTER_STATE, { commitHash: 'abc123' });
      expect(focused.active).toBe('graph');
      expect(focused.selectedCommitHash).toBe('abc123');
      // A later focus without a commit keeps the selection; only closing the
      // tab drops it.
      expect(openGraph(focused, { scope: 'head' }).selectedCommitHash).toBe('abc123');
    });

    /**
     * `Back` in the detail pane is `commitHash: null`, not the absence of a
     * commit: the key says the user wants an empty pane, and a focus without
     * the key stays out of the way.
     */
    it('clears a selected commit when the focus asks for none', () => {
      const focused = openGraph(EMPTY_CENTER_STATE, { commitHash: 'abc123' });

      const cleared = openGraph(focused, { commitHash: null });
      expect(cleared.selectedCommitHash).toBeNull();
      expect(cleared.graphOpen).toBe(true);
      expect(cleared.active).toBe('graph');
      // The commit is still the one the list needs nothing from: only the
      // detail pane went away, and the input is untouched.
      expect(focused.selectedCommitHash).toBe('abc123');

      expect(openGraph(focused, {}).selectedCommitHash).toBe('abc123');
      expect(openGraph(focused, { ref: 'main' }).selectedCommitHash).toBe('abc123');
      expect(openGraph(focused, { scope: 'branches' }).selectedCommitHash).toBe('abc123');

      // Re-selecting after a clear works like the first selection.
      expect(openGraph(cleared, { commitHash: 'def456' }).selectedCommitHash).toBe('def456');
    });

    it('falls back to the terminal when the active tab closes', () => {
      const both = openGraph(
        openCompareDiff(EMPTY_CENTER_STATE, { base: 'main', head: 'nest/a', path: null }),
        {},
      );
      expect(both.active).toBe('graph');

      const closedGraph = closeCenterTab(both, 'graph');
      expect(closedGraph.active).toBe('terminal');
      expect(closedGraph.graphOpen).toBe(false);
      expect(closedGraph.selectedCommitHash).toBeNull();
      // The diff tab keeps its payload and its open state.
      expect(closedGraph.diffOpen).toBe(true);
      expect(closedGraph.compareTarget).toEqual({ base: 'main', head: 'nest/a', path: null });

      const closedDiff = closeCenterTab(closedGraph, 'diff');
      expect(closedDiff).toEqual(EMPTY_CENTER_STATE);
    });

    it('keeps the active tab when the other one closes', () => {
      const onDiff = openCompareDiff(openGraph(EMPTY_CENTER_STATE, { ref: 'main' }), {
        base: 'main',
        head: 'HEAD',
        path: null,
      });

      const closedGraph = closeCenterTab(onDiff, 'graph');
      expect(closedGraph.active).toBe('diff');
      expect(closedGraph.diffOpen).toBe(true);

      const closedDiff = closeCenterTab(onDiff, 'diff');
      expect(closedDiff.active).toBe('terminal');
      expect(closedDiff.diffOpen).toBe(false);
      expect(closedDiff.graphOpen).toBe(true);
    });

    it('closing a tab that is not open changes nothing', () => {
      expect(closeCenterTab(EMPTY_CENTER_STATE, 'graph')).toBe(EMPTY_CENTER_STATE);
      expect(closeCenterTab(EMPTY_CENTER_STATE, 'diff')).toBe(EMPTY_CENTER_STATE);
    });

    it('activates an open surface only', () => {
      const open = openGraph(openWorkingDiff(EMPTY_CENTER_STATE), { scope: 'branches' });
      expect(activateCenterSurface(open, 'diff').active).toBe('diff');
      expect(activateCenterSurface(open, 'terminal').active).toBe('terminal');
      expect(activateCenterSurface(open, 'graph')).toBe(open);
      // A closed tab has no surface to show: opening is a transition of its own.
      expect(activateCenterSurface(EMPTY_CENTER_STATE, 'diff')).toBe(EMPTY_CENTER_STATE);
    });

    it('forgets one task without touching the others', () => {
      const states = {
        a: openWorkingDiff(EMPTY_CENTER_STATE),
        b: openGraph(EMPTY_CENTER_STATE, { ref: 'nest/b' }),
      };

      expect(forgetTaskCenter(states, 'a')).toEqual({ b: states.b });
      expect(forgetTaskCenter(states, 'missing')).toBe(states);
    });
  });

  describe('store', () => {
    function makeStore(): CenterTabsStore {
      return createCenterTabsStore();
    }

    it('keeps the center context of each task A → B → A', () => {
      const store = makeStore();
      store.openCompareDiff('a', { base: 'main', head: 'nest/a', path: 'src/a.ts' });
      store.openGraph('b', { ref: 'nest/b' });
      store.openGraph('a', { scope: 'branches' });

      expect(store.getTask('a')).toEqual({
        active: 'graph',
        diffOpen: true,
        compareTarget: { base: 'main', head: 'nest/a', path: 'src/a.ts' },
        graphOpen: true,
        graphScope: 'branches',
        graphRef: null,
        selectedCommitHash: null,
      });
      expect(store.getTask('b').graphRef).toBe('nest/b');
      expect(store.getTask('b').diffOpen).toBe(false);
      expect(store.getTask('b').active).toBe('graph');
    });

    it('never creates a task entry for a no-op transition', () => {
      const store = makeStore();
      let changes = 0;
      store.subscribe(() => {
        changes += 1;
      });

      store.openWorkingDiff('a');
      expect(changes).toBe(1);
      store.openWorkingDiff('a');
      expect(changes).toBe(1);
      store.activateCenterSurface('b', 'diff');
      expect(changes).toBe(1);
      expect(store.getSnapshot()).toEqual({ a: store.getTask('a') });
    });

    it('replaces the snapshot and notifies on every change', () => {
      const store = makeStore();
      const seen: unknown[] = [];
      const stop = store.subscribe(() => seen.push(store.getSnapshot()));

      store.openGraph('a', { commitHash: 'abc123' });
      store.closeCenterTab('a', 'graph');
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toBe(seen[1]);
      expect(store.getTask('a')).not.toBe(EMPTY_CENTER_STATE);
      expect(store.getTask('a')).toEqual(EMPTY_CENTER_STATE);

      stop();
      store.openWorkingDiff('a');
      expect(seen).toHaveLength(2);
    });

    it('defaults an unknown task and forgets a deleted one', () => {
      const store = makeStore();
      expect(store.getTask(null)).toBe(EMPTY_CENTER_STATE);
      expect(store.getTask('missing')).toBe(EMPTY_CENTER_STATE);

      store.openGraph('a', { ref: 'main' });
      store.forgetTaskCenter('a');
      expect(store.getSnapshot()).toEqual({});
      expect(store.getTask('a')).toBe(EMPTY_CENTER_STATE);
    });
  });

  describe('forget task views', () => {
    it('drops the git snapshot and the center state of a removed task together', () => {
      const center = createCenterTabsStore();
      const forgotten: string[] = [];
      const git = {
        forgetTask(taskId: string) {
          forgotten.push(taskId);
        },
      };

      center.openGraph('task-a', { ref: 'nest/a' });
      center.openWorkingDiff('task-b');
      forgetTaskViews({ git, center }, 'task-a');

      expect(forgotten).toEqual(['task-a']);
      expect(center.getSnapshot()).not.toHaveProperty('task-a');
      // The other task keeps its own surface: only the removed one is dropped.
      expect(center.getTask('task-b').active).toBe('diff');
    });
  });
});
