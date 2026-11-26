import type { Session } from '@nest/shared';

/**
 * The tab selected in each task. A single global id loses A's tab as soon as B
 * is opened, so switching A → B → A landed on the wrong terminal.
 */
export type SessionTabs = Record<string, string>;

export function rememberSession(
  tabs: SessionTabs,
  taskId: string,
  sessionId: string,
): SessionTabs {
  if (tabs[taskId] === sessionId) return tabs;
  return { ...tabs, [taskId]: sessionId };
}

/** Drops a memory that points at a closed session so the fallback is explicit. */
export function forgetSession(
  tabs: SessionTabs,
  taskId: string,
  sessionId: string,
): SessionTabs {
  if (tabs[taskId] !== sessionId) return tabs;
  const next = { ...tabs };
  delete next[taskId];
  return next;
}

function isLive(session: Session): boolean {
  return session.status === 'running' || session.status === 'idle';
}

/**
 * Restores the tab the user picked in this task. The default (newest live tab,
 * else the newest one) is only used when that tab is really gone.
 */
export function resolveSelectedSession(
  tabs: SessionTabs,
  sessions: readonly Session[],
  taskId: string | null,
): string | null {
  if (!taskId) return null;
  const list = sessions.filter((session) => session.taskId === taskId);
  if (list.length === 0) return null;

  const remembered = tabs[taskId];
  if (remembered && list.some((session) => session.id === remembered)) return remembered;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const candidate = list[index];
    if (candidate && isLive(candidate)) return candidate.id;
  }
  return list[list.length - 1]?.id ?? null;
}
