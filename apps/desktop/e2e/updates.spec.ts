import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/**
 * Exercises the real electron-updater code path against a local generic feed.
 * The feed advertises the running version, so the only network round-trip is
 * `latest.yml`: no installer is downloaded and no build is mutated.
 */
const appDir = path.resolve(__dirname, '..');
const unpackedExe = path.join(appDir, 'release', 'win-unpacked', 'Nest.exe');
const packagedExe = process.env.NEST_E2E_EXE ?? unpackedExe;
// Point the test at a real `pnpm dist` output to serve its latest.yml.
const feedDir = process.env.NEST_UPDATE_FEED_DIR
  ? path.resolve(process.env.NEST_UPDATE_FEED_DIR)
  : '';

const LATEST_YML = `version: 0.1.0
files:
  - url: Nest-Setup-0.1.0.exe
    sha512: 0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000==
    size: 1024
path: Nest-Setup-0.1.0.exe
sha512: 0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000==
releaseDate: '2026-11-25T00:00:00.000Z'
`;

let tempRoot = '';
let server: Server | null = null;
let feedUrl = '';
let app: ElectronApplication | null = null;

async function startFeed(): Promise<void> {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (feedDir) {
      const candidate = path.join(feedDir, decodeURIComponent(pathname));
      if (candidate.startsWith(feedDir) && existsSync(candidate) && statSync(candidate).isFile()) {
        response.writeHead(200);
        createReadStream(candidate).pipe(response);
        return;
      }
    }
    if (pathname === '/latest.yml') {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end(LATEST_YML);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('update feed did not bind');
  feedUrl = `http://127.0.0.1:${address.port}/`;
}

test.beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-updates-'));
  await startFeed();
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('packaged app checks a generic feed and reports up to date', async () => {
  test.skip(!existsSync(packagedExe), 'release/win-unpacked is missing: run pnpm dist first');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({
    executablePath: packagedExe,
    env: {
      ...env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data'),
      NEST_DB_PATH: path.join(tempRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees'),
      NEST_UPDATE_URL: feedUrl,
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      NEST_DISABLE_NOTIFICATIONS: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.locator('.statusbar').getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.update-state')).toHaveText('Ready to check');
  await expect(page.locator('.update-meta')).toContainText('feed configured');

  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.locator('.update-state')).toHaveText('Up to date', { timeout: 60_000 });
  await expect(page.locator('.update-message')).toHaveText('Nest is up to date.');
  await expect(page.locator('.update-meta')).toContainText('version 0.1.0');

  const install = await page.evaluate(() => window.nest!.invoke('updates.install', {}));
  expect(install.ok).toBe(false);
  if (!install.ok) expect(install.error.code).toBe('update_not_ready');

  await app.close();
  app = null;
});

test('rejects a plain HTTP feed and shows the error in settings and statusbar', async () => {
  test.skip(!existsSync(packagedExe), 'release/win-unpacked is missing: run pnpm dist first');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({
    executablePath: packagedExe,
    env: {
      ...env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data-http'),
      NEST_DB_PATH: path.join(tempRoot, 'nest-http.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees-http'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      NEST_DISABLE_NOTIFICATIONS: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.locator('.statusbar').getByRole('button', { name: 'Settings' }).click();
  await page
    .locator('.field')
    .filter({ hasText: 'Update feed' })
    .locator('input')
    .fill('http://updates.example.com/nest/');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.locator('.status-update.error')).toHaveText('Update check failed');
  await page.locator('.status-update.error').click();
  await expect(page.locator('.update-state')).toHaveText('Update check failed');
  await expect(page.locator('.update-message')).toContainText('HTTPS');
});
