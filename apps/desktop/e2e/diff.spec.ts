import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * The diff viewer virtualizes rows and highlights syntax. A file rewritten from
 * top to bottom produces a diff of roughly 1600 lines, which is far more than
 * the DOM should ever contain at once.
 */
const appDir = path.resolve(__dirname, '..');
const FILE_LINES = 800;

let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function fileBody(marker: number): string {
  const lines: string[] = [];
  for (let index = 1; index <= FILE_LINES; index += 1) {
    const name = `item${String(index).padStart(4, '0')}`;
    lines.push(`export const ${name} = ${marker};`);
  }
  return `${lines.join('\n')}\n`;
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-diff-'));
  repoPath = path.join(tempRoot, 'diff-repo');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'big.ts'), fileBody(1), 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );
  writeFileSync(path.join(repoPath, 'big.ts'), fileBody(2), 'utf8');
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
  await page.waitForSelector('.app', { timeout: 60_000 });

  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);

  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.locator('.diff-file-head .diff-path')).toHaveText('big.ts');

  // 1600 diff lines must not become 1600 DOM rows.
  await expect(page.locator('.diff-line').first()).toBeVisible({ timeout: 30_000 });
  const rowHeight = await page
    .locator('.diff-rows')
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThan(10_000);
  expect(await page.locator('.diff-line').count()).toBeLessThan(250);

  // Comments still attach to a virtualized line.
  const firstLine = page.locator('.diff-line').first();
  await firstLine.hover();
  await firstLine.locator('.diff-comment-btn').click();
  await expect(page.locator('.comment-composer textarea')).toBeVisible();
  await page.locator('.comment-composer textarea').fill('virtualized comment');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.locator('.comment-thread')).toContainText('virtualized comment');

  // Syntax highlighting arrives asynchronously; plain text must already be there.
  await expect(page.locator('.diff-text span[style*="color"]').first()).toBeVisible({
    timeout: 30_000,
  });
  const tokens = await page.locator('.diff-text span[style*="color"]').count();
  expect(tokens).toBeGreaterThan(10);

  // Scrolling to the end mounts the last lines and shows the sticky file header.
  await page.locator('.diff-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const lastLine = page.locator('.diff-text', { hasText: 'item0800 = 2' });
  await expect(lastLine).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.diff-file-head-sticky')).toContainText('big.ts');
});
