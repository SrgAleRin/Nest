import { useEffect, useId, useRef, useState } from 'react';
import type { Project } from '@nest/shared';

export interface ProjectSettingsPatch {
  name: string;
  defaultBaseRef: string | null;
  setupScript: string | null;
}

interface ProjectSettingsDialogProps {
  project: Project;
  /** The save is running: the buttons say so and cannot repeat. */
  busy?: boolean;
  /** Why the last save failed, shown inside the dialog. */
  error?: string | null;
  onSave: (patch: ProjectSettingsPatch) => void;
  onCancel: () => void;
}

/**
 * Edits the project row itself. Before this dialog the only way to change a
 * project's name or setup script was to create a task and open its inspector,
 * which invented a workspace just to edit a setting.
 */
export function ProjectSettingsDialog({
  project,
  busy = false,
  error = null,
  onSave,
  onCancel,
}: ProjectSettingsDialogProps) {
  const titleId = useId();
  const nameId = useId();
  const baseRefId = useId();
  const setupId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(project.name);
  const [defaultBaseRef, setDefaultBaseRef] = useState(project.defaultBaseRef ?? '');
  const [setupScript, setSetupScript] = useState(project.setupScript ?? '');

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
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

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !busy;

  function submit(): void {
    if (!canSave) return;
    onSave({
      name: trimmedName,
      defaultBaseRef: defaultBaseRef.trim() || null,
      setupScript: setupScript.trim() ? setupScript : null,
    });
  }

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!busy) onCancel();
      }}
    >
      <form
        className="modal project-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <header className="modal-head">
          <div>
            <h2 id={titleId}>Project settings</h2>
            <p>
              Name and defaults of <code>{project.path}</code>. Existing tasks keep the base ref
              they were created from.
            </p>
          </div>
        </header>

        <label className="field" htmlFor={nameId}>
          <span>Display name</span>
          <input
            id={nameId}
            ref={nameRef}
            value={name}
            required
            disabled={busy}
            placeholder="Project name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="field" htmlFor={baseRefId}>
          <span>Default base ref</span>
          <input
            id={baseRefId}
            value={defaultBaseRef}
            disabled={busy}
            placeholder="origin/main"
            onChange={(event) => setDefaultBaseRef(event.target.value)}
          />
          <em>New worktrees branch from this ref. Leave empty to use the resolved default.</em>
        </label>

        <label className="field" htmlFor={setupId}>
          <span>Setup script</span>
          <textarea
            id={setupId}
            value={setupScript}
            rows={4}
            disabled={busy}
            placeholder="pnpm install"
            onChange={(event) => setSetupScript(event.target.value)}
          />
          <em>Runs once in each new worktree. Leave empty for no setup step.</em>
        </label>

        {error ? (
          <p className="modal-note error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!canSave}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
