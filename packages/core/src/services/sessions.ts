import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import {
  newId,
  nowIso,
  type HarnessId,
  type HarnessProfile,
  type NestEvent,
  type Session,
  type SessionStatus,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { HarnessDiscovery } from '../harness/discovery.js';
import { HarnessRegistry } from '../harness/registry.js';
import { toSession, type SessionRow } from './rows.js';
import type { TaskService } from './tasks.js';

const MAX_SCROLLBACK = 4 * 1024 * 1024;
const IDLE_AFTER_MS = 2000;
const DISCOVERY_DELAYS = [1000, 2500, 5000, 10_000];
const DISCOVERY_NUDGE_MS = 1500;
const EXACT_RESUME_GRACE_MS = 20_000;

interface DiscoveryState {
  harnessId: HarnessId;
  cwd: string;
  since: Date;
  includeUpdated: boolean;
  attempts: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

interface Runtime {
  pty: IPty;
  taskId: string;
  buffer: string;
  status: SessionStatus;
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
  harnessSessionId: string | null;
  discovery: DiscoveryState | null;
  exactResume: boolean;
  startedAt: number;
}

export interface StartSessionInput {
  taskId: string;
  harnessId: string;
  cols?: number;
  rows?: number;
}

export class SessionService {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly harnesses: HarnessRegistry,
    private readonly discovery: HarnessDiscovery,
    private readonly emit: (event: NestEvent) => void,
  ) {}

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
        `INSERT INTO sessions (id, task_id, harness_id, title, status, cwd, exit_code, scrollback, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'starting', ?, NULL, '', ?, ?)`,
      )
      .run(id, task.id, harness.id, title, task.workspacePath, timestamp, timestamp);

    this.spawnRuntime({
      sessionId: id,
      taskId: task.id,
      cwd: task.workspacePath,
      harness,
      extraArgs: [],
      initialBuffer: '',
      cols: input.cols,
      rows: input.rows,
      discovery: { since: new Date(timestamp), includeUpdated: false },
      exactResume: false,
      harnessSessionId: null,
    });

    return this.get(id);
  }

  async resume(sessionId: string): Promise<Session> {
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
    const exactArgs = session.harnessSessionId
      ? this.harnesses.exactResumeArgs(session.harnessId, session.harnessSessionId)
      : null;

    let extraArgs: string[];
    let discovery: { since: Date; includeUpdated: boolean } | undefined;
    let exactResume = false;

    if (exactArgs && exactArgs.length > 0) {
      extraArgs = exactArgs;
      exactResume = true;
    } else if (harness.resumeArgs.length > 0) {
      extraArgs = harness.resumeArgs;
      // We just continued the newest conversation in this workspace. Give the
      // CLI a chance to reveal which one it picked so the next resume is exact.
      discovery = { since: new Date(), includeUpdated: true };
    } else {
      throw new NestError(
        'resume_unsupported',
        `${harness.label} has no resume command configured yet. Start a new session instead.`,
      );
    }

    const task = this.tasks.get(session.taskId);
    const marker = `\r\n\x1b[90m── resume ${harness.label} ──\x1b[0m\r\n`;
    const initialBuffer = `${this.scrollback(sessionId)}${marker}`;

    this.db
      .prepare(
        'UPDATE sessions SET status = ?, scrollback = ?, resume_on_start = 0, updated_at = ? WHERE id = ?',
      )
      .run('starting', initialBuffer, nowIso(), sessionId);
    this.emit({ type: 'session:status', session: this.get(sessionId) });
    this.emit({ type: 'session:data', sessionId, data: marker });

    this.spawnRuntime({
      sessionId,
      taskId: task.id,
      cwd: task.workspacePath,
      harness,
      extraArgs,
      initialBuffer,
      discovery,
      exactResume,
      harnessSessionId: exactResume ? session.harnessSessionId : null,
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
    cols?: number;
    rows?: number;
    discovery?: { since: Date; includeUpdated: boolean };
    exactResume: boolean;
    harnessSessionId: string | null;
  }): void {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.NEST = '1';
    env.NEST_TASK_ID = input.taskId;
    env.NEST_SESSION_ID = input.sessionId;
    env.NEST_HARNESS = input.harness.id;
    delete env.ELECTRON_RUN_AS_NODE;

    const { sessionId } = input;
    let child: IPty;
    try {
      child = spawnHarness(
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
      status: 'running',
      stopping: false,
      idleTimer: null,
      harnessSessionId: input.harnessSessionId,
      discovery: null,
      exactResume: input.exactResume,
      startedAt: Date.now(),
    };
    this.runtimes.set(sessionId, runtime);

    child.onData((data) => {
      const active = this.runtimes.get(sessionId);
      if (!active) return;
      active.buffer = (active.buffer + data).slice(-MAX_SCROLLBACK);
      this.emit({ type: 'session:data', sessionId, data });
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
      this.persistScrollback(sessionId, active.buffer);
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

  writeText(sessionId: string, text: string): void {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\x1b\[201~/g, ''); // eslint-disable-line no-control-regex
    this.runtime(sessionId).pty.write(`\x1b[200~${normalized}\x1b[201~\r`);
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
    this.db.prepare('UPDATE sessions SET resume_on_start = 0 WHERE id = ?').run(sessionId);
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

  stopForTask(taskId: string): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.taskId === taskId) {
        runtime.stopping = true;
        this.stopDiscovery(runtime);
        try {
          runtime.pty.kill();
        } catch {
          // already gone
        }
      }
    }
  }

  scrollback(sessionId: string): string {
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return runtime.buffer;
    const row = this.db.prepare('SELECT scrollback FROM sessions WHERE id = ?').get(sessionId) as
      { scrollback: string } | undefined;
    return row?.scrollback ?? '';
  }

  recoverStale(): void {
    this.db
      .prepare(
        `UPDATE sessions SET resume_on_start = 1
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
      void this.resume(row.id).catch(() => {
        this.db.prepare('UPDATE sessions SET resume_on_start = 0 WHERE id = ?').run(row.id);
      });
    }
  }

  shutdownAll(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.stopDiscovery(runtime);
      this.persistScrollback(id, runtime.buffer);
      this.db.prepare('UPDATE sessions SET resume_on_start = 1 WHERE id = ?').run(id);
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
    if (!runtime || runtime.harnessSessionId || runtime.discovery) return;
    if (!this.harnesses.supportsDiscovery(harnessId)) return;

    runtime.discovery = {
      harnessId,
      cwd,
      since,
      includeUpdated,
      attempts: 0,
      timer: null,
      running: false,
    };
    this.runDiscovery(sessionId);
  }

  private runDiscovery(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    const state = runtime?.discovery;
    if (!runtime || !state || state.running || runtime.harnessSessionId) return;

    state.running = true;
    void this.discovery
      .find(state.harnessId, state.cwd, state.since, {
        includeUpdated: state.includeUpdated,
      })
      .catch(() => null)
      .then((harnessSessionId) => {
        const current = this.runtimes.get(sessionId);
        if (!current || current.discovery !== state) return;
        state.running = false;

        if (harnessSessionId) {
          this.rememberHarnessSession(sessionId, harnessSessionId);
          return;
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
    if (!runtime || !state || state.running || runtime.harnessSessionId) return;

    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      state.attempts = 0;
      this.runDiscovery(sessionId);
    }, DISCOVERY_NUDGE_MS);
    state.timer.unref();
  }

  private rememberHarnessSession(sessionId: string, harnessSessionId: string): void {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;

    this.stopDiscovery(runtime);
    runtime.harnessSessionId = harnessSessionId;
    this.db
      .prepare(
        "UPDATE sessions SET harness_session_id = ?, resume_mode = 'exact', updated_at = ? WHERE id = ?",
      )
      .run(harnessSessionId, nowIso(), sessionId);
    this.emitSession(sessionId);
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

  private persistScrollback(sessionId: string, buffer: string): void {
    this.db
      .prepare('UPDATE sessions SET scrollback = ?, updated_at = ? WHERE id = ?')
      .run(buffer.slice(-MAX_SCROLLBACK), nowIso(), sessionId);
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

function spawnHarness(
  command: string,
  args: string[],
  cwd: string,
  input: { cols?: number; rows?: number; env: Record<string, string> },
): IPty {
  const cols = input.cols ?? 100;
  const rows = input.rows ?? 30;

  if (process.platform === 'win32') {
    // cmd.exe is required so that .cmd shims (npm-installed harnesses) resolve.
    // Passing the command line through an environment variable avoids node-pty
    // re-quoting arguments that already contain quotes (paths with spaces).
    const commandLine = [command, ...args].map(quote).join(' ');
    return pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '%NEST_LAUNCH%'], {
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
