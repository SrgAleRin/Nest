import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitStatus, NestClient, Task } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { ChangeList } from './ChangeSections';
import { CommitBox } from './CommitBox';
import { ConfirmAction } from './ConfirmAction';
import { SourceControlHeader } from './SourceControlHeader';
import { SourceControlSkeleton } from './PanelSkeletons';
import {
  canDiscardRow,
  discardConfirmation,
  filterSections,
  projectChanges,
  rowStillChanged,
  rowTarget,
  stageablePaths,
  staleAbortNote,
  type ChangeRow,
  type ConflictRow,
} from '../sourceControl';
import type { ConfirmRequest } from '../confirm';
import type { GitSelection, GitSide } from '../state/gitSnapshot';
import {
  useGitSnapshot,
  useGitSnapshotStore,
  useGitTaskMemory,
} from '../state/GitSnapshotProvider';
import {
  forcePushConfirmation,
  freshGuardReason,
  planSync,
  planSyncFailure,
  publishTargetConfirmation,
  publishTargetFor,
  type SyncFailure,
  type SyncKind,
} from '../gitSync';
import { errorCode, errorMessage } from '../utils';

interface SourceControlPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
  onChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Opens the stored selection as a patch, without resizing the panel. */
  onOpenPatch: () => void;
  /** Opens or activates the center `Diff` tab; never resizes the panel. */
  onOpenDiff: () => void;
  /**
   * Opens or activates the center `Graph` tab with every branch. Optional so
   * this panel still typechecks and runs without the center workbench.
   */
  onOpenGraph?: () => void;
  /**
   * Opens one branch read-only in the center graph, without switching. Optional
   * like `onOpenGraph`: without it `Inspect` only opens the graph.
   */
  onInspectBranch?: (ref: string) => void;
  onOpenHistory: () => void;
  onOpenCompare: () => void;
  /** A row the list should focus after coming back from a patch. */
  initialFocus: GitSelection | null;
}

/** One action a failed operation offers inline; nothing here runs by itself. */
interface PanelNoteAction {
  id: string;
  label: string;
  run: () => void;
}

/** What the panel says in place of a toast when an operation fails. */
interface PanelNote {
  tone: 'warn' | 'error';
  text: string;
  /** The operation's own reason, e.g. git's rejection text. */
  detail?: string;
  actions: PanelNoteAction[];
}

/**
 * `Source Control`: branch head, the change list and the commit block. The
 * status comes from the one store the app already reads; branches load on their
 * own and their failure only explains the sync button, never the change list.
 * Every step that cannot be taken back asks first, in the panel, naming its
 * exact target.
 */
