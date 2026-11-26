import { describe, expect, it } from 'vitest';
import type { HarnessProfile, TaskPreview } from '@nest/shared';
import {
  baseRefLabel,
  blockedReason,
  defaultHarnessId,
  startFailureMessage,
  taskToSelect,
} from './newTask';

function profile(id: string, available: boolean): HarnessProfile {
  return {
    id: id as HarnessProfile['id'],
    label: id,
    description: '',
    command: id,
    args: [],
    resumeArgs: [],
    available,
    source: 'builtin',
  };
}

const harnesses = [profile('claude', false), profile('codex', true), profile('shell', true)];

describe('default harness profile', () => {
  it('shows the first available profile when the preference is "ask"', () => {
    expect(defaultHarnessId(harnesses, 'ask')).toBe('codex');
  });

  it('keeps a specific default when that profile is available', () => {
    expect(defaultHarnessId(harnesses, 'shell')).toBe('shell');
  });

  it('falls back when the preferred profile is hidden or not installed', () => {
    // `claude` is in the list but not installed on this machine.
    expect(defaultHarnessId(harnesses, 'claude')).toBe('codex');
    // Hidden profiles are not passed in at all.
    expect(defaultHarnessId([profile('codex', true)], 'opencode')).toBe('codex');
  });

  it('returns null when no profile is left', () => {
    expect(defaultHarnessId([], 'ask')).toBeNull();
  });
});

describe('dialog summary', () => {
  const preview: TaskPreview = {
    branch: 'nest/fix-x',
    slug: 'fix-x',
    workspacePath: 'C:/worktrees/repo/fix-x',
    baseRef: 'origin/main',
    baseSource: 'project',
    baseAvailable: true,
  };

  it('labels the effective base and where it came from', () => {
    expect(baseRefLabel(preview)).toBe('origin/main · project default');
    expect(baseRefLabel({ ...preview, baseSource: 'explicit' })).toBe(
      'origin/main · from this dialog',
    );
    expect(baseRefLabel({ ...preview, baseRef: null, baseSource: 'current' })).toBe('—');
  });

  it('blocks submitting until there is a title and a usable base', () => {
    expect(blockedReason(preview, null, '  ')).toBe('Give the task a title first');
    expect(blockedReason(preview, null, 'Fix x')).toBeNull();
    expect(blockedReason({ ...preview, baseAvailable: false }, null, 'Fix x')).toContain(
      'does not exist',
    );
    expect(blockedReason({ ...preview, baseRef: null }, null, 'Fix x')).toContain('No base branch');
    expect(blockedReason(null, 'project not found', 'Fix x')).toBe('project not found');
    // Before the first preview answer arrives there is nothing to complain about.
    expect(blockedReason(null, null, 'Fix x')).toBeNull();
  });
});

describe('focus after creation', () => {
  it('selects the new task only when the selection did not change', () => {
    expect(taskToSelect('checkout', 'checkout', 'new')).toBe('new');
  });

  it('leaves the user where they moved to', () => {
    expect(taskToSelect('other', 'checkout', 'new')).toBe('other');
    expect(taskToSelect(null, 'checkout', 'new')).toBe('new');
  });
});

describe('failed start step', () => {
  it('keeps the task id out of the message and names the profile', () => {
    expect(startFailureMessage('fake', 'spawn failed')).toBe('fake did not start: spawn failed');
  });
});
