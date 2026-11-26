import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_UPDATE_FEED_URL,
  type AppInfo,
  type AppSettings,
  type HarnessId,
  type HarnessProfile,
  type NestClient,
  type NewSessionDefault,
  type TerminalPreferences,
  type UpdateStatus,
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
  const [harnessArgs, setHarnessArgs] = useState<Partial<Record<HarnessId, string>>>({});
  const [shellCommand, setShellCommand] = useState('');
  const [terminal, setTerminal] = useState<TerminalPreferences>({
    ...DEFAULT_TERMINAL_PREFERENCES,
  });
  const [updateFeedUrl, setUpdateFeedUrl] = useState('');
  const [updatesEnabled, setUpdatesEnabled] = useState(true);
  const [worktreeRoot, setWorktreeRoot] = useState('');
  const [copyEnvFiles, setCopyEnvFiles] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [newSessionDefault, setNewSessionDefault] = useState<NewSessionDefault>('ask');
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
      const [settings, list, status, appInfo] = await Promise.all([
        client.invoke('settings.get', {}),
        client.invoke('harness.list', { includeDisabled: true }),
        // Updates are optional: an older preload or a failed call must not
        // block harness settings.
        client.invoke('updates.status', {}).catch(() => null),
        // The resolved default root is what an empty field means.
        client.invoke('app.info', {}).catch(() => null),
      ]);
      if (!aliveRef.current) return;
      // The custom profile is configured through the text field below, not
      // through a checkbox, so it is not part of the toggle list.
      setProfiles(list.filter((profile) => profile.source === 'builtin'));
      setDisabled(new Set(settings.disabledHarnesses));
      setCustomCommand(settings.customCommand);
      setHarnessArgs(settings.harnessArgs);
      setShellCommand(settings.shellCommand);
      setTerminal(settings.terminal);
      setWorktreeRoot(settings.worktreeRoot);
      setCopyEnvFiles(settings.copyEnvFiles);
      setUpdateFeedUrl(settings.updateFeedUrl);
      setUpdatesEnabled(settings.updatesEnabled);
      setNewSessionDefault(settings.newSessionDefault);
      if (status) setUpdateStatus(status);
      if (appInfo) setInfo(appInfo);
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

  const setArgs = (id: HarnessId, value: string): void => {
    setHarnessArgs((prev) => ({ ...prev, [id]: value }));
  };

  const setTerminalValue = <K extends keyof TerminalPreferences>(
    key: K,
    value: TerminalPreferences[K],
  ): void => {
    setTerminal((prev) => ({ ...prev, [key]: value }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const args: AppSettings['harnessArgs'] = {};
      for (const [id, value] of Object.entries(harnessArgs)) {
        if (typeof value === 'string' && value.trim()) {
          args[id as HarnessId] = value.trim();
        }
      }

      const settings = await client.invoke('settings.update', {
        disabledHarnesses: [...disabled] as HarnessId[],
        customCommand: customCommand.trim(),
        harnessArgs: args,
        shellCommand: shellCommand.trim(),
        terminal,
        worktreeRoot: worktreeRoot.trim(),
        copyEnvFiles,
        updateFeedUrl: updateFeedUrl.trim(),
        updatesEnabled,
        newSessionDefault,
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
  const canCheck =
    Boolean(updatesEnabled && updateStatus?.enabled && updateStatus.feedUrl) && !busy && !updateBusy;

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
              Terminal appearance, workspace paths, harness launch arguments and updates. Disabling
              a profile only hides it from the start pickers — sessions that already exist keep
              resuming.
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
              <span className="section-label">Terminal</span>
              <label className="field">
                <span>Font family</span>
                <input
                  value={terminal.fontFamily}
                  onChange={(event) => setTerminalValue('fontFamily', event.target.value)}
                  placeholder={DEFAULT_TERMINAL_PREFERENCES.fontFamily}
                  maxLength={300}
                  spellCheck={false}
                />
                <small className="field-hint">
                  A CSS font stack. Install the font on this machine; missing families fall back to
                  the next one in the list.
                </small>
              </label>
              <div className="settings-grid">
                <NumberField
                  label="Font size"
                  value={terminal.fontSize}
                  min={8}
                  max={32}
                  onChange={(value) => setTerminalValue('fontSize', value)}
                />
                <NumberField
                  label="Line height"
                  value={terminal.lineHeight}
                  min={0.8}
                  max={2}
                  step={0.05}
                  onChange={(value) => setTerminalValue('lineHeight', value)}
                />
                <NumberField
                  label="Scrollback"
                  value={terminal.scrollback}
                  min={1000}
                  max={200000}
                  step={1000}
                  onChange={(value) => setTerminalValue('scrollback', value)}
                />
              </div>
              <div className="settings-grid">
                <label className="field">
                  <span>Colours</span>
                  <select
                    className="settings-select"
                    value={terminal.theme}
                    onChange={(event) =>
                      setTerminalValue(
                        'theme',
                        event.target.value as TerminalPreferences['theme'],
                      )
                    }
                  >
                    <option value="nest">Nest dark</option>
                    <option value="solarized">Solarized dark</option>
                    <option value="paper">Paper light</option>
                  </select>
                </label>
                <label className="field">
                  <span>Cursor</span>
                  <select
                    className="settings-select"
                    value={terminal.cursorStyle}
                    onChange={(event) =>
                      setTerminalValue(
                        'cursorStyle',
                        event.target.value as TerminalPreferences['cursorStyle'],
                      )
                    }
                  >
                    <option value="block">Block</option>
                    <option value="underline">Underline</option>
                    <option value="bar">Bar</option>
                  </select>
                </label>
              </div>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={terminal.cursorBlink}
                  onChange={(event) => setTerminalValue('cursorBlink', event.target.checked)}
                />
                Blinking cursor
              </label>
              <label className="field">
                <span>
                  Shell command <em>optional</em>
                </span>
                <input
                  value={shellCommand}
                  onChange={(event) => setShellCommand(event.target.value)}
                  placeholder="Auto: pwsh, powershell or the login shell"
                  maxLength={2000}
                  spellCheck={false}
                />
                <small className="field-hint">
                  Used by the Terminal profile. Leave empty to auto-detect. Extra terminal
                  arguments belong in the Terminal row below.
                </small>
              </label>
            </div>

            <div className="settings-section">
              <span className="section-label">Workspace</span>
              <label className="field">
                <span>
                  Worktree root <em>optional</em>
                </span>
                <input
                  value={worktreeRoot}
                  onChange={(event) => setWorktreeRoot(event.target.value)}
                  placeholder={info?.defaultWorktreesRoot ?? 'Default worktree folder'}
                  maxLength={2000}
                  spellCheck={false}
                />
                <small className="field-hint">
                  New worktrees are created here. Empty uses <code>{info?.defaultWorktreesRoot ?? 'the default worktree folder'}</code>.
                  Existing worktrees keep their paths; nothing is moved. An unusable folder is
                  reported when a task is created.
                </small>
              </label>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={copyEnvFiles}
                  onChange={(event) => setCopyEnvFiles(event.target.checked)}
                />
                Copy <code>.env</code> files into new worktrees
              </label>
              <small className="field-hint">
                Off by default: copied keys can end up in a workspace that does not ignore them.
                Copies are always refused when either file resolves outside the project or the
                worktree.
              </small>
            </div>

            <div className="settings-section">
              <span className="section-label">Harnesses</span>
              <div className="settings-list harness-list">
                {profiles.map((profile) => {
                  const enabled = !disabled.has(profile.id);
                  return (
                    <div className="settings-harness" key={profile.id}>
                      <label className="settings-row">
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
                      <input
                        className="harness-args"
                        value={harnessArgs[profile.id] ?? ''}
                        onChange={(event) => setArgs(profile.id, event.target.value)}
                        placeholder="Extra launch arguments, e.g. --model opus"
                        maxLength={2000}
                        spellCheck={false}
                        aria-label={`${profile.label} launch arguments`}
                      />
                    </div>
                  );
                })}
              </div>
              <small className="field-hint">
                Arguments are added after the profile command and before resume flags. Quotes keep
                words together.
              </small>
            </div>

            <div className="settings-section">
              <span className="section-label">New tab</span>
              <label className="field">
                <span>Plus button starts</span>
                <select
                  className="settings-select"
                  value={newSessionDefault}
                  onChange={(event) =>
                    setNewSessionDefault(event.target.value as NewSessionDefault)
                  }
                >
                  <option value="ask">Ask every time</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                      {disabled.has(profile.id)
                        ? ' (disabled)'
                        : profile.available
                          ? ''
                          : ' (not found)'}
                    </option>
                  ))}
                </select>
                <small className="field-hint">
                  The plus button starts this profile directly. The arrow next to it always opens
                  the full picker. A disabled or missing default opens the picker instead.
                </small>
              </label>
            </div>

            <div className="settings-section">
              <span className="section-label">Custom command</span>
              <label className="field">
                <span>
                  Command <em>optional</em>
                </span>
                <input
                  value={customCommand}
                  onChange={(event) => setCustomCommand(event.target.value)}
                  placeholder="my-agent or C:\Tools\my-agent.cmd"
                  maxLength={2000}
                  spellCheck={false}
                />
                <small className="field-hint">
                  An executable on PATH or a full path. It starts in the task workspace and has no
                  resume support. Clear the field to hide it.
                </small>
              </label>
              <label className="field">
                <span>Launch arguments</span>
                <input
                  value={harnessArgs.custom ?? ''}
                  onChange={(event) => setArgs('custom', event.target.value)}
                  placeholder="Extra launch arguments"
                  maxLength={2000}
                  spellCheck={false}
                />
              </label>
            </div>

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
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={updatesEnabled}
                  onChange={(event) => setUpdatesEnabled(event.target.checked)}
                />
                Check for updates automatically
              </label>
              <label className="field">
                <span>
                  Update feed <em>optional</em>
                </span>
                <input
                  value={updateFeedUrl}
                  onChange={(event) => setUpdateFeedUrl(event.target.value)}
                  placeholder={DEFAULT_UPDATE_FEED_URL}
                  maxLength={2000}
                  spellCheck={false}
                />
                <small className="field-hint">
                  A static directory serving electron-updater&apos;s <code>latest.yml</code>.
                  Packaged builds use the built-in GitHub Releases feed when this is empty and check
                  on launch and every six hours. Turning the switch off stops every check and drops
                  a downloaded installer; <code>NEST_UPDATE_URL</code> overrides the address.
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

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (): void => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    onChange(clamped);
    setText(String(clamped));
  };

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
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
