import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from '@nest/shared';
import {
  applySnapshot,
  emptySessions,
  listSessions,
  removeSession,
  sessionById,
  snapshotBaseline,
  upsertSession,
  upsertSessions,
} from './sessions';

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    taskId: 't1',
    harnessId: 'opencode',
    title: id,
    status: 'running' as SessionStatus,
    cwd: 'C:/repo',
    exitCode: null,
    harnessSessionId: null,
    resumeMode: 'latest',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ids(sessions: readonly Session[]): string[] {
  return sessions.map((entry) => entry.id);
}

describe('session rows', () => {
  it('keeps snapshot order and appends sessions started later', () => {
    const state = upsertSessions(emptySessions, [session('a'), session('b'), session('c')]);
    expect(ids(listSessions(state))).toEqual(['a', 'b', 'c']);
    expect(sessionById(state, 'b')?.id).toBe('b');
  });
});

describe('late sessions.list answers', () => {
  it('does not resurrect a row closed while the request was in flight', () => {
    const loaded = upsertSessions(emptySessions, [session('a'), session('b')]);
    const baseline = snapshotBaseline(loaded);

    // The close RPC returns before the list answer does.
    const closed = removeSession(loaded, 'b');
    const merged = applySnapshot(closed, [session('a'), session('b')], baseline);

    expect(ids(listSessions(merged))).toEqual(['a']);
  });

  it('does not drop a session that started while the request was in flight', () => {
    const loaded = upsertSessions(emptySessions, [session('a')]);
    const baseline = snapshotBaseline(loaded);

    const started = upsertSession(loaded, session('b'));
    const merged = applySnapshot(started, [session('a')], baseline);

    expect(ids(listSessions(merged))).toEqual(['a', 'b']);
  });

  it('keeps a newer status event over the older snapshot row', () => {
    const initial = upsertSessions(emptySessions, [session('a', { status: 'starting' })]);
    const baseline = snapshotBaseline(initial);

    const running = upsertSession(initial, session('a', { status: 'running', exitCode: null }));
    const merged = applySnapshot(running, [session('a', { status: 'starting' })], baseline);

    expect(sessionById(merged, 'a')?.status).toBe('running');
  });

  it('removes rows the snapshot no longer has after the request started', () => {
    const loaded = upsertSessions(emptySessions, [session('a'), session('b')]);
    // Nothing local happened, so the snapshot is authoritative.
    const merged = applySnapshot(loaded, [session('b')], snapshotBaseline(loaded));

    expect(ids(listSessions(merged))).toEqual(['b']);
  });

  it('survives two concurrent closes plus a status and a start event', () => {
    const loaded = upsertSessions(emptySessions, [session('a'), session('b'), session('c')]);
    const baseline = snapshotBaseline(loaded);

    // Both close RPCs resolve, then a status event for c and a new session d.
    let state = removeSession(loaded, 'a');
    state = removeSession(state, 'b');
    state = upsertSession(state, session('c', { status: 'exited', exitCode: 0 }));
    state = upsertSession(state, session('d'));

    // The list answer was computed before any of that.
    const merged = applySnapshot(
      state,
      [session('a'), session('b'), session('c', { status: 'running' })],
      baseline,
    );

    expect(ids(listSessions(merged))).toEqual(['c', 'd']);
    expect(sessionById(merged, 'c')?.status).toBe('exited');
    expect(Object.keys(merged.removed)).toEqual(['a', 'b']);

    // The tombstones stay until a snapshot taken after them arrives; that one
    // already reflects the deletes and clears them.
    const fresh = applySnapshot(merged, [session('c'), session('d')], snapshotBaseline(merged));
    expect(ids(listSessions(fresh))).toEqual(['c', 'd']);
    expect(fresh.removed).toEqual({});
  });
});

describe('events for removed sessions', () => {
  it('ignores a status event for a session closed meanwhile', () => {
    const loaded = upsertSessions(emptySessions, [session('a')]);
    const closed = removeSession(loaded, 'a');
    const late = upsertSession(closed, session('a', { status: 'exited' }));

    expect(late).toBe(closed);
    expect(ids(listSessions(late))).toEqual([]);
  });

  it('accepts the row again once a snapshot has cleared the tombstone', () => {
    const loaded = upsertSessions(emptySessions, [session('a')]);
    const closed = removeSession(loaded, 'a');
    const merged = applySnapshot(closed, [], snapshotBaseline(closed));
    expect(merged.removed).toEqual({});
  });
});
