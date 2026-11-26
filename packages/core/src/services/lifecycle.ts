import { NestError } from '../errors.js';

/**
 * How long Nest waits for a PTY to confirm exit before it gives up. Stopping a
 * CLI agent can take a moment (it may flush state or ask about unsaved work),
 * but a deletion must never hang forever.
 */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

/** The slice of SessionService that stop-and-verify needs. */
export interface SessionStopper {
  /** Ids of sessions whose process is still alive for these tasks. */
  liveSessions(taskIds: readonly string[]): string[];
  /** Asks one session to stop; safe to call when it already exited. */
  requestStop(sessionId: string): void;
  /** Whether the session still has a live process. */
  isLive(sessionId: string): boolean;
}

export interface StopSessionsOptions {
  /** Extra wait budget in milliseconds. */
  timeoutMs?: number;
  /** What is being removed, used in the error message ("task", "project"). */
  subject?: string;
}

/**
 * Stops every live session of the given tasks and waits for confirmed process
 * exit. Git files and SQLite rows cannot be updated in one transaction, so a
 * caller must not delete anything unless this resolves: deleting rows under a
 * live PTY leaves a process the UI can no longer control.
 */
export async function stopSessionsAndWait(
  sessions: SessionStopper,
  taskIds: readonly string[],
  options: StopSessionsOptions = {},
): Promise<void> {
  const ids = sessions.liveSessions(taskIds);
  if (ids.length === 0) return;

  for (const id of ids) sessions.requestStop(id);

  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const subject = options.subject ?? 'workspace';
  const confirmed = await waitFor(
    () => ids.every((id) => !sessions.isLive(id)),
    timeoutMs,
  );
  if (confirmed) return;

  const pending = ids.filter((id) => sessions.isLive(id));
  throw new NestError(
    'sessions_not_stopped',
    `${pending.length} session${pending.length === 1 ? '' : 's'} did not stop within ` +
      `${Math.round(timeoutMs / 1000)} s, so the ${subject} was kept`,
    `Session ids still running: ${pending.join(', ')}\n\n` +
      'Close those terminals (or press Stop) and retry the removal.',
  );
}

/** Polls `check` until it returns true or the budget runs out. */
export async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
