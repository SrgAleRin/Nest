import * as pty from 'node-pty';
import {
  newId,
  nowIso,
  type HarnessId,
  type HarnessProfile,
  type NestEvent,
  type ResumeMode,
  type Session,
  type SessionStatus,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { HarnessDiscovery, type DiscoveryResult } from '../harness/discovery.js';
import { buildPaste } from '../harness/paste.js';
import { HarnessRegistry } from '../harness/registry.js';
import { stopSessionsAndWait, type SessionStopper, type StopSessionsOptions } from './lifecycle.js';
import { toSession, type SessionRow } from './rows.js';
import type { TaskService } from './tasks.js';

const MAX_SCROLLBACK = 4 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 64 * 1024;
const IDLE_AFTER_MS = 2000;
const DISCOVERY_DELAYS = [1000, 2500, 5000, 10_000];
const DISCOVERY_NUDGE_MS = 1500;
const EXACT_RESUME_GRACE_MS = 20_000;

/**
 * Output batching. TUI agents emit many tiny escape sequences, so one IPC
 * round-trip per chunk would dominate the main process. Chunks are coalesced
 * into a single `session:data` event either after this window or as soon as
 * the pending queue reaches the byte threshold, which bounds the queue.
 */
const DATA_BATCH_INTERVAL_MS = 8;
const DATA_BATCH_MAX_BYTES = 64 * 1024;

/**
 * Crash protection. While a session runs, the tail of its output is written to
 * SQLite on a dirty-flag timer, so a crash loses at most one interval of
 * output instead of everything since the last exit. The write stays off the
 * per-chunk path and its size is capped, so ten sessions do not rewrite
 * megabytes every few seconds. Exit and graceful shutdown still store the full
 * in-memory buffer.
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 5_000;
export const DEFAULT_SNAPSHOT_BYTES = 256 * 1024;

/** Stored output of one session plus the stream position it covers. */
export interface SessionSnapshot {
  data: string;
  /** Position covered by `data`: nothing before it has to be replayed. */
  position: number;
}

/** The slice of `node-pty` this service needs, injectable for tests. */
export interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnPtyInput {
  cols?: number;
  rows?: number;
  env: Record<string, string>;
}

export type SpawnPty = (
  command: string,
  args: string[],
  cwd: string,
  input: SpawnPtyInput,
) => PtyProcess;

export interface SessionServiceOptions {
  /** Replaces PTY creation; tests drive a deterministic in-process PTY. */
  spawnPty?: SpawnPty;
  /** Crash snapshot interval; 0 disables the timer (`flushSnapshots` still works). */
  snapshotIntervalMs?: number;
  /** Upper bound of the periodically persisted snapshot, in UTF-16 units. */
  snapshotBytes?: number;
}

interface DiscoveryState {
  harnessId: HarnessId;
  cwd: string;
  since: Date;
  includeUpdated: boolean;
  attempts: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  /** Conversation ids we already warned about, so the notification is sent once. */
  warnedFor: string | null;
}

interface Runtime {
  pty: PtyProcess;
  taskId: string;
  buffer: string;
  /**
   * End of the output stream: UTF-16 units appended over the whole life of the
   * session, including parts already dropped from `buffer` or from the
   * snapshot. Monotonic, and the only clock that orders chunks against the
   * scrollback snapshot.
   */
  position: number;
  /** Chunks appended but not yet emitted as one batched event. */
  pending: string[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  /** Crash snapshot timer and its dirty flag. */
  snapshotTimer: NodeJS.Timeout | null;
  dirty: boolean;
  status: SessionStatus;
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
  harnessSessionId: string | null;
  /** The stored id is proven to be this session's own conversation. */
  exactId: boolean;
  /** Output of the launched process itself, used as ownership evidence. */
  processOutput: string;
  discovery: DiscoveryState | null;
  exactResume: boolean;
  startedAt: number;
}

type BindOutcome = 'bound' | 'kept' | 'claimed';

interface SessionScope {
  id: string;
  harnessId: HarnessId;
  cwd: string;
  taskId: string;
}

export interface StartSessionInput {
  taskId: string;
  harnessId: string;
  cols?: number;
  rows?: number;
}

export class SessionService {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly spawnPty: SpawnPty;
  private readonly snapshotIntervalMs: number;
  private readonly snapshotBytes: number;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly harnesses: HarnessRegistry,
    private readonly discovery: HarnessDiscovery,
    private readonly emit: (event: NestEvent) => void,
    options: SessionServiceOptions = {},
  ) {
    this.spawnPty = options.spawnPty ?? spawnHarness;
    this.snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
    this.snapshotBytes = options.snapshotBytes ?? DEFAULT_SNAPSHOT_BYTES;
  }

  list(taskId?: string): Session[] {
    const rows = taskId
      ? (this.db
          .prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY created_at')
          .all(taskId) as unknown as SessionRow[])
      : (this.db
          .prepare('SELECT * FROM sessions ORDER BY created_at')
          .all() as unknown as SessionRow[]);
    return rows.map(toSession);
  }

  get(sessionId: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      SessionRow | undefined;
    if (!row) throw new NestError('session_not_found', `Session ${sessionId} was not found`);
    return toSession(row);
  }

  activeForTask(taskId: string): Session | null {
    for (const [id, runtime] of this.runtimes) {
      if (
        runtime.taskId === taskId &&
        (runtime.status === 'running' || runtime.status === 'idle')
      ) {
        return this.get(id);
      }
    }
    return null;
  }

  async start(input: StartSessionInput): Promise<Session> {
    const task = this.tasks.get(input.taskId);
    const harness = this.harnesses.get(input.harnessId);

    const id = newId();
    const timestamp = nowIso();
    const title = harness.label;

    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, harness_id, title, status, cwd, exit_code, scrollback, stream_position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'starting', ?, NULL, '', 0, ?, ?)`,
      )
      .run(id, task.id, harness.id, title, task.workspacePath, timestamp, timestamp);

    this.spawnRuntime({
      sessionId: id,
      taskId: task.id,
      cwd: task.workspacePath,
      harness,
      extraArgs: [],
      initialBuffer: '',
      initialPosition: 0,
      cols: input.cols,
      rows: input.rows,
      discovery: { since: new Date(timestamp), includeUpdated: false },
      exactResume: false,
      harnessSessionId: null,
      exactId: false,
    });

    return this.get(id);
  }

  async resume(sessionId: string, options: { auto?: boolean } = {}): Promise<Session> {
    const session = this.get(sessionId);
    if (
      this.runtimes.has(sessionId) ||
      session.status === 'starting' ||
      session.status === 'running' ||
      session.status === 'idle'
    ) {
      throw new NestError('session_running', 'Session is already running');
    }

    // A profile disabled in Settings only disappears from the start pickers:
    // resuming a conversation that already exists must keep working.
    const harness = this.harnesses.get(session.harnessId, { allowDisabled: true });
    const storedId = session.harnessSessionId;
    const verified = session.resumeMode === 'exact';

    if (storedId && this.conversationClaimedByOther(sessionId, storedId) && !options.auto) {
      throw new NestError(
        'conversation_claimed',
        `Conversation ${storedId} already belongs to another tab in this project`,
      );
    }
    // Heuristic ids are only used when the user asks for them explicitly: an
    // automatic restart must never continue a conversation we could not prove.
    const useStoredId =
      storedId !== null &&
      (verified || !options.auto) &&
      this.canClaimConversation(sessionId, storedId);

    let extraArgs: string[] | null = null;
    let discovery: { since: Date; includeUpdated: boolean } | undefined;
    let exactResume = false;

    if (useStoredId) {
      const exactArgs = this.harnesses.exactResumeArgs(session.harnessId, storedId);
      if (exactArgs && exactArgs.length > 0) {
        extraArgs = exactArgs;
        exactResume = true;
      }
    }

    if (!extraArgs) {
      if (harness.resumeArgs.length === 0) {
        throw new NestError(
          'resume_unsupported',
          `${harness.label} has no resume command configured yet. Start a new session instead.`,
        );
      }
      // "Continue the latest conversation" picks whatever is newest in this
      // workspace. With another tab on the same cwd and harness that may be
      // that tab's conversation, so an automatic resume waits for the user.
      if (options.auto && this.siblingConversation(session)) {
        this.db.prepare('UPDATE sessions SET resume_on_start = 0 WHERE id = ?').run(sessionId);
        this.emit({
          type: 'notification',
          level: 'warn',
          message: `${harness.label}: another tab uses this workspace, so "Resume latest" could open its conversation. Resume this session manually.`,
        });
        return this.get(sessionId);
      }
      extraArgs = harness.resumeArgs;
      // We just continued the newest conversation in this workspace. Give the
      // CLI a chance to reveal which one it picked; the result is heuristic
      // because "latest" is chosen by the CLI, not by us.
      discovery = { since: new Date(), includeUpdated: true };
    }

    const task = this.tasks.get(session.taskId);
    const marker = `\r\n\x1b[90m── resume ${harness.label} ──\x1b[0m\r\n`;
    // The marker is appended to the stored snapshot, so it also advances the
    // stream position: the row and the event below describe the same range.
    const snapshot = this.snapshot(sessionId);
    const initialBuffer = `${snapshot.data}${marker}`;
    const initialPosition = snapshot.position + marker.length;

    this.db
      .prepare(
        `UPDATE sessions
            SET status = ?, scrollback = ?, stream_position = ?, stop_requested = 0,
                resume_on_start = 0, updated_at = ?
          WHERE id = ?`,
      )
      .run('starting', initialBuffer, initialPosition, nowIso(), sessionId);
    this.emit({ type: 'session:status', session: this.get(sessionId) });
    this.emit({
      type: 'session:data',
      sessionId,
      data: marker,
      start: initialPosition - marker.length,
      end: initialPosition,
    });

    this.spawnRuntime({
      sessionId,
      taskId: task.id,
      cwd: task.workspacePath,
      harness,
      extraArgs,
      initialBuffer,
      initialPosition,
      discovery,
      exactResume,
      harnessSessionId: exactResume ? storedId : null,
      exactId: exactResume,
    });

    return this.get(sessionId);
  }

  private spawnRuntime(input: {
    sessionId: string;
    taskId: string;
    cwd: string;
    harness: HarnessProfile;
    extraArgs: string[];
    initialBuffer: string;
    /** Position already covered by `initialBuffer`. */
    initialPosition: number;
    cols?: number;
    rows?: number;
    discovery?: { since: Date; includeUpdated: boolean };
    exactResume: boolean;
    harnessSessionId: string | null;
    exactId: boolean;
  }): void {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    // UTF-8 and truecolour everywhere; only filled in when the shell profile
    // has no opinion, so a user override still wins.
    if (!env.COLORTERM) env.COLORTERM = 'truecolor';
    if (!env.PYTHONUTF8) env.PYTHONUTF8 = '1';
    if (!env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
    env.NEST = '1';
    env.NEST_TASK_ID = input.taskId;
    env.NEST_SESSION_ID = input.sessionId;
    env.NEST_HARNESS = input.harness.id;
    delete env.ELECTRON_RUN_AS_NODE;

    const { sessionId } = input;
    let child: PtyProcess;
    try {
      child = this.spawnPty(
        input.harness.command,
        [...input.harness.args, ...input.extraArgs],
        input.cwd,
        { cols: input.cols, rows: input.rows, env },
      );
    } catch (error) {
      this.setStatus(sessionId, 'failed');
      this.db.prepare('UPDATE sessions SET exit_code = NULL WHERE id = ?').run(sessionId);
      throw new NestError(
        'session_spawn_failed',
        `Failed to start ${input.harness.label}`,
        (error as Error).message,
      );
    }

    const runtime: Runtime = {
      pty: child,
      taskId: input.taskId,
      buffer: input.initialBuffer,
      position: input.initialPosition,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      snapshotTimer: null,
      dirty: false,
      status: 'running',
      stopping: false,
      idleTimer: null,
      harnessSessionId: input.harnessSessionId,
      exactId: input.exactId,
      processOutput: '',
      discovery: null,
      exactResume: input.exactResume,
      startedAt: Date.now(),
    };
    this.runtimes.set(sessionId, runtime);
    this.startSnapshotTimer(sessionId, runtime);

    child.onData((data) => {
      // A closed or already-deleted session must not reach the renderer: the
      // runtime entry is removed before its rows are (close) or together with
      // the confirmed stop that precedes row deletion.
      const active = this.runtimes.get(sessionId);
      if (!active) return;
      this.appendOutput(sessionId, active, data);
      active.processOutput = (active.processOutput + data).slice(0, MAX_PROCESS_OUTPUT);
      if (active.status === 'starting' || active.status === 'idle') {
        this.setStatus(sessionId, 'running');
        active.status = 'running';
      }
      if (active.idleTimer) clearTimeout(active.idleTimer);
      active.idleTimer = setTimeout(() => {
        const current = this.runtimes.get(sessionId);
        if (!current || current.status !== 'running') return;
        this.setStatus(sessionId, 'idle');
        current.status = 'idle';
      }, IDLE_AFTER_MS);
    });

    child.onExit(({ exitCode }) => {
      const active = this.runtimes.get(sessionId);
      if (!active) return;
      if (active.idleTimer) clearTimeout(active.idleTimer);
      this.stopDiscovery(active);

      const failed = !active.stopping && exitCode !== 0;
      if (
        failed &&
        active.exactResume &&
        active.harnessSessionId &&
        Date.now() - active.startedAt < EXACT_RESUME_GRACE_MS
      ) {
        // The stored conversation could not be continued. Keep the session and
        // let the user retry with the "latest conversation" fallback instead of
        // leaving a stale id that fails every time.
        this.db
          .prepare(
            "UPDATE sessions SET harness_session_id = NULL, resume_mode = 'latest' WHERE id = ?",
          )
          .run(sessionId);
        this.emit({
          type: 'notification',
          level: 'warn',
          message: `Exact resume failed for ${input.harness.label}. The next Resume will continue its latest conversation.`,
        });
      }

      const status: SessionStatus = active.stopping || exitCode === 0 ? 'exited' : 'failed';
      // The whole in-memory buffer is written on exit, so a graceful end keeps
      // the full scrollback regardless of the periodic snapshot cap.
      this.clearOutputTimers(active);
      this.flushOutput(sessionId, active);
      this.persistScrollback(sessionId, active.buffer, active.position);
      this.runtimes.delete(sessionId);
      this.setStatus(sessionId, status, exitCode);
    });

    this.setStatus(sessionId, 'running');

    if (input.discovery) {
      this.startDiscovery(
        sessionId,
        input.harness.id,
        input.cwd,
        input.discovery.since,
        input.discovery.includeUpdated,
      );
    }
  }

  write(sessionId: string, data: string): void {
    this.runtime(sessionId).pty.write(data);
    this.nudgeDiscovery(sessionId);
  }

  /**
   * Writes a composed block (a review note) into the PTY. Bracketed paste plus
   * one Enter when the profile understands it; otherwise plain submitted lines.
   * See `buildPaste` and `HarnessRegistry.inputMode` for the choice per profile.
   */
  writeText(sessionId: string, text: string): void {
    const runtime = this.runtime(sessionId);
    const mode = this.harnesses.inputMode(this.get(sessionId).harnessId);
    runtime.pty.write(buildPaste(text, mode));
    this.nudgeDiscovery(sessionId);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    try {
      runtime.pty.resize(cols, rows);
    } catch {
      // the process may have exited between the renderer resize and this call
    }
  }

  stop(sessionId: string): void {
    // The explicit marker is written before the kill: recovery must not infer
    // resumability from a status a concurrent shutdown may still rewrite.
    this.db
      .prepare(
        'UPDATE sessions SET resume_on_start = 0, stop_requested = 1, updated_at = ? WHERE id = ?',
      )
      .run(nowIso(), sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.stopping = true;
    this.stopDiscovery(runtime);
    try {
      runtime.pty.kill();
    } catch {
      // already gone
    }
  }

  /**
   * Closes a tab for good: stops the PTY when it is alive and deletes the
   * session row with its scrollback. Closing is intentionally different from
   * Stop, which keeps the row so the conversation can be resumed.
   */
  close(sessionId: string): void {
    this.get(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (runtime) {
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.clearOutputTimers(runtime);
      this.stopDiscovery(runtime);
      runtime.stopping = true;
      // onExit must not persist or broadcast a session that no longer exists.
      this.runtimes.delete(sessionId);
      try {
        runtime.pty.kill();
      } catch {
        // already gone
      }
    }
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  /**
   * Stops every live session of the given tasks and waits for confirmed process
   * exit. Task and project removal call this before touching Git or SQLite: a
   * row must never disappear while its PTY still runs, and a stop that cannot
   * be confirmed is reported as an error instead of a success.
   */
  async stopTasksAndWait(
    taskIds: readonly string[],
    options: StopSessionsOptions = {},
  ): Promise<void> {
    const stopper: SessionStopper = {
      liveSessions: (ids) => this.liveSessions(ids),
      requestStop: (sessionId) => this.stop(sessionId),
      isLive: (sessionId) => this.runtimes.has(sessionId),
    };
    await stopSessionsAndWait(stopper, taskIds, options);
  }

  /** Session ids that still have a live PTY, limited to the given tasks. */
  liveSessions(taskIds: readonly string[]): string[] {
    const wanted = new Set(taskIds);
    const ids: string[] = [];
    for (const [id, runtime] of this.runtimes) {
      if (wanted.has(runtime.taskId)) ids.push(id);
    }
    return ids;
  }

  /** Output snapshot plus the stream position it covers. */
  snapshot(sessionId: string): SessionSnapshot {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return { data: runtime.buffer, position: runtime.position };
    const row = this.db
      .prepare('SELECT scrollback, stream_position FROM sessions WHERE id = ?')
      .get(sessionId) as { scrollback: string; stream_position: number } | undefined;
    return { data: row?.scrollback ?? '', position: Number(row?.stream_position ?? 0) };
  }

  scrollback(sessionId: string): string {
    return this.snapshot(sessionId).data;
  }

  /**
   * Persists the crash snapshot of every live session that produced output
   * since the last write. The periodic timer calls the same path; a caller can
   * also force it (tests, or before a long blocking operation).
   */
  flushSnapshots(): void {
    for (const [id, runtime] of this.runtimes) {
      if (!runtime.dirty) continue;
      this.persistSnapshot(id, runtime);
    }
  }

  recoverStale(): void {
    // The explicit stop marker wins over the unfinished status: a user who
    // pressed Stop must not get the session back as resumable, even when Quit
    // raced the asynchronous exit and left the row mid-flight.
    this.db
      .prepare(
        `UPDATE sessions SET resume_on_start = CASE WHEN stop_requested = 1 THEN 0 ELSE 1 END
         WHERE status IN ('starting', 'running', 'idle')`,
      )
      .run();
    this.db
      .prepare(
        `UPDATE sessions SET status = 'exited', exit_code = NULL, updated_at = ?
         WHERE status IN ('starting', 'running', 'idle')`,
      )
      .run(nowIso());
  }

  resumePending(): void {
    if (process.env.NEST_AUTO_RESUME === '0') return;
    const rows = this.db
      .prepare('SELECT id FROM sessions WHERE resume_on_start = 1 ORDER BY updated_at')
      .all() as Array<{ id: string }>;

    for (const row of rows) {
      void this.resume(row.id, { auto: true }).catch(() => {
        this.db.prepare('UPDATE sessions SET resume_on_start = 0 WHERE id = ?').run(row.id);
      });
    }
  }

  shutdownAll(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.clearOutputTimers(runtime);
      this.stopDiscovery(runtime);
      this.persistScrollback(id, runtime.buffer, runtime.position);
      if (runtime.stopping) {
        // The user stopped this session before Quit. It stays finished: no
        // resume flag, and the status is settled here because onExit may not
        // run once the runtime entry is gone.
        this.db
          .prepare(
            `UPDATE sessions SET status = 'exited', resume_on_start = 0, updated_at = ?
              WHERE id = ?`,
          )
          .run(nowIso(), id);
      } else {
        this.db.prepare('UPDATE sessions SET resume_on_start = 1 WHERE id = ?').run(id);
      }
      runtime.stopping = true;
      try {
        runtime.pty.kill();
      } catch {
        // already gone
      }
    }
    this.runtimes.clear();
  }

  private startDiscovery(
    sessionId: string,
    harnessId: HarnessId,
    cwd: string,
    since: Date,
    includeUpdated: boolean,
  ): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime || runtime.exactId || runtime.discovery) return;
    if (!this.harnesses.supportsDiscovery(harnessId)) return;

    runtime.discovery = {
      harnessId,
      cwd,
      since,
      includeUpdated,
      attempts: 0,
      timer: null,
      running: false,
      warnedFor: null,
    };
    this.runDiscovery(sessionId);
  }

  private runDiscovery(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    const state = runtime?.discovery;
    if (!runtime || !state || state.running || runtime.exactId) return;

    state.running = true;
    let pending: ReturnType<HarnessDiscovery['find']>;
    try {
      pending = this.discovery.find(state.harnessId, state.cwd, state.since, {
        includeUpdated: state.includeUpdated,
        processOutput: runtime.processOutput,
        claimedIds: this.claimedConversationIds(sessionId),
        hasSiblingSession: this.siblingConversation({
          id: sessionId,
          harnessId: state.harnessId,
          cwd: state.cwd,
          taskId: runtime.taskId,
        }),
      });
    } catch {
      // The database was closed under a timer that was already scheduled
      // (shutdown, quit, test teardown). Discovery is optional: drop it.
      state.running = false;
      return;
    }
    void pending
      .catch(() => null)
      .then((result) => {
        const current = this.runtimes.get(sessionId);
        if (!current || current.discovery !== state) return;
        state.running = false;

        if (result?.id) {
          const outcome = this.bindConversation(sessionId, result);
          if (outcome === 'claimed' && state.warnedFor !== result.id) {
            state.warnedFor = result.id;
            this.emit({
              type: 'notification',
              level: 'warn',
              message: `Conversation ${result.id} already belongs to another tab, so this one keeps the "Resume latest" fallback.`,
            });
          }
          // A heuristic binding can still be upgraded to exact once the CLI
          // prints its id, so keep a few more attempts scheduled.
          if (outcome !== 'claimed' && result.confidence === 'exact') {
            this.stopDiscovery(current);
            return;
          }
        }

        const delay = DISCOVERY_DELAYS[state.attempts];
        state.attempts += 1;
        if (delay === undefined) return;

        state.timer = setTimeout(() => {
          state.timer = null;
          this.runDiscovery(sessionId);
        }, delay);
        state.timer.unref();
      });
  }

  /**
   * Most harnesses create their conversation lazily, after the first prompt.
   * Every keystroke re-arms a short lookup so the id is captured soon after
   * the CLI writes it, even if the initial scheduled attempts are exhausted.
   */
  private nudgeDiscovery(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    const state = runtime?.discovery;
    if (!runtime || !state || state.running || runtime.exactId) return;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.attempts = 0;
      this.runDiscovery(sessionId);
    }, DISCOVERY_NUDGE_MS);
    state.timer.unref();
  }

  /**
   * Stores a discovered conversation id, but only when no other session in the
   * project already holds it. The claim check lives inside the UPDATE so two
   * tabs discovering the same conversation cannot both win.
   */
  private bindConversation(sessionId: string, result: DiscoveryResult): BindOutcome {
    const runtime = this.runtimes.get(sessionId);
    const id = result.id;
    if (!runtime || !id) return 'kept';

    const exact = result.confidence === 'exact';
    const mode: ResumeMode = exact ? 'exact' : 'heuristic';
    if (runtime.harnessSessionId === id) {
      runtime.exactId = exact;
      return 'kept';
    }
    // A second guess is not better evidence than the first one: only a
    // process-reported id may replace a heuristic binding.
    if (runtime.harnessSessionId && !exact) return 'kept';
    if (!this.canClaimConversation(sessionId, id)) return 'claimed';

    const written = this.db
      .prepare(
        `UPDATE sessions
            SET harness_session_id = ?, resume_mode = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1
                FROM sessions other
                JOIN tasks other_task ON other_task.id = other.task_id
                JOIN tasks own_task ON own_task.id = sessions.task_id
               WHERE other.harness_session_id = ?
                 AND other.id <> sessions.id
                 AND other_task.project_id = own_task.project_id
            )`,
      )
      .run(id, mode, nowIso(), sessionId, id);
    if (Number(written.changes) === 0) return 'claimed';

    runtime.harnessSessionId = id;
    runtime.exactId = exact;
    this.emitSession(sessionId);
    return 'bound';
  }

  /** Conversation ids another session in the same project already owns. */
  private claimedConversationIds(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT other.harness_session_id AS id
           FROM sessions other
           JOIN tasks other_task ON other_task.id = other.task_id
          WHERE other.id <> ?
            AND other.harness_session_id IS NOT NULL
            AND other_task.project_id = (SELECT project_id FROM tasks WHERE id = ?)`,
      )
      .all(sessionId, this.taskIdOf(sessionId)) as Array<{ id: string }>;

    const ids = rows.map((row) => row.id);
    for (const [otherId, runtime] of this.runtimes) {
      if (otherId !== sessionId && runtime.harnessSessionId) ids.push(runtime.harnessSessionId);
    }
    return ids;
  }

  private canClaimConversation(sessionId: string, harnessSessionId: string): boolean {
    for (const [otherId, runtime] of this.runtimes) {
      if (otherId !== sessionId && runtime.harnessSessionId === harnessSessionId) return false;
    }
    return !this.conversationClaimedByOther(sessionId, harnessSessionId);
  }

  private conversationClaimedByOther(sessionId: string, harnessSessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit
           FROM sessions other
           JOIN tasks other_task ON other_task.id = other.task_id
          WHERE other.id <> ?
            AND other.harness_session_id = ?
            AND other_task.project_id = (SELECT project_id FROM tasks WHERE id = ?)
          LIMIT 1`,
      )
      .get(sessionId, harnessSessionId, this.taskIdOf(sessionId));
    return Boolean(row);
  }

  /** Another tab runs the same harness in the same workspace. */
  private siblingConversation(session: SessionScope): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit
           FROM sessions other
           JOIN tasks other_task ON other_task.id = other.task_id
          WHERE other.id <> ?
            AND other.harness_id = ?
            AND other.cwd = ?
            AND other_task.project_id = (SELECT project_id FROM tasks WHERE id = ?)
          LIMIT 1`,
      )
      .get(session.id, session.harnessId, session.cwd, session.taskId);
    return Boolean(row);
  }

  private taskIdOf(sessionId: string): string {
    const row = this.db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(sessionId) as
      { task_id: string } | undefined;
    return row?.task_id ?? '';
  }

  private stopDiscovery(runtime: Runtime): void {
    if (!runtime.discovery) return;
    if (runtime.discovery.timer) clearTimeout(runtime.discovery.timer);
    runtime.discovery = null;
  }

  private runtime(sessionId: string): Runtime {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      throw new NestError('session_not_running', 'Session is not running');
    }
    return runtime;
  }

  private persistScrollback(sessionId: string, buffer: string, position: number): void {
    this.db
      .prepare(
        `UPDATE sessions SET scrollback = ?, stream_position = ?, updated_at = ? WHERE id = ?`,
      )
      .run(buffer.slice(-MAX_SCROLLBACK), position, nowIso(), sessionId);
  }

  /**
   * Crash snapshot: a bounded tail plus the position it covers, so recovery
   * restores exactly the bytes it can prove and never claims output that was
   * only in memory.
   */
  private persistSnapshot(sessionId: string, runtime: Runtime): void {
    const limit = this.snapshotBytes;
    const tail = runtime.buffer.length > limit ? runtime.buffer.slice(-limit) : runtime.buffer;
    this.persistScrollback(sessionId, tail, runtime.position);
    runtime.dirty = false;
  }

  private startSnapshotTimer(sessionId: string, runtime: Runtime): void {
    if (this.snapshotIntervalMs <= 0) return;
    const timer = setInterval(() => {
      const current = this.runtimes.get(sessionId);
      if (!current || !current.dirty) return;
      this.persistSnapshot(sessionId, current);
    }, this.snapshotIntervalMs);
    // Never keep the process alive just for a snapshot.
    timer.unref();
    runtime.snapshotTimer = timer;
  }

  /**
   * Appends a PTY chunk to the session stream. The position advances and the
   * buffer grows here, before the chunk reaches the renderer, so a snapshot
   * taken while an event is still queued already covers that event.
   */
  private appendOutput(sessionId: string, runtime: Runtime, data: string): void {
    if (data.length === 0) return;
    runtime.buffer = (runtime.buffer + data).slice(-MAX_SCROLLBACK);
    runtime.position += data.length;
    runtime.dirty = true;
    runtime.pending.push(data);
    runtime.pendingBytes += data.length;
    if (runtime.pendingBytes >= DATA_BATCH_MAX_BYTES) {
      this.flushOutput(sessionId, runtime);
      return;
    }
    if (runtime.flushTimer) return;
    const timer = setTimeout(() => {
      runtime.flushTimer = null;
      const current = this.runtimes.get(sessionId);
      if (current === runtime) this.flushOutput(sessionId, runtime);
    }, DATA_BATCH_INTERVAL_MS);
    timer.unref();
    runtime.flushTimer = timer;
  }

  /** Emits the pending chunks as one `session:data` event with its range. */
  private flushOutput(sessionId: string, runtime: Runtime): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    if (runtime.pending.length === 0) return;
    const data = runtime.pending.join('');
    const end = runtime.position;
    const start = end - runtime.pendingBytes;
    runtime.pending = [];
    runtime.pendingBytes = 0;
    this.emit({ type: 'session:data', sessionId, data, start, end });
  }

  private clearOutputTimers(runtime: Runtime): void {
    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }
    if (runtime.snapshotTimer) {
      clearInterval(runtime.snapshotTimer);
      runtime.snapshotTimer = null;
    }
  }

  private setStatus(sessionId: string, status: SessionStatus, exitCode?: number): void {
    const updatedAt = nowIso();
    if (exitCode === undefined) {
      this.db
        .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, updatedAt, sessionId);
    } else {
      this.db
        .prepare('UPDATE sessions SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?')
        .run(status, exitCode, updatedAt, sessionId);
    }
    this.emitSession(sessionId);
  }

  private emitSession(sessionId: string): void {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      SessionRow | undefined;
    if (row) this.emit({ type: 'session:status', session: toSession(row) });
  }
}

