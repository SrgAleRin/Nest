import { useEffect, useRef, useState } from 'react';
import type {
  HarnessProfile,
  NestClient,
  NewSessionDefault,
  Project,
  TaskProgressStep,
} from '@nest/shared';
import { Button } from '@nest/ui';
import type { TaskPreview } from '@nest/shared';
import { STEP_LABELS, baseRefLabel, blockedReason, defaultHarnessId } from '../newTask';
import { errorMessage } from '../utils';

export type NewTaskLocation = 'worktree' | 'checkout';

export interface NewTaskSubmission {
  location: NewTaskLocation;
  title?: string;
  /** Empty means the project default; core resolves the effective ref either way. */
  baseRef?: string;
  setupScript?: string | null;
  harnessId?: string;
  /** `Create & start` starts the chosen profile right after the task exists. */
  start: boolean;
}

interface NewTaskDialogProps {
  client: NestClient;
  project: Project;
  /** Profiles the settings do not hide; the picker never shows disabled ones. */
  harnesses: HarnessProfile[];
  newSessionDefault: NewSessionDefault;
  /** A creation is running for this dialog. */
  busy: boolean;
  /** Current creation step, pushed from the core progress events. */
  step: TaskProgressStep | null;
  error: string | null;
  /** Set when the task exists but the harness did not start: retry start only. */
  retryStart: { taskId: string; harnessId: string } | null;
  onCreate: (submission: NewTaskSubmission) => void;
  /** Aborts the running creation and closes the dialog. */
  onCancel: () => void;
  /** Hides the dialog; a running creation keeps going. */
  onClose: () => void;
  onRetryStart: () => void;
}

export function NewTaskDialog({
  client,
  project,
  harnesses,
  newSessionDefault,
  busy,
  step,
  error,
  retryStart,
  onCreate,
  onCancel,
  onClose,
  onRetryStart,
}: NewTaskDialogProps) {
  const [location, setLocation] = useState<NewTaskLocation>('worktree');
  const [title, setTitle] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [setupScript, setSetupScript] = useState(project.setupScript ?? '');
  const [harnessId, setHarnessId] = useState(() => defaultHarnessId(harnesses, newSessionDefault));
  const [preview, setPreview] = useState<TaskPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A profile can disappear (settings changed) while the dialog is open.
  useEffect(() => {
    if (harnessId && harnesses.some((harness) => harness.id === harnessId)) return;
    setHarnessId(defaultHarnessId(harnesses, newSessionDefault));
  }, [harnessId, harnesses, newSessionDefault]);

  // The effective branch, path and base come from core, so the dialog never
  // guesses what `tasks.create` will do (slug collisions included).
  useEffect(() => {
    if (location !== 'worktree') {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void client
        .invoke('tasks.preview', {
          projectId: project.id,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
        })
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setPreviewError(null);
        })
        .catch((cause) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(errorMessage(cause));
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, project.id, location, title, baseRef]);

  const worktree = location === 'worktree';
  const blocked = worktree ? blockedReason(preview, previewError, title) : null;
  const startDisabled = busy || blocked !== null || !harnessId;

  const worktreeSubmission = (start: boolean): NewTaskSubmission => ({
    location: 'worktree',
    title: title.trim(),
    ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
    setupScript: setupScript.trim() ? setupScript.trim() : null,
    ...(harnessId ? { harnessId } : {}),
    start,
  });

  const submit = () => {
    if (busy) return;
    if (!worktree) {
      onCreate({ location: 'checkout', start: false });
      return;
    }
    if (startDisabled) return;
    // Enter and the highlighted button both mean "create and start".
    onCreate(worktreeSubmission(true));
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="modal-head">
          <div>
            <h2>New task</h2>
            <p>
              {worktree ? (
                <>
                  Isolated worktree and branch from <code>{project.name}</code>
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

        <dl className="task-facts">
          <div>
            <dt>Project</dt>
            <dd>{project.name}</dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{worktree ? 'new worktree' : 'main checkout'}</dd>
          </div>
          <div>
            <dt>Branch</dt>
            <dd data-testid="preview-branch">
              <code>{worktree ? (preview?.branch ?? '—') : 'current branch'}</code>
            </dd>
          </div>
          <div>
            <dt>Path</dt>
            <dd
              data-testid="preview-path"
              title={worktree ? (preview?.workspacePath ?? '') : project.path}
            >
              {worktree ? (preview?.workspacePath ?? '—') : project.path}
            </dd>
          </div>
          <div>
            <dt>Base</dt>
            <dd data-testid="preview-base">
              {worktree ? (
                <code>{baseRefLabel(preview)}</code>
              ) : (
                <code>current branch · main checkout is never branched</code>
              )}
            </dd>
          </div>
        </dl>

        {worktree ? (
          <>
            <label className="field">
              <span>Title</span>
              <input
                ref={inputRef}
                aria-label="Title"
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
                aria-label="Base branch"
                value={baseRef}
                onChange={(event) => setBaseRef(event.target.value)}
                placeholder={`project default: ${project.defaultBaseRef ?? 'current branch'}`}
                maxLength={250}
              />
            </label>

            <label className="field">
              <span>Agent</span>
              <select
                aria-label="Agent"
                value={harnessId ?? ''}
                onChange={(event) => setHarnessId(event.target.value)}
              >
                {harnesses.length === 0 ? <option value="">No profiles enabled</option> : null}
                {harnesses.map((harness) => (
                  <option key={harness.id} value={harness.id} disabled={!harness.available}>
                    {harness.label}
                    {harness.available ? '' : ' (not installed)'}
                  </option>
                ))}
              </select>
              <small className="field-hint">
                Used by <strong>Create &amp; start</strong>. Nest only passes the profile id; the
                command comes from the harness registry.
              </small>
            </label>

            <label className="field">
              <span>
                Setup script <em>optional</em>
              </span>
              <input
                aria-label="Setup script"
                value={setupScript}
                onChange={(event) => setSetupScript(event.target.value)}
                placeholder="pnpm install"
                maxLength={2000}
              />
              <small className="field-hint">
                Runs in the new worktree after it is created and is remembered for this project.
                <code>.env</code> and <code>.env.local</code> are copied only when “Copy .env
                files” is enabled in Settings.
              </small>
            </label>
          </>
        ) : (
          <p className="field-hint">
            The main checkout is shared: sessions here see your working tree as it is. Use a
            worktree when an agent may break something.
          </p>
        )}

        {blocked && !busy ? <p className="modal-note warn">{blocked}</p> : null}
        {error ? <p className="modal-note error">{error}</p> : null}

        <footer className="modal-foot">
          {busy && step ? <span className="modal-step">{STEP_LABELS[step]}</span> : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          {busy ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : retryStart ? (
            <Button type="button" variant="primary" onClick={onRetryStart}>
              Retry start
            </Button>
          ) : worktree ? (
            <>
              <Button
                type="button"
                disabled={busy || blocked !== null}
                onClick={() => onCreate(worktreeSubmission(false))}
              >
                Create task
              </Button>
              <Button type="button" variant="primary" disabled={startDisabled} onClick={submit}>
                Create &amp; start
              </Button>
            </>
          ) : (
            <Button type="button" variant="primary" onClick={submit}>
              Open checkout
            </Button>
          )}
        </footer>
      </form>
    </div>
  );
}
