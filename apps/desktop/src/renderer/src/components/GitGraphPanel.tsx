import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  GitBranch,
  GitBranches,
  GitCommit,
  GitCommitDetail,
  GitLog,
  NestClient,
  Task,
} from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { BranchIcon, RefreshIcon } from './Icons';
import { CommitDetailView } from './CommitDetail';
import { buildGitGraph, type GraphEdge, type GraphNode } from '../gitGraph';
import { useGitSnapshot, useGitSnapshotStore } from '../state/GitSnapshotProvider';
import type { GraphScope, TaskCenterState } from '../state/centerTabs';
import { absoluteTime, errorMessage, relativeTime, shortHash } from '../utils';

/** A page of commits; the graph pages through history with `skip`/`limit`. */
export interface GraphLogPage {
  commits: GitCommit[];
  hasMore: boolean;
}

/** The page size asked of `git.log`; the graph reads a wide window at once. */
export const GRAPH_PAGE_LIMIT = 300;

/** Row height of the virtualized list; lanes are drawn for exactly this box. */
const ROW_HEIGHT = 26;
const LANE_WIDTH = 14;
const LANE_PADDING = 8;
const LANE_COLORS = [
  '#7aa2f7',
  '#9ece6a',
  '#e0af68',
  '#bb9af7',
  '#7dcfff',
  '#f7768e',
  '#2ac3de',
  '#c0caf5',
];

export const GRAPH_SCOPES: readonly { scope: GraphScope; label: string; hint: string }[] = [
  {
    scope: 'all',
    label: 'All branches',
    hint: 'Every local branch, tag and remote-tracking ref of this repository',
  },
  {
    scope: 'branches',
    label: 'Local branches',
    hint: 'Local branches and tags, without the remote-tracking refs',
  },
  { scope: 'head', label: 'Current (HEAD)', hint: 'Only the history of the current branch' },
];

/**
 * The parameters of one `git.log` page. A named ref wins over the scope and is
 * walked on its own — `graphRef` is only set while the scope is `ref`.
 */
export function graphLogParams(
  scope: GraphScope,
  ref: string | null,
  search: string,
  skip: number,
  limit: number = GRAPH_PAGE_LIMIT,
): {
  scope?: 'all' | 'branches' | 'head';
  ref?: string;
  search?: string;
  skip: number;
  limit: number;
} {
  const params: {
    scope?: 'all' | 'branches' | 'head';
    ref?: string;
    search?: string;
    skip: number;
    limit: number;
  } = { skip, limit };
  if (scope === 'ref' && ref !== null) params.ref = ref;
  else params.scope = scope === 'ref' ? 'all' : scope;
  const query = search.trim();
  if (query !== '') params.search = query;
  return params;
}

/**
 * `Load older commits` appends a page. A reset replaces the list; an append
 * drops the commits the previous page already had, so an overlap (history moved
 * under the reader) never draws a commit twice.
 */
export function mergeLogPage(
  previous: GraphLogPage | null,
  page: GraphLogPage,
  reset: boolean,
): GraphLogPage {
  if (reset || previous === null) return { commits: [...page.commits], hasMore: page.hasMore };
  const seen = new Set(previous.commits.map((commit) => commit.hash));
  const appended = page.commits.filter((commit) => !seen.has(commit.hash));
  return { commits: [...previous.commits, ...appended], hasMore: page.hasMore };
}

/** How a ref badge is drawn: `HEAD`, a local branch, a remote branch or a tag. */
export type RefKind = 'head' | 'local' | 'remote' | 'tag';

export function refKind(ref: string): RefKind {
  if (ref === 'HEAD' || ref.startsWith('HEAD -> ')) return 'head';
  if (ref.startsWith('tag: ')) return 'tag';
  if (ref.startsWith('origin/')) return 'remote';
  return 'local';
}

/** The ref without the decorations `git log --decorate` adds. */
export function refName(ref: string): string {
  return ref.replace(/^tag: /, '').replace(/^HEAD -> /, '');
}

