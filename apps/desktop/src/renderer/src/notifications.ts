import type { Session, Task } from '@nest/shared';

export interface SessionEndInput {
  session: Pick<Session, 'id' | 'taskId' | 'title' | 'status' | 'exitCode'>;
  task: Pick<Task, 'title' | 'branch' | 'kind'> | null;
  /** Session the user is looking at right now. */
  viewingSessionId: string | null;
  /** Window is focused and visible, so a toast would be redundant. */
  focused: boolean;
}

export interface SessionEndEffect {
  markUnread: boolean;
  notification: { title: string; body: string; urgent: boolean } | null;
}

/**
 * Policy for a session that just ended: bump its unread badge when it is not
 * the open tab, and raise a system notification when the window is not focused.
 */
export function sessionEndEffect(input: SessionEndInput): SessionEndEffect {
  const { session, task, viewingSessionId, focused } = input;
  const failed = session.status === 'failed';
  const where = task ? (task.kind === 'checkout' ? 'main checkout' : task.title) : session.taskId;
  const title = failed
    ? `${session.title} failed${session.exitCode === null ? '' : ` (exit ${session.exitCode})`}`
    : `${session.title} finished`;

  return {
    markUnread: viewingSessionId !== session.id,
    notification: focused
      ? null
      : {
          title,
          body: task ? `${where} · ${task.branch}` : where,
          urgent: failed,
        },
  };
}

export function unreadTotal(unread: Record<string, number>): number {
  return Object.values(unread).reduce((sum, count) => sum + count, 0);
}
