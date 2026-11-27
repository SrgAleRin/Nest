import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { openPanelMenu, pinWideWindow } from './helpers';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/**
 * History, commit details, branch comparison and the branch switcher against a
 * real repository: the git panel groups changes into a tree, the history tab
 * opens a commit with patches, and the compare tab shows commits and files
 * between two refs.
 */
const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function commit(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', message], cwd);
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-git-e2e-'));
  repoPath = path.join(tempRoot, 'history-repo');
  mkdirSync(path.join(repoPath, 'src', 'lib'), { recursive: true });

  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# history\n', 'utf8');
  commit(repoPath, 'init commit');

  writeFileSync(path.join(repoPath, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
  writeFileSync(path.join(repoPath, 'src', 'lib', 'util.ts'), 'export const util = 1;\n', 'utf8');
  commit(repoPath, 'feat: add app');

  git(['switch', '-c', 'feature'], repoPath);
  writeFileSync(path.join(repoPath, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
  commit(repoPath, 'feature: add file');
  git(['switch', 'main'], repoPath);

  // One dirty tracked file and one untracked file for the changes tree.
  writeFileSync(path.join(repoPath, 'src', 'app.ts'), 'export const app = 2;\n', 'utf8');
  writeFileSync(path.join(repoPath, 'notes.md'), 'scratch\n', 'utf8');
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('browses changes, commits and branch comparison', async () => {
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
    },
  });

  const page = await app.firstWindow();

  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });

  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // The change list groups the two changed files under src/; notes.md stays flat.
  await expect(page.locator('.file-tree .tree-dir')).toContainText('src', { timeout: 20_000 });
  await expect(page.locator('.file-tree .git-file')).toHaveCount(2);
  // The two sides are separate sections, each with its own count.
  await expect(page.locator('[data-testid="changes-unstaged"] .section-label')).toHaveText(
    'Unstaged (1)',
  );
  await expect(page.locator('[data-testid="changes-untracked"] .section-label')).toHaveText(
    'Untracked (1)',
  );

  // Tree/list toggle switches the grouping.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.locator('.file-tree')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  await expect(page.locator('.file-tree .tree-dir')).toBeVisible();

  // The most recent commit opens in History with its patch behind a file row.
  const panelMenu = await openPanelMenu(page);
  await panelMenu.getByRole('menuitem', { name: 'History' }).click();
  await expect(page.locator('.right-subhead-title')).toHaveText('History');
  await page.locator('.commit-list .commit-row').first().click();
  await expect(page.locator('.commit-detail-subject')).toHaveText('feat: add app');
  await expect(page.locator('.commit-detail .git-file')).toHaveCount(2);
  await page.locator('.commit-detail .git-file', { hasText: 'app.ts' }).click();
  await expect(page.locator('.commit-patch')).toBeVisible();
  await expect(page.locator('.commit-patch')).toContainText('export const app = 1;');

  // Compare defaults to the upstream/base ref; picking feature as head shows
  // the commit it adds on top of the merge base.
  await page.getByRole('button', { name: '← Source Control' }).click();
  const menu = await openPanelMenu(page);
  await menu.getByRole('menuitem', { name: 'Compare branches' }).click();
  await expect(page.locator('.right-subhead-title')).toHaveText('Compare');
  const pickers = page.locator('.compare-picker select');
  await expect(pickers).toHaveCount(2);
  await pickers.nth(1).selectOption('feature');
  await expect(page.locator('.compare-commits')).toContainText('feature: add file');
  await expect(page.locator('.compare-panel .git-file')).toContainText('feature.ts');
  await expect(page.locator('.compare-summary')).toContainText('↑ 1');

  // Switching branches from the panel head updates the checkout.
  await page.getByRole('button', { name: '← Source Control' }).click();
  await page.locator('.branch-button').click();
  await expect(page.locator('.branch-menu')).toBeVisible();
  await page.locator('.branch-item', { hasText: 'feature' }).click();
  await expect(page.locator('.branch-button')).toContainText('feature');

  // Header and status bar read the same git status the panel does, so one
  // checkout keeps all three in step instead of leaving the label stale.
  await expect(page.locator('.titlebar .badge')).toHaveText('feature');
  await expect(page.locator('.statusbar .status-item').first()).toContainText('feature');

  // Truncated before closing so a failure leaves the worktree in place for
  // inspection; the temp directory is removed in afterAll.
  await app.close();
  app = null;
});
