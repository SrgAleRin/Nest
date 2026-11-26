import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitBranches, GitFile, GitLog, GitStatus, NestClient, Task } from '@nest/shared';
import { Button, EmptyState, ErrorState } from '@nest/ui';
import { BranchSwitcher } from './BranchSwitcher';
import { CommitRow } from './CommitList';
import { FileTree } from './FileTree';
import { RefreshIcon } from './Icons';
import { GitPanelSkeleton } from './PanelSkeletons';
import { panelPhase } from '../panelState';
import { errorCode, errorMessage, statusLetter, statusTone } from '../utils';

type FileView = 'tree' | 'list';

interface GitPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  onOpenCommit: (hash: string) => void;
  onOpenHistory: () => void;
}

export function GitPanel({
  client,
  task,
  refreshKey,
  onChanged,
  onNotify,
  onOpenCommit,
  onOpenHistory,
}: GitPanelProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [recent, setRecent] = useState<GitLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  const [amend, setAmend] = useState(false);
  const [view, setView] = useState<FileView>('tree');

  const load = useCallback(async () => {
    if (!task) {
      setStatus(null);
      setBranches(null);
      setRecent(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextBranches, nextLog] = await Promise.all([
        client.invoke('git.status', { taskId: task.id }),
        client.invoke('git.branches', { taskId: task.id }),
        client.invoke('git.log', { taskId: task.id, limit: 5 }),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches);
      setRecent(nextLog);
    } catch (loadError) {
      // A panel error stays inline with a retry; a toast would vanish before
      // the user can act on it.
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, task]);

  // A different task must never show the previous task's files. The right
  // panel also keys this component by task id, so this only guards reuse.
  useEffect(() => {
    setStatus(null);
    setBranches(null);
    setRecent(null);
    setError(null);
  }, [task?.id]);

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

  function discard(file: GitFile): void {
    if (!task) return;
    const target = file.oldPath
      ? `${file.copied ? 'the copy' : 'the rename'} ${file.oldPath} → ${file.path}`
      : file.untracked
        ? `this untracked file ${file.path}`
        : `local changes in ${file.path}`;
    if (!window.confirm(`Discard ${target}? This cannot be undone.`)) return;
    void run(async () => {
      const next = await client.invoke('git.discard', { taskId: task.id, paths: [file.path] });
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
        amend,
      });
      setMessage('');
      onNotify('info', `${amend ? 'Amended' : 'Committed'} ${result.hash} — ${result.summary}`);
      await load();
      onChanged();
    });
  }

  async function push(force = false): Promise<void> {
    if (!task) return;
    await run(async () => {
      try {
        const result = await client.invoke('git.push', { taskId: task.id, force });
        onNotify('info', result.output || 'Pushed');
      } catch (pushError) {
        const details = errorMessage(pushError);
        if (errorCode(pushError) === 'upstream_mismatch') {
          // Older task branches inherit their base as upstream. Publishing is
          // explicit and leaves that base branch alone.
          if (!window.confirm(`${details}\n\nPublish this branch as its own remote branch?`)) {
            return;
          }
          const result = await client.invoke('git.push', {
            taskId: task.id,
            publish: true,
            force,
          });
          onNotify('info', result.output || 'Published');
        } else if (!force && /rejected|non-fast-forward|fetch first/i.test(details)) {
          // A rewritten (amended) branch is the usual reason a push is rejected;
          // offer the lease-guarded force instead of asking the user to retype it.
          if (
            !window.confirm(
              `Push was rejected:\n${details}\n\nForce push with lease? The remote branch is rewritten only if it has not changed since your last fetch.`,
            )
          ) {
            return;
          }
          const forced = await client.invoke('git.push', { taskId: task.id, force: true });
          onNotify('info', forced.output || 'Force pushed');
        } else {
          // The commit already exists, so a failed push must not read like the
          // whole operation was lost.
          throw new Error(`Push failed, the commit stays local. ${details}`);
        }
      }
      await load();
      onChanged();
    });
  }

  function fetch(): void {
    if (!task) return;
    void run(async () => {
      const result = await client.invoke('git.fetch', { taskId: task.id });
      onNotify('info', result.output || 'Fetched');
      await load();
      onChanged();
    });
  }

  function pull(): void {
    if (!task) return;
    void run(async () => {
      const result = await client.invoke('git.pull', { taskId: task.id });
      onNotify('info', result.output || 'Already up to date');
      await load();
      onChanged();
    });
  }

  function switchBranch(branch: string): void {
    if (!task || branch === status?.branch) return;
    void run(async () => {
      const next = await client.invoke('git.checkout', { taskId: task.id, branch });
      setStatus(next);
      onNotify('info', `Switched to ${next.branch}`);
      await load();
      onChanged();
    });
  }

  function createBranch(name: string): void {
    if (!task) return;
    void run(async () => {
      const next = await client.invoke('git.checkout', {
        taskId: task.id,
        branch: name,
        create: true,
      });
      setStatus(next);
      onNotify('info', `Created and switched to ${next.branch}`);
      await load();
      onChanged();
    });
  }

  const counts = useMemo(() => {
    const files = status?.files ?? [];
    const staged = files.filter((file) => file.staged).length;
    return { staged, unstaged: files.length - staged };
  }, [status]);

  const phase = panelPhase({ loading, error, hasData: status !== null });
  const hasRemotes = (branches?.remotes.length ?? 0) > 0;
  const canPull = hasRemotes && Boolean(status?.upstream);

  if (!task) {
    return <EmptyState title="No workspace selected">Select a task to see git status.</EmptyState>;
  }

  if (phase === 'error') {
    return (
      <div className="panel-scroll git-panel">
        <GitHead
          branches={branches}
          loading={loading}
          busy={busy}
          canFetch={hasRemotes}
          canPull={canPull}
          canPush={hasRemotes}
          onRefresh={() => void load()}
          onFetch={fetch}
          onPull={pull}
          onPush={() => void push()}
          onSwitchBranch={switchBranch}
          onCreateBranch={createBranch}
        />
        <ErrorState title="Git status unavailable" onRetry={() => void load()}>
          {error}
        </ErrorState>
      </div>
    );
  }

  if (phase !== 'ready' || !status) {
    return <GitPanelSkeleton />;
  }

  const renderFile = (file: GitFile, depth: number) => (
    <GitFileRow
      file={file}
      depth={depth}
      name={view === 'tree' ? (file.path.split('/').pop() ?? file.path) : file.path}
      busy={busy}
      onToggleStage={() => toggleStage(file.path, file.staged)}
      onDiscard={() => discard(file)}
    />
  );

  return (
    <div className="panel-scroll git-panel">
      <GitHead
        branches={branches}
        loading={loading}
        busy={busy}
        canFetch={hasRemotes}
        canPull={canPull}
        canPush={hasRemotes}
        onRefresh={() => void load()}
        onFetch={fetch}
        onPull={pull}
        onPush={() => void push()}
        onSwitchBranch={switchBranch}
        onCreateBranch={createBranch}
      />

      <div className="git-track">
        <span className="git-upstream">{status.upstream ?? 'no upstream'}</span>
        {status.ahead > 0 ? <span className="track-pill">↑ {status.ahead}</span> : null}
        {status.behind > 0 ? <span className="track-pill">↓ {status.behind}</span> : null}
      </div>

      <div className="git-files-head">
        <span className="section-label">
          Changes ({status.files.length}){counts.staged > 0 ? ` · ${counts.staged} staged` : ''}
        </span>
        <div className="git-files-actions">
          <button
            className={`mini-btn ${view === 'tree' ? 'selected' : ''}`}
            onClick={() => setView('tree')}
            title="Group files by directory"
          >
            Tree
          </button>
          <button
            className={`mini-btn ${view === 'list' ? 'selected' : ''}`}
            onClick={() => setView('list')}
            title="Flat file list"
          >
            List
          </button>
          <button
            className="mini-btn"
            onClick={stageEverything}
            disabled={busy || !status.files.length}
          >
            Stage all
          </button>
        </div>
      </div>

      <div className="git-files">
        {status.files.length === 0 ? (
          <div className="panel-empty">Working tree is clean</div>
        ) : view === 'tree' ? (
          <FileTree
            entries={status.files}
            emptyLabel="Working tree is clean"
            renderFile={renderFile}
          />
        ) : (
          status.files.map((file) => (
            <div key={`${file.path}:${file.indexStatus}${file.worktreeStatus}`}>
              {renderFile(file, 0)}
            </div>
          ))
        )}
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
        <label className="checkbox" title="Replace the previous commit instead of adding a new one">
          <input
            type="checkbox"
            checked={amend}
            disabled={branches?.unborn ?? false}
            onChange={(event) => setAmend(event.target.checked)}
          />
          Amend last commit
        </label>
        <div className="commit-actions">
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !message.trim() || (branches?.unborn ?? false)}
            onClick={commit}
          >
            {busy ? 'Working…' : amend ? 'Amend commit' : 'Commit'}
          </Button>
        </div>
      </div>

      <div className="git-files-head">
        <span className="section-label">Recent commits</span>
        <button className="mini-btn" onClick={onOpenHistory}>
          All commits
        </button>
      </div>
      <div className="commit-list recent-commits">
        {recent && recent.commits.length > 0 ? (
          recent.commits.map((commit) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              compact
              onSelect={() => onOpenCommit(commit.hash)}
            />
          ))
        ) : (
          <div className="panel-empty">No commits yet</div>
        )}
      </div>
    </div>
  );
}