/** The branches a picker offers: local first, then the remote-tracking ones. */
export function pickerRefs(branches: GitBranches | null, query: string): GitBranch[] {
  if (!branches) return [];
  const all = [...branches.local, ...branches.remote];
  const needle = query.trim().toLowerCase();
  if (needle === '') return all;
  return all.filter(
    (branch) =>
      branch.name.toLowerCase().includes(needle) ||
      (branch.upstream ?? '').toLowerCase().includes(needle),
  );
}

export interface GraphActions {
  /** `All branches` / `Local branches` / `Current (HEAD)`. */
  onScope: (scope: GraphScope) => void;
  /** A ref chosen in the picker or through a badge: the branch inspector. */
  onOpenRef: (ref: string) => void;
  onSelectCommit: (hash: string | null) => void;
  onCompareWithHead: (ref: string) => void;
  onBrowseFiles: (ref: string) => void;
  onNewTaskFromRef: (ref: string) => void;
}

export interface GitGraphPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  /** Scope, ref and selected commit of the workbench; the panel never owns them. */
  center: TaskCenterState;
  /** A palette command asked for the ref picker; every bump focuses it. */
  pickerNonce: number;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  onGitChanged: () => void;
  actions: GraphActions;
}

/**
 * The full tree of the repository: every branch, tag and remote-tracking ref in
 * one DAG, a commit detail pane and the branch inspector. Reading another
 * branch never touches the working tree — only `Switch here` asks for a
 * checkout, and it asks explicitly.
 */
