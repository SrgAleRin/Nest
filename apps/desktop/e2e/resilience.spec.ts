import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
 * Panels keep failures inline instead of leaving an empty column, and a retry
 * recovers once the workspace is readable again. Hiding the git dir makes every
 * git call fail without touching the task itself.
 */
const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';
let gitDir = '';
let gitDirHidden = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-resilience-'));
  repoPath = path.join(tempRoot, 'resilient-repo');
  gitDir = path.join(repoPath, '.git');
  gitDirHidden = path.join(repoPath, '.git-hidden');
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
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('shows inline panel errors and recovers after a retry', async () => {
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
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  const added = await page.evaluate(async (projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.git-branch-name')).toHaveText('main');
  await expect(page.locator('.git-files .panel-empty')).toHaveText('Working tree is clean');

  // Git panel: a failed refresh keeps the error and retry in the panel.
  renameSync(gitDir, gitDirHidden);
  await page.getByTitle('Refresh status').click();
  await expect(page.locator('.error-state-title')).toHaveText('Git status unavailable');
  await expect(page.locator('.error-state-body')).toContainText('not a git repository');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

  renameSync(gitDirHidden, gitDir);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.error-state')).toHaveCount(0);
  await expect(page.locator('.git-branch-name')).toHaveText('main');
  await expect(page.locator('.git-files .panel-empty')).toHaveText('Working tree is clean');

  // Diff panel: switching tabs mounts it, so the failure happens on its own.
  renameSync(gitDir, gitDirHidden);
  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.locator('.error-state-title')).toHaveText('Diff unavailable');

  renameSync(gitDirHidden, gitDir);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.error-state')).toHaveCount(0);
  await expect(page.locator('.diff-panel .panel-empty')).toHaveText('No changes to review');
});
