import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitStatus, NestClient, Task } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { ChangeList } from './ChangeSections';
import { CommitBox } from './CommitBox';
import { SourceControlHeader } from './SourceControlHeader';
import { SourceControlSkeleton } from './PanelSkeletons';
import {
  discardWarning,
  filterSections,
  projectChanges,
  stageablePaths,
  type ChangeRow,
  type ConflictRow,
} from '../sourceControl';
import type { GitSelection, GitSide } from '../state/gitSnapshot';
import {
  useGitSnapshot,
  useGitSnapshotStore,
  useGitTaskMemory,
} from '../state/GitSnapshotProvider';
import { planSync, type SyncKind } from '../gitSync';
import { errorMessage } from '../utils';

interface SourceControlPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Opens the stored selection as a patch, without resizing the panel. */
  onOpenPatch: () => void;
  /** The explicit `Open diff`: opens the patch and widens the panel. */
  onOpenDiff: () => void;
  onOpenHistory: () => void;
  onOpenCompare: () => void;
  /** A row the list should focus after coming back from a patch. */
  initialFocus: GitSelection | null;
}

/**
 * `Source Control`: branch head, the change list and the commit block. The
 * status comes from the one store the app already reads; branches load on their
 * own and their failure only explains the sync button, never the change list.
 */
