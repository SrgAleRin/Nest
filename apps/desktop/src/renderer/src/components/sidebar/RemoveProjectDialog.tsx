import { useEffect, useId, useRef } from 'react';
import type { Project } from '@nest/shared';
import { AlertCircleIcon } from '../Icons';

interface RemoveProjectDialogProps {
  project: Project;
  /** The removal is running: the buttons say so and cannot repeat. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Removing a project replaces `window.confirm`, which cannot explain the
 * difference between the Nest database and the disk. The dialog names both
 * sides explicitly: nothing on disk is deleted, and running sessions are
 * stopped first.
 */
export function RemoveProjectDialog({
  project,
  busy = false,
  onConfirm,
  onCancel,
}: RemoveProjectDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

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

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!busy) onCancel();
      }}
    >
      <div
        className="modal remove-project-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>Remove “{project.name}” from Nest?</h2>
            <p>
              This removes the project from the sidebar and deletes Nest&apos;s own data for it.
            </p>
          </div>
        </header>

        <div className="remove-project-body" id={bodyId}>
          <div className="remove-project-section">
            <div className="remove-project-heading">
              <AlertCircleIcon size={13} />
              <span>Deleted from Nest</span>
            </div>
            <ul>
              <li>Every task and workspace row of this project</li>
              <li>Session records and their scrollback</li>
              <li>Review comments</li>
              <li>Project settings, including the setup script and base ref</li>
            </ul>
          </div>

          <div className="remove-project-section">
            <div className="remove-project-heading">
              <span>Kept on disk</span>
            </div>
            <ul>
              <li>
                The main checkout at <code>{project.path}</code>
              </li>
              <li>Every worktree directory</li>
              <li>Every git branch</li>
            </ul>
          </div>

          <p className="modal-note">
            Running sessions of this project are stopped before anything is removed.
          </p>
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
            disabled={busy}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            {busy ? 'Removing…' : 'Remove project'}
          </button>
        </div>
      </div>
    </div>
  );
}
