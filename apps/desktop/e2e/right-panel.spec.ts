import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';
import {
  addProject,
  annotateEnvironment,
  centerTab,
  changeRow,
  commit,
  confirmAction,
  git,
  gitOrNull,
  launchNest,
  openCommitMenu,
  openPanelMenu,
  remoteFailure,
  startHarness,
  syncAction,
  waitForRemoteOutcome,
} from './helpers';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/**
 * The right panel of a temp repository: the change list with its two sides,
 * one click to a patch, the commit block, the remote actions and the notes.
 *
 * Every test builds its own repository and its own app instance, so a scenario
 * never inherits the index, the branch or the draft of the previous one. The
 * workspace is the checkout task of a throwaway repository: the destructive
 * cases (discard, force push, a conflicted merge) never touch a real checkout.
 */

interface Fixture {
  root: string;
  repo: string;
  app: ElectronApplication;
  page: Page;
}

const fixtures: string[] = [];

/** 40 numbered lines: a staged edit and an unstaged edit stay out of each
 * other's context, which is what makes a note land outside the other side. */
function mixedBody(edits: { line03?: string; line35?: string } = {}): string {
  const lines: string[] = [];
  for (let index = 1; index <= 40; index += 1) {
    const suffix = String(index).padStart(2, '0');
    if (index === 3 && edits.line03) lines.push(edits.line03);
    else if (index === 35 && edits.line35) lines.push(edits.line35);
    else lines.push(`line${suffix}`);
  }
  return `${lines.join('\n')}\n`;
}

/** A committed repository with three files the change-list cases edit. */
function seedRepo(root: string, name = 'panel'): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Nest'], repo);
  git(['config', 'user.email', 'nest@example.com'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# panel\n', 'utf8');
  writeFileSync(path.join(repo, 'mixed.txt'), mixedBody(), 'utf8');
  writeFileSync(path.join(repo, 'second.txt'), 'alpha\nbeta\n', 'utf8');
  writeFileSync(path.join(repo, 'conflict.txt'), 'base\n', 'utf8');
  git(['add', '.'], repo);
  commit(repo, 'init');
  return repo;
}

/**
 * `mixed.txt` has an edit in the index and a second edit in the worktree;
 * `second.txt` is only modified and `fresh.txt` is untracked. This is the state
 * the plan calls a partially staged file.
 */
function seedPartialStaging(repo: string): void {
  writeFileSync(path.join(repo, 'mixed.txt'), mixedBody({ line03: 'LINE03' }), 'utf8');
  git(['add', 'mixed.txt'], repo);
  writeFileSync(
    path.join(repo, 'mixed.txt'),
    mixedBody({ line03: 'LINE03', line35: 'LINE35' }),
    'utf8',
  );
  writeFileSync(path.join(repo, 'second.txt'), 'alpha\nBETA\n', 'utf8');
  writeFileSync(path.join(repo, 'fresh.txt'), 'new\n', 'utf8');
}

async function openFixture(
  options: {
    prepare?: (repo: string) => void;
    seed?: (root: string) => string;
  } = {},
): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nest-panel-'));
  fixtures.push(root);
  const repo = options.seed ? options.seed(root) : seedRepo(root);
  options.prepare?.(repo);
  const app = await launchNest({ root });
  const page = await app.firstWindow();
  await page.waitForSelector('.app', { timeout: 60_000 });
  await addProject(page, repo);
  await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible({
    timeout: 30_000,
  });
  return { root, repo, app, page };
}

/** Closes the app of a fixture and removes its repository and user data. */
async function closeFixture(fixture: Fixture | null): Promise<void> {
  await fixture?.app.close().catch(() => {});
  // A closed Electron process can still hold a handle on Windows for a moment;
  // the temp base inside the worktree is thrown away at the end of the run.
  if (fixture) {
    try {
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {
      // Left for the caller's own cleanup; never a reason to fail a scenario.
    }
  }
}

test.afterAll(() => {
  for (const root of fixtures) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
    } catch {
      // A locked directory is removed by the next run's setup or by hand.
    }
  }
});

function section(page: Page, id: 'staged' | 'unstaged' | 'untracked' | 'conflicts'): Locator {
  return page.locator(`[data-testid="changes-${id}"]`);
}

/** The row of the untracked section, whose `data-side` is `unstaged` too. */
function untrackedRow(page: Page, filePath: string): Locator {
  return section(page, 'untracked').locator(`[data-testid="change-row"][data-path="${filePath}"]`);
}

async function openPatch(page: Page, filePath: string, side: 'staged' | 'unstaged'): Promise<void> {
  await changeRow(page, filePath, side).locator('.change-open').click();
  await expect(page.locator('.diff-target-label')).toHaveText(`${filePath} · ${side} side`, {
    timeout: 30_000,
  });
}

function panelWidth(page: Page): Promise<number> {
  return page.locator('.right').evaluate((element) => element.getBoundingClientRect().width);
}

/** The one note of `Source Control` head: the state or why an action is off. */
function headNote(page: Page): Locator {
  return page.locator('.source-control-head .source-control-note');
}

/** Skips a transport scenario this Windows session cannot run at all. */
async function skipIfGitTransportIsBlocked(page: Page): Promise<void> {
  const outcome = await waitForRemoteOutcome(page);
  test.skip(
    outcome === 'blocked',
    'this Windows session refuses the shell helper git needs for a local remote',
  );
}