export function SourceControlPanel({
  client,
  task,
  refreshKey,
  onChanged,
  onNotify,
  onOpenPatch,
  onOpenDiff,
  onOpenHistory,
  onOpenCompare,
  initialFocus,
}: SourceControlPanelProps) {
  const taskId = task?.id ?? null;
  const store = useGitSnapshotStore();
  const snapshot = useGitSnapshot(taskId);
  const memory = useGitTaskMemory(taskId);
  const [busy, setBusy] = useState(false);

  const status: GitStatus | null = snapshot?.status.data ?? null;
  const branches = snapshot?.branches.data ?? null;
  const branchesLoading = snapshot?.branches.loading ?? false;
  const branchesError = snapshot?.branches.error ?? null;
  const stale = snapshot?.stale ?? false;

  // Branches are a separate slice: read them once, retry on demand, and never
  // let a failure here touch the status the list renders.
  useEffect(() => {
    if (!taskId || branches || branchesLoading || branchesError) return;
    void store.requestBranches(taskId);
  }, [branches, branchesError, branchesLoading, store, taskId]);

  // The watcher and the panel's own mutations both land as `git:changed`; the
  // version keeps a manual refresh (palette) reloading this task. The first
  // render is skipped: mounting already loads the task through the snapshot.
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    if (taskId) void store.requestStatus(taskId);
  }, [refreshKey, store, taskId]);

  // Back from a patch: the row that was open takes the focus again if it still
  // has a change on that side. The list may still be loading, so the focus is
  // retried once the status lands, and only once.
  const focusRestored = useRef(false);
  useEffect(() => {
    if (!initialFocus || focusRestored.current) return;
    const selector = `.change-row[data-path="${cssEscape(initialFocus.path)}"][data-side="${initialFocus.mode}"] .change-open`;
    const row = document.querySelector<HTMLButtonElement>(selector);
    if (!row) return;
    focusRestored.current = true;
    row.focus();
  }, [initialFocus, status]);

  const sections = useMemo(() => projectChanges(status?.files ?? []), [status]);
  const visible = useMemo(() => filterSections(sections, memory.filter), [memory.filter, sections]);
  const plan = useMemo(
    () => planSync({ status, branches, branchesError, branchesLoading }),
    [branches, branchesError, branchesLoading, status],
  );
  const hasHead = branches ? !branches.unborn : null;
  const stageable = useMemo(() => stageablePaths(status?.files ?? []), [status]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        onChanged();
      } catch (error) {
        onNotify('error', errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, onNotify],
  );

  const openSelection = useCallback(
    (path: string, mode: GitSide) => {
      if (!taskId) return;
      store.updateMemory(taskId, { selection: { path, mode } });
      onOpenPatch();
    },
    [onOpenPatch, store, taskId],
  );

  const stage = useCallback(
    (paths: string[]) => {
      if (!taskId || paths.length === 0) return;
      void run(() => store.stage(taskId, paths).then(() => undefined));
    },
    [run, store, taskId],
  );

  const unstage = useCallback(
    (paths: string[]) => {
      if (!taskId || paths.length === 0) return;
      void run(() => store.unstage(taskId, paths).then(() => undefined));
    },
    [run, store, taskId],
  );

  const discard = useCallback(
    (row: ChangeRow | ConflictRow) => {
      if (!taskId) return;
      if (!window.confirm(discardWarning(row, { hasHead: hasHead !== false }))) return;
      void run(() => store.discard(taskId, [row.path]).then(() => undefined));
    },
    [hasHead, run, store, taskId],
  );

  const commit = useCallback(() => {
    if (!taskId) return;
    const message = memory.draft.trim();
    if (!message) return;
    const amending = memory.amend;
    void run(async () => {
      const result = await store.commit(taskId, { message, amend: amending });
      // Only a successful commit clears the draft of this task; a failure
      // keeps it, and no other task's draft is touched.
      store.updateMemory(taskId, { draft: '' });
      onNotify('info', `${amending ? 'Amended' : 'Committed'} ${result.hash} — ${result.summary}`);
      await store.requestBranches(taskId);
    });
  }, [memory.amend, memory.draft, onNotify, run, store, taskId]);

  const sync = useCallback(
    (kind: SyncKind) => {
      if (!taskId) return;
      void run(async () => {
        try {
          if (kind === 'fetch') {
            const result = await client.invoke('git.fetch', { taskId });
            onNotify('info', result.output || 'Fetched');
          } else if (kind === 'pull') {
            const result = await client.invoke('git.pull', { taskId });
            onNotify('info', result.output || 'Already up to date');
          } else {
            const result = await client.invoke('git.push', {
              taskId,
              ...(kind === 'publish' ? { publish: true } : {}),
            });
            onNotify('info', result.output || (kind === 'publish' ? 'Published' : 'Pushed'));
          }
        } catch (error) {
          const details = errorMessage(error);
          if (kind === 'push' || kind === 'publish') {
            // The commit exists locally: say so and let the user retry the push
            // only, instead of implying the work was lost.
            onNotify(
              'error',
              `Push failed. The commit is saved locally; retry the push when the remote is reachable. ${details}`,
            );
          } else {
            throw error;
          }
        }
        await store.requestStatus(taskId);
        await store.requestBranches(taskId);
      });
    },
    [client, onNotify, run, store, taskId],
  );

  const switchBranch = useCallback(
    (branch: string) => {
      if (!taskId || branch === status?.branch) return;
      void run(async () => {
        const next = await store.checkout(taskId, { branch });
        onNotify('info', `Switched to ${next.branch}`);
        await store.requestBranches(taskId);
      });
    },
    [onNotify, run, status?.branch, store, taskId],
  );

  const createBranch = useCallback(
    (name: string) => {
      if (!taskId) return;
      void run(async () => {
        const next = await store.checkout(taskId, { branch: name, create: true });
        onNotify('info', `Created and switched to ${next.branch}`);
        await store.requestBranches(taskId);
      });
    },
    [onNotify, run, store, taskId],
  );

  if (!task) {
    return (
      <EmptyState title="No workspace selected">
        Select a task to see its changes and commit them.
      </EmptyState>
    );
  }

  if (snapshot?.status.error && !status) {
    return (
      <div className="source-control">
        <ErrorState
          title="Git status unavailable"
          onRetry={() => void store.requestStatus(task.id)}
        >
          {snapshot.status.error}
        </ErrorState>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="source-control">
        <SourceControlSkeleton />
      </div>
    );
  }

  return (
    <div className="source-control" data-testid="source-control-panel">
      <SourceControlHeader
        task={task}
        status={status}
        branches={branches}
        branchesError={branchesError}
        branchesLoading={branchesLoading}
        plan={plan}
        busy={busy}
        stale={stale}
        hasSelection={memory.selection !== null}
        onSync={sync}
        onRefresh={() => {
          void store.requestStatus(task.id);
          void store.requestBranches(task.id);
        }}
        onOpenDiff={onOpenDiff}
        onOpenHistory={onOpenHistory}
        onOpenCompare={onOpenCompare}
        onSwitchBranch={switchBranch}
        onCreateBranch={createBranch}
      />

      {snapshot?.status.error ? (
        <div className="source-control-note warn" role="status">
          Could not read the git status: {snapshot.status.error}{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() => void store.requestStatus(task.id)}
            disabled={busy || snapshot.status.loading}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="change-toolbar">
        <span className="section-label" data-testid="change-count">
          All changes · {visible.total}
        </span>
        <div className="change-toolbar-actions">
          <input
            className="change-filter"
            type="search"
            value={memory.filter}
            placeholder="Filter changes"
            aria-label="Filter changes by name or path"
            onChange={(event) => {
              if (!taskId) return;
              store.updateMemory(taskId, { filter: event.target.value });
            }}
          />
          <div className="view-toggle" role="group" aria-label="Change list layout">
            <button
              type="button"
              className={`mini-btn ${memory.view === 'tree' ? 'selected' : ''}`}
              aria-pressed={memory.view === 'tree'}
              title="Group files by directory"
              onClick={() => taskId && store.updateMemory(taskId, { view: 'tree' })}
            >
              Tree
            </button>
            <button
              type="button"
              className={`mini-btn ${memory.view === 'list' ? 'selected' : ''}`}
              aria-pressed={memory.view === 'list'}
              title="Flat file list"
              onClick={() => taskId && store.updateMemory(taskId, { view: 'list' })}
            >
              List
            </button>
          </div>
          <button
            type="button"
            className="mini-btn"
            disabled={busy || stageable.length === 0}
            title={
              stageable.length === 0
                ? 'Nothing to stage'
                : 'Stage every unstaged and untracked file (conflicts are left alone)'
            }
            onClick={() => stage(stageable)}
          >
            Stage all
          </button>
          <button
            type="button"
            className="mini-btn"
            disabled={memory.selection === null}
            title={
              memory.selection === null
                ? 'Select a changed file first'
                : 'Open the patch of the selected file'
            }
            onClick={onOpenDiff}
          >
            Open diff
          </button>
        </div>
      </div>

      <div className="change-list-scroll">
        <ChangeList
          sections={visible}
          filter={memory.filter}
          view={memory.view}
          selection={memory.selection}
          busy={busy}
          stale={stale}
          onOpen={openSelection}
          onStage={stage}
          onUnstage={unstage}
          onDiscard={discard}
          onClearSelection={() => taskId && store.updateMemory(taskId, { selection: null })}
        />
      </div>

      <CommitBox
        taskId={taskId}
        stagedCount={sections.staged.length}
        hasHead={hasHead}
        draft={memory.draft}
        amend={memory.amend}
        busy={busy}
        plan={plan}
        onDraft={(value) => taskId && store.updateMemory(taskId, { draft: value })}
        onAmend={(value) => taskId && store.updateMemory(taskId, { amend: value })}
        onCommit={commit}
        onSync={sync}
      />
    </div>
  );
}

/** `CSS.escape` is not available everywhere the panel is rendered. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
