import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createCore, type Core } from '@nest/core';
import type { AppInfo, NestEvent } from '@nest/shared';
import { registerIpc } from './ipc';
import { resolveProfileName } from './profile';
import { WorkspaceWatcher } from './watcher';

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAaUlEQVR4nGNggIKqRd//0xMzIAN6W47iiIGyHO6IQecABjRA1bjGYt6oAwafAwY8EQ5aB3Bw8aHgUQcMuAMI4VEHDH8HUCuRjjpg1AFDxwG0woOvQTLqgAF3wIAnQro7gBrBTJXoGSjLASwWjLvvyC/qAAAAAElFTkSuQmCC';

const profile = resolveProfileName(process.env.NEST_PROFILE);
app.setName('Nest');

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
const worktreesRoot = process.env.NEST_WORKTREES_ROOT ?? path.join(userData, 'worktrees');
const fakeHarnessScript = app.isPackaged
  ? path.join(process.resourcesPath, 'fake-harness.mjs')
  : path.resolve(app.getAppPath(), '../../scripts/fake-harness.mjs');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: Core | null = null;
let watcher: WorkspaceWatcher | null = null;
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
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
    worktreesRoot,
  };
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
      worktreesRoot,
      fakeHarnessScript,
      customCommand: process.env.NEST_CUSTOM_COMMAND,
      onEvent: broadcast,
    });

    watcher = new WorkspaceWatcher(broadcast);
    void watcher.sync(core.tasks.list());

    registerIpc({
      core,
      info,
      getWindow: () => mainWindow,
      onTasksChanged: () => {
        if (core && watcher) void watcher.sync(core.tasks.list());
      },
    });
    createWindow();
    createTray();

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
    void watcher?.close();
    watcher = null;
    core?.close();
    core = null;
  });
}
