import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createCore, resolveWorktreesRoot, type Core } from '@nest/core';
import type { AppInfo, NestEvent } from '@nest/shared';
import { currentAppUrl } from './appUrl';
import { decideExternalLink, decideNavigation, isAppUrl } from './boundaries';
import { registerIpc } from './ipc';
import { setAppBadge, showNotification } from './notifications';
import { resolveProfileName } from './profile';
import { trayIconDataUrl } from './trayIcon';
import { UpdateService } from './updates';
import { WorkspaceWatcher } from './watcher';

const profile = resolveProfileName(process.env.NEST_PROFILE);
app.setName('Nest');
// Windows only shows toasts for an app with a registered AppUserModelID, which
// the NSIS shortcut uses as well. Other platforms ignore this call.
app.setAppUserModelId('dev.nest.desktop');

if (process.env.NEST_USER_DATA) {
  const userDataPath = path.resolve(process.env.NEST_USER_DATA);
  mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
} else if (profile) {
  const profilePath = path.join(app.getPath('appData'), 'Nest', 'profiles', profile);
  mkdirSync(profilePath, { recursive: true });
  app.setPath('userData', profilePath);
}

const userData = app.getPath('userData');
const dbPath = process.env.NEST_DB_PATH ?? path.join(userData, 'nest.db');
// The default root: the environment override or the platform user-data folder.
// A path saved in Settings replaces it for new worktrees only.
const defaultWorktreesRoot =
  process.env.NEST_WORKTREES_ROOT ?? path.join(userData, 'worktrees');
const fakeHarnessScript = app.isPackaged
  ? path.join(process.resourcesPath, 'fake-harness.mjs')
  : path.resolve(app.getAppPath(), '../../scripts/fake-harness.mjs');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: Core | null = null;
let watcher: WorkspaceWatcher | null = null;
let updates: UpdateService | null = null;
let shuttingDown = false;
let quitting = false;

function broadcast(event: NestEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('nest:event', event);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 640,
    show: false,
    backgroundColor: '#080a0e',
    title: 'Nest',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    // Closing the window keeps Nest and its PTYs alive in the tray. The tray
    // menu (or a second launch) brings the same window back with the same
    // terminals; only explicit Quit stops the sessions.
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const appUrl = currentAppUrl();

  // Nest is a single window. A new window request never opens one; the URL is
  // handed to the same link policy the renderer's `app.openExternal` uses.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url);
    return { action: 'deny' };
  });

  // Navigation away from the app document is refused instead of silently
  // followed; a user-initiated external link still reaches the browser.
  mainWindow.webContents.on('will-navigate', (details) => {
    const decision = decideNavigation(details.url, appUrl);
    if (decision === 'allow') return;
    details.preventDefault();
    if (decision === 'external') openExternalLink(details.url);
  });

  // A subframe has no business loading anything: the app is one document.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (!isAppUrl(details.url, appUrl)) details.preventDefault();
  });

  mainWindow.webContents.on('will-redirect', (details) => {
    if (!isAppUrl(details.url, appUrl)) details.preventDefault();
  });

  void mainWindow.loadURL(appUrl.href);
}

function openExternalLink(raw: string): void {
  const decision = decideExternalLink(raw);
  if (!decision.allowed) return;
  void shell.openExternal(decision.url);
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (process.env.NEST_DISABLE_TRAY === '1') return;
  try {
    const icon = nativeImage.createFromDataURL(trayIconDataUrl());
    // Electron accepts an empty image and draws nothing, so a broken icon is
    // not a startup error: the tray slot stays blank and Nest looks as if it
    // had no tray icon at all. Keep the tray (close-to-tray depends on it) and
    // leave a trace for the next bug report.
    if (icon.isEmpty()) {
      console.warn('Nest: the tray icon did not decode; the tray slot will be blank.');
    }
    tray = new Tray(icon);
    tray.setToolTip('Nest');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Nest', click: () => showWindow() },
        { type: 'separator' },
        { label: 'Quit Nest', click: () => app.quit() },
      ]),
    );
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
  } catch {
    // Without a tray the window close must quit, otherwise the app would
    // become unreachable.
    tray = null;
  }
}

function info(): AppInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    platform: process.platform,
    profile,
    userData,
    dbPath,
    worktreesRoot: resolvedWorktreesRoot(),
    defaultWorktreesRoot,
  };
}

/** What an empty worktree root in Settings resolves to, shown in the dialog. */
function resolvedWorktreesRoot(): string {
  if (!core) return defaultWorktreesRoot;
  try {
    return resolveWorktreesRoot(defaultWorktreesRoot, core.settings.get().worktreeRoot);
  } catch {
    return defaultWorktreesRoot;
  }
}

const allowMultipleInstances = process.env.NEST_DISABLE_SINGLE_INSTANCE === '1';

if (!allowMultipleInstances && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    core = createCore({
      dbPath,
      worktreesRoot: defaultWorktreesRoot,
      fakeHarnessScript,
      customCommand: process.env.NEST_CUSTOM_COMMAND,
      onEvent: broadcast,
    });

    watcher = new WorkspaceWatcher(broadcast);
    void watcher.sync(core.tasks.list(undefined, { includeArchived: false }));

    const updateService = new UpdateService(() => core!.settings.get(), broadcast);
    updates = updateService;

    registerIpc({
      core,
      info,
      updates: updateService,
      getWindow: () => mainWindow,
      onTasksChanged: () => {
        if (core && watcher) {
          void watcher.sync(core.tasks.list(undefined, { includeArchived: false }));
        }
      },
      showNotification: (input) =>
        showNotification(input, (sessionId) => {
          showWindow();
          broadcast(
            sessionId
              ? { type: 'notification:activated', sessionId }
              : { type: 'notification:activated' },
          );
        }),
      setBadge: (count) => {
        setAppBadge(count);
        tray?.setToolTip(count > 0 ? `Nest — ${count} unread` : 'Nest');
      },
    });
    createWindow();
    createTray();
    updates?.start();

    app.on('activate', () => {
      showWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Stay alive in the tray so running harness sessions survive a window
    // close. app.quit() from the tray still exits normally.
  });

  app.on('before-quit', () => {
    quitting = true;
    tray?.destroy();
    tray = null;
    if (shuttingDown) return;
    shuttingDown = true;
    updates?.stop();
    updates = null;
    void watcher?.close();
    watcher = null;
    core?.close();
    core = null;
  });
}
