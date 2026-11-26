import { existsSync } from 'node:fs';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { AppSettings, NestEvent, UpdateStatus } from '@nest/shared';
import { NestError } from '@nest/core';
import { parseUpdateFeedUrl, resolveUpdateFeedUrl } from './updateFeed';

/** Let the window paint before the first background check. */
const STARTUP_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NO_FEED_MESSAGE = 'No update feed configured. Add one in Settings to check for updates.';
const SWITCHED_OFF_MESSAGE = 'Update checks are turned off in Settings.';
const CHECKING_MESSAGE = 'Checking for updates…';

/**
 * The updater event payloads this service reads. `electron-updater` carries more
 * data; naming the subset keeps the port small and the fake in tests honest.
 */
export interface UpdaterEventHandlers {
  'checking-for-update': () => void;
  'update-available': (info: { version: string }) => void;
  'update-not-available': () => void;
  'download-progress': (progress: { percent: number }) => void;
  'update-downloaded': (info: { version: string; downloadedFile?: string }) => void;
  error: (error: Error | null, message?: string) => void;
}
export type UpdaterEvent = keyof UpdaterEventHandlers;
/** Callbacks are invoked by the updater, never by this service. */
export type UpdaterListener = (...args: never[]) => void;

/** The part of `UpdateCheckResult` the service acts on. */
export interface UpdateCheckOutcome {
  downloadPromise?: Promise<unknown> | null;
  cancellationToken?: { cancel(): void } | null;
}

/**
 * The seam over `electron-updater`: global singleton state is exactly what made
 * a feed change leak the previous run, so tests drive this port instead.
 */
export interface UpdaterPort {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<UpdateCheckOutcome | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: UpdaterEvent, listener: UpdaterListener): unknown;
  off(event: UpdaterEvent, listener: UpdaterListener): unknown;
}

export interface UpdateServiceDeps {
  updater?: UpdaterPort;
  getVersion?: () => string;
  isPackaged?: () => boolean;
  now?: () => Date;
  /** Whether the recorded installer is still on disk. */
  artifactExists?: (file: string) => boolean;
}

/** An installer produced by one feed URL; it is never valid for another. */
export interface DownloadedArtifact {
  feedUrl: string;
  version: string;
  file: string;
}

interface UpdateRun {
  /** The feed this run was started for. */
  feedUrl: string;
  /** Aborts the download once `electron-updater` has handed out a token. */
  cancelDownload: (() => void) | null;
  detachListeners: () => void;
  /** The feed changed under the run; its events and result must be dropped. */
  superseded: boolean;
  finished: boolean;
}

/**
 * electron-updater wrapper. A built-in GitHub Releases feed is used by default;
 * a URL saved in Settings or the NEST_UPDATE_URL environment variable overrides
 * it for local experiments and custom hosting. The updates switch in Settings
 * turns checks off completely: it supersedes a run in flight and drops the
 * installer, exactly like a feed change.
 *
 * Check/download state, its events and the downloaded installer are bound to
 * the feed URL that produced them. A feed change supersedes the run in flight,
 * drops its events, clears the old installer and republishes an idle status, so
 * the renderer never sees a stale URL next to a stale artifact.
 *
 * Updates only run in packaged builds. Development, e2e and the packaged smoke
 * test stay on the local build (`NEST_DISABLE_UPDATES=1`).
 */
export class UpdateService {
  private readonly updater: UpdaterPort;
  private readonly getVersion: () => string;
  private readonly isPackaged: () => boolean;
  private readonly now: () => Date;
  private readonly artifactExists: (file: string) => boolean;

