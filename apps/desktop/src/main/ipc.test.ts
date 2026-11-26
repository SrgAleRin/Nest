import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '@nest/shared';
import type { Core } from '@nest/core';
import type { UpdateService } from './updates';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  appUrl: null as unknown as URL,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
  clipboard: { readText: async () => '', writeText: async () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  BrowserWindow: class {},
}));

vi.mock('./appUrl', () => ({ currentAppUrl: () => state.appUrl }));

// Imported after the mocks so the router registers into the captured map.
const { registerIpc } = await import('./ipc');

const rendererDir = path.resolve('out', 'renderer');
const appUrl = pathToFileURL(path.join(rendererDir, 'index.html'));
const info: AppInfo = {
  version: '0.1.3',
  electron: '45.5.0',
  platform: process.platform,
  profile: null,
  userData: '/tmp/nest',
  dbPath: '/tmp/nest/nest.db',
  worktreesRoot: '/tmp/nest/worktrees',
};

interface FakeFrame {
  url: string;
  origin: string;
  parent: FakeFrame | null;
}

const windowFrame: FakeFrame = { url: appUrl.href, origin: appUrl.origin, parent: null };
const webContents = { id: 'main-window' };
let window = { webContents, isDestroyed: () => false };

function event(senderFrame: FakeFrame | null, sender: unknown = webContents): unknown {
  return { senderFrame, sender };
}

type Handler = (
  event: unknown,
  ...args: unknown[]
) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}>;

function router(): Handler {
  const handler = state.handlers.get('nest:rpc');
  if (!handler) throw new Error('nest:rpc was not registered');
  return handler as Handler;
}

beforeEach(() => {
  state.appUrl = appUrl;
  state.handlers.clear();
  window = { webContents, isDestroyed: () => false };
  registerIpc({
    core: {} as Core,
    info: () => info,
    updates: {} as UpdateService,
    getWindow: () => window as never,
  });
});

describe('nest:rpc sender frame', () => {
  it('accepts the top frame of the app window', async () => {
    await expect(router()(event(windowFrame), 'app.info', {})).resolves.toEqual({
      ok: true,
      data: info,
    });
  });

  it('refuses a subframe of the app document', async () => {
    const subframe: FakeFrame = { url: appUrl.href, origin: appUrl.origin, parent: windowFrame };
    await expect(router()(event(subframe), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('refuses a frame loaded from another origin', async () => {
    const foreign: FakeFrame = {
      url: 'http://evil.example/index.html',
      origin: 'http://evil.example',
      parent: null,
    };
    await expect(router()(event(foreign), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('refuses another document on disk', async () => {
    const other: FakeFrame = {
      url: pathToFileURL(path.resolve('Windows', 'evil.html')).href,
      origin: 'null',
      parent: null,
    };
    await expect(router()(event(other), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('refuses a frame without a sender frame', async () => {
    await expect(router()(event(null), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('refuses a call from another window', async () => {
    const otherWindow = { id: 'other-window' };
    await expect(router()(event(windowFrame, otherWindow), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('refuses a call when the window is gone', async () => {
    window = { webContents, isDestroyed: () => true };
    await expect(router()(event(windowFrame), 'app.info', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });

  it('rejects the call before dispatching the method', async () => {
    const foreign: FakeFrame = { url: 'about:blank', origin: 'null', parent: null };
    // An unknown method from a foreign frame reports the frame, not the method:
    // the boundary check runs first.
    await expect(router()(event(foreign), 'no.such.method', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'untrusted_sender' },
    });
  });
});

describe('nest:rpc link policy', () => {
  it('refuses to open a local file through the shared allowlist', async () => {
    await expect(
      router()(event(windowFrame), 'app.openExternal', { url: 'file:///C:/Windows/calc.exe' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'unsupported_url' } });
  });

  it('refuses a value that is not a URL', async () => {
    await expect(
      router()(event(windowFrame), 'app.openExternal', { url: 'example.com' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_url' } });
  });

  it('still dispatches a valid method from the app frame', async () => {
    await expect(router()(event(windowFrame), 'no.such.method', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'method_not_found' },
    });
  });
});
