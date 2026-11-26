import { useEffect, useId, useRef } from 'react';
import type { ConfirmRequest } from '../confirm';

interface ConfirmActionProps {
  request: ConfirmRequest;
  /** The action is already running: the accept button says so and cannot repeat. */
  busy?: boolean;
  onAccept: () => void;
  onCancel: () => void;
}

/**
 * One in-panel confirmation for an action the panel cannot take back. It is not
 * a browser dialog: the changes list stays readable behind it, the text names
 * the exact target, Escape and the backdrop cancel, and a destructive action
 * starts with the focus on Cancel so Enter never fires it by accident.
 */
export function ConfirmAction({ request, busy = false, onAccept, onCancel }: ConfirmActionProps) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);

  // A destructive action starts on Cancel; anything else starts on the action.
  useEffect(() => {
    if (request.destructive) cancelRef.current?.focus();
    else acceptRef.current?.focus();
  }, [request.destructive]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // Capture phase: the dialog owns Escape while it is open, before the
        // diff and the list see it.
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      // Two controls: Tab cycles between them instead of leaving the dialog.
      const options = [cancelRef.current, acceptRef.current].filter(
        (option): option is HTMLButtonElement => option !== null && !option.disabled,
      );
      if (options.length === 0) return;
      const index = options.findIndex((option) => option === document.activeElement);
      const next =
        event.shiftKey || index > 0
          ? options[(index - 1 + options.length) % options.length]
          : options[1];
      if (next) {
        event.preventDefault();
        next.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className="confirm-layer"
      data-testid="confirm-backdrop"
      onMouseDown={(event) => {
        // The backdrop cancels; a click inside the card does not bubble out.
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="confirm"
        data-testid="confirm-action"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 className="confirm-title" id={titleId}>
          {request.title}
        </h2>
        <div className="confirm-body" id={bodyId}>
          {request.body.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="confirm-cancel"
            ref={cancelRef}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn-sm ${request.destructive ? 'btn-danger' : 'btn-primary'}`}
            data-testid="confirm-accept"
            ref={acceptRef}
            disabled={busy}
            onClick={onAccept}
          >
            {busy ? 'Working…' : request.acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
