import { useCallback, useEffect, useState } from 'react';
import type { GitStatus, NestClient, Task } from '@nest/shared';
import { Button, EmptyState, Spinner } from '@nest/ui';
import { BranchIcon, RefreshIcon } from './Icons';
import { errorMessage, statusLetter, statusTone } from '../utils';

interface GitPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function GitPanel({ client, task, refreshKey, onChanged, onNotify }: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);

  const load = useCallback(async () => {
    if (!task) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      const next = await client.invoke('git.status', { taskId: task.id });
      setStatus(next);
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [client, task, onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function toggleStage(path: string, staged: boolean): void {
    if (!task || !status) return;
    void run(async () => {
      const next = staged
        ? await client.invoke('git.unstage', { taskId: task.id, paths: [path] })
        : await client.invoke('git.stage', { taskId: task.id, paths: [path] });
      setStatus(next);
      onChanged();
    });
  }

  function stageEverything(): void {
    if (!task || !status) return;
    const paths = status.files.map((file) => file.path);
    if (paths.length === 0) return;
    void run(async () => {
      const next = await client.invoke('git.stage', { taskId: task.id, paths });
      setStatus(next);
      onChanged();
    });
  }

  function commit(): void {
    if (!task || !message.trim()) return;
    void run(async () => {
      const result = await client.invoke('git.commit', {
        taskId: task.id,
        message: message.trim(),
        stageAll,
      });
      setMessage('');
      onNotify('info', `Committed ${result.hash} — ${result.summary}`);
      await load();
      onChanged();
    });
  }

  function push(): void {
    if (!task) return;
    void run(async () => {
      const result = await client.invoke('git.push', { taskId: task.id });
      onNotify('info', result.output || 'Pushed');
      await load();
      onChanged();
    });
  }

  if (!task) {
    return <EmptyState title="No workspace selected">Select a task to see git status.</EmptyState>;
  }

  return (
    <div className="panel-scroll git-panel">
      <div className="git-head">
        <div className="git-branch">
          <BranchIcon />
          <span className="git-branch-name">{status?.branch ?? '…'}</span>
          {status?.upstream ? <span className="git-upstream">{status.upstream}</span> : null}
        </div>
        <button
          className="icon-btn"
          title="Refresh status"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshIcon />
        </button>
      </div>

      {status && (status.ahead > 0 || status.behind > 0) ? (
        <div className="git-track">
          {status.ahead > 0 ? <span className="track-pill">↑ {status.ahead}</span> : null}
          {status.behind > 0 ? <span className="track-pill">↓ {status.behind}</span> : null}
        </div>
      ) : null}

      <div className="git-files-head">
        <span className="section-label">Changes {status ? `(${status.files.length})` : ''}</span>
        <div className="git-files-actions">
          <button className="mini-btn" onClick={stageEverything} disabled={busy || !status?.files.length}>
            Stage all
          </button>
        </div>
      </div>

      {loading && !status ? (
        <div className="panel-loading">
          <Spinner /> Loading status
        </div>
      ) : null}

      <div className="git-files">
        {status?.files.length === 0 ? <div className="panel-empty">Working tree is clean</div> : null}
        {status?.files.map((file) => (
          <div className="git-file" key={`${file.path}-${file.indexStatus}${file.worktreeStatus}`}>
            <span className={`git-letter ${statusTone(file)}`}>{statusLetter(file)}</span>
            <span className="git-path" title={file.path}>
              {file.path}
            </span>
            {file.additions !== null && file.deletions !== null ? (
              <span
                className="git-stat"
                title={`${file.additions} added, ${file.deletions} deleted`}
              >
                <em>+{file.additions}</em> <del>-{file.deletions}</del>
              </span>
            ) : null}
            <button
              className="mini-btn"
              disabled={busy}
              onClick={() => toggleStage(file.path, file.staged)}
              title={file.staged ? 'Unstage file' : 'Stage file'}
            >
              {file.staged ? 'Unstage' : 'Stage'}
            </button>
          </div>
        ))}
      </div>

      <div className="commit-box">
        <span className="section-label">Commit</span>
        <textarea
          className="commit-message"
          rows={3}
          value={message}
          placeholder="Commit message"
          onChange={(event) => setMessage(event.target.value)}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(event) => setStageAll(event.target.checked)}
          />
          Stage all changes
        </label>
        <div className="commit-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !message.trim()}
            onClick={commit}
          >
            {busy ? 'Working…' : 'Commit'}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={push}>
            Push
          </Button>
        </div>
      </div>
    </div>
  );
}