export function SourceControlPanel({
  client,
  task,
  onChanged,
  onNotify,
  onOpenPatch,
  onOpenDiff,
  onOpenGraph,
  onInspectBranch,
  onOpenHistory,
  onOpenCompare,
  initialFocus,
}: SourceControlPanelProps) {
  const taskId = task?.id ?? null;
  const store = useGitSnapshotStore();
  const snapshot = useGitSnapshot(taskId);
  const memory = useGitTaskMemory(taskId);
  const [busy, setBusy] = useState(false);
  /** The remote action in flight; the control shows what it is doing. */
  const [pendingSync, setPendingSync] = useState<SyncKind | null>(null);
  /** A failed remote action: its reason and the actions it allows. */
  const [failure, setFailure] = useState<SyncFailure | null>(null);
  const [note, setNote] = useState<PanelNote | null>(null);
  const [confirm, setConfirm] = useState<{
    request: ConfirmRequest;
    /** The accepted action; `null` keeps the dialog while an accept runs. */
    accept: () => void;
  } | null>(null);

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
  // `unborn` comes from the status itself, so a branch list that is still
  // loading (or failed) can never make an empty repository look like it has HEAD.
  const hasHead = status ? !status.unborn : null;
  const stageable = useMemo(() => stageablePaths(status?.files ?? []), [status]);
  /** Paths that also have a staged side; the unstaged row of such a file is partial. */
  const stagedPaths = useMemo(() => new Set(sections.staged.map((row) => row.path)), [sections]);
  const openGraph = onOpenGraph ?? (() => undefined);
  // `Inspect` needs a surface that can show a branch; without the center it is
  // not offered rather than shown as a dead action.
  const inspectBranch = onInspectBranch ?? (onOpenGraph ? () => onOpenGraph() : undefined);

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

  /**
   * A remote action and what the panel offers when it fails. The reason and the
   * retry stay inline: the change list, the commit block and the draft keep
   * their data, and nothing is committed again to fix a push.
   */
  const runSync = useCallback(
    async (kind: SyncKind, options: { force?: boolean } = {}) => {
      if (!taskId) return;
      setBusy(true);
      setPendingSync(kind);
      setNote(null);
      setFailure(null);
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
            ...(options.force ? { force: true } : {}),
          });
          onNotify('info', result.output || (kind === 'publish' ? 'Published' : 'Pushed'));
        }
        onChanged();
      } catch (error) {
        const syncFailure = planSyncFailure({
          kind,
          code: errorCode(error),
          message: errorMessage(error),
          status,
          branches,
        });
        setFailure(syncFailure);
      } finally {
        // The operation may have moved the upstream or created a remote branch:
        // read both slices again, and keep the failure note on screen.
        await store.requestStatus(taskId).catch(() => undefined);
        void store.requestBranches(taskId);
        setBusy(false);
        setPendingSync(null);
      }
    },
    [branches, client, onChanged, onNotify, status, store, taskId],
  );

  /** The upstream switch: named, confirmed, and only then retried as publish. */
  const askPublishTarget = useCallback(
    (failure: SyncFailure) => {
      const target = failure.publishTarget;
      if (!target) return;
      setConfirm({
        request: publishTargetConfirmation({
          branch: target.branch,
          upstream: status?.upstream ?? null,
          target,
        }),
        accept: () => {
          setConfirm(null);
          void runSync('publish');
        },
      });
    },
    [runSync, status?.upstream],
  );

  /**
   * A destructive remote action never runs on a stale snapshot: the status is
   * read again, and the action stops when that read cannot vouch for the state.
   */
  const canRunDestructive = useCallback(async (): Promise<boolean> => {
    if (!stale || !taskId) return true;
    await store.requestStatus(taskId);
    const fresh = store.getTask(taskId);
    const reason = freshGuardReason({
      error: fresh?.status.error ?? null,
      stale: fresh?.stale ?? false,
      behind: fresh?.status.data?.behind ?? 0,
    });
    if (!reason) return true;
    setFailure(null);
    setNote({
      tone: 'warn',
      text: `Nothing was pushed: ${reason}. Read the state again and retry when it is current.`,
      actions: [],
    });
    return false;
  }, [stale, store, taskId]);

  /** The lease-guarded force: its own confirmation, never an automatic retry. */
  const askForcePush = useCallback(() => {
    const target = publishTargetFor(branches, status);
    const branch = target?.branch ?? status?.branch ?? 'this branch';
    setConfirm({
      request: forcePushConfirmation({
        branch,
        target: target?.target ?? status?.upstream ?? 'the remote branch',
      }),
      accept: () => {
        setConfirm(null);
        void (async () => {
          if (!(await canRunDestructive())) return;
          await runSync('push', { force: true });
        })();
      },
    });
  }, [branches, canRunDestructive, runSync, status]);

  const noteOfFailure = useCallback(
    (syncFailure: SyncFailure): PanelNote => {
      const actions: PanelNoteAction[] = [
        syncFailure.publishTarget
          ? {
              id: 'publish-target',
              label: 'Publish branch',
              run: () => askPublishTarget(syncFailure),
            }
          : {
              id: 'retry',
              label: `Retry ${syncFailure.kind}`,
              run: () => void runSync(syncFailure.kind),
            },
      ];
      if (syncFailure.canForcePush) {
        actions.push({ id: 'force', label: 'Force push with lease', run: askForcePush });
      }
      return {
        tone: 'error',
        text: syncFailure.summary,
        ...(syncFailure.message ? { detail: syncFailure.message } : {}),
        actions,
      };
    },
    [askForcePush, askPublishTarget, runSync],
  );

  /** One inline note: a failed remote action, or the panel's own refusal. */
  const panelNote = failure ? noteOfFailure(failure) : note;

  /**
   * `Discard` asks in the panel and names its scope. A stale snapshot is never
   * used for it: the panel reads the status again and refuses when the row
   * moved, so a discard cannot hit a path that changed under the confirmation.
   */
  const performDiscard = useCallback(
    async (row: ChangeRow | ConflictRow) => {
      if (!taskId) return;
      setConfirm(null);
      setNote(null);
      setFailure(null);
      if (stale) {
        await store.requestStatus(taskId);
        const fresh = store.getTask(taskId);
        if (fresh?.status.error) {
          setNote({
            tone: 'warn',
            text: `Nothing was discarded: the fresh git status could not be read (${fresh.status.error}).`,
            actions: [{ id: 'retry', label: 'Retry', run: () => void performDiscard(row) }],
          });
          return;
        }
        // A read that lost to a newer invalidation leaves the snapshot stale:
        // it cannot prove what is on disk, so the discard does not run.
        if (fresh?.stale) {
          setNote({
            tone: 'warn',
            text: `Nothing was discarded: the git status changed again while it was read, so ${rowTarget(row)} could not be checked. Retry when the panel is not stale.`,
            actions: [{ id: 'retry', label: 'Retry', run: () => void performDiscard(row) }],
          });
          return;
        }
        if (!rowStillChanged(row, fresh?.status.data?.files ?? [])) {
          setNote({ tone: 'warn', text: staleAbortNote(row), actions: [] });
          return;
        }
      }
      // The worktree row of a partially staged file restores only the worktree
      // from the index; every other discard drops the path entirely.
      const unstagedHalf = 'side' in row && row.side === 'unstaged' && stagedPaths.has(row.path);
      await run(async () => {
        if (!unstagedHalf) {
          await store.discard(taskId, [row.path]);
          return;
        }
        await store.discard(taskId, [row.path], 'unstaged');
      });
    },
    [run, stale, stagedPaths, store, taskId],
  );

  const discard = useCallback(
    (row: ChangeRow | ConflictRow) => {
      if (!taskId) return;
      const hasStagedSide = 'side' in row && row.side === 'unstaged' && stagedPaths.has(row.path);
      const options = { hasHead: hasHead === true, hasStagedSide };
      const permission = canDiscardRow(row, options);
      if (!permission.allowed) {
        // The row action is disabled, but a stale render could still get here.
        setNote({
          tone: 'warn',
          text: permission.reason ?? 'This discard is not possible.',
          actions: [],
        });
        return;
      }
      setConfirm({
        request: discardConfirmation(row, options),
        accept: () => void performDiscard(row),
      });
    },
    [hasHead, performDiscard, stagedPaths, taskId],
  );

  const commit = useCallback(() => {
    if (!taskId) return;
    const message = memory.draft.trim();
    if (!message) return;
    const amending = memory.amend;
    void run(async () => {
      const result = await store.commit(taskId, { message, amend: amending });
      // Only a successful commit clears the draft of this task; a failure
      // keeps it, and no other task's draft is touched. `Amend` is one-shot:
      // leaving it on would let the next commit silently rewrite this one.
      store.updateMemory(taskId, { draft: '', amend: false });
      onNotify('info', `${amending ? 'Amended' : 'Committed'} ${result.hash} — ${result.summary}`);
      await store.requestBranches(taskId);
    });
  }, [memory.amend, memory.draft, onNotify, run, store, taskId]);

  /**
   * A switch that a dirty worktree refuses stays on screen as a panel note:
   * a toast would disappear before the user can read why the branch is still
   * the old one.
   */
  const switchBranch = useCallback(
    (branch: string) => {
      if (!taskId || branch === status?.branch) return;
      setBusy(true);
      setNote(null);
      setFailure(null);
      void (async () => {
        try {
          const next = await store.checkout(taskId, { branch });
          onChanged();
          onNotify('info', `Switched to ${next.branch}`);
          await store.requestBranches(taskId);
        } catch (error) {
          setNote({
            tone: 'error',
            text: `Could not switch to ${branch}: ${errorMessage(error)}`,
            actions: [],
          });
        } finally {
          setBusy(false);
        }
      })();
    },
    [onChanged, onNotify, status?.branch, store, taskId],
  );

  /**
   * Enabling `Amend last commit` on a blank draft loads the message of `HEAD`
   * from the log slice, so the user edits the real message instead of an empty
   * box. The draft is only filled while the draft is still blank and `Amend`
   * is still on: a slow answer cannot overwrite typing that started meanwhile.
   */
  const toggleAmend = useCallback(
    (value: boolean) => {
      if (!taskId) return;
      store.updateMemory(taskId, { amend: value });
      if (!value || store.getMemory(taskId).draft.trim() !== '') return;
      void (async () => {
        await store.requestLog(taskId, 1);
        const last = store.getTask(taskId)?.log.data?.commits[0];
        if (!last) return;
        const memoryNow = store.getMemory(taskId);
        if (!memoryNow.amend || memoryNow.draft.trim() !== '') return;
        const message = [last.subject.trim(), last.body.trim()].filter(Boolean).join('\n\n');
        store.updateMemory(taskId, { draft: message });
      })();
    },
    [store, taskId],
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
        pendingSync={pendingSync}
        stale={stale}
        onSync={(kind) => void runSync(kind)}
        onRefresh={() => {
          void store.requestStatus(task.id);
          void store.requestBranches(task.id);
        }}
        onOpenDiff={onOpenDiff}
        onOpenGraph={openGraph}
        onInspectBranch={inspectBranch}
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

      {panelNote ? (
        <div
          className={`source-control-note ${panelNote.tone} source-control-failure`}
          role="status"
          data-testid="panel-note"
        >
          <span>{panelNote.text}</span>
          {panelNote.detail ? (
            <details className="source-control-reason">
              <summary>Reason</summary>
              <pre>{panelNote.detail}</pre>
            </details>
          ) : null}
          {panelNote.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="link-btn"
              disabled={busy}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
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
            title={
              memory.selection === null
                ? 'Open the worktree diff of this task'
                : 'Open the patch of the selected file'
            }
            onClick={onOpenDiff}
          >
            Open diff
          </button>
          <button
            type="button"
            className="mini-btn"
            title="Open the Git graph of all branches in the center"
            onClick={openGraph}
          >
            Graph
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
          hasHead={hasHead === true}
          stagedPaths={stagedPaths}
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
        onAmend={toggleAmend}
        onCommit={commit}
        onSync={(kind) => void runSync(kind)}
      />

      {confirm ? (
        <ConfirmAction
          request={confirm.request}
          busy={busy}
          onAccept={confirm.accept}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  );
}

/** `CSS.escape` is not available everywhere the panel is rendered. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}
