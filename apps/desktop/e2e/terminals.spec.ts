import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appDir = path.resolve(__dirname, '..');
let tempRoot = '';
let repoPath = '';

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

test.afterAll(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('keeps at most eight terminals mounted and replays scrollback for the rest', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
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
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.evaluate((projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await expect(page.locator('.project-name')).toHaveText('demo-repo');

  // Nine sessions on the same task: only eight xterm instances may stay mounted.
  for (let index = 0; index < 9; index += 1) {
    await page.locator('.select').selectOption('fake');
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
});
