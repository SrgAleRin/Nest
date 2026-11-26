import { gitOrNull } from './exec.js';

/**
 * Base ref decisions live here so `projects.add` (stores the default once) and
 * `tasks.create` (falls back for rows registered before migration 12) agree on
 * one rule. Nothing in this module touches the network: a stale `origin/HEAD` is
 * accepted on purpose, and `fetch` stays where it already is.
 */

/** Short name of the branch HEAD points at; null when detached or unborn. */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const branch = await gitOrNull(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  return branch ? branch : null;
}

/**
 * `origin/HEAD` when the repository has one, otherwise the current branch.
 *
 * Falls back cleanly for a repository without a remote, an offline clone whose
 * `origin/HEAD` was never fetched, and an unborn `origin/HEAD` that points at a
 * ref nobody has (a bare remote, or a remote with no default branch yet): only
 * a symbolic ref that actually resolves is used.
 */
export async function resolveDefaultBase(repoPath: string): Promise<string | null> {
  const originHead = await gitOrNull(repoPath, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead && originHead.startsWith('origin/')) {
    if (await refExists(repoPath, `refs/remotes/${originHead}`)) return originHead;
  }
  return currentBranch(repoPath);
}

/** True when the ref resolves to a commit (local branch, remote-tracking or SHA). */
export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const value = await gitOrNull(repoPath, ['rev-parse', '--verify', ref]);
  return Boolean(value);
}

/**
 * A base is usable when it exists as a local branch or as a remote-tracking ref:
 * `main` and `origin/main` are both accepted, and a repository without a remote
 * only has the first.
 */
export async function baseRefExists(repoPath: string, ref: string): Promise<boolean> {
  if (await refExists(repoPath, `refs/heads/${ref}`)) return true;
  return refExists(repoPath, `refs/remotes/${ref}`);
}
