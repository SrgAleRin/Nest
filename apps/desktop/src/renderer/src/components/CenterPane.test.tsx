import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NestClient, Task } from '@nest/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@nest/shared';
import { CenterPane, centerLayerClass, type CenterPaneProps } from './CenterPane';
import { EMPTY_CENTER_STATE, openGraph, openWorkingDiff } from '../state/centerTabs';
import { EMPTY_GIT_MEMORY } from '../state/gitSnapshot';

/**
 * The layer composition is what this file checks: the terminals, the patch and
 * the graph are three stubs. The real patch and graph read the git store (and
 * mount virtualized lists), so their own logic is covered by their own tests.
 */
vi.mock('../state/GitSnapshotProvider', () => ({
  useGitTaskMemory: () => ({ ...EMPTY_GIT_MEMORY, selection: null }),
}));
vi.mock('./DiffPanel', () => ({ DiffPanel: () => <div data-testid="diff-body">patch</div> }));
vi.mock('./GitGraphPanel', () => ({
  GitGraphPanel: () => <div data-testid="graph-body">graph</div>,
}));

const client = {
  invoke: () => new Promise(() => {}),
  on: () => () => {},
} as unknown as NestClient;

const task: Task = {
  id: 'task-a',
  projectId: 'project-a',
  kind: 'worktree',
  slug: 'task-a',
  title: 'task a',
  branch: 'nest/task-a',
  baseRef: 'main',
  workspacePath: 'D:/nest/task-a',
  status: 'active',
  setupError: null,
  workflowStatus: 'in_progress',
  pinned: false,
  sortOrder: 0,
  notes: null,
  archivedAt: null,
  unread: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function render(center: CenterPaneProps['center'], currentTask: Task | null = null): string {
  const props: CenterPaneProps = {
    client,
    task: currentTask,
    hasProjects: true,
    sessions: [],
    selectedSessionId: null,
    unread: {},
    harnesses: [],
    allHarnessesDisabled: false,
    terminal: DEFAULT_TERMINAL_PREFERENCES,
    busy: false,
    newSessionDefault: 'ask',
    resumableHarnesses: new Set(),
    refreshKey: 0,
    center,
    graphPickerNonce: 0,
    onSelectSession: () => undefined,
    onStart: () => undefined,
    onCloseSession: () => undefined,
    onResume: () => undefined,
    onNewSession: () => undefined,
    onError: () => undefined,
    onOpenPalette: () => undefined,
    onOpenSettings: () => undefined,
    onAddProject: () => undefined,
    onGitChanged: () => undefined,
    onNotify: () => undefined,
    onActivateSurface: () => undefined,
    onCloseTab: () => undefined,
    graph: {
      onScope: () => undefined,
      onOpenRef: () => undefined,
      onSelectCommit: () => undefined,
      onCompareWithHead: () => undefined,
      onBrowseFiles: () => undefined,
      onNewTaskFromRef: () => undefined,
    },
  };
  return renderToStaticMarkup(<CenterPane {...props} />);
}

/** The class list of one layer, without parsing the whole document. */
function layerClass(html: string, name: 'terminal' | 'diff' | 'graph'): string {
  const match = new RegExp(`<div class="([^"]*)" data-testid="center-${name}-layer"`).exec(html);
  return match?.[1] ?? '';
}

describe('center layers', () => {
  it('hides a layer that is not the active surface', () => {
    expect(centerLayerClass('terminal', 'terminal')).toBe(
      'center-layer center-layer-terminal is-active',
    );
    expect(centerLayerClass('diff', 'terminal')).toBe(
      'center-layer center-layer-terminal is-hidden',
    );
    expect(centerLayerClass('graph', 'diff')).toBe('center-layer center-layer-diff is-hidden');
  });

  /**
   * The invariant of the workbench: switching to `Diff` or `Graph` hides the
   * terminals with a class, it never unmounts them.
   */
  it('keeps the terminal layer mounted under the patch', () => {
    const terminal = render(EMPTY_CENTER_STATE);
    const patch = render(openWorkingDiff(EMPTY_CENTER_STATE));

    expect(layerClass(terminal, 'terminal')).toContain('is-active');
    expect(layerClass(patch, 'terminal')).toContain('is-hidden');

    // The same layer in both renders: the terminals were hidden, not rebuilt.
    expect(layerClass(patch, 'terminal')).toBe(
      layerClass(terminal, 'terminal').replace('is-active', 'is-hidden'),
    );
    expect(patch).toContain('terminal-body');
    expect(patch).toContain('data-testid="diff-body"');
    // The graph was never opened, so it has no layer at all.
    expect(layerClass(terminal, 'graph')).toBe('');
    expect(layerClass(patch, 'graph')).toBe('');
  });

  it('keeps the terminal layer mounted under the graph', () => {
    const graph = render(openGraph(EMPTY_CENTER_STATE), task);

    expect(layerClass(graph, 'terminal')).toContain('is-hidden');
    expect(graph).toContain('terminal-body');
    expect(layerClass(graph, 'graph')).toContain('is-active');
    expect(graph).toContain('data-testid="graph-body"');
    // No task means no graph to read, so the layer is not there at all.
    expect(layerClass(render(openGraph(EMPTY_CENTER_STATE), null), 'graph')).toBe('');
  });

  it('shows the tool tabs of the open surfaces only', () => {
    const terminal = render(EMPTY_CENTER_STATE);
    expect(terminal).not.toContain('center-diff-tab');
    expect(terminal).not.toContain('center-graph-tab');

    const patch = render(openWorkingDiff(EMPTY_CENTER_STATE));
    expect(patch).toContain('data-testid="center-diff-tab"');
    expect(patch).toContain('Close Diff');
    expect(patch).not.toContain('data-testid="center-graph-tab"');

    const both = render(openGraph(openWorkingDiff(EMPTY_CENTER_STATE)), task);
    expect(both).toContain('data-testid="center-diff-tab"');
    expect(both).toContain('data-testid="center-graph-tab"');
  });
});