export function GitGraphPanel({
  client,
  task,
  refreshKey,
  center,
  pickerNonce,
  onNotify,
  onGitChanged,
  actions,
}: GitGraphPanelProps) {
  const taskId = task?.id ?? null;
  const store = useGitSnapshotStore();
  const snapshot = useGitSnapshot(taskId);
  const branches = snapshot?.branches.data ?? null;
  const branchesError = snapshot?.branches.error ?? null;

  const [page, setPage] = useState<GraphLogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [search, setSearch] = useState('');
  const [refQuery, setRefQuery] = useState('');
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pickerInputRef = useRef<HTMLInputElement | null>(null);
  /** Only the newest log answer may be applied; scope and search race. */
  const requestSeq = useRef(0);
  /** What the list already holds: `Load older commits` pages from its length. */
  const commitsRef = useRef<GitCommit[]>([]);

  // Branches feed the picker, the head marker and the inspector; a failure here
  // explains itself and never blanks the tree.
  useEffect(() => {
    if (!taskId || branches || snapshot?.branches.loading || branchesError) return;
    void store.requestBranches(taskId);
  }, [branches, branchesError, snapshot?.branches.loading, store, taskId]);

  const loadPage = useCallback(
    async (reset: boolean) => {
      if (!taskId) return;
      const seq = (requestSeq.current += 1);
      const params = graphLogParams(
        center.graphScope,
        center.graphRef,
        search,
        reset ? 0 : commitsRef.current.length,
      );
      setLoading(true);
      setError(null);
      try {
        const next: GitLog = await client.invoke('git.log', { taskId, ...params });
        if (seq !== requestSeq.current) return;
        // An append merges into what the list already holds; the ref is the
        // list itself, so paging never depends on the rendered page state.
        const previous = reset ? null : { commits: commitsRef.current, hasMore: false };
        const merged = mergeLogPage(previous, next, reset);
        commitsRef.current = merged.commits;
        setPage(merged);
      } catch (loadError) {
        if (seq !== requestSeq.current) return;
        setError(errorMessage(loadError));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [center.graphRef, center.graphScope, client, search, taskId],
  );

  // A new scope, ref, search, task or local git operation starts a fresh page.
  useEffect(() => {
    commitsRef.current = [];
    setPage(null);
    void loadPage(true);
  }, [loadPage, refreshKey]);

  // The selected commit is part of the workbench state, so its detail loads on
  // demand and a task switch drops it instead of showing another repository's.
  const selectedHash = center.selectedCommitHash;
  useEffect(() => {
    if (!taskId || selectedHash === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void client
      .invoke('git.commitDetail', { taskId, hash: selectedHash })
      .then((next) => {
        if (!cancelled) setDetail(next);
      })
      .catch((detailError) => {
        if (cancelled) return;
        setDetail(null);
        onNotify('error', errorMessage(detailError));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, onNotify, selectedHash, taskId]);

  useEffect(() => {
    if (pickerNonce === 0) return;
    pickerInputRef.current?.focus();
  }, [pickerNonce]);

  const headHash = useMemo(
    () => branches?.local.find((branch) => branch.current)?.tip ?? null,
    [branches],
  );

  const nodes = useMemo(
    () =>
      buildGitGraph(page?.commits ?? [], {
        headHash,
        hasMore: page?.hasMore ?? false,
      }),
    [headHash, page],
  );

  const laneCount = useMemo(
    () =>
      nodes.reduce(
        (widest, node) => Math.max(widest, node.lane + 1, ...node.lanes.map((lane) => lane + 1)),
        1,
      ),
    [nodes],
  );
  const lanesWidth = laneCount * LANE_WIDTH + LANE_PADDING;

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => nodes[index]?.hash ?? index,
    overscan: 12,
  });

  const currentBranch = branches?.current ?? null;
  const inspected = center.graphRef;
  const inspectedBranch = useMemo(() => findBranch(branches, inspected), [branches, inspected]);

  async function refresh(): Promise<void> {
    if (!taskId) return;
    await Promise.all([loadPage(true), store.requestBranches(taskId)]);
  }

  async function fetchRemotes(): Promise<void> {
    if (!taskId) return;
    setFetching(true);
    try {
      const result = await client.invoke('git.fetch', { taskId });
      onNotify('info', result.output || 'Fetched');
      onGitChanged();
      await refresh();
    } catch (fetchError) {
      onNotify('error', errorMessage(fetchError));
    } finally {
      setFetching(false);
    }
  }

  async function switchHere(branch: GitBranch): Promise<void> {
    if (!taskId) return;
    try {
      await store.checkout(taskId, { branch: branch.name });
      onGitChanged();
      onNotify('info', `Switched to ${branch.name}`);
      // HEAD moved, so the tree and the branch list are read again.
      await refresh();
    } catch (checkoutError) {
      onNotify('error', errorMessage(checkoutError));
    }
  }

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  if (!task) {
    return (
      <div className="graph-panel">
        <EmptyState title="No workspace selected">Select a task to see its history.</EmptyState>
      </div>
    );
  }

  return (
    <div className="graph-panel">
      <div className="graph-toolbar">
        <div className="graph-scopes" role="tablist" aria-label="History range">
          {GRAPH_SCOPES.map((option) => (
            <button
              key={option.scope}
              type="button"
              role="tab"
              aria-selected={center.graphScope === option.scope}
              data-testid={`graph-scope-${option.scope}`}
              className={`mini-btn graph-scope ${center.graphScope === option.scope ? 'selected' : ''}`}
              title={option.hint}
              onClick={() => actions.onScope(option.scope)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="graph-toolbar-actions">
          <button
            type="button"
            className="mini-btn"
            disabled={fetching}
            title="Fetch every remote and read the tree again"
            onClick={() => void fetchRemotes()}
          >
            {fetching ? 'Fetching…' : 'Fetch'}
          </button>
          <button
            type="button"
            className="mini-btn"
            disabled={loading}
            title="Read the tree and the branch list again"
            onClick={() => void refresh()}
          >
            <RefreshIcon size={11} /> Refresh
          </button>
        </div>
      </div>

      <div className="graph-toolbar graph-toolbar-inputs">
        <div className="graph-ref-picker">
          <BranchIcon size={12} />
          <input
            ref={pickerInputRef}
            className="graph-ref-input"
            value={refQuery}
            placeholder={inspected ?? 'Inspect a branch or tag…'}
            aria-label="Inspect a branch or tag"
            spellCheck={false}
            onChange={(event) => setRefQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setRefQuery('');
              }
            }}
          />
          {refQuery.trim() !== '' ? (
            <div className="graph-ref-list" role="listbox" aria-label="Branches and tags">
              {pickerRefs(branches, refQuery)
                .slice(0, 40)
                .map((branch) => (
                  <button
                    key={`${branch.remote ? 'r' : 'l'}:${branch.name}`}
                    type="button"
                    role="option"
                    aria-selected={inspected === branch.name}
                    className="graph-ref-option"
                    title={branch.worktreePath ?? branch.subject}
                    onClick={() => {
                      setRefQuery('');
                      actions.onOpenRef(branch.name);
                    }}
                  >
                    <span className="graph-ref-option-name">{branch.name}</span>
                    {branch.worktreePath ? (
                      <span className="graph-ref-worktree" title={branch.worktreePath}>
                        worktree
                      </span>
                    ) : null}
                    <span className="graph-ref-option-meta">
                      {shortHash(branch.tip)} · {relativeTime(branch.committedAt)}
                    </span>
                  </button>
                ))}
              {pickerRefs(branches, refQuery).length === 0 ? (
                <div className="graph-ref-empty">No branch or tag matches</div>
              ) : null}
            </div>
          ) : null}
        </div>

        <input
          className="graph-search"
          value={search}
          placeholder="Filter by message, author or hash"
          aria-label="Filter commits"
          spellCheck={false}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && search !== '') {
              event.preventDefault();
              setSearch('');
            }
          }}
        />
      </div>

      {inspected !== null ? (
        <BranchInspector
          inspectedName={inspected}
          branch={inspectedBranch}
          tip={inspectedBranch?.tip ?? findRefTip(page?.commits ?? [], inspected)}
          currentBranch={currentBranch}
          taskId={taskId}
          client={client}
          onClear={() => actions.onScope(center.graphScope === 'ref' ? 'all' : center.graphScope)}
          onCompareWithHead={() => actions.onCompareWithHead(inspected)}
          onBrowseFiles={() => actions.onBrowseFiles(inspected)}
          onNewTaskFromRef={() => actions.onNewTaskFromRef(inspected)}
          onSwitchHere={(branch) => void switchHere(branch)}
        />
      ) : null}

      {branchesError !== null ? (
        <div className="graph-note">Branches could not be read: {branchesError}</div>
      ) : null}

      <div className={`graph-body ${detail || detailLoading ? 'graph-body-split' : ''}`}>
        <div className="graph-list">
          {error !== null && page === null ? (
            <ErrorState title="History unavailable" onRetry={() => void loadPage(true)}>
              {error}
            </ErrorState>
          ) : null}

          {page !== null && nodes.length === 0 ? (
            <div className="panel-empty">
              No commits to show{search.trim() !== '' ? ' for this filter' : ''}.
            </div>
          ) : null}

          <div className="graph-scroll" ref={scrollRef}>
            <div className="graph-rows" style={{ height: totalSize }}>
              {virtualItems.map((item) => {
                const node = nodes[item.index];
                const commit = page?.commits[item.index];
                if (!node || !commit) return null;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="graph-row"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <GraphRow
                      node={node}
                      commit={commit}
                      width={lanesWidth}
                      selected={selectedHash === node.hash}
                      onSelect={() => actions.onSelectCommit(node.hash)}
                      onOpenRef={(ref) => actions.onOpenRef(ref)}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          {page?.hasMore ? (
            <button
              type="button"
              className="mini-btn graph-older"
              data-testid="graph-load-older"
              disabled={loading}
              onClick={() => void loadPage(false)}
            >
              {loading ? 'Loading…' : 'Load older commits'}
            </button>
          ) : null}
        </div>

        {detail || detailLoading ? (
          <div className="graph-detail" data-testid="graph-commit-detail">
            {detail ? (
              <CommitDetailView
                client={client}
                detail={detail}
                backLabel="Back to the graph"
                onBack={() => actions.onSelectCommit(null)}
                onBrowseFiles={(ref) => actions.onBrowseFiles(ref)}
                onNotify={onNotify}
              />
            ) : (
              <div className="panel-empty">Loading commit…</div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The branch a ref names, from either list; `null` for a tag or a bare hash. */
function findBranch(branches: GitBranches | null, ref: string | null): GitBranch | null {
  if (!branches || ref === null) return null;
  return (
    branches.local.find((branch) => branch.name === ref) ??
    branches.remote.find((branch) => branch.name === ref) ??
    null
  );
}

/** Tip of a ref that is a tag or a hash: the first commit carrying the badge. */
function findRefTip(commits: readonly GitCommit[], ref: string): string | null {
  for (const commit of commits) {
    if (commit.refs.some((badge) => refName(badge) === ref)) return commit.hash;
  }
  return null;
}

/**
 * The compact strip of one inspected ref: what it is, how far it is from the
 * current branch, and the read-only ways to look at it. Only `Switch here`
 * changes the workspace, and only for a branch nobody else holds.
 */
function BranchInspector({
  inspectedName,
  branch,
  tip,
  currentBranch,
  taskId,
  client,
  onClear,
  onCompareWithHead,
  onBrowseFiles,
  onNewTaskFromRef,
  onSwitchHere,
}: {
  inspectedName: string;
  branch: GitBranch | null;
  tip: string | null;
  currentBranch: string | null;
  taskId: string | null;
  client: NestClient;
  onClear: () => void;
  onCompareWithHead: () => void;
  onBrowseFiles: () => void;
  onNewTaskFromRef: () => void;
  onSwitchHere: (branch: GitBranch) => void;
}) {
  const [counts, setCounts] = useState<{ ahead: number; behind: number } | null>(null);

  // Ahead/behind against the current branch, not against the ref's own upstream.
  useEffect(() => {
    if (!taskId || branch === null || branch.current || currentBranch === null) {
      setCounts(null);
      return;
    }
    let cancelled = false;
    void client
      .invoke('git.compare', { taskId, base: currentBranch, head: branch.name })
      .then((result) => {
        if (!cancelled) setCounts({ ahead: result.ahead, behind: result.behind });
      })
      .catch(() => {
        if (!cancelled) setCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, [branch, client, currentBranch, taskId]);

  const taken = branch?.worktreePath ?? null;
  const canSwitch = branch !== null && !branch.current && !branch.remote && taken === null;

  return (
    <div className="branch-inspector" data-testid="branch-inspector">
      <div className="branch-inspector-head">
        <BranchIcon size={12} />
        <span className="branch-inspector-name">{inspectedName}</span>
        {branch?.current ? <span className="graph-badge head">HEAD</span> : null}
        {branch?.remote ? <span className="graph-badge remote">remote</span> : null}
        {taken ? (
          <span className="graph-badge worktree" title={taken}>
            worktree
          </span>
        ) : null}
        {counts ? (
          <span className="branch-inspector-counts" title={`Against ${currentBranch}`}>
            <em>↑{counts.ahead}</em> <del>↓{counts.behind}</del>
          </span>
        ) : null}
        {tip ? (
          <span className="branch-inspector-tip" title={tip}>
            {shortHash(tip, 10)}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-btn branch-inspector-close"
          aria-label="Stop inspecting"
          title="Back to the whole tree"
          onClick={onClear}
        >
          ×
        </button>
      </div>
      {branch ? (
        <div className="branch-inspector-subject" title={branch.subject}>
          {branch.subject}
          {branch.committedAt ? ` · ${absoluteTime(branch.committedAt)}` : ''}
        </div>
      ) : null}
      <div className="branch-inspector-actions">
        <button
          type="button"
          className="mini-btn"
          data-testid="branch-compare"
          title="Open the read-only patch of this branch against HEAD in the center"
          onClick={onCompareWithHead}
        >
          Compare with HEAD
        </button>
        <button
          type="button"
          className="mini-btn"
          data-testid="branch-browse"
          title="Open this revision in the Files panel, read-only, without a checkout"
          onClick={onBrowseFiles}
        >
          Browse files
        </button>
        <button
          type="button"
          className="mini-btn"
          data-testid="branch-new-task"
          title="Create a new task whose branch starts here"
          onClick={onNewTaskFromRef}
        >
          New task from branch
        </button>
        <button
          type="button"
          className="mini-btn"
          data-testid="branch-switch"
          disabled={!canSwitch}
          title={
            taken
              ? `Already checked out in ${taken}`
              : branch?.remote
                ? 'A remote-tracking branch cannot be checked out directly'
                : branch?.current
                  ? 'This branch is already checked out here'
                  : 'Check this branch out in this workspace'
          }
          onClick={() => branch && onSwitchHere(branch)}
        >
          Switch here
        </button>
      </div>
    </div>
  );
}

/** One commit row: the lanes, the subject and the ref badges of the commit. */
function GraphRow({
  node,
  commit,
  width,
  selected,
  onSelect,
  onOpenRef,
}: {
  node: GraphNode;
  commit: GitCommit;
  width: number;
  selected: boolean;
  onSelect: () => void;
  onOpenRef: (ref: string) => void;
}) {
  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      data-hash={node.hash}
      className={`graph-commit ${selected ? 'selected' : ''} ${node.onHeadPath ? 'on-head' : ''}`}
      title={commit.subject}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <GraphLanes node={node} width={width} />
      <span className="graph-subject">{commit.subject || '(no message)'}</span>
      <span className="graph-commit-meta">
        {shortHash(node.hash)} · {commit.authorName} · {relativeTime(commit.committedAt)}
      </span>
      <span className="graph-refs">
        {commit.refs.map((ref) => {
          const kind = refKind(ref);
          return (
            <button
              key={ref}
              type="button"
              className={`graph-badge ${kind}`}
              title={`Inspect ${refName(ref)}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenRef(refName(ref));
              }}
            >
              {refName(ref)}
            </button>
          );
        })}
      </span>
    </div>
  );
}

/** The lanes of one row: the dot and the SVG lines of its edges. */
function GraphLanes({ node, width }: { node: GraphNode; width: number }) {
  const height = ROW_HEIGHT;
  const middle = height / 2;
  const x = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const color = (index: number): string => LANE_COLORS[index % LANE_COLORS.length] as string;

  return (
    <svg
      className="graph-lanes"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      {node.continuesBelow.map((lane) => (
        <line
          key={`below:${lane}`}
          x1={x(lane)}
          y1={middle}
          x2={x(lane)}
          y2={height}
          stroke={color(lane)}
          strokeWidth={1.4}
          opacity={0.55}
        />
      ))}
      {node.edges.map((edge, index) => (
        <path
          key={`${edge.kind}:${edge.fromLane}:${edge.toLane}:${index}`}
          d={edgePath(edge, x, middle, height)}
          stroke={color(edge.color)}
          strokeWidth={1.4}
          strokeLinecap="round"
          fill="none"
          opacity={node.onHeadPath ? 0.95 : 0.6}
        />
      ))}
      <circle
        cx={x(node.lane)}
        cy={middle}
        r={node.isHead ? 4.5 : node.onHeadPath ? 4 : 3}
        fill={color(node.color)}
        stroke={node.isHead ? '#e7ecf6' : 'none'}
        strokeWidth={node.isHead ? 1.2 : 0}
      />
    </svg>
  );
}

/**
 * The path of one edge. A straight lane is a plain vertical line; a line that
 * changes lane bends at the middle of the row, so a merge reads as a fork
 * rather than as two unrelated dots.
 */
function edgePath(
  edge: GraphEdge,
  x: (lane: number) => number,
  middle: number,
  height: number,
): string {
  const from = x(edge.fromLane);
  const to = x(edge.toLane);
  if (edge.kind === 'through') return `M ${from} 0 L ${to} ${height}`;
  if (edge.kind === 'incoming') {
    if (from === to) return `M ${from} 0 L ${from} ${middle}`;
    return `M ${from} 0 C ${from} ${middle * 0.55} ${to} ${middle * 0.55} ${to} ${middle}`;
  }
  if (from === to) return `M ${from} ${middle} L ${from} ${height}`;
  return `M ${from} ${middle} C ${from} ${middle + (height - middle) * 0.45} ${to} ${
    middle + (height - middle) * 0.45
  } ${to} ${height}`;
}
