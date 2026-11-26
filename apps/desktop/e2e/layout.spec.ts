import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { addProject, openRightPanel, startHarness } from './helpers';

/**
 * The Windows smoke from `docs/right-panel-plan.md` §4, asserted instead of
 * eyeballed: a 1100x700 window and a wide one, at 100 % and 150 % scaling, with
 * the panel as a column and as a drawer next to a live terminal.
 */

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
    .replace(/\r\n/g, '\n')
    .trim();
}

function commit(cwd: string, message: string): void {
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', message], cwd);
}

function seed(root: string, name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Nest'], repo);
  git(['config', 'user.email', 'nest@example.com'], repo);
  for (const file of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
    writeFileSync(path.join(repo, file), 'one\ntwo\nthree\n', 'utf8');
  }
  mkdirSync(path.join(repo, 'packages', 'core', 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'packages/core/src/a-very-long-file-name.ts'), 'a\nb\n', 'utf8');
  git(['add', '.'], repo);
  commit(repo, 'init');
  // A mix of states: a partially staged file, a rename, a deep long path and an
  // untracked file with a space in its name.
  writeFileSync(path.join(repo, 'alpha.ts'), 'one\nTWO\nthree\n', 'utf8');
  git(['add', 'alpha.ts'], repo);
  writeFileSync(path.join(repo, 'alpha.ts'), 'one\nTWO3\nthree\n', 'utf8');
  git(['mv', 'beta.ts', 'beta-renamed.ts'], repo);
  writeFileSync(path.join(repo, 'packages/core/src/a-very-long-file-name.ts'), 'a\nBBBB\n', 'utf8');
  writeFileSync(path.join(repo, 'notes with a space.md'), 'untracked\n', 'utf8');
  return repo;
}

