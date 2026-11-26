import { describe, expect, it } from 'vitest';
import type { Session } from '@nest/shared';
import { collectActivity } from './activity';

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'status'>): Session {
  return {
    taskId: 'task',
    harnessId: 'claude',
    title: 'Claude Code',
    cwd: '/repo',
    exitCode: null,
    harnessSessionId: null,
    resumeMode: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('collectActivity', () => {
  it('separates working, waiting and unread finished sessions', () => {
    const sessions = [
      session({ id: 'run', status: 'running', updatedAt: '2026-01-01T00:00:04.000Z' }),
      session({ id: 'wait', status: 'idle', updatedAt: '2026-01-01T00:00:03.000Z' }),
      session({
        id: 'done',
        status: 'exited',
        updatedAt: '2026-01-01T00:00:02.000Z',
      }),
      session({ id: 'seen', status: 'exited' }),
    ];

    const result = collectActivity({
      sessions,
      unread: { done: 1 },
      selectedSessionId: null,
    });

    expect(result.working.map((item) => item.session.id)).toEqual(['run']);
    expect(result.waiting.map((item) => item.session.id)).toEqual(['wait']);
    expect(result.finished.map((item) => item.session.id)).toEqual(['done']);
  });

  it('skips the open tab and idle plain shells', () => {
    const sessions = [
      session({ id: 'open', status: 'idle' }),
      session({ id: 'shell', status: 'idle', harnessId: 'shell' }),
    ];

    const result = collectActivity({
      sessions,
      unread: {},
      selectedSessionId: 'open',
    });

    expect(result.waiting).toEqual([]);
  });

  it('sorts each group newest first', () => {
    const sessions = [
      session({ id: 'older', status: 'running', updatedAt: '2026-01-01T00:00:01.000Z' }),
      session({ id: 'newer', status: 'running', updatedAt: '2026-01-01T00:00:02.000Z' }),
    ];

    const result = collectActivity({ sessions, unread: {}, selectedSessionId: null });

    expect(result.working.map((item) => item.session.id)).toEqual(['newer', 'older']);
  });
});
