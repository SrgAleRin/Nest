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
import { UpdateService } from './updates';
import { WorkspaceWatcher } from './watcher';

const TRAY_ICON_BASE64 =
  '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';

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
    minWidth: 1040,
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
    tray = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`));
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
    void watcher.sync(core.tasks.list());

    const updateService = new UpdateService(() => core!.settings.get(), broadcast);
    updates = updateService;

    registerIpc({
      core,
      info,
      updates: updateService,
      getWindow: () => mainWindow,
      onTasksChanged: () => {
        if (core && watcher) void watcher.sync(core.tasks.list());
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
