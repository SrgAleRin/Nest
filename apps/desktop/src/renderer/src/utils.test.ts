import { describe, expect, it } from 'vitest';
import type { Session } from '@nest/shared';
import { resumeActionLabel, resumeTone } from './utils';

function session(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    taskId: 't1',
    harnessId: 'opencode',
    title: 'OpenCode',
    status: 'exited',
    cwd: 'C:/repo',
    exitCode: 0,
    harnessSessionId: null,
    resumeMode: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resume labels', () => {
  it('promises exact only for a verified conversation id', () => {
    const exact = session({ harnessSessionId: 'ses-1', resumeMode: 'exact' });
    expect(resumeTone(exact)).toBe('exact');
    expect(resumeActionLabel(exact)).toBe('Resume exact');
  });

  it('marks a heuristic id as unverified', () => {
    const heuristic = session({ harnessSessionId: 'ses-1', resumeMode: 'heuristic' });
    expect(resumeTone(heuristic)).toBe('heuristic');
    expect(resumeActionLabel(heuristic)).toBe('Resume unverified');
  });

  it('falls back to latest without an id', () => {
    const latest = session({});
    expect(resumeTone(latest)).toBe('latest');
    expect(resumeActionLabel(latest)).toBe('Resume latest');
  });
});
