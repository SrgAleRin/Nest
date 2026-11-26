import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, nowIso, TerminalReplay, type NestEvent, type SessionDataChunk } from '@nest/shared';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { HarnessDiscovery } from '../src/harness/discovery.js';
import { HarnessRegistry } from '../src/harness/registry.js';
import { ProjectService } from '../src/services/projects.js';
import {
  SessionService,
  type PtyProcess,
  type SessionServiceOptions,
} from '../src/services/sessions.js';
import { TaskService } from '../src/services/tasks.js';

/**
 * In-process PTY. Tests decide exactly when output arrives and when the
 * process reports `onExit`, so a stop can be made to race a quit.
 */
class FakePty implements PtyProcess {
  readonly written: string[] = [];
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
  }

  /** Pushes output as the PTY would. */
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  /** Reports the exit; `kill()` deliberately does not, so it can be delayed. */
  exit(exitCode = 0): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

interface Fixture {
  root: string;
  db: Db;
  projects: ProjectService;
  tasks: TaskService;
  sessions: SessionService;
  events: NestEvent[];
  ptys: FakePty[];
  taskId: string;
}

type DataEvent = Extract<NestEvent, { type: 'session:data' }>;

// The fake profile only exists while this script is on disk; PTYs are stubbed.
const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  delete process.env.NEST_AUTO_RESUME;
});

function createFixture(options: SessionServiceOptions = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nest-stream-'));
  const db = openDatabase(path.join(root, 'nest.db'));
  migrate(db);

  const workspace = path.join(root, 'repo');
  mkdirSync(workspace, { recursive: true });

  const projectId = newId();
  const taskId = newId();
  const timestamp = nowIso();
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    'repo',
    workspace,
    timestamp,
  );
  db.prepare(
    `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
     VALUES (?, ?, 'checkout', '@main', 'repo', 'main', ?, 'active', ?, ?)`,
  ).run(taskId, projectId, workspace, timestamp, timestamp);

  const projects = new ProjectService(db);
  const tasks = new TaskService(db, projects, path.join(root, 'worktrees'));
  const harnesses = new HarnessRegistry({ fakeHarnessScript });
  const discovery = new HarnessDiscovery({
    homeDir: root,
    env: {},
    // No child processes: these tests never resolve a conversation id.
    run: async () => '',
  });
  const events: NestEvent[] = [];
  const ptys: FakePty[] = [];
  const sessions = new SessionService(
    db,
    tasks,
    harnesses,
    discovery,
    (event) => events.push(event),
    {
      snapshotIntervalMs: 0,
      ...options,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    },
  );

  const fixture: Fixture = { root, db, projects, tasks, sessions, events, ptys, taskId };
  cleanup.push(() => {
    try {
      fixture.sessions.shutdownAll();
    } catch {
      // the database may already be closed
    }
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });
  return fixture;
}

