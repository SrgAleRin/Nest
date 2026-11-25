import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...process.env,
      NEST_USER_DATA: path.join(tempRoot, 'user-data'),
      NEST_DB_PATH: path.join(tempRoot, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(tempRoot, 'worktrees'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
    },
  });
}

test.beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-e2e-'));
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

test('runs the fake harness, persists scrollback and recovers after restart', async () => {
  let app = await launchApp();
  let page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  const response = await page.evaluate(async (projectPath) => {
    return window.nest!.invoke('projects.add', { path: projectPath });
  }, repoPath);
  expect(response.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });

  await expect(page.locator('.project-name')).toHaveText('demo-repo');
  await expect(page.locator('.task-kind-main')).toBeVisible();

  await page.locator('.select').selectOption('fake');
  await expect(page.locator('.terminal-tab')).toContainText('Fake harness', { timeout: 30_000 });
  await expect(page.locator('.xterm-rows')).toContainText('FakeHarness', { timeout: 30_000 });

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo hello-e2e');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e', { timeout: 30_000 });

  // A status change (running -> idle) must not remount the terminal: remounting
  // disposes xterm and replays scrollback, which looks like flashing in TUIs.
  const terminal = await page.locator('.xterm').elementHandle();
  await page.waitForTimeout(2_500);
  const sameTerminal = await terminal?.evaluate(
    (node) => node === document.querySelector('.xterm'),
  );
  expect(sameTerminal).toBe(true);
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e');

  const before = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    return list.data;
  });
  expect(before).toHaveLength(1);
  expect(before[0]?.status === 'running' || before[0]?.status === 'idle').toBe(true);

  await app.close();

  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // Sessions that were live at shutdown resume automatically, in the same tab.
  const after = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    return list.data;
  });
  expect(after).toHaveLength(1);
  expect(['running', 'idle']).toContain(after[0]?.status ?? '');
  await expect(page.locator('.terminal-tab')).toHaveCount(1);

  // Previous output is kept in scrollback above the resumed PTY's fresh screen.
  const restored = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    const scroll = await window.nest!.invoke('sessions.scrollback', {
      sessionId: list.data[0]!.id,
    });
    if (!scroll.ok) throw new Error(scroll.error.message);
    return scroll.data.data;
  });
  expect(restored).toContain('hello-e2e');
  expect(restored).toContain('resume Fake harness');

  await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo after-reopen');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('after-reopen', {
    timeout: 30_000,
  });

  // Manual Resume covers sessions stopped during the current run.
  await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    await window.nest!.invoke('sessions.stop', { sessionId: list.data[0]!.id });
  });
  await expect(page.locator('.terminal-exit')).toContainText('exited', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.locator('.terminal-tab')).toHaveCount(1);

  await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo manual-resume');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('manual-resume', {
    timeout: 30_000,
  });

  await app.close();
});