  private status: UpdateStatus;
  /** The feed the current status, run and artifact belong to. */
  private feedUrl: string;
  /** The saved switch; false means no check ever starts. */
  private updatesEnabled: boolean;
  private artifact: DownloadedArtifact | null = null;
  /** The run that owns the updater, or a superseded run still unwinding. */
  private run: UpdateRun | null = null;
  /** A check was requested while another run still held the updater. */
  private queued = false;
  private emittedSignature: string | null = null;
  private started = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly emit: (event: NestEvent) => void,
    deps: UpdateServiceDeps = {},
  ) {
    this.updater = deps.updater ?? autoUpdater;
    this.getVersion = deps.getVersion ?? (() => app.getVersion());
    this.isPackaged = deps.isPackaged ?? (() => app.isPackaged);
    this.now = deps.now ?? (() => new Date());
    this.artifactExists = deps.artifactExists ?? ((file) => existsSync(file));

    this.status = {
      state: 'idle',
      currentVersion: this.getVersion(),
      enabled: this.isPackaged(),
      feedUrl: null,
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    };
    // Resolved after the parameter properties so a failed settings read is contained.
    this.feedUrl = this.resolveFeedUrl();
    this.updatesEnabled = this.resolveUpdatesEnabled();

    this.updater.autoDownload = true;
    // Installing stays on the guarded path: an implicit install on quit could
    // run an installer that was downloaded from a feed the user has replaced.
    this.updater.autoInstallOnAppQuit = false;
    this.updater.logger = null;
  }

  start(): void {
    if (this.started || this.disabledReason() || !this.updatesEnabled) return;
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
    this.syncConfig();
    return this.snapshot();
  }

  /**
   * Applies a saved settings change: a new feed URL or the switch supersedes
   * the run bound to the old configuration, drops its installer and starts or
   * stops the background timers.
   */
  applySettings(): UpdateStatus {
    this.syncConfig();
    if (this.updatesEnabled && !this.disabledReason()) this.start();
    else this.stop();
    return this.getStatus();
  }

  /**
   * Starts a background check and returns the current status immediately; the
   * result arrives as `updates:status` events so the RPC never blocks on the
   * network.
   */
  check(): UpdateStatus {
    this.syncConfig();
    const current = this.snapshot();
    if (!current.enabled) return current;
    if (!this.feedUrl) {
      this.setStatus({ state: 'disabled', message: NO_FEED_MESSAGE, checkedAt: this.timestamp() });
      return this.getStatus();
    }
    if (this.run && !this.run.finished) {
      if (!this.run.superseded && this.run.feedUrl === this.feedUrl) return current;
      // The previous feed's check or download still holds the updater; its
      // result is dropped and this check starts as soon as it unwinds.
      this.queued = true;
      this.setStatus({
        state: 'checking',
        availableVersion: null,
        percent: null,
        message: CHECKING_MESSAGE,
        checkedAt: null,
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
      parsed = parseUpdateFeedUrl(this.feedUrl);
    } catch (error) {
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Invalid update feed URL.',
        percent: null,
        checkedAt: this.timestamp(),
      });
      return this.getStatus();
    }

    this.startRun(parsed);
    return this.getStatus();
  }

  /**
   * Installs only an artifact recorded for the currently configured feed. The
   * renderer's snapshot may be older than the settings, so the feed is
   * re-resolved here before the decision.
   */
  async install(): Promise<void> {
    this.syncConfig();
    if (this.run && !this.run.finished) {
      throw new NestError(
        'update_not_ready',
        'An update check is still running; wait for it before installing',
      );
    }
    const artifact = this.artifact;
    if (!artifact || artifact.feedUrl !== this.feedUrl || this.snapshot().state !== 'downloaded') {
      throw new NestError('update_not_ready', 'No downloaded update is ready to install');
    }
    if (!this.artifactExists(artifact.file)) {
      throw new NestError(
        'update_not_ready',
        `The downloaded update ${artifact.version} is no longer on disk`,
      );
    }
    // Only this verified artifact is installed: the second flag restarts Nest
    // after the installer finishes.
    this.updater.quitAndInstall(false, true);
  }

  private startRun(parsed: URL): void {
    this.queued = false;
    const run: UpdateRun = {
      feedUrl: this.feedUrl,
      cancelDownload: null,
      detachListeners: () => {},
      superseded: false,
      finished: false,
    };
    this.run = run;
    this.attachListeners(run);
    this.setStatus({
      state: 'checking',
      availableVersion: null,
      percent: null,
      message: CHECKING_MESSAGE,
      checkedAt: null,
    });
    this.updater.setFeedURL({ provider: 'generic', url: parsed.toString() });
    void this.driveRun(run);
  }

  private async driveRun(run: UpdateRun): Promise<void> {
    try {
      const outcome = await this.updater.checkForUpdates();
      const token = outcome?.cancellationToken ?? null;
      if (token) run.cancelDownload = () => token.cancel();
      if (!this.isCurrent(run)) {
        // The feed changed while the request was in flight: stop the download
        // it may have started and drop the result.
        run.cancelDownload?.();
      }
      const download = outcome?.downloadPromise ?? null;
      if (download) await download;
    } catch (error) {
      // Failures of a superseded run are not this service's status to report;
      // the current run reports its own through the `error` event.
      if (this.isCurrent(run)) {
        this.setStatus({
          state: 'error',
          message: error instanceof Error && error.message ? error.message : 'Update check failed',
          percent: null,
          checkedAt: this.timestamp(),
        });
      }
    } finally {
      this.finishRun(run);
    }
  }

  private finishRun(run: UpdateRun): void {
    if (run.finished) return;
    run.finished = true;
    run.detachListeners();
    if (this.run === run) this.run = null;
    if (this.queued) {
      this.queued = false;
      this.startQueuedRun();
    }
  }

  private startQueuedRun(): void {
    const parsed = this.parseCurrentFeed();
    if (parsed) this.startRun(parsed);
  }

  private parseCurrentFeed(): URL | null {
    if (!this.feedUrl) return null;
    try {
      return parseUpdateFeedUrl(this.feedUrl);
    } catch (error) {
      this.setStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Invalid update feed URL.',
        percent: null,
        checkedAt: this.timestamp(),
      });
      return null;
    }
  }

  /**
   * A run is current only while the feed still resolves to the source it was
   * started for; everything else is stale and must not touch the status.
   */
  private isCurrent(run: UpdateRun): boolean {
    return !run.superseded && this.run === run && run.feedUrl === this.feedUrl;
  }

  /**
   * Re-resolves the feed and switch, and discards everything bound to the
   * previous configuration. Safe to call often: it only acts when the resolved
   * values actually changed.
   */
  private syncConfig(): void {
    const feedUrl = this.resolveFeedUrl();
    const updatesEnabled = this.resolveUpdatesEnabled();
    if (feedUrl === this.feedUrl && updatesEnabled === this.updatesEnabled) return;
    this.feedUrl = feedUrl;
    this.updatesEnabled = updatesEnabled;
    this.supersedeRun();
    this.artifact = null;
    this.queued = false;
    this.status = {
      ...this.status,
      state: 'idle',
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    };
    this.publish();
  }

  private supersedeRun(): void {
    const run = this.run;
    if (!run || run.finished || run.superseded) return;
    run.superseded = true;
    run.detachListeners();
    // `electron-updater` cannot abort the metadata request, but the download it
    // hands out can be cancelled. Until then the run stays as the updater owner
    // so no second check starts concurrently.
    run.cancelDownload?.();
  }

  private attachListeners(run: UpdateRun): void {
    const detachers: Array<() => void> = [];
    const listen = <E extends UpdaterEvent>(
      event: E,
      handler: UpdaterEventHandlers[E],
    ): void => {
      const listener: UpdaterListener = (...args) => {
        if (!this.isCurrent(run)) return;
        (handler as UpdaterListener)(...args);
      };
      this.updater.on(event, listener);
      detachers.push(() => this.updater.off(event, listener));
    };

    listen('checking-for-update', () => {
      this.setStatus({
        state: 'checking',
        availableVersion: null,
        percent: null,
        message: CHECKING_MESSAGE,
      });
    });
    listen('update-available', (info) => {
      this.setStatus({
        state: 'available',
        availableVersion: info.version,
        percent: null,
        message: `Version ${info.version} found, downloading…`,
        checkedAt: this.timestamp(),
      });
    });
    listen('update-not-available', () => {
      this.setStatus({
        state: 'not-available',
        availableVersion: null,
        percent: null,
        message: 'Nest is up to date.',
        checkedAt: this.timestamp(),
      });
    });
    listen('download-progress', (progress) => {
      const percent = Number.isFinite(progress.percent)
        ? Math.min(100, Math.max(0, Math.round(progress.percent)))
        : null;
      this.setStatus({
        state: 'downloading',
        percent,
        message: percent === null ? 'Downloading update…' : `Downloading update… ${percent}%`,
      });
    });
    listen('update-downloaded', (info) => {
      const file = typeof info.downloadedFile === 'string' ? info.downloadedFile : '';
      this.artifact = file ? { feedUrl: run.feedUrl, version: info.version, file } : null;
      this.setStatus({
        state: 'downloaded',
        availableVersion: info.version,
        percent: 100,
        message: `Version ${info.version} is ready. Restart Nest to install it.`,
        checkedAt: this.timestamp(),
      });
    });
    listen('error', (error) => {
      this.setStatus({
        state: 'error',
        message: error instanceof Error && error.message ? error.message : 'Update check failed',
        percent: null,
        checkedAt: this.timestamp(),
      });
    });

    run.detachListeners = () => {
      for (const detach of detachers) detach();
      detachers.length = 0;
    };
  }

  private resolveFeedUrl(): string {
    let fromSettings = '';
    try {
      fromSettings = this.getSettings().updateFeedUrl;
    } catch {
      // A failed settings read must not disable the built-in feed.
    }
    return resolveUpdateFeedUrl(process.env.NEST_UPDATE_URL, fromSettings);
  }

  private resolveUpdatesEnabled(): boolean {
    try {
      return this.getSettings().updatesEnabled;
    } catch {
      // A failed settings read keeps the default: checks on.
      return true;
    }
  }

  private disabledReason(): string | null {
    if (process.env.NEST_DISABLE_UPDATES === '1') {
      return 'Update checks are disabled for this run.';
    }
    if (!this.isPackaged()) return 'Updates are available in packaged builds only.';
    return null;
  }

  private snapshot(): UpdateStatus {
    const reason = this.disabledReason();
    const base: UpdateStatus = {
      ...this.status,
      currentVersion: this.getVersion(),
      enabled: reason === null && this.updatesEnabled,
      feedUrl: this.feedUrl || null,
    };

    if (reason) return { ...base, state: 'disabled', message: reason, percent: null };
    // The switch turns checks off completely, whatever feed is configured.
    if (!this.updatesEnabled) {
      return { ...base, state: 'disabled', message: SWITCHED_OFF_MESSAGE, percent: null };
    }
    if (!this.feedUrl) {
      return { ...base, state: 'disabled', message: NO_FEED_MESSAGE, percent: null };
    }
    // A previously disabled state must not stick after a feed is configured.
    if (base.state === 'disabled') return { ...base, state: 'idle', message: null };
    return base;
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.publish();
  }

  /** Emits only when the renderer-visible status actually changed. */
  private publish(): void {
    const status = this.snapshot();
    const signature = JSON.stringify(status);
    if (signature === this.emittedSignature) return;
    this.emittedSignature = signature;
    try {
      this.emit({ type: 'updates:status', status });
    } catch {
      // The renderer may be gone during shutdown.
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
