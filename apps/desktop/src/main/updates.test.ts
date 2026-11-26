import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppSettingsSchema, type NestEvent, type UpdateStatus } from '@nest/shared';
import { NestError } from '@nest/core';
import {
  UpdateService,
  type UpdateCheckOutcome,
  type UpdaterEvent,
  type UpdaterListener,
  type UpdaterPort,
} from './updates';

// The service must be importable outside Electron; the real autoUpdater is
// never used because every test injects its own port.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.3', isPackaged: true },
}));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

const FEED_A = 'https://feed-a.example/nest/';
const FEED_B = 'https://feed-b.example/nest/';
const FILE_A = 'C:/updates/Nest-Setup-0.2.0.exe';
const FILE_B = 'C:/updates-b/Nest-Setup-0.3.0.exe';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** Lets the service's promise chain settle between assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface PendingCheck {
  feedUrl: string;
  deferred: Deferred<UpdateCheckOutcome | null>;
}

class FakeUpdater implements UpdaterPort {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  logger: unknown = null;

  readonly feedUrls: string[] = [];
  readonly installs: Array<[boolean | undefined, boolean | undefined]> = [];
  readonly checks: PendingCheck[] = [];

  private readonly emitter = new EventEmitter();

  setFeedURL(options: { provider: 'generic'; url: string }): void {
    this.feedUrls.push(options.url);
  }

  checkForUpdates(): Promise<UpdateCheckOutcome | null> {
    const deferred = createDeferred<UpdateCheckOutcome | null>();
    this.checks.push({ feedUrl: this.feedUrls.at(-1) ?? '', deferred });
    return deferred.promise;
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }

