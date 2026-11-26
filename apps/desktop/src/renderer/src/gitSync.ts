import type { GitBranches, GitStatus } from '@nest/shared';
import type { ConfirmRequest } from './confirm';

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

/** The control says what it is doing while a remote operation is in flight. */
const BUSY_LABELS: Record<SyncKind, string> = {
  publish: 'Publishing…',
  push: 'Pushing…',
  pull: 'Pulling…',
  fetch: 'Fetching…',
};

export function syncBusyLabel(kind: SyncKind): string {
  return BUSY_LABELS[kind];
}

/** The `remote/branch` a publish creates; the upstream switch names both. */
export interface PublishTarget {
  remote: string;
  branch: string;
  /** Exactly `remote/branch`. */
  target: string;
}

/**
 * The remote and branch `Publish branch` pushes to. It mirrors core's
 * `pushRemote`: the remote of the current upstream when it exists, `origin`
 * otherwise, then the first remote. `null` when there is nothing to name.
 */
export function publishTargetFor(
  branches: GitBranches | null,
  status: GitStatus | null,
): PublishTarget | null {
  const branch = status?.branch ?? branches?.current ?? null;
  if (!branch || branch === 'HEAD' || branches?.detached) return null;
  const remotes = (branches?.remotes ?? []).map((remote) => remote.name);
  const first = remotes[0];
  if (!first) return null;
  const fromUpstream = status?.upstream?.split('/')[0];
  const remote = fromUpstream && remotes.includes(fromUpstream) ? fromUpstream : null;
  const name = remote ?? (remotes.includes('origin') ? 'origin' : first);
  return { remote: name, branch, target: `${name}/${branch}` };
}

/**
 * The confirmation of an upstream switch: it names the upstream the branch
 * tracks now and the exact `remote/branch` the publish creates, and says the
 * old upstream is left alone. Nothing pushes before this is accepted.
 */
export function publishTargetConfirmation(input: {
  branch: string;
  upstream: string | null;
  target: PublishTarget;
}): ConfirmRequest {
  const current = input.upstream ?? 'no upstream';
  return {
    title: `Publish ${input.branch} as ${input.target.target}`,
    body: [
      `This branch tracks ${current}, so a plain push would update ${current} instead.`,
      `Publishing pushes ${input.branch} to ${input.target.target} (git push -u ${input.target.remote} ${input.branch}) and makes ${input.target.target} the upstream of this branch.`,
      `${current} is not touched.`,
    ],
    acceptLabel: 'Publish branch',
    destructive: false,
  };
}

/**
 * The confirmation of `Force push with lease`: a rewrite of the remote branch
 * that only succeeds while nobody else pushed to it since the last fetch.
 */
export function forcePushConfirmation(input: { branch: string; target: string }): ConfirmRequest {
  return {
    title: `Force push ${input.target}`,
    body: [
      `Replaces ${input.target} with the local ${input.branch} (git push --force-with-lease).`,
      'The lease only allows this while nobody else pushed to that remote branch since your last fetch; otherwise git refuses and the remote keeps its commits.',
      'Commits that exist only on the remote are dropped when the rewrite goes through.',
    ],
    acceptLabel: 'Force push with lease',
    destructive: true,
  };
}

/** What a failed remote action means for the panel, by state and by error code. */
export interface SyncFailure {
  kind: SyncKind;
  code: string;
  /** Core's message, including the git details; shown unchanged as the reason. */
  message: string;
  /** One sentence the panel puts above the reason. */
  summary: string;
  /** The branch tracks another upstream: only an explicit publish retries it. */
  publishTarget: PublishTarget | null;
  /** The commit exists locally, so only the push needs a retry. */
  savedLocally: boolean;
  /** Only a rejected push can end in a lease-guarded force, never by itself. */
  canForcePush: boolean;
}

/** A non-fast-forward push: git's own wording, with the push's `git_failed` code. */
export function isRejectedPush(code: string, message: string): boolean {
  if (code !== 'git_failed') return false;
  return /rejected|non-fast-forward|fetch first/i.test(message);
}

/**
 * Why a destructive remote action must not run even after a fresh read. A check
 * that cannot see the current state, or a branch that moved away from its
 * upstream, both stop the action before it touches the remote.
 */
export function freshGuardReason(input: {
  /** The fresh read failed with this message. */
  error: string | null;
  /** The read lost to a newer invalidation, so the snapshot is still stale. */
  stale: boolean;
  /** Commits the branch is behind its upstream right now. */
  behind: number;
}): string | null {
  if (input.error) return `the fresh git status could not be read (${input.error})`;
  if (input.stale) return 'the git status kept changing while it was read';
  if (input.behind > 0) {
    return `the branch moved: it is now ${input.behind} commit${input.behind === 1 ? '' : 's'} behind its upstream`;
  }
  return null;
}

/**
 * Reads a failed `git.push`/`git.fetch`/`git.pull` into what the panel must
 * offer: the reason, a retry that pushes only, and — for a rejected push — a
 * separate lease-guarded force that is never run automatically.
 */
export function planSyncFailure(input: {
  kind: SyncKind;
  code: string;
  message: string;
  status: GitStatus | null;
  branches: GitBranches | null;
}): SyncFailure {
  const base = {
    kind: input.kind,
    code: input.code,
    message: input.message,
    summary: '',
    publishTarget: null,
    savedLocally: false,
    canForcePush: false,
  } satisfies SyncFailure;
  const branch = input.status?.branch ?? 'this branch';
  const upstream = input.status?.upstream ?? null;

  if (input.code === 'upstream_mismatch') {
    const target = publishTargetFor(input.branches, input.status);
    return {
      ...base,
      summary: target
        ? `Push stopped: ${branch} tracks ${upstream ?? 'another upstream'}. Publish it as ${target.target} instead; ${upstream ?? 'that upstream'} is left untouched.`
        : `Push stopped: ${branch} tracks ${upstream ?? 'another upstream'}, and Nest does not rewrite an upstream you did not choose.`,
      publishTarget: target,
      savedLocally: true,
    };
  }

  if (input.kind === 'pull' && input.code === 'pull_not_fast_forward') {
    return {
      ...base,
      summary:
        'Pull stopped: the branch and its upstream have diverged, and Nest only fast-forwards.',
    };
  }

  if (isRejectedPush(input.code, input.message)) {
    return {
      ...base,
      summary:
        'Push rejected: the remote has commits this branch does not have. The commit is saved locally; only the push needs a retry, and nothing is committed again.',
      savedLocally: true,
      canForcePush: true,
    };
  }

  if (input.kind === 'push' || input.kind === 'publish') {
    return {
      ...base,
      summary: 'Push failed: the commit is saved locally, so only the push needs a retry.',
      savedLocally: true,
    };
  }

  return {
    ...base,
    summary:
      input.kind === 'fetch'
        ? 'Fetch failed: the upstream state is still the last one read here.'
        : 'Pull failed: the working tree and the upstream are unchanged.',
  };
}