test('keeps both sides of a partially staged file and commits only the index', async () => {
  const fixture = await openFixture({ prepare: seedPartialStaging });
  const { page, repo } = fixture;
  try {
    // The same path is one row per side, and the badge counts paths, not rows.
    await expect(changeRow(page, 'mixed.txt', 'staged')).toBeVisible({ timeout: 30_000 });
    await expect(changeRow(page, 'mixed.txt', 'unstaged')).toBeVisible();
    await expect(changeRow(page, 'second.txt', 'unstaged')).toBeVisible();
    await expect(untrackedRow(page, 'fresh.txt')).toBeVisible();
    await expect(page.locator('[data-testid="change-count"]')).toHaveText('All changes · 3');
    await expect(page.locator('[data-testid="right-tab-count-source-control"]')).toHaveText('3');
    await expect(section(page, 'staged').locator('[data-testid="change-row"]')).toHaveCount(1);
    await expect(section(page, 'unstaged').locator('[data-testid="change-row"]')).toHaveCount(2);
    await expect(page.locator('[data-testid="commit-scope"]')).toHaveText('1 staged');

    // Stage the second file through the list, not through a `Stage all` box.
    await changeRow(page, 'second.txt', 'unstaged')
      .getByRole('button', { name: 'Stage', exact: true })
      .click();
    await expect(
      section(page, 'staged').locator('[data-testid="change-row"][data-path="second.txt"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="commit-scope"]')).toHaveText('2 staged');

    await page.locator('.commit-message').fill('commit the index only');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });

    // Git is the witness: the commit holds the two staged paths and nothing else.
    expect(git(['show', '--name-status', '--format=', 'HEAD'], repo).split('\n').sort()).toEqual([
      'M\tmixed.txt',
      'M\tsecond.txt',
    ]);
    expect(gitOrNull(['diff', '--cached', '--name-only'], repo)).toBe('');
    expect(git(['show', 'HEAD:mixed.txt'], repo)).toBe(mixedBody({ line03: 'LINE03' }).trimEnd());
    // The unstaged edit, the modified second file's work and the untracked file
    // are all still in the workspace.
    expect(git(['diff', '--name-only'], repo)).toBe('mixed.txt');
    expect(git(['ls-files', '--others', '--exclude-standard'], repo)).toBe('fresh.txt');
    expect(git(['diff', '--name-only'], repo)).toBe('mixed.txt');

    // The UI agrees: the staged side is gone, the unstaged row stays.
    await expect(section(page, 'staged')).toHaveCount(0);
    await expect(changeRow(page, 'mixed.txt', 'unstaged')).toBeVisible();
    await expect(untrackedRow(page, 'fresh.txt')).toBeVisible();
    await expect(page.locator('[data-testid="change-count"]')).toHaveText('All changes · 2');
  } finally {
    await closeFixture(fixture);
  }
});

test('opens the patch in the center while the list stays, and switches files in one click', async () => {
  const fixture = await openFixture({ prepare: seedPartialStaging });
  const { page } = fixture;
  try {
    // A terminal of its own: the center hosts both the sessions and the tools, and
    // a session-less window has no terminal layer to keep alive.
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
      timeout: 30_000,
    });
    expect(await panelWidth(page)).toBeLessThan(600);

    // One click on the unstaged row opens its patch in the center, and the change
    // list, the commit box and the column width all stay where they were.
    await openPatch(page, 'mixed.txt', 'unstaged');
    await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-testid="center-diff-layer"]')).toBeVisible();
    await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="change-count"]')).toBeVisible();
    await expect(page.locator('[data-testid="commit-box"]')).toBeInViewport();
    await expect(page.locator('.diff-modes [role="tab"][aria-selected="true"]')).toHaveText(
      /Unstaged/,
    );
    // The request is filtered to that file: one header and the unstaged edit only,
    // not the staged `LINE03` line.
    await expect(page.locator('.center .diff-file-head .diff-path')).toHaveCount(1);
    await expect(page.locator('.center .diff-file-head .diff-path')).toHaveText('mixed.txt');
    await expect(
      page.locator('.center .diff-line.diff-add .diff-text', { hasText: 'LINE35' }),
    ).toHaveCount(1);
    await expect(page.locator('.center .diff-text', { hasText: 'LINE03' })).toHaveCount(0);
    // The patch never widens the column: that was the old `Open diff` behaviour.
    const width = await panelWidth(page);
    expect(width).toBeLessThan(600);

    // A second file is one click away: the list never leaves the screen.
    await changeRow(page, 'second.txt', 'unstaged').locator('.change-open').click();
    await expect(page.locator('.diff-target-label')).toHaveText('second.txt · unstaged side', {
      timeout: 30_000,
    });
    await expect(page.locator('.center .diff-file-head .diff-path')).toHaveText('second.txt');
    await expect(page.locator('[data-testid="change-count"]')).toBeVisible();
    expect(await panelWidth(page)).toBe(width);

    // The other side of the same file is one click too, and keeps the selection.
    await openPatch(page, 'mixed.txt', 'staged');
    await expect(changeRow(page, 'mixed.txt', 'staged')).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('.center .diff-line.diff-add .diff-text', { hasText: 'LINE03' }))
      .toHaveCount(1);

    // `Show all files` drops the filter without closing the tab: the whole patch
    // of the current comparison is shown, so the mode still decides the files.
    await page.locator('[data-testid="diff-show-all"]').click();
    await expect(page.locator('.diff-target-bar')).toHaveCount(0);
    await expect(
      page.locator('.center .diff-file-head .diff-path', { hasText: 'mixed.txt' }),
    ).toHaveCount(1);
    await expect(
      page.locator('.center .diff-file-head .diff-path', { hasText: 'second.txt' }),
    ).toHaveCount(0);
    // `Both` then shows the staged and the unstaged file in one patch.
    await page.locator('.diff-modes [role="tab"]', { hasText: 'Both' }).click();
    await expect(
      page.locator('.center .diff-file-head .diff-path', { hasText: 'second.txt' }),
    ).toHaveCount(1);
    await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');
    // The terminal kept its layer and the column kept its width all along.
    await expect(page.locator('.center .terminal-view')).toHaveCount(1);
    expect(await panelWidth(page)).toBe(width);
  } finally {
    await closeFixture(fixture);
  }
});

