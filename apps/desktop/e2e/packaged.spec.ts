import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

/**
 * Smoke test for the packaged application (pnpm dist output). It proves that
 * the asar bundle, the unpacked node-pty binaries and the fake-harness
 * resource work outside the dev tree, without Node.js in PATH for the app
 * itself. Skipped when the release was not built yet.
 */
const appDir = path.resolve(__dirname, '..');
const unpackedExe = path.join(appDir, 'release', 'win-unpacked', 'Nest.exe');
// NEST_E2E_EXE lets the same smoke run against an installed copy of Nest.
const packagedExe = process.env.NEST_E2E_EXE ?? unpackedExe;
const resourcesDir = path.join(path.dirname(packagedExe), 'resources');
const fakeHarnessResource = path.join(resourcesDir, 'fake-harness.mjs');

let tempRoot = '';
let repoPath = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-packaged-'));
  repoPath = path.join(tempRoot, 'packaged-repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# packaged\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
});

test.afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('the packaged app starts, runs a PTY and keeps its database', async () => {
  test.skip(!existsSync(packagedExe), 'release/win-unpacked is missing: run pnpm dist first');
  expect(existsSync(fakeHarnessResource)).toBe(true);

  // An Electron-based terminal (for example an agent harness) may export
  // ELECTRON_RUN_AS_NODE, which would turn Nest into a plain Node process.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    executablePath: packagedExe,
    env: {
      ...env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data'),
      NEST_DB_PATH: path.join(tempRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(tempRoot, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  const info = await page.evaluate(async () => {
    const result = await window.nest!.invoke('app.info', {});
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  });
  expect(info.version).toBe('0.1.0');
  expect(info.dbPath).toBe(path.join(tempRoot, 'nest.db'));

  const added = await page.evaluate(async (projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.project-name')).toHaveText('packaged-repo');
  await expect(page.locator('.task-kind-main')).toBeVisible();

  // The fake harness is launched from resources/fake-harness.mjs, so a broken
  // extraResources copy fails right here.
  await page.locator('.select').selectOption('fake');
  await expect(page.locator('.xterm-rows')).toContainText('FakeHarness', { timeout: 60_000 });

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo hello-packaged');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('hello-packaged', { timeout: 60_000 });

  // The packaged main process must persist into the profile database.
  await expect
    .poll(() => existsSync(path.join(tempRoot, 'nest.db')), { timeout: 30_000 })
    .toBe(true);

  await app.close();
});
