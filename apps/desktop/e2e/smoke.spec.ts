import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { electronArgs, startHarness } from './helpers';

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
  // An Electron-based terminal (for example an agent harness) may export
  // ELECTRON_RUN_AS_NODE, which would turn Nest into a plain Node process.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return electron.launch({
    args: electronArgs(),
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

  await startHarness(page, 'fake');
  await expect(page.locator('.terminal-tab')).toContainText('Fake harness', { timeout: 30_000 });
  await expect(page.locator('.xterm-rows')).toContainText('FakeHarness', { timeout: 30_000 });

  // The workspace card summarizes its live agent without dumping every row.
  await expect(page.locator('[data-testid="workspace-card"] .ws-agents-label')).toContainText(
    'fake',
    { timeout: 30_000 },
  );

  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('echo hello-e2e');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e', { timeout: 30_000 });

  // Ctrl+F opens the in-terminal search with match highlighting.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.terminal-find')).toBeVisible();
  await page.locator('.terminal-find input').fill('FakeHarness');
  await expect(page.locator('.find-count')).toContainText('/', { timeout: 10_000 });
  await expect(page.locator('.find-count')).not.toHaveText('0/0');
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-find')).toHaveCount(0);

  // Ctrl+Shift+V pastes the system clipboard into the PTY.
  await app.evaluate(({ clipboard }) => clipboard.writeText('echo pasted-e2e'));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+v');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('pasted-e2e', { timeout: 30_000 });

  // Selecting text and pressing Ctrl+Shift+C copies it to the system clipboard.
  const screenBox = await page.locator('.xterm-screen').boundingBox();
  if (!screenBox) throw new Error('terminal screen is not rendered');
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await page.mouse.move(screenBox.x + 10, screenBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(screenBox.x + 220, screenBox.y + 8, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Control+Shift+c');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('');

  // A status change (running -> idle) must not remount the terminal: remounting
  // disposes xterm and replays scrollback, which looks like flashing in TUIs.
  const terminal = await page.locator('.xterm').elementHandle();
  await page.waitForTimeout(2_500);
  const sameTerminal = await terminal?.evaluate(
    (node) => node === document.querySelector('.xterm'),
  );
  expect(sameTerminal).toBe(true);
  await expect(page.locator('.xterm-rows')).toContainText('hello-e2e');

  // Closing the window hides it to the tray. The PTY keeps running; showing
  // the same window again must resume the exact terminal without a restart.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          destroyed: window.isDestroyed(),
        })),
      ),
    )
    .toEqual([{ visible: false, destroyed: false }]);

  const hidden = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    return list.data;
  });
  expect(hidden).toHaveLength(1);
  expect(['running', 'idle']).toContain(hidden[0]?.status ?? '');

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo after-hide');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('after-hide', {
    timeout: 30_000,
  });

  const before = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    return list.data;
  });
  expect(before).toHaveLength(1);
  expect(before[0]?.status === 'running' || before[0]?.status === 'idle').toBe(true);

  // The fake harness writes its conversation id on disk, so discovery should
  // upgrade the session from the "latest conversation" fallback to exact resume.
  await expect
    .poll(
      async () => {
        const list = await page.evaluate(async () => {
          const result = await window.nest!.invoke('sessions.list', {});
          if (!result.ok) throw new Error(result.error.message);
          return result.data;
        });
        const session = list[0];
        return session?.resumeMode === 'exact' ? (session.harnessSessionId ?? null) : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();

  const harnessSessionId = await page.evaluate(async () => {
    const list = await window.nest!.invoke('sessions.list', {});
    if (!list.ok) throw new Error(list.error.message);
    return list.data[0]?.harnessSessionId ?? '';
  });
  expect(harnessSessionId).not.toBe('');

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
  expect(after[0]?.harnessSessionId).toBe(harnessSessionId);
  expect(after[0]?.resumeMode).toBe('exact');
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
  expect(restored).toContain(`session ${harnessSessionId} (fresh)`);

  // The resumed process must be launched with the stored id, not --continue.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const list = await window.nest!.invoke('sessions.list', {});
          if (!list.ok) throw new Error(list.error.message);
          const scroll = await window.nest!.invoke('sessions.scrollback', {
            sessionId: list.data[0]!.id,
          });
          if (!scroll.ok) throw new Error(scroll.error.message);
          return scroll.data.data;
        }),
      { timeout: 30_000 },
    )
    .toContain(`session ${harnessSessionId} (exact)`);

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
  await page.getByRole('button', { name: 'Resume exact', exact: true }).click();
  await expect(page.locator('.terminal-tab')).toHaveCount(1);

  await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo manual-resume');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('manual-resume', {
    timeout: 30_000,
  });

  await app.close();
});
