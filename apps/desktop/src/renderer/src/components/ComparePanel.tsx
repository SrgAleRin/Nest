import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitCompare, GitCompareFile, NestClient, Task } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { CommitRow } from './CommitList';
import { FileTree } from './FileTree';
import { applyCompareSeed, type CompareSelection } from '../comparePanel';
import { panelPhase } from '../panelState';
import { useGitSnapshot, useGitSnapshotStore } from '../state/GitSnapshotProvider';
import { diffStatusLetter, diffStatusTone, errorMessage, shortHash } from '../utils';

/** The two revisions a file patch is opened between. */
export interface CompareDiffTarget {
  base: string;
  head: string;
  path: string | null;
}

interface ComparePanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onOpenCommit: (hash: string) => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Opens the patch of a file between the selected revisions in the center
   * `Diff`. Omitted when the panel runs on its own: the rows then stay inert.
   */
  onOpenDiff?: (target: CompareDiffTarget) => void;
}

type Selection = CompareSelection;

/**
 * Branch-to-branch comparison. The branch list is the snapshot the rest of the
 * panel reads, the comparison itself is one `git.compare`. A file row opens
 * its cross-branch patch in the center without checking anything out, and a
 * commit row opens that commit in the center graph.
 */
export function ComparePanel({
  client,
  task,
  refreshKey,
  onOpenCommit,
  onNotify,
  onOpenDiff,
}: ComparePanelProps) {
  const taskId = task?.id ?? null;
  const store = useGitSnapshotStore();
  const snapshot = useGitSnapshot(taskId);
  const branches = snapshot?.branches.data ?? null;
  const branchesLoading = snapshot?.branches.loading ?? false;
  const branchesError = snapshot?.branches.error ?? null;

  const [selection, setSelection] = useState<Selection>({ base: '', head: '' });
  const [compare, setCompare] = useState<GitCompare | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The effects below must not restart when the pickers change, so they read
  // the current pair from a ref and only refresh the data.
  const current = useRef<Selection>({ base: '', head: '' });
  /** The user chose a side by hand: a later seed must not touch the pair. */
  const touched = useRef(false);
  /** Only the newest comparison may write its answer into the panel. */
  const compareRequest = useRef(0);

  // Branches are a separate snapshot slice; a failure here never blanks the
  // comparison that is already on screen.
  useEffect(() => {
    if (!taskId || branches || branchesLoading || branchesError) return;
    void store.requestBranches(taskId);
  }, [branches, branchesError, branchesLoading, store, taskId]);

  const runCompare = useCallback(
    async (next: Selection) => {
      const request = ++compareRequest.current;
      if (!task || !next.base) {
        setCompare(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await client.invoke('git.compare', {
          taskId: task.id,
          base: next.base,
          head: next.head || 'HEAD',
        });
        // A pick or a refresh started a newer comparison meanwhile: this older
        // answer must not replace the one the user is looking at.
        if (request !== compareRequest.current) return;
        setCompare(result);
      } catch (compareError) {
        if (request !== compareRequest.current) return;
        setCompare(null);
        setError(errorMessage(compareError));
      } finally {
        if (request === compareRequest.current) setLoading(false);
      }
    },
    [client, task],
  );

  // Seed the pair from the branch list: upstream/default branch as the base,
  // the current branch as the head. A pair the user picked by hand is never
  // overwritten, and a seed that arrives late does not restart the comparison.
  useEffect(() => {
    if (!branches) return;
    const next = applyCompareSeed(
      current.current,
      {
        base: branches.baseRef || branches.local[0]?.name || '',
        head: branches.current || 'HEAD',
      },
      touched.current,
    );
    if (!next) return;
    current.current = next;
    setSelection(next);
    void runCompare(next);
  }, [branches, runCompare]);

  /** Re-reads the comparison; the branch list refreshes with the snapshot. */
  const refresh = useCallback(() => {
    if (!taskId) return;
    if (current.current.base) void runCompare(current.current);
  }, [runCompare, taskId]);

  /** A manual refresh or a fetch also re-reads the branch list. */
  const reload = useCallback(() => {
    if (!taskId) return;
    void store.requestBranches(taskId);
    refresh();
  }, [refresh, store, taskId]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  function pick(next: Partial<Selection>): void {
    touched.current = true;
    const merged: Selection = { ...current.current, ...next };
    current.current = merged;
    setSelection(merged);
    void runCompare(merged);
  }

  async function fetch(): Promise<void> {
    if (!task) return;
    setBusy(true);
    try {
      const result = await client.invoke('git.fetch', { taskId: task.id });
      onNotify('info', result.output || 'Fetched');
      reload();
    } catch (fetchError) {
      onNotify('error', errorMessage(fetchError));
    } finally {
      setBusy(false);
    }
  }

  const options = useMemo(() => {
    const local = branches?.local.map((branch) => branch.name) ?? [];
    const remote = branches?.remote.map((branch) => branch.name) ?? [];
    // Keep a stale selection visible even after its branch was deleted.
    const extra = [selection.base, selection.head].filter(
      (name) => name && name !== 'HEAD' && !local.includes(name) && !remote.includes(name),
    );
    return { local, remote, extra: [...new Set(extra)] };
  }, [branches, selection]);

  if (!task) {
    return (
      <EmptyState title="No workspace selected">Select a task to compare branches.</EmptyState>
    );
  }

  const phase = panelPhase({ loading, error: error ?? branchesError, hasData: compare !== null });

  if (phase === 'error' && !compare) {
    return (
      <div className="compare-panel">
        <div className="diff-head">
          <span className="section-label">Compare</span>
          <button className="mini-btn" onClick={reload} disabled={loading}>
            Retry
          </button>
        </div>
        <ErrorState title="Comparison unavailable" onRetry={reload}>
          {error ?? branchesError}
        </ErrorState>
      </div>
    );
  }

  const openFilePatch = (file: GitCompareFile): void => {
    if (!onOpenDiff || !compare) return;
    onOpenDiff({ base: compare.base, head: compare.head, path: file.path });
  };

  return (
    <div className="panel-scroll compare-panel">
      <div className="diff-head">
        <span className="section-label">Compare</span>
        <div className="compare-head-actions">
          <button className="mini-btn" onClick={() => void fetch()} disabled={busy}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
          <button className="mini-btn" onClick={reload} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="compare-pickers">
        <label className="compare-picker">
          <span>Base</span>
          <select value={selection.base} onChange={(event) => pick({ base: event.target.value })}>
            {options.extra.map((name) => (
              <option key={`extra-base:${name}`} value={name}>
                {name}
              </option>
            ))}
            <optgroup label="Local">{renderOptions(options.local)}</optgroup>
            <optgroup label="Remote">{renderOptions(options.remote)}</optgroup>
          </select>
        </label>
        <button
          className="mini-btn compare-swap"
          title="Swap base and head"
          onClick={() => pick({ base: selection.head, head: selection.base })}
          disabled={!selection.head || selection.head === 'HEAD'}
        >
          ⇄
        </button>
        <label className="compare-picker">
          <span>Head</span>
          <select value={selection.head} onChange={(event) => pick({ head: event.target.value })}>
            <option value="HEAD">HEAD</option>
            {options.extra.map((name) => (
              <option key={`extra-head:${name}`} value={name}>
                {name}
              </option>
            ))}
            <optgroup label="Local">{renderOptions(options.local)}</optgroup>
            <optgroup label="Remote">{renderOptions(options.remote)}</optgroup>
          </select>
        </label>
      </div>

      {error ? <div className="compare-error">{error}</div> : null}
      {branchesError ? (
        <div className="compare-error">
          Branches could not be read, so the pickers may be incomplete. {branchesError}
        </div>
      ) : null}

      {!selection.base ? (
        <div className="panel-empty">
          {branchesLoading ? 'Loading branches…' : 'Pick a base branch to compare against'}
        </div>
      ) : !compare ? (
        <div className="panel-empty">{loading ? 'Comparing…' : 'No comparison yet'}</div>
      ) : (
        <>
          <div className="compare-summary">
            <span className="track-pill">↑ {compare.ahead}</span>
            <span className="track-pill">↓ {compare.behind}</span>
            {compare.mergeBase ? (
              <span className="compare-base" title={compare.mergeBase}>
                merge base {shortHash(compare.mergeBase)}
              </span>
            ) : (
              <span className="compare-base">no common history</span>
            )}
          </div>

          <div className="git-files-head">
            <span className="section-label">Commits ({compare.ahead})</span>
          </div>
          <div className="commit-list compare-commits">
            {compare.commits.length === 0 ? (
              <div className="panel-empty">No commits ahead of {compare.base}</div>
            ) : (
              compare.commits.map((commit) => (
                <CommitRow
                  key={commit.hash}
                  commit={commit}
                  compact
                  onSelect={() => onOpenCommit(commit.hash)}
                />
              ))
            )}
            {compare.commitsTruncated ? (
              <div className="commit-more">Showing the newest commits only</div>
            ) : null}
          </div>

          <div className="git-files-head">
            <span className="section-label">Files ({compare.files.length})</span>
            {onOpenDiff ? (
              <span className="change-group-hint">Click a file to open its patch</span>
            ) : null}
          </div>
          <FileTree
            entries={compare.files}
            emptyLabel="No file changes against the merge base"
            renderFile={(file, depth) => (
              <CompareFileRow
                file={file}
                depth={depth}
                onOpen={onOpenDiff ? () => openFilePatch(file) : null}
              />
            )}
          />
        </>
      )}
    </div>
  );
}

function CompareFileRow({
  file,
  depth,
  onOpen,
}: {
  file: GitCompareFile;
  depth: number;
  onOpen: (() => void) | null;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <button
      type="button"
      className="git-file tree-row compare-file-row"
      style={{ paddingLeft: 6 + depth * 11 }}
      title={onOpen ? `Open the patch of ${file.path}` : file.path}
      aria-label={`${diffStatusLetter(file.status)} ${file.path}${
        onOpen ? ' — open its patch between the compared revisions' : ''
      }`}
      disabled={!onOpen}
      onClick={() => onOpen?.()}
    >
      <span className={`git-letter ${diffStatusTone(file.status)}`}>
        {diffStatusLetter(file.status)}
      </span>
      <span className="git-path">{name}</span>
      {file.oldPath ? <span className="commit-old-path">← {file.oldPath}</span> : null}
      {file.additions !== null && file.deletions !== null ? (
        <span className="git-stat">
          <em>+{file.additions}</em> <del>-{file.deletions}</del>
        </span>
      ) : (
        <span className="git-stat muted">bin</span>
      )}
    </button>
  );
}

function renderOptions(names: string[]) {
  return names.map((name) => (
    <option key={name} value={name}>
      {name}
    </option>
  ));
}
