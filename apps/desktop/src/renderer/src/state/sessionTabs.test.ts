import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from '@nest/shared';
import { forgetSession, rememberSession, resolveSelectedSession, type SessionTabs } from './sessionTabs';

function session(id: string, taskId: string, status: SessionStatus = 'exited'): Session {
  return {
    id,
    taskId,
    harnessId: 'opencode',
    title: id,
    status,
    cwd: 'C:/repo',
    exitCode: null,
    harnessSessionId: null,
    resumeMode: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const sessions = [
  session('a1', 'A', 'exited'),
  session('a2', 'A', 'running'),
  session('a3', 'A', 'exited'),
  session('b1', 'B'),
];

describe('selected tab per task', () => {
  it('restores the tab that was selected in a task after A → B → A', () => {
    let tabs: SessionTabs = {};
    tabs = rememberSession(tabs, 'A', 'a1');
    tabs = rememberSession(tabs, 'B', 'b1');

    expect(resolveSelectedSession(tabs, sessions, 'B')).toBe('b1');
    expect(resolveSelectedSession(tabs, sessions, 'A')).toBe('a1');
  });

  it('falls back only when the remembered tab is really gone', () => {
    const tabs = rememberSession({}, 'A', 'a2');
    const withoutA2 = sessions.filter((entry) => entry.id !== 'a2');

    expect(resolveSelectedSession(tabs, sessions, 'A')).toBe('a2');
    // The newest live tab, else the newest one, is the pre-existing default.
    expect(resolveSelectedSession(tabs, withoutA2, 'A')).toBe('a3');
    expect(resolveSelectedSession(tabs, [sessions[0]!], 'A')).toBe('a1');
  });

  it('defaults to a live tab and then to the newest one', () => {
    expect(resolveSelectedSession({}, sessions, 'A')).toBe('a2');
    expect(
      resolveSelectedSession({}, [session('x', 'A', 'starting'), session('y', 'A', 'exited')], 'A'),
    ).toBe('y');
  });

  it('has no tab without a task or without sessions', () => {
    expect(resolveSelectedSession({ A: 'a1' }, sessions, null)).toBeNull();
    expect(resolveSelectedSession({}, sessions, 'missing')).toBeNull();
  });

  it('forgets a closed tab so the fallback is explicit', () => {
    const tabs = rememberSession({}, 'A', 'a1');
    expect(forgetSession(tabs, 'A', 'a2')).toBe(tabs);
    expect(forgetSession(tabs, 'A', 'a1')).toEqual({});
  });
});
