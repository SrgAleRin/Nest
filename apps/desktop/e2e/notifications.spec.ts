import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { electronArgs } from './helpers';

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
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-notifications-'));
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

test('marks finished sessions unread and routes notification clicks', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app: ElectronApplication = await electron.launch({
    args: electronArgs(),
    cwd: appDir,
    env: {
      ...env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data'),
      NEST_DB_PATH: path.join(tempRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      // Keep the developer's notification center quiet; the toggle is also the
      // switch the renderer observes through `shown`.
      NEST_DISABLE_NOTIFICATIONS: '1',
      NEST_ENABLE_FAKE_HARNESS: '1',
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

    // The raw bridge call bypassed the renderer state, so reload once to load
    // the project and its checkout into the UI.
    await page.reload();
    await page.waitForSelector('.app', { timeout: 60_000 });
    await expect(page.locator('.task-kind-main')).toBeVisible();

    const start = (): Promise<{ id: string }> =>
      page.evaluate(async (id) => {
        const response = await window.nest!.invoke('sessions.start', {
          taskId: id,
          harnessId: 'fake',
        });
        if (!response.ok) throw new Error(response.error.message);
        return { id: response.data.id };
      }, taskId);

    const first = await start();
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
    const second = await page.evaluate(async (id) => {
      const response = await window.nest!.invoke('sessions.start', {
        taskId: id,
        harnessId: 'fake',
      });
      if (!response.ok) throw new Error(response.error.message);
      return { id: response.data.id };
    }, taskId);
    await expect(page.locator('.terminal-tab')).toHaveCount(2, { timeout: 30_000 });
    expect(second.id).not.toBe(first.id);

    // Look at the second tab, then let the first session end in the background.
    await page.locator('.terminal-tab').nth(1).click();
    await expect(page.locator('.terminal-tab').nth(1)).toHaveClass(/selected/);

    await page.evaluate(async (sessionId) => {
      const response = await window.nest!.invoke('sessions.stop', { sessionId });
      if (!response.ok) throw new Error(response.error.message);
    }, first.id);

    // Unread shows up in the tab and on the workspace card.
    await expect(page.locator('.terminal-tab .unread-badge')).toHaveText('1', {
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid="workspace-card"] .unread-badge')).toHaveText('1');

    // Opening the finished session clears it everywhere.
    await page.locator('.terminal-tab').nth(0).click();
    await expect(page.locator('.terminal-tab .unread-badge')).toHaveCount(0);
    await expect(page.locator('[data-testid="workspace-card"] .unread-badge')).toHaveCount(0);

    // A notification click arrives as an event and opens the matching session.
    await app.evaluate(({ BrowserWindow }, sessionId) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('nest:event', {
        type: 'notification:activated',
        sessionId,
      });
    }, second.id);
    await expect(page.locator('.terminal-tab').nth(1)).toHaveClass(/selected/, {
      timeout: 20_000,
    });

    const shown = await page.evaluate(async () => {
      return window.nest!.invoke('notifications.show', { title: 'Test', body: 'Body' });
    });
    expect(shown).toEqual({ ok: true, data: { shown: false } });

    const badge = await page.evaluate(async () => {
      return window.nest!.invoke('notifications.badge', { count: 3 });
    });
    expect(badge.ok).toBe(true);
  } finally {
    await app.close();
  }
});
