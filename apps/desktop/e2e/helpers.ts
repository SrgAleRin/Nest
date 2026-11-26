import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import type { NestBridge } from '@nest/shared';

declare global {
  interface Window {
    nest: NestBridge;
  }
}

/** The built app `electron-vite` writes next to the specs. */
const appDir = path.resolve(__dirname, '..');

/** Opens the new-tab picker anchored to the plus button. */
export async function openNewTabPicker(page: Page): Promise<void> {
  await page.locator('.terminal-new-caret').click();
}

/** Opens the picker and starts one harness by its profile id. */
export async function startHarness(page: Page, harnessId: string): Promise<void> {
  await openNewTabPicker(page);
  const item = page.locator(`[data-harness-id="${harnessId}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

export interface LaunchNestOptions {
  /** Isolated user-data, database, worktree and harness root. */
  root: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts the built app with its state pointed at one temporary root, so a spec
 * never reads or writes the user's own data directory.
 */
export function launchNest(options: LaunchNestOptions): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: ['.'],
    cwd: appDir,
    env: {
      ...env,
      ...options.env,
      NEST_USER_DATA: path.join(options.root, 'user-data'),
      NEST_DB_PATH: path.join(options.root, 'nest.db'),
      NEST_WORKTREES_ROOT: path.join(options.root, 'worktrees'),
      NEST_FAKE_SESSION_DIR: path.join(options.root, 'fake-sessions'),
      NEST_DISABLE_SINGLE_INSTANCE: '1',
      NEST_DISABLE_TRAY: '1',
      NEST_DISABLE_NOTIFICATIONS: '1',
      NEST_DISABLE_UPDATES: '1',
    },
  });
}

/**
 * Registers a repository. The native folder picker cannot be driven by a test,
 * so the project goes through the bridge and the window reloads onto it; every
 * task below is then created through the interface.
 */
export async function addProject(page: Page, repoPath: string): Promise<string> {
  const added = await page.evaluate(
    async (projectPath) => window.nest!.invoke('projects.add', { path: projectPath }),
    repoPath,
  );
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.error.message);
  await page.reload();
  await page.waitForSelector('.app', { timeout: 60_000 });
  return added.data.project.id;
}

/** `git` in a fixture repository; the tests read the real index, not the UI. */
export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The same call where an absent answer (no upstream, no HEAD) is not a failure. */
export function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** A commit that works on a machine without a global git identity. */
export function commit(repoPath: string, message: string): void {
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', message],
    repoPath,
  );
}

/** One row of the change list, by path and (optionally) side. */
export function changeRow(page: Page, filePath: string, side?: 'staged' | 'unstaged'): Locator {
  const selector = side
    ? `[data-testid="change-row"][data-path="${filePath}"][data-side="${side}"]`
    : `[data-testid="change-row"][data-path="${filePath}"]`;
  return page.locator(selector);
}

/** The remote action of the `Source Control` head. */
export function syncAction(page: Page): Locator {
  return page.locator('.sync-action');
}

/** Opens the `⋯` menu of the `Source Control` head. */
export async function openPanelMenu(page: Page): Promise<Locator> {
  await page.locator('.source-control-head .panel-menu-trigger').click();
  const menu = page.locator('.panel-menu-popup[role="menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/** The `⋯` menu of the commit block, which holds `Amend` and `Push`. */
export async function openCommitMenu(page: Page): Promise<Locator> {
  await page.locator('[data-testid="commit-box"] .panel-menu-trigger').click();
  const menu = page.locator('.panel-menu-popup[role="menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * A remote that is a path on this disk is reached with git's shell helper. A
 * locked down Windows session can refuse the named objects that helper needs
 * (`NtCreateDirectoryObject … 0xC0000022`). That failure happens outside Nest,
 * so a spec can say why the remote part cannot run here instead of reporting a
 * broken panel.
 */
export const SHELL_HELPER_FAILURE = /NtCreateDirectoryObject|Could not read from remote repository/;

export type RemoteOutcome = 'pushed' | 'blocked';

/**
 * What the remote action left behind. The report is either a toast or the
 * panel's own inline note, and the note keeps git's text inside a folded
 * `<details>`, so `textContent` is read instead of `innerText`.
 */
export async function waitForRemoteOutcome(page: Page): Promise<RemoteOutcome> {
  let outcome: RemoteOutcome | null = null;
  await expect
    .poll(
      async () => {
        const text = (
          await page
            .locator('.toast, [data-testid="panel-note"]')
            .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''))
        ).join(' | ');
        if (SHELL_HELPER_FAILURE.test(text)) return (outcome = 'blocked');
        if (/\[new branch\]|Published|Pushed|set up to track/.test(text)) {
          return (outcome = 'pushed');
        }
        return null;
      },
      { timeout: 90_000 },
    )
    .not.toBeNull();
  if (outcome === null) throw new Error('the remote action reported no outcome');
  return outcome;
}

/**
 * The panel's report of a remote action, whichever surface carries it: the
 * inline note that names the target and the retry, or the toast that came
 * before it.
 */
export function remoteFailure(page: Page, text: RegExp): Locator {
  return page.locator('.toast, [data-testid="panel-note"]', { hasText: text }).first();
}

/** The confirmation a destructive action asks for, from either affordance. */
export async function confirmAction(page: Page): Promise<Locator> {
  const confirm = page.locator('[data-testid="confirm-action"]');
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  return confirm;
}

/** Records an environment limitation on the test instead of hiding it. */
export function annotateEnvironment(description: string): void {
  test.info().annotations.push({ type: 'environment', description });
}
