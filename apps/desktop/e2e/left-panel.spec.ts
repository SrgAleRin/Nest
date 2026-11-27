import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { addProject, electronArgs, pinWideWindow, startHarness } from './helpers';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
    .replace(/\r\n/g, '\n')
    .trim();
}

function seedRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Nest'], repo);
  git(['config', 'user.email', 'nest@example.com'], repo);
  writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

async function launchOnce(): Promise<{
  app: ElectronApplication;
  page: Page;
  root: string;
  repo: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nest-left-panel-'));
  const repo = seedRepo(root, 'alpha-repo');
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({
    args: electronArgs(),
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...env,
      NEST_USER_DATA: path.join(root, 'user-data'),
      NEST_DB_PATH: path.join(root, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(root, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(root, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      NEST_DISABLE_NOTIFICATIONS: '1',
      NEST_DISABLE_UPDATES: '1',
      NEST_ENABLE_FAKE_HARNESS: '1',
    },
  });
  await pinWideWindow(app);
  const page = await app.firstWindow();
  await addProject(page, repo);
  return { app, page, root, repo };
}

async function createWorktreeTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New task', exact: true }).first().click();
  const dialog = page.locator('.modal');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create task' }).click();
  await expect(
    page.locator('[data-testid="workspace-card"]', { hasText: title }),
  ).toBeVisible({ timeout: 60_000 });
}

test('covers cards, rename, pin, grouping, filters, archive/restore, delete dialog, resize, shortcuts and drawer', async () => {
  const { app, page, root, repo } = await launchOnce();
  try {
    // 1. Create a task that pauses in setup so we can cancel from PendingTaskRow.
    const projectId = await page.evaluate(async () => {
      const res = await window.nest!.invoke('projects.list', {});
      if (!res.ok || !res.data[0]) throw new Error('missing project');
      return res.data[0].id;
    });
    const slowScript =
      process.platform === 'win32'
        ? 'ping -n 6 127.0.0.1 >nul'
        : 'sleep 5';
    await page.evaluate(
      async ({ id, setupScript }) => {
        const res = await window.nest!.invoke('projects.update', { projectId: id, setupScript });
        if (!res.ok) throw new Error(res.error.message);
      },
      { id: projectId, setupScript: slowScript },
    );

    await page.getByRole('button', { name: 'New task', exact: true }).first().click();
    const pendingDialog = page.locator('.modal');
    await expect(pendingDialog).toBeVisible();
    await pendingDialog.getByLabel('Title').fill('Abortable task');
    await pendingDialog.getByRole('button', { name: 'Create task' }).click();
    const pendingRow = page.locator('[data-testid="pending-task"]', { hasText: 'Abortable task' });
    await expect(pendingRow).toBeVisible({ timeout: 15_000 });
    await pendingDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(pendingDialog).toHaveCount(0);
    await pendingRow.getByRole('button', { name: 'Cancel creation' }).click();
    await expect(pendingRow).toHaveCount(0, { timeout: 15_000 });
    await expect(
      page.locator('[data-testid="workspace-card"]', { hasText: 'Abortable task' }),
    ).toHaveCount(0);

    // Clear setupScript before normal task creation.
    await page.evaluate(async (id) => {
      await window.nest!.invoke('projects.update', { projectId: id, setupScript: null });
    }, projectId);

    // 2. Create two real worktree tasks.
    await createWorktreeTask(page, 'Feature auth');
    await createWorktreeTask(page, 'Cleanup logs');

    const authCard = page.locator('[data-testid="workspace-card"]', { hasText: 'Feature auth' });
    const cleanupCard = page.locator('[data-testid="workspace-card"]', { hasText: 'Cleanup logs' });
    const mainCard = page.locator('[data-testid="workspace-card"][data-task-kind="checkout"]');

    // 3. Inline rename via F2: Escape cancels, Enter commits while terminal keeps running.
    await authCard.click();
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
      timeout: 30_000,
    });
    await expect(authCard.locator('.ws-agents-label')).toContainText('fake', { timeout: 15_000 });

    await authCard.focus();
    await page.keyboard.press('F2');
    const renameInput = page.locator('[data-testid="workspace-card"] .ws-rename-input');
    await expect(renameInput).toBeVisible();
    await renameInput.fill('Should revert');
    await page.keyboard.press('Escape');
    await expect(authCard).toContainText('Feature auth');

    await authCard.focus();
    await page.keyboard.press('F2');
    await expect(renameInput).toBeVisible();
    await renameInput.fill('Auth v2');
    await page.keyboard.press('Enter');
    const renamedCard = page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' });
    await expect(renamedCard).toBeVisible();

    // Terminal stays alive in the renamed task without remounting.
    await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
    await page.keyboard.type('echo still-working-after-rename');
    await page.keyboard.press('Enter');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
      'still-working-after-rename',
      { timeout: 30_000 },
    );

    // 4. Background exit -> unread badge on card and collapsed group header; click unread clears it.
    const authTaskId = await renamedCard.getAttribute('data-task-id');
    const authSessionId = await page.evaluate(async (taskId) => {
      const res = await window.nest!.invoke('sessions.list', { taskId: taskId! });
      if (!res.ok || !res.data[0]) throw new Error('missing session');
      return res.data[0].id;
    }, authTaskId);
    await cleanupCard.click();
    await page.evaluate(async (sessionId) => {
      await window.nest!.invoke('sessions.stop', { sessionId });
    }, authSessionId);

    await expect(renamedCard.locator('.unread-badge')).toHaveText('1', { timeout: 20_000 });
    await expect(renamedCard.locator('.ws-status-unread')).toBeVisible();

    // Collapse project header and check aggregated unread badge.
    const projectHeader = page.locator('.ws-group-header', { hasText: 'alpha-repo' });
    await projectHeader.click();
    await expect(projectHeader.locator('.unread-badge')).toHaveText('1');
    await projectHeader.click();

    // Toggle unread on card without switching away from Cleanup logs.
    await renamedCard.locator('.ws-status-unread').click();
    await expect(cleanupCard).toHaveAttribute('aria-selected', 'true');

    // 5. Pin moves card to Pinned section without duplicates.
    await renamedCard.click({ button: 'right' });
    await page.getByRole('menuitemcheckbox', { name: 'Pin' }).click();
    await expect(page.locator('.ws-group-header', { hasText: 'Pinned' })).toBeVisible();
    await expect(
      page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' }),
    ).toHaveCount(1);

    // Unpin so we can test Status grouping & filters cleanly.
    await page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' }).click({
      button: 'right',
    });
    await page.getByRole('menuitemcheckbox', { name: 'Unpin' }).click();
    await expect(page.locator('.ws-group-header', { hasText: 'Pinned' })).toHaveCount(0);

    // 6. Change workflow status and switch Group by -> Status.
    await renamedCard.click({ button: 'right' });
    const statusMenu = page.getByRole('menuitem', { name: 'Status' });
    await statusMenu.hover();
    await page.getByRole('menuitemcheckbox', { name: 'In review' }).click();

    await page.getByRole('button', { name: 'Workspace options' }).click();
    const optionsPopover = page.locator('.sidebar-options-popover');
    await optionsPopover.getByLabel('Status').check();
    await expect(page.locator('.ws-group-header', { hasText: 'In review' })).toBeVisible();

    // Filter: Hide inactive workspaces hides Cleanup logs while keeping main checkout.
    await optionsPopover.getByLabel('Hide inactive workspaces').check();
    await expect(cleanupCard).toHaveCount(0);
    await expect(mainCard).toHaveCount(1);
    await optionsPopover.getByRole('button', { name: 'Reset filters' }).click();
    await optionsPopover.getByLabel('Project', { exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(cleanupCard).toBeVisible();

    // 7. Archive and Restore with scrollback preserved.
    await renamedCard.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
    await expect(
      page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' }),
    ).toHaveCount(0);
    const archiveBtn = page.locator('.sidebar-foot-btn', { hasText: 'Archived · 1' });
    await expect(archiveBtn).toBeVisible();
    await archiveBtn.click();

    const archiveDrawer = page.locator('.archived-drawer');
    await expect(archiveDrawer).toBeVisible();
    await expect(archiveDrawer).toContainText('Auth v2');
    await archiveDrawer.getByRole('button', { name: 'Restore' }).click();
    await archiveDrawer.getByRole('button', { name: /Back to workspaces/ }).click();
    await expect(
      page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' }),
    ).toBeVisible();
    await page.locator('[data-testid="workspace-card"]', { hasText: 'Auth v2' }).click();
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
      'still-working-after-rename',
      { timeout: 15_000 },
    );

    // 8. Dirty worktree delete dialog shows uncommitted file and removes branch when checked.
    const cleanupInfo = await page.evaluate(async () => {
      const res = await window.nest!.invoke('tasks.list', {});
      if (!res.ok) throw new Error(res.error.message);
      const t = res.data.find((x) => x.title === 'Cleanup logs');
      if (!t) throw new Error('missing Cleanup logs');
      return { workspacePath: t.workspacePath, branch: t.branch };
    });
    writeFileSync(path.join(cleanupInfo.workspacePath, 'dirty-uncommitted.txt'), 'wip\n', 'utf8');

    await cleanupCard.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete worktree…' }).click();
    const deleteModal = page.locator('.delete-task-modal');
    await expect(deleteModal).toBeVisible();
    await expect(deleteModal.locator('.dirty-files-list')).toContainText('dirty-uncommitted.txt', {
      timeout: 15_000,
    });
    await deleteModal.locator('.delete-branch input[type="checkbox"]').check();
    await deleteModal.getByRole('button', { name: 'Force delete worktree' }).click();
    await expect(deleteModal).toHaveCount(0, { timeout: 30_000 });
    await expect(cleanupCard).toHaveCount(0);
    expect(existsSync(cleanupInfo.workspacePath)).toBe(false);
    const branches = git(['branch', '--list', cleanupInfo.branch], repo);
    expect(branches).toBe('');

    // 9. Keyboard resize, collapse rail, Ctrl+B guard in terminal, Ctrl+Shift+B & narrow drawer.
    const resizer = page.locator('.left-resizer');
    const widthBefore = (await page.locator('.sidebar').boundingBox())?.width ?? 0;
    await resizer.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const widthAfter = (await page.locator('.sidebar').boundingBox())?.width ?? 0;
    expect(widthAfter).toBeGreaterThan(widthBefore);

    // Ctrl+B inside terminal must NOT collapse the left sidebar; Ctrl+Shift+B MUST collapse it.
    await mainCard.click();
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
      timeout: 30_000,
    });
    await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
    await page.keyboard.press('Control+b');
    await expect(page.locator('.sidebar-rail')).toHaveCount(0);

    await page.keyboard.press('Control+Shift+b');
    await expect(page.locator('.sidebar-rail')).toBeVisible();
    await page.locator('.left-rail-toggle').click();
    await expect(page.locator('.sidebar-rail')).toHaveCount(0);

    // Narrow window -> rail + left-drawer without horizontal shell overflow.
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w) w.setSize(900, 700);
    });
    await expect(page.locator('.sidebar-rail')).toBeVisible({ timeout: 30_000 });
    await page.locator('.left-rail-toggle').click();
    await expect(page.locator('.left-drawer')).toBeVisible();
    await page.locator('[data-testid="left-drawer-backdrop"]').click({ position: { x: 400, y: 20 } });
    await expect(page.locator('.left-drawer')).toHaveCount(0);

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(1);
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
});
