import type { Task } from '@nest/shared';
import { useEffect, useRef, useState } from 'react';

export interface TaskNotesPopoverProps {
  task: Task;
  /** Trimmed notes, or null when the draft is empty and the notes are cleared. */
  onSave: (notes: string | null) => void;
  onCancel: () => void;
}

/**
 * Inline notes editor of a workspace card. `Clear` only empties the draft, so a
 * closed popover never writes on its own; `Save` or `Ctrl+Enter` commits.
 */
export function TaskNotesPopover({ task, onSave, onCancel }: TaskNotesPopoverProps) {
  const [draft, setDraft] = useState(task.notes ?? '');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const save = () => {
    const trimmed = draft.trim();
    onSave(trimmed.length > 0 ? trimmed : null);
  };

  return (
    <div
      className="ws-notes-popover"
      role="dialog"
      aria-label="Task notes"
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        ref={textareaRef}
        className="ws-notes-input"
        value={draft}
        placeholder="Notes for this task…"
        aria-label="Task notes"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            save();
          }
        }}
      />
      <div className="ws-notes-actions">
        <button type="button" className="ws-notes-save" title="Save (Ctrl+Enter)" onClick={save}>
          Save
        </button>
        <button type="button" className="ws-notes-clear" onClick={() => setDraft('')}>
          Clear
        </button>
        <button type="button" className="ws-notes-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