test('resets Amend after a commit and prefills it with the last message', async () => {
  const fixture = await openFixture({
    prepare: (repo) => writeFileSync(path.join(repo, 'second.txt'), 'alpha\nBETA\n', 'utf8'),
  });
  const { page, repo } = fixture;
  try {
    await expect(changeRow(page, 'second.txt', 'unstaged')).toBeVisible({ timeout: 30_000 });
    await changeRow(page, 'second.txt', 'unstaged')
      .getByRole('button', { name: 'Stage', exact: true })
      .click();
    await expect(page.locator('[data-testid="commit-scope"]')).toHaveText('1 staged');

    // `Amend` on a blank draft loads the message of `HEAD`, so the user edits the
    // real message instead of an empty box.
    const menu = await openCommitMenu(page);
    await menu.getByRole('menuitem', { name: /Amend last commit/ }).click();
    await expect(page.locator('.commit-message')).toHaveValue('init', { timeout: 30_000 });
    await expect(page.locator('.commit-amend-flag')).toHaveText('Amend');

    await page.locator('.commit-message').fill('amended init');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Amended', { timeout: 30_000 });
    expect(git(['log', '--format=%s'], repo)).toBe('amended init');

    // `Amend` is one-shot: the flag is gone, so the next commit creates a commit
    // instead of silently rewriting the one just amended.
    await expect(page.locator('.commit-amend-flag')).toHaveCount(0);
    await expect(page.locator('.commit-submit')).toHaveText('Commit');
    const again = await openCommitMenu(page);
    await expect(again.getByRole('menuitem', { name: /Amend last commit/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.keyboard.press('Escape');
    await expect(again).toHaveCount(0);

    writeFileSync(path.join(repo, 'README.md'), '# panel again\n', 'utf8');
    await expect(changeRow(page, 'README.md', 'unstaged')).toBeVisible({ timeout: 30_000 });
    await changeRow(page, 'README.md', 'unstaged')
      .getByRole('button', { name: 'Stage', exact: true })
      .click();
    await page.locator('.commit-message').fill('follow up');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });
    expect(git(['log', '--format=%s'], repo).split('\n')).toEqual(['follow up', 'amended init']);
  } finally {
    await closeFixture(fixture);
  }
});

test('discards only the worktree side of a partially staged file', async () => {
  const fixture = await openFixture({ prepare: seedPartialStaging });
  const { page, repo } = fixture;
  try {
    const unstaged = changeRow(page, 'mixed.txt', 'unstaged');
    await expect(unstaged).toBeVisible({ timeout: 30_000 });
    const index = git(['ls-files', '--stage'], repo);

    // The confirmation names the side it will drop, not the whole path.
    await unstaged.getByRole('button', { name: 'Discard', exact: true }).click();
    const confirm = await confirmAction(page);
    await expect(confirm).toContainText('Discard unstaged changes of mixed.txt');
    await expect(confirm).toContainText('staged part of this path stays staged');
    await page.locator('[data-testid="confirm-accept"]').click();

    // Git is the witness: the index is untouched and the worktree is back to it.
    await expect
      .poll(() => gitOrNull(['diff', '--name-only', '--', 'mixed.txt'], repo), {
        timeout: 30_000,
      })
      .toBe('');
    expect(git(['ls-files', '--stage'], repo)).toBe(index);
    expect(git(['diff', '--cached', '--name-only'], repo)).toBe('mixed.txt');
    // `core.autocrlf` is on in this environment's git config, so the restore
    // writes CRLF where the fixture wrote LF. The bytes are compared as lines:
    // git's own `diff` above is what proves the worktree matches the index.
    expect(readFileSync(path.join(repo, 'mixed.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      mixedBody({ line03: 'LINE03' }),
    );

    // The UI agrees: the staged row stays, the unstaged row is gone.
    await expect(
      section(page, 'staged').locator('[data-testid="change-row"][data-path="mixed.txt"]'),
    ).toBeVisible();
    await expect(changeRow(page, 'mixed.txt', 'unstaged')).toHaveCount(0, { timeout: 30_000 });
    // The badge counts paths, not rows: mixed.txt still has its staged side.
    await expect(page.locator('[data-testid="change-count"]')).toHaveText('All changes · 3');
  } finally {
    await closeFixture(fixture);
  }
});

test('keeps the collapsed rail change badge current while the panel is closed', async () => {
  const fixture = await openFixture();
  const { page, repo } = fixture;
  try {
    await expect(page.locator('[data-testid="source-control-panel"]')).toBeVisible({
      timeout: 30_000,
    });
    expect(git(['status', '--porcelain'], repo)).toBe('');

    // Collapsing unmounts `Source Control`, but the shell still watches the task:
    // the snapshot must keep refreshing, or the rail freezes on the old count.
    await page.locator('.right-collapse').click();
    await expect(page.locator('.right-rail')).toBeVisible();
    await expect(page.locator('.rail-label')).toHaveText('Source Control · 0');

    writeFileSync(path.join(repo, 'second.txt'), 'alpha\nBETA\n', 'utf8');
    await expect(page.locator('.rail-label')).toHaveText('Source Control · 1', { timeout: 30_000 });
    writeFileSync(path.join(repo, 'fresh.txt'), 'new\n', 'utf8');
    await expect(page.locator('.rail-label')).toHaveText('Source Control · 2', { timeout: 30_000 });

    // Opening the panel again shows the same numbers the rail was reporting.
    await page.locator('.rail-toggle').click();
    await expect(page.locator('[data-testid="change-count"]')).toHaveText('All changes · 2', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="right-tab-count-source-control"]')).toHaveText('2');
  } finally {
    await closeFixture(fixture);
  }
});

test('explains a commit with nothing staged and keeps the first commit available', async () => {
  const fixture = await openFixture({
    prepare: (repo) => writeFileSync(path.join(repo, 'second.txt'), 'alpha\nGAMMA\n', 'utf8'),
  });
  const { page, repo } = fixture;
  try {
    await expect(changeRow(page, 'second.txt', 'unstaged')).toBeVisible({ timeout: 30_000 });
    const submit = page.locator('.commit-submit');
    await expect(submit).toBeDisabled();
    await expect(page.locator('[data-testid="commit-reason"]')).toHaveText(
      'Write a commit message',
    );

    // Only the index is committed, so a message alone is not enough.
    await page.locator('.commit-message').fill('nothing to record');
    await expect(page.locator('[data-testid="commit-reason"]')).toHaveText('Nothing staged');
    await expect(submit).toBeDisabled();

    // Staging the row makes the same draft committable.
    await changeRow(page, 'second.txt', 'unstaged')
      .getByRole('button', { name: 'Stage', exact: true })
      .click();
    await expect(page.locator('[data-testid="commit-reason"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });
    expect(git(['show', '--name-status', '--format=', 'HEAD'], repo)).toBe('M\tsecond.txt');
  } finally {
    await closeFixture(fixture);
  }
});

test('allows the first commit on a branch that has no commits yet', async () => {
  const fixture = await openFixture();
  const { page, repo } = fixture;
  try {
    // A project needs one commit before Nest will add it, so the unborn branch
    // is made here: `--orphan` keeps the files and drops HEAD, and the index is
    // reset so everything is untracked again.
    git(['checkout', '--orphan', 'fresh-start'], repo);
    git(['rm', '-rf', '--cached', '.'], repo);
    for (const entry of readdirSync(repo)) {
      if (entry === '.git') continue;
      rmSync(path.join(repo, entry), { recursive: true, force: true });
    }
    writeFileSync(path.join(repo, 'first.txt'), 'first\n', 'utf8');
    await page.getByRole('button', { name: 'Refresh git status' }).click();
    await expect(page.locator('.git-branch-name')).toHaveText('fresh-start', { timeout: 30_000 });
    expect(gitOrNull(['rev-parse', '--verify', '-q', 'HEAD'], repo)).toBeNull();
    await expect(untrackedRow(page, 'first.txt')).toBeVisible({ timeout: 30_000 });

    // `Amend` needs a commit; the first commit does not.
    const menu = await openCommitMenu(page);
    const amend = menu.getByRole('menuitem', { name: /Amend last commit/ });
    await expect(amend).toBeDisabled();
    await expect(amend).toContainText('no commits yet');
    await page.keyboard.press('Escape');

    await untrackedRow(page, 'first.txt')
      .getByRole('button', { name: 'Stage', exact: true })
      .click();
    await page.locator('.commit-message').fill('the root commit');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });

    expect(git(['log', '--format=%s', '-1'], repo)).toBe('the root commit');
    expect(git(['show', '--name-status', '--format=', 'HEAD'], repo)).toContain('A\tfirst.txt');
    expect(git(['rev-list', '--count', 'HEAD'], repo)).toBe('1');
    await expect(page.locator('[data-testid="changes-empty"]')).toHaveText('Working tree is clean');
  } finally {
    await closeFixture(fixture);
  }
});

test('keeps the draft and the selection of each task across A → B → A', async () => {
  const fixture = await openFixture({
    prepare: (repo) => writeFileSync(path.join(repo, 'second.txt'), 'alpha\nBETA\n', 'utf8'),
  });
  const { page, repo, app } = fixture;
  try {
    // A second task of the same project: a worktree with its own workspace. It
    // is created before the first draft, because the reload it needs would
    // clear the in-memory memory the test is about.
    const projectId = await page.evaluate(async () => {
      const projects = await window.nest!.invoke('projects.list', {});
      if (!projects.ok) throw new Error(projects.error.message);
      const project = projects.data[0];
      if (!project) throw new Error('no project');
      return project.id;
    });
    const taskB = await page.evaluate(async (id) => {
      const created = await window.nest!.invoke('tasks.create', {
        projectId: id,
        title: 'Task B',
        operationId: `panel-b-${Date.now()}`,
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data;
    }, projectId);
    await page.reload();
    await page.waitForSelector('.app', { timeout: 60_000 });

    const select = async (title: string): Promise<void> => {
      await page.locator('.task-row', { hasText: title }).locator('.task-select').click();
    };
    await select('Main checkout');
    await expect(changeRow(page, 'second.txt', 'unstaged')).toBeVisible({ timeout: 30_000 });
    await page.locator('.commit-message').fill('draft of task A');
    await openPatch(page, 'second.txt', 'unstaged');

    // The center is per task too: B starts on its terminal, and A comes back
    // with its `Diff` tab, its selection and its draft.
    await select('Task B');
    await expect(page.locator('[data-testid="center-terminal-layer"]')).toHaveClass(/is-active/);
    await page.locator('#right-tab-source-control').click();
    await expect(page.locator('.commit-message')).toHaveValue('', { timeout: 30_000 });
    await expect(page.locator('[data-testid="changes-empty"]')).toBeVisible();
    await page.locator('.commit-message').fill('draft of task B');

    // A change made in B's workspace, so B's list is not empty either.
    writeFileSync(path.join(taskB.workspacePath, 'b-only.txt'), 'b\n', 'utf8');
    await expect(untrackedRow(page, 'b-only.txt')).toBeVisible({ timeout: 30_000 });

    // Back to A: its draft, its list, its selected row and its open patch are all
    // still there, so no second click is needed to read the file again.
    await select('Main checkout');
    await expect(page.locator('.commit-message')).toHaveValue('draft of task A', {
      timeout: 30_000,
    });
    await expect(changeRow(page, 'second.txt', 'unstaged')).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(centerTab(page, 'diff')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.diff-target-label')).toHaveText('second.txt · unstaged side');

    // `Open diff` is the whole patch of the task: it drops the single-file
    // filter without resizing the column.
    await page.getByRole('button', { name: 'Open diff' }).click();
    await expect(page.locator('.diff-target-bar')).toHaveCount(0);
    await expect(
      page.locator('.center .diff-file-head .diff-path', { hasText: 'second.txt' }),
    ).toHaveCount(1);

    // B's draft was not overwritten by A's.
    await select('Task B');
    await page.locator('#right-tab-source-control').click();
    await expect(page.locator('.commit-message')).toHaveValue('draft of task B', {
      timeout: 30_000,
    });
    await select('Main checkout');
    await expect(page.locator('.commit-message')).toHaveValue('draft of task A');
    await expect(page.locator('.sidebar')).toContainText('Task B');
    expect(git(['diff', '--name-only'], repo)).toBe('second.txt');
    expect(git(['ls-files', '--others', '--exclude-standard'], repo)).toBe('');
  } finally {
    await closeFixture(fixture);
    expect(app).toBeTruthy();
  }
});

test('publishes the first branch and pushes the next commit to a local bare remote', async () => {
  const fixture = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'publish');
      const origin = path.join(root, 'origin.git');
      mkdirSync(origin, { recursive: true });
      git(['init', '--bare', '-b', 'main', origin], root);
      git(['remote', 'add', 'origin', origin], repo);
      return repo;
    },
  });
  const { page, repo } = fixture;
  const origin = path.join(fixture.root, 'origin.git');
  try {
    // No upstream yet: the one remote action is publishing the branch.
    await expect(syncAction(page)).toHaveText('Publish branch', { timeout: 30_000 });
    await expect(headNote(page)).toContainText('No upstream branch yet');
    await expect(page.locator('.git-upstream')).toHaveText('no upstream');

    await syncAction(page).click();
    await skipIfGitTransportIsBlocked(page);
    await expect(page.locator('.git-upstream')).toHaveText('origin/main', { timeout: 60_000 });
    expect(git(['rev-parse', 'main'], origin)).toBe(git(['rev-parse', 'HEAD'], repo));

    // A commit on the published branch turns the action into `Push`.
    writeFileSync(path.join(repo, 'published.txt'), 'published\n', 'utf8');
    git(['add', '.'], repo);
    await expect(
      section(page, 'staged').locator('[data-testid="change-row"][data-path="published.txt"]'),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator('.commit-message').fill('publish me');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });
    await expect(syncAction(page)).toHaveText('Push', { timeout: 30_000 });
    await expect(page.locator('.track-pill')).toHaveText('↑1');

    await syncAction(page).click();
    await expect
      .poll(() => git(['rev-parse', 'main'], origin), { timeout: 60_000 })
      .toBe(git(['rev-parse', 'HEAD'], repo));
    await expect(page.locator('.track-pill')).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await closeFixture(fixture);
  }
});

test('keeps the commit when a push is rejected and retries only the push', async () => {
  const fixture = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'reject');
      const origin = path.join(root, 'origin.git');
      mkdirSync(origin, { recursive: true });
      git(['init', '--bare', '-b', 'main', origin], root);
      git(['remote', 'add', 'origin', origin], repo);
      return repo;
    },
  });
  const { page, repo } = fixture;
  const origin = path.join(fixture.root, 'origin.git');
  const other = path.join(fixture.root, 'other');
  try {
    await expect(syncAction(page)).toHaveText('Publish branch', { timeout: 30_000 });
    await syncAction(page).click();
    await skipIfGitTransportIsBlocked(page);
    await expect(page.locator('.git-upstream')).toHaveText('origin/main', { timeout: 60_000 });

    // A second clone puts a commit on the remote branch first, so the next push
    // from the panel is a plain non-fast-forward rejection. A `pre-receive` hook
    // would need an executable bit, which a file mode does not create on
    // Windows: git ignores the hook and the push simply succeeds there.
    const shared = git(['rev-parse', 'HEAD'], repo);
    git(['clone', origin, other], fixture.root);
    git(['config', 'user.name', 'Other'], other);
    git(['config', 'user.email', 'other@example.com'], other);
    writeFileSync(path.join(other, 'remote.txt'), 'remote\n', 'utf8');
    git(['add', '.'], other);
    commit(other, 'remote commit');
    git(['push', 'origin', 'main'], other);
    expect(git(['rev-parse', 'refs/heads/main'], origin)).not.toBe(shared);

    writeFileSync(path.join(repo, 'rejected.txt'), 'rejected\n', 'utf8');
    git(['add', '.'], repo);
    await expect(
      section(page, 'staged').locator('[data-testid="change-row"][data-path="rejected.txt"]'),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator('.commit-message').fill('kept locally');
    await page.locator('.commit-submit').click();
    await expect(page.locator('.toast').first()).toContainText('Committed', { timeout: 30_000 });
    const headBefore = git(['rev-parse', 'HEAD'], repo);

    await syncAction(page).click();
    const failure = remoteFailure(page, /Push rejected/);
    await expect(failure).toBeVisible({ timeout: 60_000 });
    // The message says the work is safe locally instead of implying a loss, and
    // the folded reason is git's own rejection, not a retold one.
    await expect(failure).toContainText('saved locally');
    await expect(failure.locator('pre')).toContainText(/rejected|non-fast-forward/i);

    // Nothing was rewritten and nothing has to be committed twice.
    expect(git(['rev-parse', 'HEAD'], repo)).toBe(headBefore);
    expect(git(['log', '--format=%s', '-1'], repo)).toBe('kept locally');
    expect(gitOrNull(['rev-parse', 'refs/heads/main'], origin)).not.toBe(headBefore);
    await expect(page.locator('[data-testid="changes-empty"]')).toBeVisible();

    // A retry touches only the push, and the rejected branch offers the
    // lease-guarded force as its own explicit action: a button of the failure
    // note, or an item of the panel menu.
    await syncAction(page).click();
    await expect(remoteFailure(page, /Push rejected/)).toBeVisible({ timeout: 60_000 });
    const noteAction = page.getByRole('button', { name: 'Force push with lease' });
    const force =
      (await noteAction.count()) > 0
        ? noteAction
        : (await openPanelMenu(page)).getByRole('menuitem', { name: /Force push with lease/ });
    await expect(force).toBeEnabled();
    await force.click();
    const confirm = page.locator('[data-testid="confirm-action"]');
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await expect(confirm).toContainText('origin/main');
    await expect(confirm).toContainText('force-with-lease');
    // A lease-guarded force starts on Cancel, so Enter never fires it by accident.
    await expect(page.locator('[data-testid="confirm-cancel"]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    // Escape cancelled: the remote branch is still where the rejection left it.
    expect(gitOrNull(['rev-parse', 'refs/heads/main'], origin)).not.toBe(headBefore);

    // Fixing the state: the other clone's commit is withdrawn, so the same
    // local commit is a fast-forward again and one plain push lands it.
    git(['update-ref', 'refs/heads/main', shared], origin);
    await syncAction(page).click();
    await expect
      .poll(() => git(['rev-parse', 'main'], origin), { timeout: 60_000 })
      .toBe(headBefore);
    expect(git(['log', '--format=%s', '-1'], repo)).toBe('kept locally');
  } finally {
    await closeFixture(fixture);
  }
});

test('offers only Fetch with an explanation when the branch has diverged', async () => {
  const fixture = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'diverged');
      const origin = path.join(root, 'origin.git');
      const other = path.join(root, 'other');
      mkdirSync(origin, { recursive: true });
      git(['init', '--bare', '-b', 'main', origin], root);
      git(['remote', 'add', 'origin', origin], repo);
      git(['push', '-u', 'origin', 'main'], repo);
      git(['clone', origin, other], root);
      git(['config', 'user.name', 'Other'], other);
      git(['config', 'user.email', 'other@example.com'], other);
      // Both sides move: one commit here, one in the clone, then a fetch so the
      // remote-tracking ref is current without the panel making a network call.
      writeFileSync(path.join(repo, 'local.txt'), 'local\n', 'utf8');
      git(['add', '.'], repo);
      commit(repo, 'local commit');
      writeFileSync(path.join(other, 'remote.txt'), 'remote\n', 'utf8');
      git(['add', '.'], other);
      commit(other, 'remote commit');
      git(['push', 'origin', 'main'], other);
      git(['fetch', 'origin'], repo);
      return repo;
    },
  });
  const { page } = fixture;
  try {
    await expect(syncAction(page)).toHaveText('Fetch', { timeout: 30_000 });
    await expect(page.locator('.track-pill')).toHaveText(['↑1', '↓1']);
    await expect(headNote(page)).toContainText('Diverged from upstream');
    await expect(headNote(page)).toContainText('only Fetch runs');
    // Nothing merges by itself: publish and push are not offered here.
    const menu = await openPanelMenu(page);
    await expect(menu.getByRole('menuitem', { name: /Publish branch/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(syncAction(page)).toBeEnabled();
  } finally {
    await closeFixture(fixture);
  }
});

test('explains an unavailable sync for no remote, no upstream and a detached HEAD', async () => {
  const withRemote = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'no-upstream');
      const origin = path.join(root, 'origin.git');
      mkdirSync(origin, { recursive: true });
      git(['init', '--bare', '-b', 'main', origin], root);
      git(['remote', 'add', 'origin', origin], repo);
      return repo;
    },
  });
  try {
    await expect(syncAction(withRemote.page)).toHaveText('Publish branch', { timeout: 30_000 });
    await expect(headNote(withRemote.page)).toContainText('No upstream branch yet');
  } finally {
    await closeFixture(withRemote);
  }

  const withoutRemote = await openFixture();
  try {
    await expect(syncAction(withoutRemote.page)).toHaveText('Fetch', { timeout: 30_000 });
    await expect(syncAction(withoutRemote.page)).toBeDisabled();
    await expect(syncAction(withoutRemote.page)).toHaveAttribute(
      'title',
      'This repository has no remotes',
    );
    await expect(headNote(withoutRemote.page)).toHaveText('This repository has no remotes');
    // The state is not reported as `Up to date`.
    await expect(withoutRemote.page.locator('.source-control-head')).not.toContainText(
      'Up to date',
    );
  } finally {
    await closeFixture(withoutRemote);
  }

  const detached = await openFixture({
    prepare: (repo) => {
      git(['checkout', '--detach', 'HEAD'], repo);
    },
  });
  try {
    await expect(headNote(detached.page)).toContainText(
      'Detached HEAD: there is no branch to sync',
      {
        timeout: 30_000,
      },
    );
    await expect(syncAction(detached.page)).toBeDisabled();
    await expect(detached.page.locator('.source-control-head')).not.toContainText('Up to date');
  } finally {
    await closeFixture(detached);
  }
});

