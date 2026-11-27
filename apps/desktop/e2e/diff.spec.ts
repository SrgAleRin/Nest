import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { centerTab, pinWideWindow, runPaletteCommand } from './helpers';

/**
 * The diff viewer virtualizes rows, highlights syntax, supports multi-line
 * comments and re-anchors them when the file changes underneath. `big.ts` is
 * rewritten top to bottom (1600 diff lines); `a-small.ts` holds the comment and
 * is edited while the app is running, so the watcher has to refresh it.
 */
const appDir = path.resolve(__dirname, '..');
const FILE_LINES = 800;

let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function bigBody(marker: number): string {
  const lines: string[] = [];
  for (let index = 1; index <= FILE_LINES; index += 1) {
    const name = `item${String(index).padStart(4, '0')}`;
    lines.push(`export const ${name} = ${marker};`);
  }
  return `${lines.join('\n')}\n`;
}

function writeSmall(lines: string[]): void {
  writeFileSync(path.join(repoPath, 'a-small.ts'), `${lines.join('\n')}\n`, 'utf8');
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-diff-'));
  repoPath = path.join(tempRoot, 'diff-repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'big.ts'), bigBody(1), 'utf8');
  writeSmall(['one', 'two', 'three', 'four']);
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
  writeFileSync(path.join(repoPath, 'big.ts'), bigBody(2), 'utf8');
  writeSmall(['one', 'TWO', 'three', 'four']);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('virtualizes a large diff, keeps comments working and highlights syntax', async () => {
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

  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });

  // `Show diff` opens the whole working tree as a tab of the center, with no
  // single target; the right panel keeps its own section on screen.
  await runPaletteCommand(page, 'show diff');
  await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="center-diff-layer"]')).toBeVisible();
  await expect(page.locator('.right-subhead-title')).toHaveCount(0);
  await expect(page.locator('.diff-target-bar')).toHaveCount(0);
  await expect(page.locator('.diff-file-head .diff-path').first()).toHaveText('a-small.ts');
  await expect(page.locator('.diff-file-head .diff-path', { hasText: 'big.ts' })).toHaveCount(1);

  // 1600 diff lines must not become 1600 DOM rows.
  await expect(page.locator('.diff-line').first()).toBeVisible({ timeout: 30_000 });
  const listHeight = await page
    .locator('.diff-rows')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(listHeight).toBeGreaterThan(10_000);
  expect(await page.locator('.diff-line').count()).toBeLessThan(250);

  // A range comment: + on the added line, then Shift+click + on the next one.
  const addedLine = page.locator('.diff-line.diff-add').first();
  await addedLine.hover();
  await addedLine.locator('.diff-comment-btn').click();
  const contextLine = page.locator('.diff-line').filter({ hasText: 'three' }).first();
  await contextLine.hover();
  await contextLine.locator('.diff-comment-btn').click({ modifiers: ['Shift'] });
  await expect(page.locator('.comment-composer-head')).toContainText('a-small.ts:2-3');

  await page.locator('.comment-composer textarea').fill('range note');
  // The composer unmounts itself once the note is stored. Playwright would read
  // that detach as a failed click and retry against a button that no longer
  // exists, so the click is dispatched without the actionability retry loop and
  // the assertion below proves it landed.
  const addComment = page.getByRole('button', { name: 'Add comment' });
  await expect(addComment).toBeEnabled();
  await addComment.dispatchEvent('click');
  await expect(page.locator('.comment-anchor')).toHaveText('a-small.ts:2-3');
  await expect(page.locator('.comment-thread')).toContainText('range note');

  // Syntax highlighting arrives asynchronously.
  await expect(page.locator('.diff-text span[style*="color"]').first()).toBeVisible({
    timeout: 30_000,
  });
  expect(await page.locator('.diff-text span[style*="color"]').count()).toBeGreaterThan(10);

  // Inserting a line moves the anchored block: the comment follows it.
  writeSmall(['zero', 'one', 'TWO', 'three', 'four']);
  await expect(page.locator('.comment-anchor')).toHaveText('a-small.ts:3-4', {
    timeout: 20_000,
  });

  // Replacing the anchored text makes the comment stale, shown at the file top.
  writeSmall(['zero', 'one', 'CHANGED', 'three', 'four']);
  await expect(page.locator('.comment-stale')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.comment-thread')).toContainText('range note');

  // The change list opens the same viewer narrowed to one side of one file.
  await page.locator('#right-tab-source-control').click();
  const smallRow = page.locator(
    '[data-testid="change-row"][data-path="a-small.ts"][data-side="unstaged"]',
  );
  await smallRow.locator('.change-open').click();
  await expect(page.locator('.diff-target-label')).toHaveText('a-small.ts · unstaged side');
  await expect(page.locator('.diff-file-head .diff-path')).toHaveCount(1);
  await expect(page.locator('.diff-file-head .diff-path')).toHaveText('a-small.ts');
  await expect(page.locator('.diff-file-head .diff-path', { hasText: 'big.ts' })).toHaveCount(0);

  // Escape on the list drops the selection, so the viewer goes back to the
  // whole working tree without leaving the `Diff` tab: one viewer, two ways in.
  await smallRow.locator('.change-open').focus();
  await page.keyboard.press('Escape');
  await expect(smallRow).not.toHaveAttribute('data-selected', 'true');
  await expect(page.locator('.diff-target-bar')).toHaveCount(0);
  await expect(page.locator('.diff-file-head .diff-path')).toHaveCount(2);
  await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');

  // Scrolling to the end mounts the last lines and shows the sticky file header.
  await page.locator('.diff-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.diff-text', { hasText: 'item0800 = 2' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.diff-file-head-sticky')).toContainText('big.ts');
});