/** Restarts on the same database, the way the next app launch would. */
function restart(fixture: Fixture, options: SessionServiceOptions = {}): SessionService {
  const ptys = fixture.ptys;
  const sessions = new SessionService(
    fixture.db,
    fixture.tasks,
    new HarnessRegistry({ fakeHarnessScript }),
    new HarnessDiscovery({ homeDir: fixture.root, env: {}, run: async () => '' }),
    (event) => fixture.events.push(event),
    {
      snapshotIntervalMs: 0,
      ...options,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    },
  );
  // The restarted service owns fresh discovery timers; stop them before the
  // database closes, the way the cleanup of a fresh fixture does.
  cleanup.push(() => {
    try {
      sessions.shutdownAll();
    } catch {
      // the database may already be closed
    }
  });
  sessions.recoverStale();
  sessions.resumePending();
  return sessions;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Longer than the batching window, so every pending chunk has been flushed. */
const flushOutput = (): Promise<void> => sleep(50);

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

function dataEvents(events: NestEvent[]): DataEvent[] {
  return events.filter((event): event is DataEvent => event.type === 'session:data');
}

function chunksOf(events: DataEvent[]): SessionDataChunk[] {
  return events.map((event) => ({ data: event.data, start: event.start, end: event.end }));
}

describe('session output stream', () => {
  it('joins history and live output exactly once, in order, after reload and remount', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;
    const parts = Array.from({ length: 7 }, (_, index) => `<${index}>`);
    const payload = parts.join('');
    let delivered = dataEvents(fixture.events).length;

    // Output while no terminal is mounted reaches nobody: it stays in the
    // session stream and is rebuilt from the snapshot later.
    pty.emit(parts[0]!);
    pty.emit(parts[1]!);
    await flushOutput();
    expect(fixture.sessions.snapshot(session.id).position).toBe(parts[0]!.length * 2);
    expect(delivered).toBe(0);

    // Reload: subscribe first, buffer, then fetch the snapshot.
    const writes: string[] = [];
    const replay = new TerminalReplay((data) => writes.push(data));
    const collect = (): void => {
      const events = dataEvents(fixture.events);
      for (const chunk of chunksOf(events.slice(delivered))) replay.push(chunk);
      delivered = events.length;
    };
    delivered = dataEvents(fixture.events).length;

    pty.emit(parts[2]!);
    pty.emit(parts[3]!);
    await flushOutput();
    collect();
    const snapshot = fixture.sessions.snapshot(session.id);
    expect(snapshot.position).toBe(parts.slice(0, 4).join('').length);
    expect(snapshot.data).toBe(parts.slice(0, 4).join(''));

    // The buffered chunks are already inside the snapshot: only history is
    // written, nothing is duplicated.
    replay.attach(snapshot);
    expect(writes.join('')).toBe(parts.slice(0, 4).join(''));

    // Chunks that arrive later are written live.
    pty.emit(parts[4]!);
    pty.emit(parts[5]!);
    await flushOutput();
    collect();
    expect(writes.join('')).toBe(parts.slice(0, 6).join(''));

    // Event ranges are contiguous with the stream: nothing skipped, nothing
    // repeated, and each range matches its payload length.
    let cursor = 0;
    for (const event of dataEvents(fixture.events)) {
      expect(event.start).toBe(cursor);
      expect(event.end).toBe(event.start + event.data.length);
      cursor = event.end;
    }
    expect(cursor).toBe(parts.slice(0, 6).join('').length);

    // LRU remount: the snapshot alone rebuilds the same screen.
    const remounted: string[] = [];
    const second = new TerminalReplay((data) => remounted.push(data));
    second.attach(fixture.sessions.snapshot(session.id));
    expect(remounted.join('')).toBe(parts.slice(0, 6).join(''));

    // The remounted terminal is evicted again, then more output arrives: the
    // mounted terminal takes it, the disposed one must not receive a write.
    second.dispose();
    pty.emit(parts[6]!);
    await flushOutput();
    const late = chunksOf(dataEvents(fixture.events).slice(delivered));
    for (const chunk of late) {
      replay.push(chunk);
      second.push(chunk);
    }
    expect(writes.join('')).toBe(payload);
    expect(remounted.join('')).toBe(parts.slice(0, 6).join(''));
    expect(second.pendingBytes).toBe(0);

    // A fresh mount after the last chunk replays the full numbered stream.
    const final: string[] = [];
    const third = new TerminalReplay((data) => final.push(data));
    third.attach(fixture.sessions.snapshot(session.id));
    expect(final.join('')).toBe(payload);
  });

  it('trims a buffered chunk that the snapshot only partly covers', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;
    const parts = ['<0>', '<1>', '<2>', '<3>'];
    const payload = parts.join('');

    pty.emit(parts[0]!);
    pty.emit(parts[1]!);
    await flushOutput();

    const writes: string[] = [];
    const replay = new TerminalReplay((data) => writes.push(data));
    let delivered = dataEvents(fixture.events).length;

    // Two chunks enter the same batch, but the history request resolves in
    // between: the event straddles the snapshot position.
    pty.emit(parts[2]!);
    const snapshot = fixture.sessions.snapshot(session.id);
    pty.emit(parts[3]!);
    await flushOutput();

    const events = dataEvents(fixture.events);
    const straddling = events.at(-1)!;
    expect(straddling.start).toBe(parts.slice(0, 2).join('').length);
    expect(snapshot.position).toBeGreaterThan(straddling.start);
    expect(snapshot.position).toBeLessThan(straddling.end);

    for (const chunk of chunksOf(events.slice(delivered))) replay.push(chunk);
    delivered = events.length;
    replay.attach(snapshot);
    // The snapshot covers `<0><1><2>` and the straddling chunk contributes the
    // uncovered `<3>` only.
    expect(writes.join('')).toBe(parts.join(''));
    expect(`${snapshot.data}${straddling.data.slice(snapshot.position - straddling.start)}`).toBe(
      parts.join(''),
    );

    pty.emit('tail');
    await flushOutput();
    for (const chunk of chunksOf(dataEvents(fixture.events).slice(delivered))) replay.push(chunk);
    expect(writes.join('')).toBe(`${payload}tail`);
  });

  it('coalesces chunks into one event without changing the stream', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;

    const chunks = Array.from({ length: 200 }, (_, index) => `chunk-${index};`);
    const payload = chunks.join('');
    for (const chunk of chunks) pty.emit(chunk);
    await waitFor(() => dataEvents(fixture.events).length > 0);

    const events = dataEvents(fixture.events);
    expect(events.length).toBeLessThanOrEqual(2);
    expect(events.map((event) => event.data).join('')).toBe(payload);
    expect(events.at(-1)!.end).toBe(payload.length);
    expect(fixture.sessions.snapshot(session.id).data).toBe(payload);

    // A burst above the byte threshold flushes without waiting for the timer,
    // and two chunks still cannot produce two events.
    const big = 'x'.repeat(48 * 1024);
    const before = dataEvents(fixture.events).length;
    pty.emit(big);
    pty.emit(big);
    await waitFor(
      () => fixture.sessions.snapshot(session.id).position === payload.length + 2 * big.length,
    );
    const burst = dataEvents(fixture.events).slice(before);
    expect(burst.map((event) => event.data).join('')).toBe(big + big);
    expect(burst.length).toBeLessThanOrEqual(2);
  });

  it('measures the crash snapshot cost off the per-chunk path', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;

    // A 4 MB buffer and a 256 KB persisted tail: the worst case the timer sees.
    pty.emit('x'.repeat(4 * 1024 * 1024));
    await flushOutput();
    fixture.sessions.flushSnapshots();

    const samples: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      pty.emit('y');
      const started = performance.now();
      fixture.sessions.flushSnapshots();
      samples.push(performance.now() - started);
    }
    const average = samples.reduce((total, value) => total + value, 0) / samples.length;
    // Generous bound: a single snapshot write must stay well below one frame
    // budget even on a slow CI disk, and it never runs between chunks.
    expect(average).toBeLessThan(50);
    const stored = fixture.db
      .prepare('SELECT length(scrollback) AS size, stream_position FROM sessions WHERE id = ?')
      .get(session.id) as { size: number; stream_position: number };
    expect(stored.size).toBe(256 * 1024);
    expect(stored.stream_position).toBe(4 * 1024 * 1024 + 10);
  });
});

