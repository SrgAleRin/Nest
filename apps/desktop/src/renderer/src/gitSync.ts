import type { GitBranches, GitStatus } from '@nest/shared';

/** The single remote action the header offers for the current state. */
export type SyncKind = 'publish' | 'push' | 'pull' | 'fetch';

export interface SyncPlan {
  /** `null` when the repository cannot sync right now; `label` still names the intent. */
  kind: SyncKind | null;
  label: string;
  /** Why the action is unavailable; shown inline and as the tooltip. */
  disabledReason: string | null;
  /** What the state is, e.g. `Up to date` or `Diverged from upstream`. */
  detail: string;
  ahead: number;
  behind: number;
  /** Ahead and behind at once: only Fetch runs, nothing merges by itself. */
  diverged: boolean;
}

const LABELS: Record<SyncKind, string> = {
  publish: 'Publish branch',
  push: 'Push',
  pull: 'Pull',
  fetch: 'Fetch',
};

export interface SyncInput {
  /** The store's status slice; the head, ahead and behind live here. */
  status: GitStatus | null;
  /** The store's branches slice; remotes, detached and unborn live here. */
  branches: GitBranches | null;
  /** The branches slice failed: the remote state is unknown, not `Up to date`. */
  branchesError: string | null;
  /** The branches slice is still loading. */
  branchesLoading: boolean;
}

/**
 * Decides the one remote action the header shows, and why it is unavailable
 * when it is. Mounting the panel never runs any of these: the state comes from
 * the snapshot the store already has.
 *
 * - no upstream + a remote → `Publish branch`
 * - ahead → `Push`, behind → `Pull` (fast-forward only)
 * - diverged → `Fetch` with an explanation, never an automatic merge
 * - otherwise → `Fetch`
 */
export function planSync(input: SyncInput): SyncPlan {
  const status = input.status;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const base = {
    kind: null,
    label: LABELS.fetch,
    disabledReason: null,
    detail: '',
    ahead,
    behind,
    diverged: ahead > 0 && behind > 0,
  } satisfies SyncPlan;

  if (!status) return { ...base, disabledReason: 'Git status is not available yet' };
  if (input.branchesError) {
    return { ...base, disabledReason: `Branches could not be read: ${input.branchesError}` };
  }
  if (!input.branches) {
    return {
      ...base,
      disabledReason: input.branchesLoading ? 'Reading branches…' : 'Branch list is not loaded',
    };
  }
  const branches = input.branches;
  if (branches.detached) {
    return {
      ...base,
      label: LABELS.fetch,
      disabledReason: 'Detached HEAD: there is no branch to sync',
    };
  }
  if (branches.unborn) {
    return {
      ...base,
      label: LABELS.publish,
      disabledReason: 'This branch has no commits yet, so there is nothing to publish',
    };
  }
  if (branches.remotes.length === 0) {
    return { ...base, disabledReason: 'This repository has no remotes' };
  }
  if (!status.upstream) {
    return { ...base, kind: 'publish', label: LABELS.publish, detail: 'No upstream branch yet' };
  }
  if (ahead > 0 && behind > 0) {
    return {
      ...base,
      kind: 'fetch',
      detail: 'Diverged from upstream: push and pull both rewrite history here, so only Fetch runs',
    };
  }
  if (ahead > 0) return { ...base, kind: 'push', label: LABELS.push, detail: `Ahead ${ahead}` };
  if (behind > 0) {
    return {
      ...base,
      kind: 'pull',
      label: LABELS.pull,
      detail: `Behind ${behind}: pull fast-forwards only`,
    };
  }
  return { ...base, kind: 'fetch', detail: 'Up to date with upstream' };
}

/** The upstream label of the header; `no upstream` is a state, not an error. */
export function upstreamLabel(status: GitStatus | null): string {
  if (!status) return 'no upstream';
  return status.upstream ?? 'no upstream';
}

/** `↑2 ↓1` pills for the head; empty when both counters are zero. */
export function trackSummary(status: GitStatus | null): string[] {
  if (!status) return [];
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts;
}
