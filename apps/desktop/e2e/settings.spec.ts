import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@nest/shared';
import { openNewTabPicker } from './helpers';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-settings-e2e-'));
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
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('saves harness settings and keeps a disabled harness resumable', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app: ElectronApplication = await electron.launch({
    args: ['.'],
    cwd: appDir,
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

  try {
    const page = await app.firstWindow();
    await page.waitForSelector('.app', { timeout: 60_000 });

    const added = await page.evaluate(async (projectPath) => {
      const response = await window.nest!.invoke('projects.add', { path: projectPath });
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    }, repoPath);
    const taskId = added.checkout.id;

    await page.reload();
    await page.waitForSelector('.app', { timeout: 60_000 });
    await expect(page.locator('.start-card').filter({ hasText: 'Fake harness' })).toBeVisible();

    // An existing conversation that is later disabled in Settings must still
    // resume; only the start pickers should hide it.
    const session = await page.evaluate(async (id) => {
      const started = await window.nest!.invoke('sessions.start', {
        taskId: id,
        harnessId: 'fake',
      });
      if (!started.ok) throw new Error(started.error.message);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stopped = await window.nest!.invoke('sessions.stop', {
        sessionId: started.data.id,
      });
      if (!stopped.ok) throw new Error(stopped.error.message);
      return started.data;
    }, taskId);
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.terminal-exit')).toContainText('exited', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.settings-modal')).toBeVisible();
    expect(await page.locator('.settings-row').count()).toBeGreaterThanOrEqual(7);
    await expect(page.locator('.update-state')).toHaveText('Updates disabled');
    const customSection = page.locator('.settings-section').filter({ hasText: 'Custom command' });
    const customCommandField = customSection.locator('.field').filter({ hasText: 'Command' });
    const feedField = page.locator('.field').filter({ hasText: 'Update feed' });
    const fontSizeField = page.locator('.field').filter({ hasText: 'Font size' });

    const fakeRow = page.locator('.settings-row').filter({ hasText: 'Fake harness' });
    await expect(fakeRow.locator('input')).toBeChecked();
    await fakeRow.locator('input').uncheck();
    await page.getByLabel('Fake harness launch arguments').fill('--demo');
    await fontSizeField.locator('input').fill('15');
    await fontSizeField.locator('input').press('Enter');
    await customCommandField.locator('input').fill('node');
    await feedField.locator('input').fill('https://updates.example.com/nest/');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.locator('.settings-modal')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Settings saved');
    await openNewTabPicker(page);
    await expect(page.locator('[data-harness-id="custom"]')).toBeVisible({ timeout: 20_000 });
    const itemLabels = (await page.locator('.new-tab-item').allTextContents()).join('|');
    expect(itemLabels).not.toContain('Fake harness');
    expect(itemLabels).toContain('Custom command');
    await page.keyboard.press('Escape');
    await expect(page.locator('.new-tab-menu')).toHaveCount(0);

    // The exited session still offers Resume in the UI, even though its
    // profile is gone from the pickers.
    await expect(page.getByRole('button', { name: /^Resume/ })).toBeVisible();

    // Disabled profiles are rejected for new sessions...
    const blocked = await page.evaluate(async (id) => {
      return window.nest!.invoke('sessions.start', { taskId: id, harnessId: 'fake' });
    }, taskId);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('harness_disabled');

    // ...but resuming the conversation that already exists still works.
    const resumed = await page.evaluate(async (sessionId) => {
      return window.nest!.invoke('sessions.resume', { sessionId });
    }, session.id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(['starting', 'running', 'idle']).toContain(resumed.data.status);

    // Settings live in SQLite, so a renderer reload keeps them.
    await page.reload();
    await page.waitForSelector('.app', { timeout: 60_000 });
    const stored = await page.evaluate(async () => {
      const response = await window.nest!.invoke('settings.get', {});
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    });
    expect(stored).toEqual({
      disabledHarnesses: ['fake'],
      customCommand: 'node',
      harnessArgs: { fake: '--demo' },
      shellCommand: '',
      terminal: { ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 15 },
      worktreeRoot: '',
      copyEnvFiles: false,
      updateFeedUrl: 'https://updates.example.com/nest/',
      updatesEnabled: true,
      newSessionDefault: 'ask',
    });

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.settings-modal')).toBeVisible();
    await expect(fakeRow.locator('input')).not.toBeChecked();
    await expect(customCommandField.locator('input')).toHaveValue('node');
    await expect(feedField.locator('input')).toHaveValue('https://updates.example.com/nest/');
    await expect(page.getByLabel('Fake harness launch arguments')).toHaveValue('--demo');
    await expect(fontSizeField.locator('input')).toHaveValue('15');
    await expect(page.locator('.update-meta')).toContainText('feed configured');
  } finally {
    await app.close();
  }
});