describe('crash snapshots', () => {
  it('restores the persisted window and never claims output that was lost', async () => {
    const fixture = createFixture({ snapshotBytes: 64 });
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;

    const confirmed = `confirmed-${'a'.repeat(80)}`;
    pty.emit(confirmed);
    fixture.sessions.flushSnapshots();
    const stored = fixture.db
      .prepare('SELECT scrollback, stream_position FROM sessions WHERE id = ?')
      .get(session.id) as { scrollback: string; stream_position: number };
    expect(stored.scrollback).toBe(confirmed.slice(-64));
    expect(stored.stream_position).toBe(confirmed.length);

    // Output after the last snapshot only ever lives in memory.
    const lost = '-after-last-snapshot';
    pty.emit(lost);
    await waitFor(() => fixture.sessions.snapshot(session.id).data.endsWith(lost));

    // "Crash": the next launch reads the row only, with auto-resume off.
    process.env.NEST_AUTO_RESUME = '0';
    const reopened = restart(fixture);
    expect(reopened.snapshot(session.id).data).toBe(confirmed.slice(-64));
    expect(reopened.snapshot(session.id).data).not.toContain('after-last-snapshot');
    expect(reopened.snapshot(session.id).position).toBe(confirmed.length);
    expect(reopened.get(session.id).status).toBe('exited');
  });

  it('rebuilds the confirmed window on resume and keeps positions monotonic', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    fixture.ptys[0]!.emit('first-window');
    fixture.sessions.flushSnapshots();
    fixture.ptys[0]!.emit('-not-confirmed');
    await waitFor(() => fixture.sessions.snapshot(session.id).data.includes('-not-confirmed'));

    process.env.NEST_AUTO_RESUME = '0';
    const reopened = restart(fixture);
    fixture.sessions = reopened;
    expect(reopened.snapshot(session.id).data).toBe('first-window');

    const resumed = await reopened.resume(session.id);
    expect(resumed.status).toBe('running');
    const snapshot = reopened.snapshot(session.id);
    expect(snapshot.data.startsWith('first-window')).toBe(true);
    expect(snapshot.data).not.toContain('-not-confirmed');
    expect(snapshot.data.slice('first-window'.length)).toContain('── resume');
    // The stored position covers exactly what the row stores.
    expect(snapshot.position).toBe(snapshot.data.length);

    const resumedPty = fixture.ptys[1]!;
    resumedPty.emit('second-window');
    await waitFor(() => dataEvents(fixture.events).at(-1)?.data === 'second-window');
    const event = dataEvents(fixture.events).at(-1)!;
    expect(event.start).toBe(snapshot.position);
    expect(event.end).toBe(snapshot.position + 'second-window'.length);
  });
});