async function openOnce(options: {
  scale?: number;
  width: number;
  height: number;
}): Promise<{ app: ElectronApplication; page: Page; root: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nest-smoke-'));
  const repo = seed(root, 'smoke');
  const args = ['.'];
  if (options.scale) args.push(`--force-device-scale-factor=${options.scale}`);
  const app = await electron.launch({
    args,
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined as unknown as string,
      NEST_USER_DATA: path.join(root, 'user-data'),
      NEST_DB_PATH: path.join(root, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(root, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(root, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      NEST_DISABLE_NOTIFICATIONS: '1',
      NEST_DISABLE_UPDATES: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await addProject(page, repo);
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window) window.setSize(size.width, size.height);
    },
    { width: options.width, height: options.height },
  );
  // A narrow window already shows the rail; a wide one shows the panel.
  await expect(
    page.locator('.right-rail, [data-testid="source-control-panel"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  return { app, page, root };
}

async function shellOverflow(page: Page): Promise<{ horizontal: number; clipped: string[] }> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clipped = Array.from(
      document.querySelectorAll(
        '.right button, .right [role="tab"], .commit-box button, .source-control-head button',
      ),
    )
      .filter((element) => {
        const node = element as HTMLElement;
        return node.offsetParent !== null && node.scrollWidth > node.clientWidth + 1;
      })
      .map((element) => (element.textContent ?? '').trim());
    return { horizontal: root.scrollWidth - root.clientWidth, clipped };
  });
}

async function terminalAlive(page: Page): Promise<void> {
  const rows = page.locator('.terminal-view.active .xterm-rows');
  await page.locator('.terminal-view.active .xterm-helper-textarea').focus();
  await page.keyboard.type('echo still-here');
  await page.keyboard.press('Enter');
  await expect(rows).toContainText('still-here', { timeout: 30_000 });
}

test('keeps the shell readable at 1100x700 and in a wide window with the panel open', async () => {
  const { app, page, root } = await openOnce({ width: 1100, height: 700 });
  try {
    // A narrow window starts with the rail: the panel opens on request.
    await expect(page.locator('.right-rail')).toBeVisible({ timeout: 30_000 });
    await page.locator('.rail-toggle').click();
    await expect(page.locator('.right-drawer')).toBeVisible();
    await expect(page.locator('[data-testid="changes-staged"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-unstaged"]')).toBeVisible();
    await expect(page.locator('[data-testid="changes-untracked"]')).toBeVisible();

    const narrow = await shellOverflow(page);
    expect(narrow.horizontal).toBeLessThanOrEqual(1);
    expect(narrow.clipped).toEqual([]);

    // Long paths stay readable through the row tooltip and the accessible name.
    const longRow = page.locator(
      '[data-testid="change-row"][data-path$="a-very-long-file-name.ts"]',
    );
    await expect(longRow).toHaveCount(1);
    await expect(longRow).toHaveAttribute('title', /a-very-long-file-name\.ts/);
    await expect(longRow.locator('.change-open')).toHaveAccessibleName(/a-very-long-file-name\.ts/);

    // The list scrolls on its own: the head and the commit block stay put.
    const scroll = page.locator('.change-list-scroll');
    const before = await page.locator('[data-testid="commit-box"]').boundingBox();
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const after = await page.locator('[data-testid="commit-box"]').boundingBox();
    expect(after?.y).toBeCloseTo(before?.y ?? 0, 0);
    await expect(page.locator('[data-testid="source-control-head"]')).toBeVisible();
    await expect(page.locator('[data-testid="commit-box"]')).toBeInViewport();

    // Keyboard: arrow moves inside the list, Enter opens the patch, Escape returns.
    const first = page.locator('[data-testid="change-row"] .change-open').first();
    await first.focus();
    await page.keyboard.press('ArrowDown');
    const second = page.locator('[data-testid="change-row"] .change-open').nth(1);
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.diff-target-bar')).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="change-count"]')).toBeVisible();

    // Back to the list keeps the selection; the drawer closes from its own
    // affordances (Escape in the list is the explicit "clear selection" key).
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="change-count"]')).toBeVisible();
    await page.locator('[data-testid="right-drawer-backdrop"]').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.right-drawer')).toHaveCount(0);
    await expect(page.locator('.right-rail')).toBeVisible();
    await expect(page.locator('.rail-toggle')).toBeFocused();

    // The terminal keeps its input through every open and close of the panel.
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
      timeout: 30_000,
    });
    await terminalAlive(page);
    const scrollback = await page
      .locator('.terminal-view.active .xterm-rows')
      .evaluate((element) => element.textContent ?? '');
    await page.locator('.rail-toggle').click();
    await expect(page.locator('.right-drawer')).toBeVisible();
    // The drawer sits over the terminal, so input resumes once it is closed.
    await page.locator('[data-testid="right-drawer-backdrop"]').click({ position: { x: 4, y: 4 } });
    await expect(page.locator('.right-drawer')).toHaveCount(0);
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
      scrollback.slice(-40),
    );
    await terminalAlive(page);

    // The wide window keeps the panel as a column: nothing clipped, no h-scroll.
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window) window.setSize(1440, 900);
    });
    await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await shellOverflow(page)).horizontal, { timeout: 10_000 })
      .toBeLessThanOrEqual(1);
    const wide = await shellOverflow(page);
    expect(wide.clipped).toEqual([]);
    await expect(page.locator('[data-testid="commit-box"]')).toBeInViewport();

    // A column can be resized from the keyboard on its own handle: the handle
    // sits on the panel's left edge, so ArrowRight narrows it.
    const resizer = page.locator('.right-resizer');
    await resizer.focus();
    const widthBefore = (await page.locator('.right').boundingBox())?.width ?? 0;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const widthAfter = (await page.locator('.right').boundingBox())?.width ?? 0;
    expect(widthAfter).toBeLessThan(widthBefore);
    await page.keyboard.press('Home');
    const widthMin = (await page.locator('.right').boundingBox())?.width ?? 0;
    expect(widthMin).toBeGreaterThan(0);
    expect(widthMin).toBeLessThanOrEqual(widthAfter);
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
});

test('survives 150 % scaling without clipped actions or a horizontal scroll', async () => {
  // At 150 % the same window keeps roughly two thirds of the CSS pixels, which
  // is the drawer path for a fractional-scaling user on a small laptop. The
  // drawer is opened on purpose: that is the layout being checked.
  const { app, page, root } = await openOnce({ width: 1100, height: 700, scale: 1.5 });
  try {
    await openRightPanel(page);
    const scaled = await shellOverflow(page);
    expect(scaled.horizontal).toBeLessThanOrEqual(1);
    expect(scaled.clipped).toEqual([]);
    await expect(page.locator('[data-testid="commit-box"]')).toBeInViewport();
    await expect(page.locator('.sync-action')).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
});