test('refuses a mismatched upstream and publishes only after confirming the target', async () => {
  const fixture = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'mismatch');
      const origin = path.join(root, 'origin.git');
      mkdirSync(origin, { recursive: true });
      git(['init', '--bare', '-b', 'main', origin], root);
      git(['remote', 'add', 'origin', origin], repo);
      git(['push', '-u', 'origin', 'main'], repo);
      // A branch of its own that still tracks the base branch: a plain push
      // would update `origin/main` instead of publishing the branch.
      git(['switch', '-c', 'feature/panel'], repo);
      git(['branch', '--set-upstream-to=origin/main'], repo);
      writeFileSync(path.join(repo, 'feature.txt'), 'feature\n', 'utf8');
      git(['add', '.'], repo);
      commit(repo, 'feature commit');
      return repo;
    },
  });
  const { page, repo } = fixture;
  const origin = path.join(fixture.root, 'origin.git');
  const originMain = git(['rev-parse', 'main'], repo);
  try {
    await expect(page.locator('.git-branch-name')).toHaveText('feature/panel', {
      timeout: 30_000,
    });
    await expect(page.locator('.git-upstream')).toHaveText('origin/main');
    await expect(page.locator('.track-pill')).toHaveText(['↑1']);
    await expect(syncAction(page)).toHaveText('Push');

    // Core never rewrites an upstream the user did not choose: the push stops
    // before it touches the remote, and the panel says so inline.
    await syncAction(page).click();
    const note = page.locator('[data-testid="panel-note"]');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText('Push stopped');
    await expect(note).toContainText('feature/panel tracks origin/main');
    await expect(note).toContainText('origin/feature/panel');
    // The reason is git-core's own sentence, kept behind a `Reason` toggle.
    await note.locator('summary').click();
    await expect(note.locator('pre')).toContainText('tracks origin/main');
    // Nothing moved: not the remote branch, not the upstream, not the commit.
    expect(gitOrNull(['rev-parse', 'refs/heads/feature/panel'], origin)).toBeNull();
    expect(git(['rev-parse', 'main'], origin)).toBe(originMain);
    await expect(page.locator('.git-upstream')).toHaveText('origin/main');

    // The retry is a publish of the exact target, and it is asked for by name.
    await note.getByRole('button', { name: 'Publish branch' }).click();
    const confirm = page.locator('[data-testid="confirm-action"]');
    await expect(confirm).toHaveAttribute('role', 'alertdialog');
    await expect(confirm).toContainText('Publish feature/panel as origin/feature/panel');
    await expect(confirm).toContainText('tracks origin/main');
    await expect(confirm).toContainText('origin/main is not touched');

    // Escape cancels the dialog, and nothing on the remote changed.
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(gitOrNull(['rev-parse', 'refs/heads/feature/panel'], origin)).toBeNull();
    await expect(note).toBeVisible();

    // Accepting is the only thing that publishes; the old upstream stays put.
    await note.getByRole('button', { name: 'Publish branch' }).click();
    await page.locator('[data-testid="confirm-accept"]').click();
    if ((await waitForRemoteOutcome(page)) === 'blocked') {
      annotateEnvironment(
        'this Windows session refuses the shell helper git needs for a local remote',
      );
      await expect(page.locator('.git-upstream')).toHaveText('origin/main');
    } else {
      await expect(page.locator('.git-upstream')).toHaveText('origin/feature/panel', {
        timeout: 60_000,
      });
      expect(git(['rev-parse', 'feature/panel'], origin)).toBe(git(['rev-parse', 'HEAD'], repo));
    }
    expect(git(['rev-parse', 'main'], origin)).toBe(originMain);
  } finally {
    await closeFixture(fixture);
  }
});