describe('stop and quit', () => {
  it('keeps a stopped session finished when quit races the exit', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    const pty = fixture.ptys[0]!;
    pty.emit('before-stop');
    await waitFor(() => fixture.sessions.snapshot(session.id).data.includes('before-stop'));

    // Stop writes the explicit marker before the kill; onExit is still pending.
    fixture.sessions.stop(session.id);
    expect(pty.killed).toBe(true);
    const marked = fixture.db
      .prepare('SELECT stop_requested, resume_on_start FROM sessions WHERE id = ?')
      .get(session.id) as { stop_requested: number; resume_on_start: number };
    expect(marked.stop_requested).toBe(1);
    expect(marked.resume_on_start).toBe(0);

    // Quit while the exit is still in flight.
    fixture.sessions.shutdownAll();
    expect(fixture.ptys).toHaveLength(1);

    // Next launch: finished, history kept, no autostart.
    const reopened = restart(fixture);
    expect(fixture.ptys).toHaveLength(1);
    expect(reopened.get(session.id).status).toBe('exited');
    expect(reopened.snapshot(session.id).data).toContain('before-stop');
    const row = fixture.db
      .prepare('SELECT resume_on_start, stop_requested FROM sessions WHERE id = ?')
      .get(session.id) as { resume_on_start: number; stop_requested: number };
    expect(row.resume_on_start).toBe(0);

    // The row is still resumable by hand.
    const resumed = await reopened.resume(session.id);
    expect(resumed.status).toBe('running');
    expect(fixture.ptys).toHaveLength(2);
  });

  it('keeps a session resumable when quit does not follow a stop', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    fixture.ptys[0]!.emit('live-output');
    await waitFor(() => fixture.sessions.snapshot(session.id).data.includes('live-output'));

    fixture.sessions.shutdownAll();
    const reopened = restart(fixture);
    await waitFor(() => fixture.ptys.length === 2);
    expect(reopened.get(session.id).status).not.toBe('exited');
    expect(reopened.snapshot(session.id).data).toContain('live-output');
  });
});
