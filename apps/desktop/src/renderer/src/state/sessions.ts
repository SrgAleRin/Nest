import type { Session } from '@nest/shared';

/**
 * Session rows as the renderer knows them. Every mutation produces the next
 * state from the previous one, so an answer that arrives late can only touch the
 * rows it actually changed. Rows are keyed by id instead of kept in a plain
 * array, because a late `sessions.list` snapshot would otherwise replace newer
 * events: it would resurrect a tab that was closed meanwhile and drop one that
 * started meanwhile.
 */
interface Entry {
  session: Session;
  /** Local revision that last changed this row; older snapshots lose to it. */
  rev: number;
}

export interface SessionsState {
  entries: Record<string, Entry>;
  /** Tab order: the database order, with sessions started meanwhile appended. */
  order: string[];
  /** Ids removed locally, with the revision that removed them. */
  removed: Record<string, number>;
  /** Monotonic local revision counter. */
  rev: number;
}

export const emptySessions: SessionsState = { entries: {}, order: [], removed: {}, rev: 0 };

/** The revision a `sessions.list` request starts from; pass it back on arrival. */
export function snapshotBaseline(state: SessionsState): number {
  return state.rev;
}

export function listSessions(state: SessionsState): Session[] {
  return state.order
    .map((id) => state.entries[id]?.session)
    .filter((session): session is Session => session !== undefined);
}

export function sessionById(state: SessionsState, sessionId: string): Session | null {
  return state.entries[sessionId]?.session ?? null;
}

/**
 * A start or status event. A closed session never comes back: a `session:status`
 * emitted while the close was in flight must not reopen its tab.
 */
export function upsertSession(state: SessionsState, session: Session): SessionsState {
  if (state.removed[session.id] !== undefined) return state;
  const existing = state.entries[session.id];
  const rev = state.rev + 1;
  return {
    entries: { ...state.entries, [session.id]: { session, rev } },
    order: existing ? state.order : [...state.order, session.id],
    removed: state.removed,
    rev,
  };
}

export function upsertSessions(state: SessionsState, sessions: readonly Session[]): SessionsState {
  return sessions.reduce(upsertSession, state);
}

/** A local close: drop the row and remember it, so late data cannot restore it. */
export function removeSession(state: SessionsState, sessionId: string): SessionsState {
  const rev = state.rev + 1;
  const entries = { ...state.entries };
  delete entries[sessionId];
  return {
    entries,
    order: state.order.filter((id) => id !== sessionId),
    removed: { ...state.removed, [sessionId]: rev },
    rev,
  };
}

/**
 * Merge a snapshot taken from `baseline`. Rows closed after the request started
 * stay closed, rows that appeared or changed after it keep their newer local
 * value, and everything else comes from the snapshot.
 */
export function applySnapshot(
  state: SessionsState,
  rows: readonly Session[],
  baseline: number,
): SessionsState {
  const rev = state.rev + 1;
  const entries: Record<string, Entry> = {};
  const order: string[] = [];

  for (const row of rows) {
    const removedAt = state.removed[row.id];
    if (removedAt !== undefined && removedAt > baseline) continue;
    const existing = state.entries[row.id];
    entries[row.id] = existing && existing.rev > baseline ? existing : { session: row, rev };
    order.push(row.id);
  }

  for (const id of state.order) {
    if (entries[id]) continue;
    const entry = state.entries[id];
    // Not in the snapshot and untouched since the request: it was deleted by
    // something this window did not do, so the snapshot wins and it goes away.
    if (!entry || entry.rev <= baseline) continue;
    entries[id] = entry;
    order.push(id);
  }

  // Every tombstone at or below this baseline is already reflected by the
  // snapshot, so keeping it would only grow the map.
  const removed: Record<string, number> = {};
  for (const [id, removedAt] of Object.entries(state.removed)) {
    if (removedAt > baseline) removed[id] = removedAt;
  }

  return { entries, order, removed, rev };
}