function GitFileRow({
  file,
  depth,
  name,
  busy,
  onToggleStage,
  onDiscard,
}: {
  file: GitFile;
  depth: number;
  name: string;
  busy: boolean;
  onToggleStage: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="git-file tree-row"
      style={{ paddingLeft: 6 + depth * 11 }}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      <span className={`git-letter ${statusTone(file)}`}>{statusLetter(file)}</span>
      <span className="git-path">{renameLabel(file, name)}</span>
      {file.additions !== null && file.deletions !== null ? (
        <span className="git-stat" title={`${file.additions} added, ${file.deletions} deleted`}>
          <em>+{file.additions}</em> <del>-{file.deletions}</del>
        </span>
      ) : null}
      <span className="git-file-actions">
        <button
          className="mini-btn"
          disabled={busy}
          onClick={onToggleStage}
          title={file.staged ? 'Unstage file' : 'Stage file'}
        >
          {file.staged ? 'Unstage' : 'Stage'}
        </button>
        <button
          className="mini-btn danger git-discard"
          disabled={busy}
          onClick={onDiscard}
          title="Discard changes in this file"
        >
          Discard
        </button>
      </span>
    </div>
  );
}

function renameLabel(file: GitFile, name: string): string {
  if (!file.oldPath) return name;
  const source = file.oldPath.split('/').pop() ?? file.oldPath;
  return `${source} → ${name}`;
}

