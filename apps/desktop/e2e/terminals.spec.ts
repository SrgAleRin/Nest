import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { pinWideWindow, startHarness } from './helpers';

const appDir = path.resolve(__dirname, '..');
let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-terminals-'));
  repoPath = path.join(tempRoot, 'demo-repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  // Windows may keep the SQLite/PTY files locked for a moment after exit. A
  // temp directory that outlives the run is the harness's problem, not the
  // product's, so it must not turn a green scenario red.
  if (!tempRoot) return;
  try {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    test.info().annotations.push({
      type: 'environment',
      description: `could not remove ${tempRoot}: ${String(error)}`,
    });
  }
});

test('keeps at most eight terminals mounted and replays scrollback for the rest', async () => {
  // Nine PTY sessions are noticeably slower on a shared Windows runner.
  test.setTimeout(240_000);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data'),
      NEST_DB_PATH: path.join(tempRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(tempRoot, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      // Without this the window hides to the tray and app.close() never exits.
      NEST_DISABLE_TRAY: '1',
    },
  });

  const page = await app.firstWindow();

  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.evaluate((projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.project-name')).toHaveText('demo-repo');

  // Nine sessions on the same task: only eight xterm instances may stay mounted.
  for (let index = 0; index < 9; index += 1) {
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-tab')).toHaveCount(index + 1, { timeout: 30_000 });
  }

  await expect(page.locator('.terminal-tab')).toHaveCount(9);
  await expect(page.locator('.terminal-view')).toHaveCount(8);

  // The first tab was evicted; selecting it remounts from stored scrollback.
  await page.locator('.terminal-tab').first().click();
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
    timeout: 30_000,
  });
  await expect(page.locator('.terminal-view')).toHaveCount(8);

  await app.close();
  app = null;
});

test('opens a plain terminal and closes tabs for good', async () => {
  test.setTimeout(180_000);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const closeRoot = path.join(tempRoot, 'close-tabs');
  mkdirSync(closeRoot, { recursive: true });

  app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...env,
      NEST_USER_DATA: path.join(closeRoot, 'user-data'),
      NEST_DB_PATH: path.join(closeRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(closeRoot, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(closeRoot, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
    },
  });

  const page = await app.firstWindow();

  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.evaluate((projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.project-name')).toHaveText('demo-repo');

  // The picker offers a plain shell next to the agent profiles.
  await page.locator('.terminal-new-caret').click();
  await expect(page.locator('.new-tab-heading', { hasText: 'Terminal' })).toBeVisible();
  await page.locator('[data-harness-id="shell"]').click();
  await expect(page.locator('.terminal-tab')).toContainText('Terminal', { timeout: 30_000 });

  const countSessions = async (): Promise<number> =>
    page.evaluate(async () => {
      const response = await window.nest!.invoke('sessions.list', {});
      if (!response.ok) throw new Error(response.error.message);
      return response.data.length;
    });

  expect(await countSessions()).toBe(1);

  // Closing the only tab removes it from the bar and from the database.
  await page.locator('.terminal-tab').first().hover();
  await page.locator('.terminal-tab').first().locator('.terminal-tab-close').click();
  await expect(page.locator('.terminal-tab')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(countSessions, { timeout: 30_000 }).toBe(0);

  // Two sessions, one close: the other tab keeps running.
  await startHarness(page, 'fake');
  await startHarness(page, 'fake');
  await expect(page.locator('.terminal-tab')).toHaveCount(2, { timeout: 30_000 });

  await page.locator('.terminal-tab').first().hover();
  await page.locator('.terminal-tab').first().locator('.terminal-tab-close').click();
  await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(countSessions, { timeout: 30_000 }).toBe(1);

  // The closed row is not resurrected by a reload.
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });

  // Keyboard shortcuts. Another harness gives two tabs to cycle.
  await startHarness(page, 'fake');
  await expect(page.locator('.terminal-tab')).toHaveCount(2, { timeout: 30_000 });
  // Both tabs are "Fake harness", so the selected index is the only signal.
  const selectedIndex = (): Promise<number> =>
    page
      .locator('.terminal-tab')
      .evaluateAll((tabs) => tabs.findIndex((tab) => tab.classList.contains('selected')));
  const firstIndex = await selectedIndex();
  await page.locator('#right-tab-sessions').click();
  await page.keyboard.press('Control+Tab');
  await expect.poll(selectedIndex).not.toBe(firstIndex);
  await page.keyboard.press('Control+Shift+Tab');
  await expect.poll(selectedIndex).toBe(firstIndex);

  // Ctrl+` puts the caret back into the terminal.
  await page.locator('#right-tab-sessions').click();
  await page.keyboard.press('Control+Backquote');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    )
    .toBe(true);

  // Ctrl+N opens the new-task dialog whenever no modal owns the keyboard.
  await page.locator('#right-tab-sessions').click();
  await page.keyboard.press('Control+n');
  await expect(page.locator('.modal')).toBeVisible();
  // The header X and the footer button are both labelled Close; the footer one
  // dismisses without cancelling anything.
  await page.locator('.modal').getByRole('button', { name: 'Close' }).last().click();
  await expect(page.locator('.modal')).toHaveCount(0);

  // Ctrl+W closes the active tab while the focus is outside the terminal; with
  // focus inside xterm it stays a shell kill-word.
  await page.locator('#right-tab-sessions').click();
  await page.keyboard.press('Control+w');
  await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(countSessions, { timeout: 30_000 }).toBe(1);

  await app.close();
  app = null;
});

test('the plus button follows the configured default', async () => {
  test.setTimeout(120_000);

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const defaultRoot = path.join(tempRoot, 'new-tab-default');
  mkdirSync(defaultRoot, { recursive: true });

  app = await electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...env,
      NEST_USER_DATA: path.join(defaultRoot, 'user-data'),
      NEST_DB_PATH: path.join(defaultRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(defaultRoot, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(defaultRoot, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
    },
  });

  const page = await app.firstWindow();

  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.evaluate((projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  await page.evaluate(() => {
    return window.nest!.invoke('settings.update', { newSessionDefault: 'fake' });
  });
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // A configured default starts immediately; the picker stays closed.
  await page.locator('.terminal-new-main').click();
  await expect(page.locator('.new-tab-menu')).toHaveCount(0);
  await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.terminal-tab')).toContainText('Fake harness');

  // `ask` puts the picker back on the plus button.
  await page.evaluate(() => {
    return window.nest!.invoke('settings.update', { newSessionDefault: 'ask' });
  });
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.locator('.terminal-new-main').click();
  await expect(page.locator('.new-tab-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.new-tab-menu')).toHaveCount(0);

  await app.close();
  app = null;
});
