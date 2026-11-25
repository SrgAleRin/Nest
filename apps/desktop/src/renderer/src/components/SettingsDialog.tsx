import { useEffect, useState } from 'react';
import type { AppSettings, HarnessId, HarnessProfile, NestClient } from '@nest/shared';
import { Button, Spinner } from '@nest/ui';
import { CloseIcon } from './Icons';
import { errorMessage } from '../utils';

interface SettingsDialogProps {
  client: NestClient;
  onClose: () => void;
  onSaved: (settings: AppSettings) => void;
}

export function SettingsDialog({ client, onClose, onSaved }: SettingsDialogProps) {
  const [profiles, setProfiles] = useState<HarnessProfile[] | null>(null);
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [customCommand, setCustomCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, list] = await Promise.all([
          client.invoke('settings.get', {}),
          client.invoke('harness.list', { includeDisabled: true }),
        ]);
        if (cancelled) return;
        // The custom profile is configured through the text field below, not
        // through a checkbox, so it is not part of the toggle list.
        setProfiles(list.filter((profile) => profile.source === 'builtin'));
        setDisabled(new Set(settings.disabledHarnesses));
        setCustomCommand(settings.customCommand);
      } catch (loadError) {
        if (!cancelled) setError(errorMessage(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggle = (id: HarnessId, enabled: boolean): void => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const settings = await client.invoke('settings.update', {
        disabledHarnesses: [...disabled] as HarnessId[],
        customCommand: customCommand.trim(),
      });
      onSaved(settings);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2>Settings</h2>
            <p>
              Harnesses Nest may start. Disabling one only hides it from the start pickers —
              sessions that already exist keep resuming.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </header>

        {error ? <div className="settings-error">{error}</div> : null}

        {profiles === null ? (
          <div className="settings-loading">
            {error ? null : <Spinner />} {error ? 'Could not load settings.' : 'Loading settings…'}
          </div>
        ) : (
          <>
            <div className="settings-section">
              <span className="section-label">Harnesses</span>
              <div className="settings-list">
                {profiles.map((profile) => {
                  const enabled = !disabled.has(profile.id);
                  return (
                    <label className="settings-row" key={profile.id}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(event) => toggle(profile.id, event.target.checked)}
                      />
                      <span className="settings-row-main">
                        <span className="settings-row-title">
                          {profile.label}
                          <code>{profile.command}</code>
                        </span>
                        <span className="settings-row-sub">{profile.description}</span>
                      </span>
                      <span className={`settings-avail ${profile.available ? 'ok' : ''}`}>
                        {profile.available ? 'found' : 'not found'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <label className="field">
              <span>
                Custom command <em>optional</em>
              </span>
              <input
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
                placeholder="my-agent or C:\Tools\my-agent.cmd"
                maxLength={2000}
                spellCheck={false}
              />
              <small className="field-hint">
                An executable on PATH or a full path. It starts in the task workspace without
                arguments and has no resume support. Clear the field to hide it.
              </small>
            </label>
          </>
        )}

        <footer className="modal-foot">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || profiles === null}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
