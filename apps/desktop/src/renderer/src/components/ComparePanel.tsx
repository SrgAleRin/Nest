import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitBranches, GitCompare, GitCompareFile, NestClient, Task } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { CommitRow } from './CommitList';
import { FileTree } from './FileTree';
import { panelPhase } from '../panelState';
import { diffStatusLetter, diffStatusTone, errorMessage, shortHash } from '../utils';

interface ComparePanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onOpenCommit: (hash: string) => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface Selection {
  base: string;
  head: string;
}

export function ComparePanel({
  client,
  task,
  refreshKey,
  onOpenCommit,
  onNotify,
}: ComparePanelProps) {
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [selection, setSelection] = useState<Selection>({ base: '', head: '' });
  const [compare, setCompare] = useState<GitCompare | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The effect below must not restart when the pickers change, so it reads the
  // current pair from a ref and only refreshes the data.
  const current = useRef<Selection>({ base: '', head: '' });

  const runCompare = useCallback(
    async (next: Selection) => {
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
        setCompare(result);
      } catch (compareError) {
        setCompare(null);
        setError(errorMessage(compareError));
      } finally {
        setLoading(false);
      }
    },
    [client, task],
  );

  const load = useCallback(async () => {
    if (!task) {
      setBranches(null);
      setCompare(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const nextBranches = await client.invoke('git.branches', { taskId: task.id });
      setBranches(nextBranches);

      // Keep the user's picks across refreshes; fall back to upstream/default
      // branch and the current branch on the first load.
      const previous = current.current;
      const next: Selection = {
        base: previous.base || nextBranches.baseRef || nextBranches.local[0]?.name || '',
        head: previous.head || nextBranches.current || 'HEAD',
      };
      current.current = next;
      setSelection(next);

      if (!next.base) {
        setCompare(null);
        setLoading(false);
        return;
      }
      const result = await client.invoke('git.compare', {
        taskId: task.id,
        base: next.base,
        head: next.head,
      });
      setCompare(result);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, task]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function pick(next: Partial<Selection>): void {
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
      await load();
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

  const phase = panelPhase({ loading, error, hasData: compare !== null });

  if (phase === 'error' && !compare) {
    return (
      <div className="compare-panel">
        <div className="diff-head">
          <span className="section-label">Compare</span>
          <button className="mini-btn" onClick={() => void load()} disabled={loading}>
            Retry
          </button>
        </div>
        <ErrorState title="Comparison unavailable" onRetry={() => void load()}>
          {error}
        </ErrorState>
      </div>
    );
  }

  return (
    <div className="panel-scroll compare-panel">
      <div className="diff-head">
        <span className="section-label">Compare</span>
        <div className="compare-head-actions">
          <button className="mini-btn" onClick={() => void fetch()} disabled={busy}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>
          <button className="mini-btn" onClick={() => void load()} disabled={loading}>
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

      {!selection.base ? (
        <div className="panel-empty">Pick a base branch to compare against</div>
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
          </div>
          <FileTree
            entries={compare.files}
            emptyLabel="No file changes against the merge base"
            renderFile={(file, depth) => <CompareFileRow file={file} depth={depth} />}
          />
        </>
      )}
    </div>
  );
}

function CompareFileRow({ file, depth }: { file: GitCompareFile; depth: number }) {
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <div className="git-file tree-row" style={{ paddingLeft: 6 + depth * 11 }} title={file.path}>
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
    </div>
  );
}

function renderOptions(names: string[]) {
  return names.map((name) => (
    <option key={name} value={name}>
      {name}
    </option>
  ));
}