  on(event: UpdaterEvent, listener: UpdaterListener): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off(event: UpdaterEvent, listener: UpdaterListener): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit(event: UpdaterEvent, ...args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  listenerCount(event: UpdaterEvent): number {
    return this.emitter.listenerCount(event);
  }

  lastCheck(): PendingCheck {
    const check = this.checks.at(-1);
    if (!check) throw new Error('the service started no check');
    return check;
  }
}

function createToken(): { cancelled: boolean; token: { cancel: () => void } } {
  const state = { cancelled: false };
  return {
    get cancelled() {
      return state.cancelled;
    },
    token: {
      cancel: () => {
        state.cancelled = true;
      },
    },
  };
}

function createHarness(initialFeed: string) {
  const envBefore = { url: process.env.NEST_UPDATE_URL, disabled: process.env.NEST_DISABLE_UPDATES };
  delete process.env.NEST_UPDATE_URL;
  delete process.env.NEST_DISABLE_UPDATES;

  const settings = AppSettingsSchema.parse({
    disabledHarnesses: [],
    customCommand: '',
    updateFeedUrl: initialFeed,
  });
  const events: NestEvent[] = [];
  const updater = new FakeUpdater();
  /** Files that exist on disk; install() verifies the recorded artifact. */
  const files = new Set<string>();
  const service = new UpdateService(() => settings, (event) => events.push(event), {
    updater,
    getVersion: () => '0.1.3',
    isPackaged: () => true,
    artifactExists: (file) => files.has(file),
    now: () => new Date('2026-11-26T10:00:00.000Z'),
  });

  return {
    settings,
    events,
    updater,
    files,
    service,
    restoreEnv: () => {
      if (envBefore.url === undefined) delete process.env.NEST_UPDATE_URL;
      else process.env.NEST_UPDATE_URL = envBefore.url;
      if (envBefore.disabled === undefined) delete process.env.NEST_DISABLE_UPDATES;
      else process.env.NEST_DISABLE_UPDATES = envBefore.disabled;
    },
    setFeed: (url: string) => {
      settings.updateFeedUrl = url;
    },
    statuses: (): UpdateStatus[] =>
      events.filter((event) => event.type === 'updates:status').map((event) => event.status),
  };
}

describe('UpdateService', () => {
  it('binds status and the downloaded artifact to the feed that produced them', async () => {
    const h = createHarness(FEED_A);
    try {
      expect(h.updater.autoDownload).toBe(true);
      // Only the guarded install path may run an installer.
      expect(h.updater.autoInstallOnAppQuit).toBe(false);

      const status = h.service.check();
      expect(status).toMatchObject({ state: 'checking', feedUrl: FEED_A, availableVersion: null });
      expect(h.updater.feedUrls).toEqual([FEED_A]);

      h.updater.emit('update-available', { version: '0.2.0' });
      expect(h.service.getStatus()).toMatchObject({
        state: 'available',
        feedUrl: FEED_A,
        availableVersion: '0.2.0',
        checkedAt: '2026-11-26T10:00:00.000Z',
      });

      h.updater.emit('download-progress', { percent: 42.4 });
      expect(h.service.getStatus()).toMatchObject({ state: 'downloading', percent: 42 });

      h.files.add(FILE_A);
      h.updater.emit('update-downloaded', { version: '0.2.0', downloadedFile: FILE_A });
      expect(h.service.getStatus()).toMatchObject({
        state: 'downloaded',
        feedUrl: FEED_A,
        availableVersion: '0.2.0',
        percent: 100,
      });

      h.updater.lastCheck().deferred.resolve({ downloadPromise: null, cancellationToken: null });
      await flush();

      await h.service.install();
      expect(h.updater.installs).toEqual([[false, true]]);
    } finally {
      h.restoreEnv();
    }
  });

  it('supersedes a check when the feed changes and drops the stale events', async () => {
    const h = createHarness(FEED_A);
    try {
      h.service.check();
      expect(h.updater.checks).toHaveLength(1);
      expect(h.updater.listenerCount('update-available')).toBe(1);

      // The user saves feed B while feed A's metadata request is still in flight.
      h.setFeed(FEED_B);
      const status = h.service.check();
      expect(status).toMatchObject({
        state: 'checking',
        feedUrl: FEED_B,
        availableVersion: null,
        percent: null,
      });
      // One run owns the updater: B must not race A's request.
      expect(h.updater.checks).toHaveLength(1);
      expect(h.updater.feedUrls).toEqual([FEED_A]);
      // A's listeners are gone, so its events cannot reach the status.
      expect(h.updater.listenerCount('update-available')).toBe(0);
      expect(h.updater.listenerCount('download-progress')).toBe(0);

      h.updater.emit('update-available', { version: '0.2.0' });
      h.updater.emit('download-progress', { percent: 90 });
      h.updater.emit('update-downloaded', { version: '0.2.0', downloadedFile: FILE_A });
      expect(h.service.getStatus()).toMatchObject({
        state: 'checking',
        feedUrl: FEED_B,
        availableVersion: null,
        percent: null,
      });

      // A resolves late: its download is cancelled and B waits for it to unwind.
      const token = createToken();
      const staleDownload = createDeferred<unknown>();
      h.updater.lastCheck().deferred.resolve({
        cancellationToken: token.token,
        downloadPromise: staleDownload.promise,
      });
      await flush();
      expect(token.cancelled).toBe(true);
      expect(h.updater.checks).toHaveLength(1);

      staleDownload.reject(new Error('Download cancelled'));
      await flush();
      expect(h.updater.checks).toHaveLength(2);
      expect(h.updater.lastCheck().feedUrl).toBe(FEED_B);
      expect(h.updater.feedUrls).toEqual([FEED_A, FEED_B]);

      h.updater.emit('update-available', { version: '0.3.0' });
      h.files.add(FILE_B);
      h.updater.emit('update-downloaded', { version: '0.3.0', downloadedFile: FILE_B });
      expect(h.service.getStatus()).toMatchObject({
        state: 'downloaded',
        feedUrl: FEED_B,
        availableVersion: '0.3.0',
      });

      // No status ever pairs feed B with feed A's version.
      expect(h.statuses().filter((s) => s.feedUrl === FEED_B && s.availableVersion === '0.2.0'))
        .toEqual([]);
    } finally {
      h.restoreEnv();
    }
  });

  it('cancels an in-flight download when the feed changes mid-download', async () => {
    const h = createHarness(FEED_A);
    try {
      h.service.check();
      const token = createToken();
      const download = createDeferred<unknown>();
      h.updater.lastCheck().deferred.resolve({
        cancellationToken: token.token,
        downloadPromise: download.promise,
      });
      await flush();

      h.updater.emit('update-available', { version: '0.2.0' });
      h.updater.emit('download-progress', { percent: 60 });
      expect(h.service.getStatus()).toMatchObject({ state: 'downloading', percent: 60 });

      h.setFeed(FEED_B);
      expect(h.service.check()).toMatchObject({
        state: 'checking',
        feedUrl: FEED_B,
        availableVersion: null,
        percent: null,
      });
      // The token is already known, so the old download is aborted right away.
      expect(token.cancelled).toBe(true);
      expect(h.updater.listenerCount('download-progress')).toBe(0);

      h.updater.emit('download-progress', { percent: 99 });
      h.updater.emit('update-available', { version: '0.2.0' });
      expect(h.service.getStatus()).toMatchObject({
        state: 'checking',
        feedUrl: FEED_B,
        availableVersion: null,
        percent: null,
      });

      download.reject(new Error('Download cancelled'));
      await flush();
      expect(h.updater.lastCheck()).toMatchObject({ feedUrl: FEED_B });
      expect(h.service.getStatus()).toMatchObject({ state: 'checking', feedUrl: FEED_B });
    } finally {
      h.restoreEnv();
    }
  });

  it('clears a downloaded artifact when the feed changes and refuses to install it', async () => {
    const h = createHarness(FEED_A);
    try {
      h.service.check();
      h.files.add(FILE_A);
      h.updater.emit('update-downloaded', { version: '0.2.0', downloadedFile: FILE_A });
      h.updater.lastCheck().deferred.resolve({ downloadPromise: null, cancellationToken: null });
      await flush();
      expect(h.service.getStatus().state).toBe('downloaded');

      h.setFeed(FEED_B);
      // Reading the status is enough: the old artifact is already unusable.
      expect(h.service.getStatus()).toMatchObject({
        state: 'idle',
        feedUrl: FEED_B,
        availableVersion: null,
        percent: null,
        message: null,
        checkedAt: null,
      });

      const failure = await h.service.install().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(NestError);
      expect((failure as NestError).code).toBe('update_not_ready');
      expect(h.updater.installs).toHaveLength(0);

      // The published stream never mixes feed A's artifact with feed B's URL.
      expect(h.statuses().filter((s) => s.feedUrl === FEED_B && s.availableVersion !== null))
        .toEqual([]);
      expect(h.statuses().at(-1)).toMatchObject({
        state: 'idle',
        feedUrl: FEED_B,
        availableVersion: null,
      });
    } finally {
      h.restoreEnv();
    }
  });

  it('installs only a fresh artifact of the current feed', async () => {
    const h = createHarness(FEED_A);
    try {
      // Nothing downloaded yet.
      await expect(h.service.install()).rejects.toMatchObject({ code: 'update_not_ready' });

      h.service.check();
      h.files.add(FILE_A);
      h.updater.emit('update-downloaded', { version: '0.2.0', downloadedFile: FILE_A });
      h.updater.lastCheck().deferred.resolve({ downloadPromise: null, cancellationToken: null });
      await flush();
      expect(h.service.getStatus().state).toBe('downloaded');

      // The installer disappeared from the cache: refuse instead of quitting.
      h.files.delete(FILE_A);
      const failure = await h.service.install().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(NestError);
      expect((failure as NestError).code).toBe('update_not_ready');
      expect((failure as NestError).message).toContain('no longer on disk');
      expect(h.updater.installs).toHaveLength(0);
    } finally {
      h.restoreEnv();
    }
  });

  it('reports an invalid replacement feed without keeping the old artifact', async () => {
    const h = createHarness(FEED_A);
    try {
      h.service.check();
      h.files.add(FILE_A);
      h.updater.emit('update-downloaded', { version: '0.2.0', downloadedFile: FILE_A });
      h.updater.lastCheck().deferred.resolve({ downloadPromise: null, cancellationToken: null });
      await flush();

      h.setFeed('http://feed-b.example/nest/');
      const status = h.service.check();
      expect(status).toMatchObject({ state: 'error', feedUrl: 'http://feed-b.example/nest/' });
      expect(status.message).toContain('HTTPS');

      await expect(h.service.install()).rejects.toMatchObject({ code: 'update_not_ready' });
      expect(h.updater.installs).toHaveLength(0);
    } finally {
      h.restoreEnv();
    }
  });
});
