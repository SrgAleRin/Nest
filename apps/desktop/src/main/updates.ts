import { app } from 'electron';
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { AppSettings, NestEvent, UpdateStatus } from '@nest/shared';
import { NestError } from '@nest/core';
import { parseUpdateFeedUrl } from './updateFeed';

/** Let the window paint before the first background check. */
const STARTUP_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * electron-updater wrapper. The generic feed URL lives in settings so a build
 * can be pointed at any static directory serving `latest.yml`; the environment
 * variable `NEST_UPDATE_URL` overrides it for release experiments.
 *
 * Updates only run in packaged builds. Development, e2e and the packaged smoke
 * test stay on the local build (`NEST_DISABLE_UPDATES=1`).
 */
export class UpdateService {
  private status: UpdateStatus;
  private started = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly emit: (event: NestEvent) => void,
  ) {
    this.status = {
      state: 'idle',
      currentVersion: app.getVersion(),
      enabled: app.isPackaged,
      feedUrl: null,
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    };

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    this.bindEvents();
  }

  start(): void {
    if (this.started || this.disabledReason()) return;
    this.started = true;
    this.startupTimer = setTimeout(() => this.check(), STARTUP_DELAY_MS);
    this.intervalTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
    this.started = false;
  }

  getStatus(): UpdateStatus {
    const feedUrl = this.resolveFeedUrl();
    const reason = this.disabledReason();
    const base: UpdateStatus = {
      ...this.status,
      currentVersion: app.getVersion(),
      enabled: reason === null,
      feedUrl: feedUrl || null,
    };

    if (reason) return { ...base, state: 'disabled', message: reason, percent: null };
    if (!feedUrl) {
      return {
        ...base,
        state: 'disabled',
        message: 'No update feed configured. Add one in Settings to check for updates.',
        percent: null,
      };
    }
    // A previously disabled state must not stick after a feed is configured.
    if (base.state === 'disabled') return { ...base, state: 'idle', message: null };
    return base;
  }

  /**
   * Starts a background check and returns the current status immediately; the
   * result arrives as `updates:status` events so the RPC never blocks on the
   * network.
   */
  check(): UpdateStatus {
    const current = this.getStatus();
    if (!current.enabled) return current;
    if (!current.feedUrl) {
      this.setStatus({
        state: 'disabled',
        message: 'No update feed configured. Add one in Settings to check for updates.',
        checkedAt: new Date().toISOString(),
      });
      return this.getStatus();
    }
    if (
      current.state === 'checking' ||
      current.state === 'available' ||
      current.state === 'downloading' ||
      current.state === 'downloaded'
    ) {
      return current;
    }

    let parsed: URL;
    try {
      parsed = parseUpdateFeedUrl(current.feedUrl);
    } catch (error) {
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Invalid update feed URL.',
        percent: null,
        checkedAt: new Date().toISOString(),
      });
      return this.getStatus();
    }

    this.setStatus({
      state: 'checking',
      availableVersion: null,
      percent: null,
      message: 'Checking for updates…',
      checkedAt: null,
    });
    autoUpdater.setFeedURL({ provider: 'generic', url: parsed.toString() });
    void this.runCheck();
    return this.getStatus();
  }

  async install(): Promise<void> {
    if (this.status.state !== 'downloaded') {
      throw new NestError('update_not_ready', 'No downloaded update is ready to install');
    }
    // The second flag restarts Nest after the installer finishes.
    autoUpdater.quitAndInstall(false, true);
  }

  private async runCheck(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Update check failed',
        percent: null,
        checkedAt: new Date().toISOString(),
      });
    }
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      this.setStatus({ state: 'checking', message: 'Checking for updates…', percent: null });
    });
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.setStatus({
        state: 'available',
        availableVersion: info.version,
        percent: null,
        message: `Version ${info.version} found, downloading…`,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on('update-not-available', () => {
      this.setStatus({
        state: 'not-available',
        availableVersion: null,
        percent: null,
        message: 'Nest is up to date.',
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      const percent = Number.isFinite(progress.percent)
        ? Math.min(100, Math.max(0, Math.round(progress.percent)))
        : null;
      this.setStatus({
        state: 'downloading',
        percent,
        message: percent === null ? 'Downloading update…' : `Downloading update… ${percent}%`,
      });
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.setStatus({
        state: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: `Version ${info.version} is ready. Restart Nest to install it.`,
        checkedAt: new Date().toISOString(),
      });
    });
    autoUpdater.on('error', (error: Error | null) => {
      this.setStatus({
        state: 'error',
        message: error instanceof Error && error.message ? error.message : 'Update check failed',
        percent: null,
        checkedAt: new Date().toISOString(),
      });
    });
  }

  private resolveFeedUrl(): string {
    const fromEnv = process.env.NEST_UPDATE_URL?.trim();
    if (fromEnv) return fromEnv;
    try {
      return this.getSettings().updateFeedUrl.trim();
    } catch {
      return '';
    }
  }

  private disabledReason(): string | null {
    if (process.env.NEST_DISABLE_UPDATES === '1') {
      return 'Update checks are disabled for this run.';
    }
    if (!app.isPackaged) return 'Updates are available in packaged builds only.';
    return null;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    try {
      this.emit({ type: 'updates:status', status: this.getStatus() });
    } catch {
      // The renderer may be gone during shutdown.
    }
  }
}
