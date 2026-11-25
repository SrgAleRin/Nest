import { describe, expect, it } from 'vitest';
import { sessionEndEffect, unreadTotal } from './notifications';

const base = {
  session: {
    id: 'session-1',
    taskId: 'task-1',
    title: 'Fake harness 1',
    status: 'exited' as const,
    exitCode: 0,
  },
  task: { title: 'Fix terminal', branch: 'nest/fix-terminal', kind: 'worktree' as const },
};

describe('session end policy', () => {
  it('does nothing while the ended session is open and the window is focused', () => {
    expect(sessionEndEffect({ ...base, viewingSessionId: 'session-1', focused: true })).toEqual({
      markUnread: false,
      notification: null,
    });
  });

  it('marks another open tab unread without a toast when the window is focused', () => {
    expect(sessionEndEffect({ ...base, viewingSessionId: 'session-2', focused: true })).toEqual({
      markUnread: true,
      notification: null,
    });
  });

  it('reports a finished session when the window is in the background', () => {
    expect(sessionEndEffect({ ...base, viewingSessionId: null, focused: false })).toEqual({
      markUnread: true,
      notification: {
        title: 'Fake harness 1 finished',
        body: 'Fix terminal · nest/fix-terminal',
        urgent: false,
      },
    });
  });

  it('includes the exit code and urgency for failures', () => {
    const effect = sessionEndEffect({
      ...base,
      session: { ...base.session, status: 'failed', exitCode: 2 },
      viewingSessionId: 'session-2',
      focused: false,
    });
    expect(effect.notification).toEqual({
      title: 'Fake harness 1 failed (exit 2)',
      body: 'Fix terminal · nest/fix-terminal',
      urgent: true,
    });
  });

  it('falls back to the workspace id and main checkout wording', () => {
    const effect = sessionEndEffect({
      ...base,
      task: { title: 'main checkout', branch: 'main', kind: 'checkout' },
      viewingSessionId: null,
      focused: false,
    });
    expect(effect.notification?.body).toBe('main checkout · main');

    const noTask = sessionEndEffect({
      ...base,
      task: null,
      viewingSessionId: null,
      focused: false,
    });
    expect(noTask.notification?.body).toBe('task-1');
  });

  it('sums unread counts', () => {
    expect(unreadTotal({})).toBe(0);
    expect(unreadTotal({ a: 1, b: 2 })).toBe(3);
  });
});
