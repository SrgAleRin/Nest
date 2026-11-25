import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * The Git panel must react to files written outside Nest (an agent in a
 * terminal, another editor) without a manual refresh, and each changed file
 * shows its line counts.
 */
const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-watch-'));
  repoPath = path.join(tempRoot, 'watcher-repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# watcher\n', 'utf8');
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

test('refreshes git status and shows line counts for files changed on disk', async () => {
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

  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.project-name')).toHaveText('watcher-repo');
  await expect(page.locator('.git-files .panel-empty')).toHaveText('Working tree is clean');

  // Written by someone else: only the filesystem watcher can notice it.
  writeFileSync(path.join(repoPath, 'fresh.txt'), 'one\ntwo\n', 'utf8');
  const fresh = page.locator('.git-file', { hasText: 'fresh.txt' });
  await expect(fresh).toBeVisible({ timeout: 20_000 });
  await expect(fresh.locator('.git-stat')).toHaveText('+2 -0');

  // The same watch keeps the counts current for follow-up edits.
  appendFileSync(path.join(repoPath, 'fresh.txt'), 'three\n', 'utf8');
  await expect(fresh.locator('.git-stat')).toHaveText('+3 -0', { timeout: 20_000 });
});
