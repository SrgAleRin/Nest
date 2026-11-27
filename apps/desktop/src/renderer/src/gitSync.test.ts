import { describe, expect, it } from 'vitest';
import type { GitBranches, GitStatus } from '@nest/shared';
import {
  forcePushConfirmation,
  freshGuardReason,
  isRejectedPush,
  planSync,
  planSyncFailure,
  publishTargetConfirmation,
  publishTargetFor,
  syncBusyLabel,
  trackSummary,
  upstreamLabel,
} from './gitSync';

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feature/login',
    upstream: 'origin/feature/login',
    ahead: 0,
    behind: 0,
    unborn: false,
    files: [],
    ...overrides,
  };
}

function branches(overrides: Partial<GitBranches> = {}): GitBranches {
  return {
    current: 'feature/login',
    detached: false,
    unborn: false,
    baseRef: 'main',
    remotes: [
      { name: 'origin', fetchUrl: 'git@example.com:a/b.git', pushUrl: 'git@example.com:a/b.git' },
    ],
    local: [],
    remote: [],
    ...overrides,
  };
}

describe('sync action by state', () => {
  it('publishes when a remote exists but the branch has no upstream', () => {
    const plan = planSync({
      status: status({ upstream: null }),
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect(plan.kind).toBe('publish');
    expect(plan.label).toBe('Publish branch');
    expect(plan.disabledReason).toBeNull();
  });

  it('pushes ahead, pulls behind, fetches when in sync', () => {
    const ahead = planSync({
      status: status({ ahead: 2 }),
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect([ahead.kind, ahead.label]).toEqual(['push', 'Push']);

    const behind = planSync({
      status: status({ behind: 3 }),
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect([behind.kind, behind.label]).toEqual(['pull', 'Pull']);

    const even = planSync({
      status: status(),
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect([even.kind, even.detail]).toEqual(['fetch', 'Up to date with upstream']);
  });

  it('only fetches when the branch diverged', () => {
    const plan = planSync({
      status: status({ ahead: 1, behind: 1 }),
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect(plan.kind).toBe('fetch');
    expect(plan.diverged).toBe(true);
    expect(plan.detail).toContain('Diverged');
  });

  it('explains an unavailable action instead of claiming Up to date', () => {
    const noRemotes = planSync({
      status: status({ upstream: null }),
      branches: branches({ remotes: [] }),
      branchesError: null,
      branchesLoading: false,
    });
    expect(noRemotes.kind).toBeNull();
    expect(noRemotes.disabledReason).toContain('no remotes');

    const detached = planSync({
      status: status({ branch: 'HEAD', upstream: null }),
      branches: branches({ current: null, detached: true }),
      branchesError: null,
      branchesLoading: false,
    });
    expect(detached.disabledReason).toContain('Detached HEAD');

    const unborn = planSync({
      status: status({ upstream: null }),
      branches: branches({ unborn: true }),
      branchesError: null,
      branchesLoading: false,
    });
    expect(unborn.disabledReason).toContain('no commits yet');

    const unknown = planSync({
      status: status(),
      branches: null,
      branchesError: 'git failed',
      branchesLoading: false,
    });
    expect(unknown.kind).toBeNull();
    expect(unknown.detail).not.toContain('Up to date');
    expect(unknown.disabledReason).toContain('git failed');

    const loading = planSync({
      status: status(),
      branches: null,
      branchesError: null,
      branchesLoading: true,
    });
    expect(loading.disabledReason).toBe('Reading branches…');
  });

  it('waits for a status before offering anything', () => {
    const plan = planSync({
      status: null,
      branches: branches(),
      branchesError: null,
      branchesLoading: false,
    });
    expect(plan.kind).toBeNull();
    expect(plan.disabledReason).toContain('status');
  });
});

describe('head labels', () => {
  it('names the upstream and the counters', () => {
    expect(upstreamLabel(status())).toBe('origin/feature/login');
    expect(upstreamLabel(status({ upstream: null }))).toBe('no upstream');
    expect(upstreamLabel(null)).toBe('no upstream');
    expect(trackSummary(status({ ahead: 2, behind: 1 }))).toEqual(['↑2', '↓1']);
    expect(trackSummary(status())).toEqual([]);
  });
});

describe('publish target', () => {
  it('names the remote and the remote branch of a publish', () => {
    const target = publishTargetFor(branches(), status({ upstream: null }));
    expect(target).toEqual({
      remote: 'origin',
      branch: 'feature/login',
      target: 'origin/feature/login',
    });
  });

  it('keeps the remote the branch already tracks', () => {
    const target = publishTargetFor(
      branches({
        remotes: [
          { name: 'fork', fetchUrl: 'a', pushUrl: 'a' },
          { name: 'origin', fetchUrl: 'b', pushUrl: 'b' },
        ],
      }),
      status({ upstream: 'fork/feature/login' }),
    );
    expect(target?.target).toBe('fork/feature/login');
  });

  it('has nothing to name without a branch or without a remote', () => {
    expect(publishTargetFor(branches({ remotes: [] }), status())).toBeNull();
    expect(
      publishTargetFor(branches({ current: null, detached: true }), status({ branch: 'HEAD' })),
    ).toBeNull();
    expect(publishTargetFor(null, status())).toBeNull();
  });

  it('confirms the upstream switch with both names and the untouched upstream', () => {
    const target = publishTargetFor(branches(), status({ upstream: 'origin/main' }))!;
    const request = publishTargetConfirmation({
      branch: 'feature/login',
      upstream: 'origin/main',
      target,
    });
    expect(request.title).toBe('Publish feature/login as origin/feature/login');
    const body = request.body.join(' ');
    expect(body).toContain('tracks origin/main');
    expect(body).toContain('git push -u origin feature/login');
    expect(body).toContain('origin/main is not touched');
    expect(request.acceptLabel).toBe('Publish branch');
    expect(request.destructive).toBe(false);
  });
});

describe('force with lease', () => {
  it('explains the lease and starts on cancel', () => {
    const request = forcePushConfirmation({
      branch: 'feature/login',
      target: 'origin/feature/login',
    });
    expect(request.title).toBe('Force push origin/feature/login');
    expect(request.body.join(' ')).toContain('--force-with-lease');
    expect(request.body.join(' ')).toContain('since your last fetch');
    expect(request.acceptLabel).toBe('Force push with lease');
    expect(request.destructive).toBe(true);
  });
});

describe('failed sync by state', () => {
  const mismatchCode = 'upstream_mismatch';
  const rejected = [
    'git push origin feature/login failed',
    '! [rejected] feature/login -> feature/login (non-fast-forward)',
    'error: failed to push some refs',
  ].join('\n');

  it('offers only an explicit publish when the upstream points elsewhere', () => {
    const failure = planSyncFailure({
      kind: 'push',
      code: mismatchCode,
      message: 'git push origin feature/login failed',
      status: status({ upstream: 'origin/main' }),
      branches: branches(),
    });
    expect(failure.publishTarget?.target).toBe('origin/feature/login');
    expect(failure.summary).toContain('tracks origin/main');
    expect(failure.summary).toContain('Publish it as origin/feature/login');
    expect(failure.savedLocally).toBe(true);
    expect(failure.canForcePush).toBe(false);
  });

  it('keeps a rejected push retryable and offers the lease separately', () => {
    expect(isRejectedPush('git_failed', rejected)).toBe(true);
    expect(isRejectedPush('git_failed', 'nothing staged')).toBe(false);
    expect(isRejectedPush('upstream_mismatch', rejected)).toBe(false);

    const failure = planSyncFailure({
      kind: 'push',
      code: 'git_failed',
      message: rejected,
      status: status(),
      branches: branches(),
    });
    expect(failure.savedLocally).toBe(true);
    expect(failure.canForcePush).toBe(true);
    expect(failure.publishTarget).toBeNull();
    expect(failure.summary).toContain('commit is saved locally');
    expect(failure.summary).toContain('nothing is committed again');
  });

  it('never turns another push failure into a force', () => {
    const failure = planSyncFailure({
      kind: 'push',
      code: 'git_failed',
      message: 'git push failed\nfatal: unable to access the remote',
      status: status(),
      branches: branches(),
    });
    expect(failure.savedLocally).toBe(true);
    expect(failure.canForcePush).toBe(false);
  });

  it('explains a pull that refused to fast-forward', () => {
    const failure = planSyncFailure({
      kind: 'pull',
      code: 'pull_not_fast_forward',
      message: 'The branch has diverged from its upstream',
      status: status({ behind: 1 }),
      branches: branches(),
    });
    expect(failure.summary).toContain('only fast-forwards');
    expect(failure.canForcePush).toBe(false);
    expect(failure.savedLocally).toBe(false);
  });

  it('labels the control while a remote action runs', () => {
    expect(syncBusyLabel('publish')).toBe('Publishing…');
    expect(syncBusyLabel('push')).toBe('Pushing…');
    expect(syncBusyLabel('pull')).toBe('Pulling…');
    expect(syncBusyLabel('fetch')).toBe('Fetching…');
  });
});

describe('destructive guard on a fresh read', () => {
  it('accepts a read that proves the state did not move', () => {
    expect(freshGuardReason({ error: null, stale: false, behind: 0 })).toBeNull();
  });

  it('stops the action when the read failed, stayed stale or moved the branch', () => {
    expect(freshGuardReason({ error: 'git failed', stale: false, behind: 0 })).toContain(
      'git failed',
    );
    expect(freshGuardReason({ error: null, stale: true, behind: 0 })).toContain('kept changing');
    expect(freshGuardReason({ error: null, stale: false, behind: 2 })).toContain(
      '2 commits behind its upstream',
    );
    expect(freshGuardReason({ error: null, stale: false, behind: 1 })).toContain('1 commit behind');
  });
});
