import { describe, expect, it } from 'vitest';
import type { GitBranches, GitStatus } from '@nest/shared';
import { planSync, trackSummary, upstreamLabel } from './gitSync';

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'feature/login',
    upstream: 'origin/feature/login',
    ahead: 0,
    behind: 0,
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
