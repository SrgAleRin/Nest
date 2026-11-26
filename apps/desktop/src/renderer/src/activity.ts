import type { Session } from '@nest/shared';

export type ActivityKind = 'working' | 'waiting' | 'finished';

export interface ActivityItem {
  kind: ActivityKind;
  session: Session;
}

export interface ActivityGroups {
  working: ActivityItem[];
  waiting: ActivityItem[];
  finished: ActivityItem[];
}

/**
 * Sessions that deserve attention in the sidebar.
 *
 * - `working`: the PTY is producing output right now.
 * - `waiting`: an agent went quiet while still alive, which usually means it is
 *   asking a question. The open tab and plain shells are skipped, since the
 *   user is already looking at the former and the latter is not asking
 *   anything.
 * - `finished`: the process ended while the user was elsewhere.
 */
export function collectActivity(input: {
  sessions: Session[];
  unread: Record<string, number>;
  selectedSessionId: string | null;
}): ActivityGroups {
  const working: ActivityItem[] = [];
  const waiting: ActivityItem[] = [];
  const finished: ActivityItem[] = [];

  for (const session of input.sessions) {
    if (session.status === 'starting' || session.status === 'running') {
      working.push({ kind: 'working', session });
      continue;
    }

    if (
      session.status === 'idle' &&
      session.id !== input.selectedSessionId &&
      session.harnessId !== 'shell'
    ) {
      waiting.push({ kind: 'waiting', session });
      continue;
    }

    if (
      (session.status === 'exited' || session.status === 'failed') &&
      (input.unread[session.id] ?? 0) > 0
    ) {
      finished.push({ kind: 'finished', session });
    }
  }

  const newestFirst = (left: ActivityItem, right: ActivityItem): number =>
    right.session.updatedAt.localeCompare(left.session.updatedAt);

  return {
    working: working.sort(newestFirst),
    waiting: waiting.sort(newestFirst),
    finished: finished.sort(newestFirst),
  };
}