test('puts a conflicted merge in its own section without a stage action', async () => {
  const fixture = await openFixture({
    seed: (root) => {
      const repo = seedRepo(root, 'conflict');
      git(['switch', '-c', 'feature'], repo);
      writeFileSync(path.join(repo, 'conflict.txt'), 'feature\n', 'utf8');
      git(['add', '.'], repo);
      commit(repo, 'feature side');
      git(['switch', 'main'], repo);
      writeFileSync(path.join(repo, 'conflict.txt'), 'main\n', 'utf8');
      git(['add', '.'], repo);
      commit(repo, 'main side');
      return repo;
    },
    prepare: (repo) => {
      // A real conflicted merge, not a hand-written status line.
      try {
        git(['merge', 'feature'], repo);
      } catch {
        // `git merge` exits non-zero on a conflict, which is the point here.
      }
    },
  });
  const { page, repo } = fixture;
  try {
    expect(git(['status', '--porcelain'], repo)).toContain('UU conflict.txt');
    const conflicts = section(page, 'conflicts');
    await expect(conflicts).toBeVisible({ timeout: 30_000 });
    await expect(
      conflicts.locator('[data-testid="change-row"][data-path="conflict.txt"]'),
    ).toBeVisible();
    // Not staged, not unstaged: a conflict is its own state.
    await expect(section(page, 'staged')).toHaveCount(0);
    await expect(section(page, 'unstaged')).toHaveCount(0);
    await expect(conflicts).toContainText('Resolve the conflict, then stage the result');
    // The row offers no stage action that would fake a resolution.
    const row = conflicts.locator('[data-testid="change-row"][data-path="conflict.txt"]');
    await expect(row.getByRole('button', { name: 'Stage', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Unstage', exact: true })).toHaveCount(0);
    await expect(row.locator('.git-letter')).toHaveText('UU');
    // Reading the conflict in the patch does not touch the index either.
    const indexBefore = git(['ls-files', '--stage'], repo);
    await row.locator('.change-open').click();
    await expect(page.locator('.diff-target-label')).toHaveText('conflict.txt · unstaged side');
    expect(git(['ls-files', '--stage'], repo)).toBe(indexBefore);
    expect(git(['status', '--porcelain'], repo)).toContain('UU conflict.txt');
  } finally {
    await closeFixture(fixture);
  }
});

test('picks up an external add and branch switch without losing the draft', async () => {
  const fixture = await openFixture({
    prepare: (repo) => writeFileSync(path.join(repo, 'second.txt'), 'alpha\nBETA\n', 'utf8'),
  });
  const { page, repo } = fixture;
  try {
    await expect(changeRow(page, 'second.txt', 'unstaged')).toBeVisible({ timeout: 30_000 });
    await page.locator('.commit-message').fill('draft across an external add');

    // `git add` outside Nest: the watcher turns the row into a staged row.
    git(['add', 'second.txt'], repo);
    await expect(changeRow(page, 'second.txt', 'staged')).toBeVisible({ timeout: 30_000 });
    await expect(changeRow(page, 'second.txt', 'unstaged')).toHaveCount(0);
    await expect(page.locator('[data-testid="commit-scope"]')).toHaveText('1 staged');
    await expect(page.locator('.commit-message')).toHaveValue('draft across an external add');

    // `git checkout -b` outside Nest: the status is re-read, so the status bar
    // and the titlebar follow the new branch.
    git(['checkout', '-b', 'external-branch'], repo);
    await expect(page.locator('.statusbar .status-item').first()).toContainText('external-branch', {
      timeout: 30_000,
    });
    await expect(page.locator('.titlebar .badge')).toHaveText('external-branch');
    await expect(page.locator('.commit-message')).toHaveValue('draft across an external add');
    // The staged work survived the switch.
    await expect(changeRow(page, 'second.txt', 'staged')).toBeVisible();
    // One branch, one label: the panel head must not keep naming the old branch
    // while the status bar and the titlebar already show the new one.
    await expect(page.locator('.git-branch-name')).toHaveText('external-branch');
  } finally {
    await closeFixture(fixture);
  }
});

test('keeps a note written on the staged side outside the unstaged patch and sends it', async () => {
  const fixture = await openFixture({ prepare: seedPartialStaging });
  const { page } = fixture;
  try {
    await startHarness(page, 'fake');
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('FakeHarness', {
      timeout: 30_000,
    });

    // The note belongs to the staged side of the partially staged file.
    await openPatch(page, 'mixed.txt', 'staged');
    const stagedLine = page.locator('.diff-line.diff-add').first();
    await stagedLine.hover();
    await stagedLine.locator('.diff-comment-btn').click();
    await page.locator('.comment-composer textarea').fill('this side is staged');
    const addComment = page.getByRole('button', { name: 'Add comment' });
    await expect(addComment).toBeEnabled();
    await addComment.dispatchEvent('click');
    await expect(page.locator('.comment-anchor')).toHaveText('mixed.txt:3');

    // The unstaged patch does not draw the note inline: its line lives in the
    // index, so the note is reported outside this patch instead of dropped.
    await openPatch(page, 'mixed.txt', 'unstaged');
    await expect(page.locator('.comment-thread')).toHaveCount(0);
    const outside = page.locator('.outside-notes');
    await expect(outside).toBeVisible({ timeout: 30_000 });
    await expect(outside.locator('.section-label')).toHaveText('Outside this patch');
    await expect(outside.locator('.outside-group-head')).toContainText('Other comparison');
    await expect(outside.locator('.outside-note')).toContainText('this side is staged');
    await expect(outside.locator('.outside-note .comment-anchor')).toHaveText('mixed.txt:3');

    // Sending it puts the `file:line` text into the running harness. The text
    // goes to the PTY wherever the center is showing, so the terminal is opened
    // to read it: a hidden layer draws nothing, exactly as the fit does not run
    // for a 0×0 box.
    await outside.locator('.outside-note').getByRole('button', { name: 'Send' }).click();
    await page.locator('.terminal-tab').first().click();
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText('mixed.txt:3', {
      timeout: 30_000,
    });
    await expect(page.locator('.terminal-view.active .xterm-rows')).toContainText(
      'this side is staged',
    );
  } finally {
    await closeFixture(fixture);
  }
});
