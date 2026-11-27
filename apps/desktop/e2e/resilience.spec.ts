import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { pinWideWindow } from './helpers';

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

/**
 * The fixture is created inside this worktree, so hiding `.git` would let git
 * walk up into the Nest repository and report *its* changes. A `.git` file that
 * points at a directory that is not there fails the lookup instead.
 */
function breakRepository(): void {
  renameSync(gitDir, gitDirHidden);
  writeFileSync(
    gitDir,
    `gitdir: ${path.join(gitDirHidden, 'gone')}
`,
    'utf8',
  );
}

function restoreRepository(): void {
  rmSync(gitDir, { force: true });
  renameSync(gitDirHidden, gitDir);
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
  // One change, so the list has a row to keep showing when git stops answering.
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n\nmore\n', 'utf8');
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

  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });

  const added = await page.evaluate(async (projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.git-branch-name')).toHaveText('main');
  const readmeRow = page.locator('[data-testid="change-row"][data-path="README.md"]');
  await expect(readmeRow).toBeVisible({ timeout: 30_000 });
  const syncAction = page.locator('.sync-action');
  await expect(syncAction).toHaveText('Fetch');
  // No remote is a state, and the tooltip says so instead of failing silently.
  await expect(syncAction).toHaveAttribute('title', 'This repository has no remotes');

  // A failed refresh does not empty the column: the last list stays readable,
  // one note explains the failure with its own retry, and only the remote
  // action is turned off, because the remote state is unknown.
  breakRepository();
  await page.getByRole('button', { name: 'Refresh git status' }).click();
  const statusNote = page.locator('.source-control-note.warn', {
    hasText: 'Could not read the git status',
  });
  // The panel shows git's own message, and git words a broken gitfile
  // differently across versions: 2.55 says "not a git repository", the runner's
  // build says "gitfile does not point to a valid repository".
  await expect(statusNote).toContainText(/not a git repository|not point to a valid repository/, {
    timeout: 30_000,
  });
  // The branches slice fails on its own and only explains the remote action.
  const branchesNote = page.locator('.source-control-note.warn', {
    hasText: 'Branches could not be read',
  });
  await expect(branchesNote).toBeVisible();
  await expect(readmeRow).toBeVisible();
  await expect(page.locator('[data-testid="change-count"]')).toHaveText('All changes · 1');
  await expect(page.locator('.error-state')).toHaveCount(0);
  // The commit block is still there and still explains itself.
  await expect(page.locator('.commit-message')).toBeEditable();
  await expect(page.locator('.commit-submit')).toBeDisabled();
  await expect(page.locator('.commit-reason')).toHaveText('Write a commit message');
  await expect(syncAction).toBeDisabled();
  await expect(syncAction).toHaveAttribute('title', /Branches could not be read/);

  // The patch asks for itself, so the same broken workspace is a panel state
  // with a retry rather than a stale diff.
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.palette-search input').fill('show diff');
  await page.keyboard.press('Enter');
  await expect(page.locator('.error-state-title')).toHaveText('Diff unavailable', {
    timeout: 30_000,
  });

  restoreRepository();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.error-state')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.diff-file-head .diff-path')).toHaveText('README.md');

  // And back in the list the column is whole again. The restored `.git` is
  // picked up by the watcher on its own, so the notes may already be gone by the
  // time the list is back; the retry is what is left to check when they are not.
  await page.getByRole('button', { name: '← Source Control' }).click();
  const retryBranches = branchesNote.getByRole('button', { name: 'Retry' });
  if (await retryBranches.count()) await retryBranches.click();
  await expect(page.locator('.source-control-note.warn')).toHaveCount(0, { timeout: 30_000 });
  await expect(readmeRow).toBeVisible();
  await expect(syncAction).toHaveAttribute('title', 'This repository has no remotes');
});
