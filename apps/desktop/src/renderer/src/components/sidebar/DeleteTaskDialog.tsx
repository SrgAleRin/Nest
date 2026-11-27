import { useEffect, useId, useRef, useState } from 'react';
import type { GitFile, GitStatus, NestClient, Project, Task } from '@nest/shared';
import { AlertCircleIcon } from '../Icons';
import { errorMessage, statusLetter } from '../../utils';

/** Long dirty lists are cut here: the dialog names the risk, not the whole diff. */
export const DIRTY_FILES_PREVIEW_LIMIT = 20;

export interface DeleteRiskSummary {
  /** Uncommitted entries; the worktree can only go with a force delete. */
  dirtyFiles: GitFile[];
  /** Local commits that are not pushed yet. */
  unpushed: number;
  /** The branch has no upstream, so nothing of it exists on the remote. */
  localOnlyBranch: boolean;
  /** Warning to show above the actions, or null when nothing would be lost. */
  warning: string | null;
  /** The branch can be deleted together with the worktree. */
  canDeleteBranch: boolean;
  /** Why the branch checkbox is disabled, or null. */
  branchBlockedReason: string | null;
  /** Label of the confirm button: a dirty worktree needs `--force`. */
  confirmLabel: string;
  /** Git status could not be read: the worktree may already be gone. */
  statusUnknown: boolean;
}

/**
 * What deleting this worktree would throw away. Pure, so the dialog markup and
 * the tests agree on the same rules: a dirty worktree forces the deletion, and
 * the main checkout or the project base branch is never deleted with it.
 */
export function summarizeDeleteRisk(
  status: GitStatus | null,
  project: Project | null,
  task: Task,
): DeleteRiskSummary {
  const dirtyFiles = status?.files ?? [];
  const unpushed = status?.ahead ?? 0;
  const localOnlyBranch = status ? !status.upstream && !status.unborn : false;
  const warning = localOnlyBranch
    ? 'This branch has no upstream: its commits exist only on this machine.'
    : unpushed > 0
      ? `${unpushed} local commit${unpushed === 1 ? '' : 's'} not pushed yet.`
      : null;

  const isCheckout = task.kind === 'checkout';
  const isBaseBranch = project !== null && task.branch === project.defaultBaseRef;
  const branchBlockedReason = isCheckout
    ? 'The main checkout has no worktree branch to delete'
    : isBaseBranch
      ? 'This is the project base branch'
      : null;

  return {
    dirtyFiles,
    unpushed,
    localOnlyBranch,
    warning,
    canDeleteBranch: branchBlockedReason === null,
    branchBlockedReason,
    confirmLabel: dirtyFiles.length > 0 ? 'Force delete worktree' : 'Delete worktree',
    statusUnknown: status === null,
  };
}

export interface DeleteTaskOptions {
  force: boolean;
  deleteBranch: boolean;
}

interface DeleteTaskDialogProps {
  client: NestClient;
  task: Task;
  /** The owning project; null when it is already gone from the list. */
  project: Project | null;
  /** The deletion is running: the buttons say so and cannot repeat. */
  busy?: boolean;
  onConfirm: (options: DeleteTaskOptions) => void;
  onCancel: () => void;
}

/**
 * Deleting a worktree is not undoable, so it gets a real dialog instead of
 * `window.confirm`: the uncommitted files are named, unpushed commits are
 * called out, and the branch is kept unless the user explicitly asks for it.
 * The dialog never blocks the app: the list behind it stays readable.
 */
export function DeleteTaskDialog({
  client,
  task,
  project,
  busy = false,
  onConfirm,
  onCancel,
}: DeleteTaskDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteBranch, setDeleteBranch] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    client
      .invoke('git.status', { taskId: task.id })
      .then((result) => {
        if (!alive) return;
        setStatus(result);
        setStatusError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        // A worktree that is already gone on disk has no status to read; that
        // is exactly the case where the dialog must still allow the deletion.
        setStatus(null);
        setStatusError(errorMessage(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, task.id]);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onCancel]);

  const risk = summarizeDeleteRisk(status, project, task);
  const preview = risk.dirtyFiles.slice(0, DIRTY_FILES_PREVIEW_LIMIT);
  const hidden = risk.dirtyFiles.length - preview.length;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!busy) onCancel();
      }}
    >
      <div
        className="modal delete-task-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>Delete worktree “{task.title}”?</h2>
            <p>
              Removes the worktree of <code>{project?.name ?? task.projectId}</code> from disk. The
              local branch <code>{task.branch}</code> is kept unless you delete it below.
            </p>
          </div>
        </header>

        <div className="delete-task-body" id={bodyId}>
          {loading ? (
            <p className="modal-note">Reading git status…</p>
          ) : risk.dirtyFiles.length > 0 ? (
            <div className="dirty-files">
              <div className="dirty-files-head">
                <AlertCircleIcon size={13} />
                <span>
                  {risk.dirtyFiles.length} uncommitted file
                  {risk.dirtyFiles.length === 1 ? '' : 's'} will be lost
                </span>
              </div>
              <ul className="dirty-files-list">
                {preview.map((file) => (
                  <li key={file.path}>
                    <span className="dirty-file-status">{statusLetter(file)}</span>
                    <span className="dirty-file-path" title={file.path}>
                      {file.path}
                    </span>
                  </li>
                ))}
              </ul>
              {hidden > 0 ? <p className="dirty-files-more">…and {hidden} more</p> : null}
            </div>
          ) : statusError ? (
            <p className="modal-note warn">
              Git status is unavailable ({statusError}). The worktree may already be gone, or it may
              still hold changes Nest cannot list.
            </p>
          ) : (
            <p className="modal-note">No uncommitted changes in this worktree.</p>
          )}

          {risk.warning ? (
            <p className="modal-note warn">
              {risk.warning} Deleting the worktree keeps the branch, so those commits stay in git.
            </p>
          ) : null}

          <label className={`delete-branch ${risk.canDeleteBranch ? '' : 'disabled'}`}>
            <input
              type="checkbox"
              checked={deleteBranch && risk.canDeleteBranch}
              disabled={!risk.canDeleteBranch || busy}
              onChange={(event) => setDeleteBranch(event.target.checked)}
            />
            <span>
              Also delete local branch <code>{task.branch}</code>
            </span>
          </label>
          {risk.branchBlockedReason ? (
            <p className="delete-branch-note">{risk.branchBlockedReason}.</p>
          ) : null}
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            ref={cancelRef}
            disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy || loading}
            onClick={() => {
              if (busy) return;
              onConfirm({
                force: risk.dirtyFiles.length > 0,
                deleteBranch: deleteBranch && risk.canDeleteBranch,
              });
            }}
          >
            {busy ? 'Deleting…' : risk.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
