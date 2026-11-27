import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { annotateEnvironment, pinWideWindow, startHarness, waitForRemoteOutcome } from './helpers';

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
  // The spec commits through the app, so the fixture carries its own identity:
  // a CI runner has no global `user.name`/`user.email` and git would refuse.
  git(['config', 'user.name', 'Nest'], repoPath);
  git(['config', 'user.email', 'nest@example.com'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n', 'utf8');
  writeFileSync(path.join(repoPath, 'notes.md'), 'one\ntwo\n', 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
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
  await pinWideWindow(app);
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
  await dialog.getByLabel('Title').fill('Audit workflow');
  await dialog.getByLabel('Base branch').fill('origin/main');
  // The dialog shows the concrete branch, path and effective base before
  // anything is created.
  await expect(dialog.locator('[data-testid="preview-branch"]')).toHaveText('nest/audit-workflow');
  await expect(dialog.locator('[data-testid="preview-path"]')).toContainText('audit-workflow');
  await expect(dialog.locator('[data-testid="preview-base"]')).toContainText('origin/main');
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(page.locator('.sidebar')).toContainText('Audit workflow', { timeout: 60_000 });

  type TaskRow = { id: string; title: string; branch: string; workspacePath: string };
  // The sidebar shows the pending operation before the row exists, so poll the
  // database instead of assuming creation already finished.
  const findTask = (title: string) =>
    page.evaluate(async (wanted) => {
      const tasks = await window.nest!.invoke('tasks.list', {});
      if (!tasks.ok) throw new Error(tasks.error.message);
      return tasks.data.find((candidate) => candidate.title === wanted) ?? null;
    }, title);
  await expect.poll(() => findTask('Audit workflow'), { timeout: 60_000 }).not.toBeNull();
  const createdTask = (await findTask('Audit workflow')) as unknown as TaskRow;
  expect(createdTask.branch.startsWith('nest/')).toBe(true);
  expect(existsSync(createdTask.workspacePath)).toBe(true);

  // The new branch must not track the base: that is what broke the first push.
  expect(
    gitOrNull(['rev-parse', '--abbrev-ref', `${createdTask.branch}@{upstream}`], repoPath),
  ).toBeNull();

  // --- Create & start: the harness chosen in the dialog starts by itself ----
  await page.getByRole('button', { name: 'New task' }).first().click();
  const startDialog = page.locator('.modal');
  await expect(startDialog).toBeVisible();
  await startDialog.getByLabel('Title').fill('Started on create');
  await startDialog.getByLabel('Agent').selectOption('fake');
  await startDialog.getByRole('button', { name: 'Create & start' }).click();
  await expect(page.locator('.modal')).toHaveCount(0, { timeout: 60_000 });
  // No picker: the session of the new task is already running.
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
    timeout: 60_000,
  });

  // Back to the first task for the rest of the pass.
  await page.locator('.task-row', { hasText: 'Audit workflow' }).locator('.task-select').click();

  // --- run the fake harness in the task ------------------------------------
  await startHarness(page, 'fake');
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
    timeout: 30_000,
  });

  // --- make a change and review both sides ---------------------------------
  writeFileSync(path.join(createdTask.workspacePath, 'notes.md'), 'one\nTWO\nthree\n', 'utf8');
  writeFileSync(path.join(createdTask.workspacePath, 'added.md'), '# added\n', 'utf8');

  // The change list is the entry point: one click on a row opens its patch.
  const notesRow = page.locator(
    '[data-testid="change-row"][data-path="notes.md"][data-side="unstaged"]',
  );
  await expect(notesRow).toBeVisible({ timeout: 30_000 });
  await notesRow.locator('.change-open').click();
  await expect(page.locator('.diff-target-bar')).toHaveText('notes.md · unstaged side');
  await expect(page.locator('.diff-file-head .diff-path')).toHaveText('notes.md');

  // Stage the untracked file from the list, without leaving the panel.
  await page.locator('#right-tab-source-control').click();
  const addedRow = page.locator('[data-testid="change-row"][data-path="added.md"]');
  await addedRow.getByRole('button', { name: 'Stage', exact: true }).click();
  await expect(
    page.locator('[data-testid="changes-staged"] [data-testid="change-row"][data-path="added.md"]'),
  ).toBeVisible({ timeout: 30_000 });
  // A normal commit records the index only, so the scope says what it covers.
  await expect(page.locator('[data-testid="commit-scope"]')).toHaveText('1 staged');

  // --- save a note and send it to the harness ------------------------------
  await notesRow.locator('.change-open').click();
  await expect(page.locator('.diff-target-bar')).toHaveText('notes.md · unstaged side');
  await expect(page.locator('.diff-file-head .diff-path')).toHaveText('notes.md', {
    timeout: 30_000,
  });
  const changedLine = page.locator('.diff-line.diff-add, .diff-line.diff-del').first();
  await changedLine.hover();
  await changedLine.locator('.diff-comment-btn').click();
  await page.locator('.comment-composer textarea').fill('please fix this line');
  // The composer unmounts itself once the note is stored. Playwright would read
  // that detach as a failed click and retry against a button that no longer
  // exists, so the click is dispatched without the actionability retry loop and
  // the assertion below proves it landed.
  const addComment = page.getByRole('button', { name: 'Add comment' });
  await expect(addComment).toBeEnabled();
  await addComment.dispatchEvent('click');
  await expect(page.locator('.comment-thread')).toContainText('please fix this line');

  const sendButton = page.locator('.comment-thread button[title^="Send to"]').first();
  await expect(sendButton).toBeVisible();
  await sendButton.click();
  await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
    'please fix this line',
    { timeout: 30_000 },
  );

  // --- commit and publish to the local bare remote ------------------------
  await page.locator('#right-tab-source-control').click();
  await page.locator('.commit-message').fill('audit workflow change');
  await page.locator('.commit-submit').click();
  await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });
  // Only the staged file was committed; the unstaged edit is still there.
  expect(git(['show', '--name-status', '--format=', 'HEAD'], createdTask.workspacePath)).toBe(
    'A\tadded.md',
  );
  await expect(notesRow).toBeVisible();

  // The branch has no upstream yet, so the one remote action is `Publish branch`.
  await expect(page.locator('.sync-action')).toHaveText('Publish branch', { timeout: 30_000 });
  await page.locator('.sync-action').click();
  // Push reports git's own output ("branch ... set up to track ... * [new branch]").
  if ((await waitForRemoteOutcome(page)) === 'blocked') {
    annotateEnvironment(
      'this Windows session refuses the shell helper git needs for a local remote',
    );
  } else {
    await expect(page.locator('.toast').first()).toContainText(`nest/audit-workflow`);
    expect(
      git(['for-each-ref', '--format=%(refname)', 'refs/heads'], originPath).split('\n'),
    ).toContain(`refs/heads/${createdTask.branch}`);
    expect(git(['rev-parse', 'main'], originPath)).toBe(git(['rev-parse', 'main'], repoPath));
  }

  // --- restart: the note and the task survive -----------------------------
  await app.close();
  app = await launchApp();
  page = await app.firstWindow();
  await pinWideWindow(app);
  await page.waitForSelector('.app', { timeout: 60_000 });

  const notesAfterRestart = await page.evaluate(async (taskId) => {
    const comments = await window.nest!.invoke('comments.list', { taskId });
    if (!comments.ok) throw new Error(comments.error.message);
    return comments.data.map((comment) => comment.body);
  }, createdTask.id);
  expect(notesAfterRestart).toContain('please fix this line');

  await expect(page.locator('.sidebar')).toContainText('Audit workflow', { timeout: 30_000 });

  // --- delete the tasks through the UI ------------------------------------
  // The `Create & start` task goes first so the leftover check below sees no
  // sessions at all; deleting it also stops the session it started.
  page.once('dialog', (confirm) => void confirm.accept());
  await page.locator('.task-row', { hasText: 'Started on create' }).locator('.task-remove').click();
  await expect(page.locator('.sidebar')).not.toContainText('Started on create', {
    timeout: 30_000,
  });

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
