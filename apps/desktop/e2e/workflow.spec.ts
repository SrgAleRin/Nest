import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { startHarness } from './helpers';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/**
 * The cross-cutting pass the audit asked for: create the task through the UI,
 * run the fake harness, review staged and unstaged sides, save a note, send it,
 * commit and push to a local bare remote, restart, and delete.
 *
 * The remote is a real bare repository with `branch.autoSetupMerge=true` and
 * `push.default=simple`, which is what made the first push fail before the fix.
 */
const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';
let originPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function launchApp(): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return electron.launch({
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
      NEST_DISABLE_UPDATES: '1',
    },
  });
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-workflow-'));
  originPath = path.join(tempRoot, 'origin.git');
  repoPath = path.join(tempRoot, 'demo');

  mkdirSync(originPath, { recursive: true });
  git(['init', '--bare', '-b', 'main', originPath], tempRoot);

  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n', 'utf8');
  writeFileSync(path.join(repoPath, 'notes.md'), 'one\ntwo\n', 'utf8');
  git(['add', '.'], repoPath);
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'], repoPath);
  git(['remote', 'add', 'origin', originPath], repoPath);
  git(['push', '-u', 'origin', 'main'], repoPath);
  git(['config', 'branch.autoSetupMerge', 'true'], repoPath);
  git(['config', 'push.default', 'simple'], repoPath);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  app = null;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('task workflow: UI creation, staged review, note, commit, first push, restart, delete', async () => {
  app = await launchApp();
  let page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // Adding the project needs a native folder picker, so it uses the bridge;
  // the task itself is created through the interface below.
  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // --- create the task through the UI -------------------------------------
  await page.getByRole('button', { name: 'New task' }).first().click();
  const dialog = page.locator('.modal');
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Fix terminal reconnect').fill('Audit workflow');
  await dialog.getByPlaceholder('current branch, or origin/main after fetch').fill('origin/main');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('.sidebar')).toContainText('Audit workflow', { timeout: 60_000 });

  type TaskRow = { id: string; title: string; branch: string; workspacePath: string };
  const task = await page.evaluate(async () => {
    const tasks = await window.nest!.invoke('tasks.list', {});
    if (!tasks.ok) throw new Error(tasks.error.message);
    return tasks.data.find((candidate) => candidate.title === 'Audit workflow') ?? null;
  });
  expect(task).not.toBeNull();
  const createdTask = task as unknown as TaskRow;
  expect(createdTask.branch.startsWith('nest/')).toBe(true);
  expect(existsSync(createdTask.workspacePath)).toBe(true);

  // The new branch must not track the base: that is what broke the first push.
  expect(
    gitOrNull(['rev-parse', '--abbrev-ref', `${createdTask.branch}@{upstream}`], repoPath),
  ).toBeNull();

  // --- run the fake harness in the task ------------------------------------
  await startHarness(page, 'fake');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
    timeout: 30_000,
  });

  // --- make a change and review both sides ---------------------------------
  writeFileSync(path.join(createdTask.workspacePath, 'notes.md'), 'one\nTWO\nthree\n', 'utf8');
  writeFileSync(path.join(createdTask.workspacePath, 'added.md'), '# added\n', 'utf8');

  await page.getByRole('tab', { name: 'Diff' }).click();
  const unstaged = page.getByRole('tab', { name: /^Unstaged/ });
  await expect(unstaged).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.diff-path', { hasText: 'added.md' })).toBeVisible();

  // Stage one file from the diff without leaving the panel.
  const addedFile = page.locator('.diff-file-head', { hasText: 'added.md' });
  await addedFile.locator('button[title^="Stage this file"]').click();
  await page.getByRole('tab', { name: /^Staged/ }).click();
  await expect(page.locator('.diff-path', { hasText: 'added.md' })).toBeVisible();
  await expect(page.locator('.panel-empty')).toHaveCount(0);
  await page.getByRole('tab', { name: /^Both/ }).click();
  await expect(page.locator('.diff-path', { hasText: 'notes.md' })).toBeVisible();

  // --- save a note and send it to the harness ------------------------------
  await page.getByRole('tab', { name: /^Unstaged/ }).click();
  const changedLine = page.locator('.diff-line.diff-add, .diff-line.diff-del').first();
  await changedLine.hover();
  await changedLine.locator('.diff-comment-btn').click();
  await page.locator('.comment-composer textarea').fill('please fix this line');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.locator('.comment-thread')).toContainText('please fix this line');

  const sendButton = page.locator('.comment-thread button[title^="Send to"]').first();
  await expect(sendButton).toBeVisible();
  await sendButton.click();
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
    'please fix this line',
    { timeout: 30_000 },
  );

  // --- commit and push to the local bare remote ---------------------------
  await page.getByRole('tab', { name: 'Git' }).click();
  await page.locator('.commit-message').fill('audit workflow change');
  await page.getByRole('button', { name: 'Commit', exact: true }).click();
  await expect(page.locator('.commit-list')).toContainText('audit workflow change', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Push', exact: true }).click();
  // Push reports git's own output ("branch ... set up to track ... * [new branch]").
  await expect(page.locator('.toast')).toContainText(`nest/audit-workflow`, { timeout: 60_000 });

  expect(
    git(['for-each-ref', '--format=%(refname)', 'refs/heads'], originPath).split('\n'),
  ).toContain(`refs/heads/${createdTask.branch}`);
  expect(git(['rev-parse', 'main'], originPath)).toBe(git(['rev-parse', 'main'], repoPath));

  // --- restart: the note and the task survive -----------------------------
  await app.close();
  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });

  const notesAfterRestart = await page.evaluate(async (taskId) => {
    const comments = await window.nest!.invoke('comments.list', { taskId });
    if (!comments.ok) throw new Error(comments.error.message);
    return comments.data.map((comment) => comment.body);
  }, createdTask.id);
  expect(notesAfterRestart).toContain('please fix this line');

  await expect(page.locator('.sidebar')).toContainText('Audit workflow', { timeout: 30_000 });

  // --- delete the task through the UI -------------------------------------
  page.once('dialog', (confirm) => void confirm.accept());
  await page.locator('.task-row', { hasText: 'Audit workflow' }).locator('.task-remove').click();
  await expect(page.locator('.sidebar')).not.toContainText('Audit workflow', { timeout: 30_000 });
  expect(existsSync(createdTask.workspacePath)).toBe(false);

  // The deleted task's rows are gone, so ask for notes through a surviving task:
  // a comment query for a removed task is refused on purpose.
  const checkoutTaskId = await page.evaluate(async () => {
    const tasks = await window.nest!.invoke('tasks.list', {});
    if (!tasks.ok) throw new Error(tasks.error.message);
    return tasks.data.find((candidate) => candidate.kind === 'checkout')?.id ?? '';
  });
  const leftovers = await page.evaluate(async (taskId) => {
    const [tasks, sessions, comments] = await Promise.all([
      window.nest!.invoke('tasks.list', {}),
      window.nest!.invoke('sessions.list', {}),
      window.nest!.invoke('comments.list', { taskId }),
    ]);
    if (!tasks.ok || !sessions.ok || !comments.ok) throw new Error('read failed');
    return {
      tasks: tasks.data.filter((candidate) => candidate.title === 'Audit workflow').length,
      sessions: sessions.data.length,
      comments: comments.data.length,
    };
  }, checkoutTaskId);
  expect(leftovers).toEqual({ tasks: 0, sessions: 0, comments: 0 });

  await app.close();
  app = null;
});
