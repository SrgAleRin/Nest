import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { centerTab, pinWideWindow } from './helpers';

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
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-palette-'));
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

test('navigates tasks, actions and starts a harness from the palette', async () => {
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
      NEST_DISABLE_NOTIFICATIONS: '1',
    },
  });

  try {
    const page = await app.firstWindow();
    await pinWideWindow(app);
    await page.waitForSelector('.app', { timeout: 60_000 });

    const added = await page.evaluate(async (projectPath) => {
      const response = await window.nest!.invoke('projects.add', { path: projectPath });
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    }, repoPath);

    const task = await page.evaluate(async (projectId) => {
      const response = await window.nest!.invoke('tasks.create', {
        projectId,
        title: 'Palette navigation',
        operationId: `palette-${Date.now()}`,
      });
      if (!response.ok) throw new Error(response.error.message);
      return response.data;
    }, added.project.id);
    expect(task.branch).toBe('nest/palette-navigation');

    await page.reload();
    await page.waitForSelector('.app', { timeout: 60_000 });
    await expect(page.locator('.task-kind-main')).toBeVisible();

    // Shortcut opens the palette with focus in its search field.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('.palette-search input')).toBeFocused();

    await page.locator('.palette-search input').fill('palette navigation');
    await expect(page.locator('.palette-item').first()).toContainText('Palette navigation');
    await page.keyboard.press('Enter');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await expect(page.locator('.crumb.current')).toHaveText('Palette navigation');

    // Panel commands switch the right column, and the selected section says so.
    await page.locator('#right-tab-files').click();
    await expect(page.locator('#right-tab-files')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.palette-search input').fill('source control');
    await page.keyboard.press('Enter');
    await expect(page.locator('#right-tab-source-control')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible();

    // A comparison opens `Diff` in the center; the panel keeps its own section,
    // so the change list stays next to the patch instead of being replaced by it.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.palette-search input').fill('show diff');
    await page.keyboard.press('Enter');
    await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="center-diff-layer"]')).toBeVisible();
    await expect(page.locator('.right-subhead-title')).toHaveCount(0);
    await expect(page.locator('#right-tab-source-control')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible();

    // The graph is a center tab too, and the palette reaches it by name.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.palette-search input').fill('git graph');
    await page.keyboard.press('Enter');
    await expect(centerTab(page, 'graph')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="center-graph-layer"]')).toBeVisible();

    // Escape closes the active tool tab and hands the center back to the
    // terminal; the other tab keeps its open state.
    await page.keyboard.press('Escape');
    await expect(centerTab(page, 'graph')).toHaveCount(0);
    await expect(page.locator('[data-testid="center-terminal-layer"]')).toHaveClass(/is-active/);
    await expect(centerTab(page, 'diff')).toBeVisible();

    // Actions run after the palette closes.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.palette-search input').fill('settings');
    await page.keyboard.press('Enter');
    await expect(page.locator('.settings-modal')).toBeVisible();
    await expect(page.locator('.command-palette')).toHaveCount(0);

    // A modal owns the shortcut until it is closed.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-modal')).toHaveCount(0);

    // Start a harness from the palette, then return to the terminal it starts in.
    await page.keyboard.press('Control+Shift+P');
    await page.locator('.palette-search input').fill('start fake');
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-tab')).toHaveCount(1, { timeout: 30_000 });
    // The tool tab stays open, so the session tab is what brings the terminal back.
    await page.locator('.terminal-tab').first().click();
    await expect(page.locator('[data-testid="center-terminal-layer"]')).toHaveClass(/is-active/);

    await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('.palette-search input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.command-palette')).toHaveCount(0);

    // Arrow keys move the selection.
    await page.keyboard.press('Control+Shift+P');
    const firstActive = await page.locator('.palette-item.active').textContent();
    await page.keyboard.press('ArrowDown');
    const secondActive = await page.locator('.palette-item.active').textContent();
    expect(secondActive).not.toBe(firstActive);

    // No match is explained instead of showing an empty box.
    await page.locator('.palette-search input').fill('zzzz');
    await expect(page.locator('.palette-empty')).toContainText('No commands match');
  } finally {
    await app.close();
  }
});
