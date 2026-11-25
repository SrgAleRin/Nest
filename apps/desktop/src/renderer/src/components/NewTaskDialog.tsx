import { useEffect, useRef, useState } from 'react';
import type { Project } from '@nest/shared';
import { Button } from '@nest/ui';

export type NewTaskLocation = 'worktree' | 'checkout';

export interface NewTaskSubmission {
  location: NewTaskLocation;
  title?: string;
  baseBranch?: string;
  setupScript?: string | null;
}

interface NewTaskDialogProps {
  project: Project;
  busy: boolean;
  onClose: () => void;
  onSubmit: (submission: NewTaskSubmission) => void;
}

export function NewTaskDialog({ project, busy, onClose, onSubmit }: NewTaskDialogProps) {
  const [location, setLocation] = useState<NewTaskLocation>('worktree');
  const [title, setTitle] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [setupScript, setSetupScript] = useState(project.setupScript ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const worktree = location === 'worktree';
  const canSubmit = worktree ? title.trim().length > 0 : true;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy) return;
          if (!worktree) {
            onSubmit({ location: 'checkout' });
            return;
          }
          onSubmit({
            location: 'worktree',
            title: title.trim(),
            baseBranch: baseBranch.trim() || undefined,
            setupScript: setupScript.trim() ? setupScript.trim() : null,
          });
        }}
      >
        <header className="modal-head">
          <div>
            <h2>New task</h2>
            <p>
              {worktree ? (
                <>
                  Creates a worktree and branch <code>nest/&lt;slug&gt;</code> from{' '}
                  <code>{project.name}</code>
                </>
              ) : (
                <>
                  Opens the main checkout of <code>{project.name}</code> — no worktree, no branch
                </>
              )}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="choice-row" role="radiogroup" aria-label="Task location">
          <label className={`choice ${worktree ? 'active' : ''}`}>
            <input
              type="radio"
              name="location"
              checked={worktree}
              onChange={() => setLocation('worktree')}
            />
            <strong>New worktree</strong>
            <span>Isolated branch for risky work</span>
          </label>
          <label className={`choice ${!worktree ? 'active' : ''}`}>
            <input
              type="radio"
              name="location"
              checked={!worktree}
              onChange={() => setLocation('checkout')}
            />
            <strong>Main checkout</strong>
            <span>Project root, current branch</span>
          </label>
        </div>

        {worktree ? (
          <>
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
          </>
        ) : (
          <p className="field-hint">
            The main checkout is shared: sessions here see your working tree as it is. Use a
            worktree when an agent may break something.
          </p>
        )}

        <footer className="modal-foot">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !canSubmit}>
            {busy ? (worktree ? 'Creating…' : 'Opening…') : worktree ? 'Create task' : 'Open checkout'}
          </Button>
        </footer>
      </form>
    </div>
  );
}
