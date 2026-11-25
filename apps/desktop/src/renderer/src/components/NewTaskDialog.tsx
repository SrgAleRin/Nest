import { useEffect, useRef, useState } from 'react';
import type { Project } from '@nest/shared';
import { Button } from '@nest/ui';

interface NewTaskDialogProps {
  project: Project;
  busy: boolean;
  onClose: () => void;
  onSubmit: (title: string, baseBranch?: string, setupScript?: string | null) => void;
}

export function NewTaskDialog({ project, busy, onClose, onSubmit }: NewTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [setupScript, setSetupScript] = useState(project.setupScript ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim() || busy) return;
          onSubmit(
            title.trim(),
            baseBranch.trim() || undefined,
            setupScript.trim() ? setupScript.trim() : null,
          );
        }}
      >
        <header className="modal-head">
          <div>
            <h2>New task</h2>
            <p>
              Creates a worktree and branch <code>nest/&lt;slug&gt;</code> from{' '}
              <code>{project.name}</code>
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <label className="field">
          <span>Title</span>
          <input
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Fix terminal reconnect"
            maxLength={200}
          />
        </label>

        <label className="field">
          <span>
            Base branch <em>optional</em>
          </span>
          <input
            value={baseBranch}
            onChange={(event) => setBaseBranch(event.target.value)}
            placeholder="current branch, or origin/main after fetch"
          />
        </label>

        <label className="field">
          <span>
            Setup script <em>optional</em>
          </span>
          <input
            value={setupScript}
            onChange={(event) => setSetupScript(event.target.value)}
            placeholder="pnpm install"
            maxLength={2000}
          />
          <small className="field-hint">
            Runs in the new worktree after it is created and is remembered for this project.
            <code>.env</code> and <code>.env.local</code> are copied automatically.
          </small>
        </label>

        <footer className="modal-foot">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
            {busy ? 'Creating…' : 'Create task'}
          </Button>
        </footer>
      </form>
    </div>
  );
}