function GitHead({
  branches,
  loading,
  busy,
  canFetch,
  canPull,
  canPush,
  onRefresh,
  onFetch,
  onPull,
  onPush,
  onSwitchBranch,
  onCreateBranch,
}: {
  branches: GitBranches | null;
  loading: boolean;
  busy: boolean;
  canFetch: boolean;
  canPull: boolean;
  canPush: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onSwitchBranch: (branch: string) => void;
  onCreateBranch: (name: string) => void;
}) {
  return (
    <div className="git-head">
      <BranchSwitcher
        branches={branches}
        busy={busy}
        onSwitch={onSwitchBranch}
        onCreate={onCreateBranch}
      />
      <div className="git-head-actions">
        <button
          className="mini-btn"
          onClick={onFetch}
          disabled={busy || !canFetch}
          title={canFetch ? 'git fetch --prune' : 'This repository has no remotes'}
        >
          Fetch
        </button>
        <button
          className="mini-btn"
          onClick={onPull}
          disabled={busy || !canPull}
          title={canPull ? 'Fast-forward from the upstream branch' : 'No upstream branch'}
        >
          Pull
        </button>
        <button
          className="mini-btn"
          onClick={onPush}
          disabled={busy || !canPush}
          title={canPush ? 'git push' : 'This repository has no remotes'}
        >
          Push
        </button>
        <button className="icon-btn" title="Refresh status" onClick={onRefresh} disabled={loading}>
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}
