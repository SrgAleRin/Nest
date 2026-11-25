import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  HarnessId,
  HarnessProfile,
  NestClient,
  UpdateStatus,
} from '@nest/shared';
import { Button } from '@nest/ui';
import { CloseIcon } from './Icons';
import { SettingsListSkeleton } from './PanelSkeletons';
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
  const [updateFeedUrl, setUpdateFeedUrl] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [settings, list, status] = await Promise.all([
        client.invoke('settings.get', {}),
        client.invoke('harness.list', { includeDisabled: true }),
        // Updates are optional: an older preload or a failed call must not
        // block harness settings.
        client.invoke('updates.status', {}).catch(() => null),
      ]);
      if (!aliveRef.current) return;
      // The custom profile is configured through the text field below, not
      // through a checkbox, so it is not part of the toggle list.
      setProfiles(list.filter((profile) => profile.source === 'builtin'));
      setDisabled(new Set(settings.disabledHarnesses));
      setCustomCommand(settings.customCommand);
      setUpdateFeedUrl(settings.updateFeedUrl);
      if (status) setUpdateStatus(status);
    } catch (loadError) {
      if (aliveRef.current) setError(errorMessage(loadError));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return client.on((event) => {
      if (event.type === 'updates:status') setUpdateStatus(event.status);
    });
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
        updateFeedUrl: updateFeedUrl.trim(),
      });
      onSaved(settings);
    } catch (saveError) {
      setError(errorMessage(saveError));
      setBusy(false);
    }
  };

  const checkUpdates = async (): Promise<void> => {
    try {
      setUpdateStatus(await client.invoke('updates.check', {}));
    } catch (checkError) {
      setError(errorMessage(checkError));
    }
  };

  const installUpdate = async (): Promise<void> => {
    try {
      await client.invoke('updates.install', {});
    } catch (installError) {
      setError(errorMessage(installError));
    }
  };

  const updateBusy =
    updateStatus?.state === 'checking' ||
    updateStatus?.state === 'available' ||
    updateStatus?.state === 'downloading' ||
    updateStatus?.state === 'downloaded';
  const canCheck = Boolean(updateStatus?.enabled && updateStatus.feedUrl) && !busy && !updateBusy;

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

        {error ? (
          <div className="settings-error">
            <span>{error}</span>
            {profiles === null ? (
              <button type="button" className="link-btn" onClick={() => void load()}>
                Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {profiles === null ? (
          error ? (
            <div className="settings-loading">Could not load settings.</div>
          ) : (
            <SettingsListSkeleton />
          )
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

            <div className="settings-section">
              <span className="section-label">Updates</span>
              <div className="update-card">
                <div className="update-head">
                  <div className="update-main">
                    <span className={`update-state state-${updateStatus?.state ?? 'idle'}`}>
                      {updateTitle(updateStatus)}
                    </span>
                    <span className="update-meta">
                      version {updateStatus?.currentVersion ?? '—'}
                      {updateStatus?.availableVersion ? ` → ${updateStatus.availableVersion}` : ''}
                      {' · '}
                      {updateStatus?.feedUrl ? 'feed configured' : 'no feed'}
                    </span>
                  </div>
                  <div className="update-actions">
                    {updateStatus?.state === 'downloaded' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => void installUpdate()}
                      >
                        Install and restart
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canCheck}
                      onClick={() => void checkUpdates()}
                    >
                      {updateStatus?.state === 'checking' ? 'Checking…' : 'Check now'}
                    </Button>
                  </div>
                </div>
                {updateStatus?.message ? (
                  <p className="update-message">{updateStatus.message}</p>
                ) : null}
                {typeof updateStatus?.percent === 'number' ? (
                  <div className="update-progress">
                    <span style={{ width: `${updateStatus.percent}%` }} />
                  </div>
                ) : null}
              </div>
              <label className="field">
                <span>
                  Update feed <em>optional</em>
                </span>
                <input
                  value={updateFeedUrl}
                  onChange={(event) => setUpdateFeedUrl(event.target.value)}
                  placeholder="https://updates.example.com/nest/"
                  maxLength={2000}
                  spellCheck={false}
                />
                <small className="field-hint">
                  A static directory serving electron-updater&apos;s <code>latest.yml</code>.
                  Packaged builds check on launch and every six hours; <code>NEST_UPDATE_URL</code>{' '}
                  overrides this value. Leave empty to disable updates.
                </small>
              </label>
            </div>
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

function updateTitle(status: UpdateStatus | null): string {
  if (!status) return 'Updates unavailable';
  switch (status.state) {
    case 'idle':
      return 'Ready to check';
    case 'disabled':
      return 'Updates disabled';
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Version ${status.availableVersion ?? 'new'} found`;
    case 'not-available':
      return 'Up to date';
    case 'downloading':
      return status.percent === null ? 'Downloading…' : `Downloading ${status.percent}%`;
    case 'downloaded':
      return `Version ${status.availableVersion ?? 'new'} ready`;
    case 'error':
      return 'Update check failed';
    default:
      return 'Updates unavailable';
  }
}
