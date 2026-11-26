import { useCallback, useEffect, useState } from 'react';
import type { GitCommitDetail, GitLog, NestClient, Task } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { CommitDetailView } from './CommitDetail';
import { CommitRow } from './CommitList';
import { panelPhase } from '../panelState';
import { errorMessage } from '../utils';

const PAGE_SIZE = 50;

interface HistoryPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  selectedHash: string | null;
  onSelectCommit: (hash: string | null) => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function HistoryPanel({
  client,
  task,
  refreshKey,
  selectedHash,
  onSelectCommit,
  onNotify,
}: HistoryPanelProps) {
  const [log, setLog] = useState<GitLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!task) {
      setLog(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await client.invoke('git.log', { taskId: task.id, limit: PAGE_SIZE });
      setLog(next);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, task]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const loadDetail = useCallback(async () => {
    if (!task || !selectedHash) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await client.invoke('git.commitDetail', { taskId: task.id, hash: selectedHash }));
    } catch (loadError) {
      setDetailError(errorMessage(loadError));
    } finally {
      setDetailLoading(false);
    }
  }, [client, task, selectedHash]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail, refreshKey]);

  async function loadMore(): Promise<void> {
    if (!task || !log || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.invoke('git.log', {
        taskId: task.id,
        limit: PAGE_SIZE,
        skip: log.commits.length,
      });
      setLog({ commits: [...log.commits, ...next.commits], hasMore: next.hasMore });
    } catch (loadError) {
      onNotify('error', errorMessage(loadError));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!task) {
    return (
      <EmptyState title="No workspace selected">Select a task to browse its commits.</EmptyState>
    );
  }

  if (selectedHash) {
    return (
      <div className="history-panel">
        {detailError ? (
          <>
            <div className="diff-head">
              <button className="mini-btn" onClick={() => onSelectCommit(null)}>
                ← History
              </button>
            </div>
            <ErrorState title="Commit unavailable" onRetry={() => void loadDetail()}>
              {detailError}
            </ErrorState>
          </>
        ) : detail ? (
          <CommitDetailView
            client={client}
            detail={detail}
            onBack={() => onSelectCommit(null)}
            onNotify={onNotify}
          />
        ) : (
          <div className="panel-empty">
            {detailLoading ? 'Loading commit…' : 'No commit selected'}
          </div>
        )}
      </div>
    );
  }

  const phase = panelPhase({ loading, error, hasData: log !== null });

  if (phase === 'error') {
    return (
      <div className="history-panel">
        <div className="diff-head">
          <span className="section-label">History</span>
          <button className="mini-btn" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
        </div>
        <ErrorState title="History unavailable" onRetry={() => void load()}>
          {error}
        </ErrorState>
      </div>
    );
  }

  if (phase !== 'ready' || !log) {
    return <div className="panel-empty">Loading history…</div>;
  }

  return (
    <div className="history-panel">
      <div className="diff-head">
        <span className="section-label">
          History{log.commits.length > 0 ? ` · ${log.commits.length}` : ''}
        </span>
        <button className="mini-btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="commit-list">
        {log.commits.length === 0 ? (
          <div className="panel-empty">No commits yet</div>
        ) : (
          log.commits.map((commit) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              onSelect={() => onSelectCommit(commit.hash)}
            />
          ))
        )}
      </div>

      {log.hasMore ? (
        <div className="commit-more">
          <button className="mini-btn" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older commits'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
