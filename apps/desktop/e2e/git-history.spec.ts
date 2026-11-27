import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import { centerTab, git, openPanelMenu, pinWideWindow } from './helpers';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/**
 * History against a real repository: the `Graph` tab of the center workbench
 * shows both branches and the merge between them with their ref badges, a
 * commit opens in its split pane, and another branch can be read in the `Files`
 * panel without checking it out. The workspace stays clean throughout: every
 * step is a read, so `git status` is empty before and after.
 */
const appDir = path.resolve(__dirname, '..');

let tempRoot = '';
let repoPath = '';
let app: ElectronApplication | null = null;

function commit(cwd: string, message: string): void {
  git(['add', '-A'], cwd);
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', message], cwd);
}

test.beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-git-e2e-'));
  repoPath = path.join(tempRoot, 'history-repo');
  mkdirSync(path.join(repoPath, 'src', 'lib'), { recursive: true });

  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# history\n', 'utf8');
  commit(repoPath, 'init commit');

  writeFileSync(path.join(repoPath, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
  writeFileSync(path.join(repoPath, 'src', 'lib', 'util.ts'), 'export const util = 1;\n', 'utf8');
  commit(repoPath, 'feat: add app');
  git(['tag', 'v1.0.0'], repoPath);

  // `feature` leaves main here and comes back through a merge, so the graph
  // draws both branches and the merge commit that joined them.
  git(['switch', '-c', 'feature'], repoPath);
  writeFileSync(path.join(repoPath, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
  commit(repoPath, 'feature: add file');

  git(['switch', 'main'], repoPath);
  writeFileSync(path.join(repoPath, 'README.md'), '# history\n\nmain notes\n', 'utf8');
  commit(repoPath, 'main: readme');
  git(['merge', '--no-ff', 'feature', '-m', 'merge: feature into main'], repoPath);
  git(['tag', 'v1.1.0'], repoPath);

  // A commit only the feature branch carries: main has nothing of it, and the
  // file it adds is not in the checkout, so reading it proves the read comes
  // from git objects and not from the working tree.
  git(['switch', 'feature'], repoPath);
  writeFileSync(path.join(repoPath, 'src', 'follow-up.ts'), 'export const followUp = 1;\n', 'utf8');
  commit(repoPath, 'feature: follow-up');
  git(['switch', 'main'], repoPath);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('reads the graph, a commit and another branch without leaving main', async () => {
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
      NEST_FAKE_SESSION_DIR: path.join(tempRoot, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
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

  // The fixture is clean: nothing below is expected to write to the workspace.
  expect(git(['status', '--porcelain'], repoPath)).toBe('');
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).toBe('main');

  // `History` in the panel menu opens the graph in the center, on HEAD, and the
  // right panel keeps its own section instead of being replaced by the graph.
  const panelMenu = await openPanelMenu(page);
  await panelMenu.getByRole('menuitem', { name: 'History' }).click();
  await expect(centerTab(page, 'graph')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="center-graph-layer"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-testid="graph-scope-head"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible();
  await expect(page.locator('.right-subhead-title')).toHaveCount(0);

  // `All branches` shows both branches and the merge: the merge commit carries
  // main and the release tag, the feature tip carries its own badge.
  await page.locator('[data-testid="graph-scope-all"]').click();
  const mergeHash = git(['rev-parse', 'main'], repoPath);
  const featureHash = git(['rev-parse', 'feature'], repoPath);
  const mergeRow = page.locator(`.graph-commit[data-hash="${mergeHash}"]`);
  await expect(mergeRow).toBeVisible({ timeout: 20_000 });
  await expect(mergeRow.locator('.graph-badge', { hasText: 'main' })).toHaveCount(1);
  await expect(mergeRow.locator('.graph-badge', { hasText: 'v1.1.0' })).toHaveCount(1);
  const featureRow = page.locator(`.graph-commit[data-hash="${featureHash}"]`);
  await expect(featureRow.locator('.graph-badge', { hasText: 'feature' })).toHaveCount(1);
  await expect(page.locator('.graph-commit', { hasText: 'main: readme' })).toHaveCount(1);
  await expect(page.locator('.graph-commit', { hasText: 'feature: add file' })).toHaveCount(1);
  await expect(
    page.locator('.graph-commit', { hasText: 'feat: add app' }).locator('.graph-badge', {
      hasText: 'v1.0.0',
    }),
  ).toHaveCount(1);

  // A commit opens in the graph's split pane with its files and its patch.
  // The subject is clicked rather than the row's centre: the ref badges in the
  // row are buttons of their own and must not be hit by accident.
  await page
    .locator('.graph-commit', { hasText: 'feat: add app' })
    .locator('.graph-subject')
    .click();
  const detail = page.locator('[data-testid="graph-commit-detail"]');
  await expect(detail.locator('.commit-detail-subject')).toHaveText('feat: add app');
  await expect(detail.locator('.commit-detail .git-file')).toHaveCount(2);
  await detail.locator('.commit-detail .git-file', { hasText: 'app.ts' }).click();
  await expect(detail.locator('.commit-patch')).toBeVisible();
  await expect(detail.locator('.commit-patch')).toContainText('export const app = 1;');

  // The ref picker narrows the graph to one branch: main's own commit and the
  // merge disappear, the feature tip stays.
  await page.locator('.graph-ref-input').fill('feature');
  await page.locator('.graph-ref-option', { hasText: 'feature' }).click();
  await expect(page.locator('[data-testid="branch-inspector"]')).toContainText('feature');
  await expect(page.locator('.graph-commit', { hasText: 'feature: follow-up' })).toHaveCount(1);
  await expect(page.locator('.graph-commit', { hasText: 'main: readme' })).toHaveCount(0);

  // `Browse files` opens the same branch in the `Files` panel, read-only. The
  // file only exists on the feature tip, so a working-tree read could not find
  // it: the panel reads the git objects of the ref.
  await page.locator('[data-testid="branch-browse"]').click();
  await expect(page.locator('#right-tab-files')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="files-readonly"]')).toContainText(
    'Viewing feature (read-only)',
  );
  await page.locator('.files-row', { hasText: 'follow-up.ts' }).click();
  await expect(page.locator('.files-preview-path')).toHaveText('src/follow-up.ts');
  await expect(page.locator('.files-preview')).toContainText('export const followUp = 1;');

  // Nothing was checked out and nothing was written: main is still the branch,
  // the workspace is still clean and the file is still absent from the disk.
  expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)).toBe('main');
  expect(git(['status', '--porcelain'], repoPath)).toBe('');
  expect(existsSync(path.join(repoPath, 'src', 'follow-up.ts'))).toBe(false);

  // Compare keeps its own sub-view in the right panel; against main, the feature
  // branch is one commit ahead.
  await page.locator('#right-tab-source-control').click();
  const menu = await openPanelMenu(page);
  await menu.getByRole('menuitem', { name: 'Compare branches' }).click();
  await expect(page.locator('.right-subhead-title')).toHaveText('Compare');
  const pickers = page.locator('.compare-picker select');
  await expect(pickers).toHaveCount(2);
  // The panel seeds itself with base = the default branch and head = HEAD, so
  // the first comparison is the branch against itself. Waiting for it keeps the
  // spec off the panel's request ordering: a late first answer must not be read
  // as the answer to the next pick.
  await expect(page.locator('.compare-summary')).toContainText('↑ 0');
  await expect(page.locator('.compare-commits')).toContainText('No commits ahead of main');
  await pickers.nth(1).selectOption('feature');
  await expect(page.locator('.compare-summary')).toContainText('↑ 1');
  await expect(page.locator('.compare-commits')).toContainText('feature: follow-up');
  await expect(page.locator('.compare-panel .git-file')).toContainText('follow-up.ts');

  // Known product defect, reported rather than hidden: `← Back to the graph`
  // asks for `openGraph({ commitHash: null })`, and the reducer keeps the old
  // selection on `null`, so the detail pane stays open and the only way out is
  // closing the `Graph` tab. The assertion stays so the fix is noticed.
  await detail.getByRole('button', { name: '← Back to the graph' }).click();
  await expect(
    detail,
    'Back from a commit must close the detail; the reducer keeps selectedCommitHash',
  ).toHaveCount(0);

  // Truncated before closing so a failure leaves the worktree in place for
  // inspection; the temp directory is removed in afterAll.
  await app.close();
  app = null;
});