function quote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Windows ConPTY inherits the OEM/ANSI codepage, so Cyrillic names and
 * box-drawing output reach the renderer mangled. `chcp 65001` switches the
 * console to UTF-8 before the harness starts; the `&` keeps the chain going
 * regardless, and `%NEST_LAUNCH%` carries a command line that is already quoted
 * so node-pty does not re-quote paths that contain spaces.
 */
export function buildWindowsConptyLaunch(
  command: string,
  args: string[],
): { commandLine: string; cmdArgs: string[] } {
  return {
    commandLine: [command, ...args].map(quote).join(' '),
    cmdArgs: ['/d', '/s', '/c', 'chcp 65001 >nul & %NEST_LAUNCH%'],
  };
}

function spawnHarness(
  command: string,
  args: string[],
  cwd: string,
  input: { cols?: number; rows?: number; env: Record<string, string> },
): PtyProcess {
  const cols = input.cols ?? 100;
  const rows = input.rows ?? 30;

  if (process.platform === 'win32') {
    // cmd.exe is required so that .cmd shims (npm-installed harnesses) resolve.
    // Passing the command line through an environment variable avoids node-pty
    // re-quoting arguments that already contain quotes (paths with spaces).
    const { commandLine, cmdArgs } = buildWindowsConptyLaunch(command, args);
    return pty.spawn(process.env.ComSpec || 'cmd.exe', cmdArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...input.env, NEST_LAUNCH: commandLine },
      useConpty: true,
    });
  }

  return pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: input.env,
  });
}
