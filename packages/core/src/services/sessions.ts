import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import {
  newId,
  nowIso,
  type NestEvent,
  type Session,
  type SessionStatus,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { HarnessRegistry } from '../harness/registry.js';
import { toSession, type SessionRow } from './rows.js';
import type { TaskService } from './tasks.js';

const MAX_SCROLLBACK = 4 * 1024 * 1024;
const IDLE_AFTER_MS = 2000;

interface Runtime {
  pty: IPty;
  taskId: string;
  buffer: string;
  status: SessionStatus;
  stopping: boolean;
  idleTimer: NodeJS.Timeout | null;
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
      | SessionRow
      | undefined;
    if (!row) throw new NestError('session_not_found', `Session ${sessionId} was not found`);
    return toSession(row);
  }

  activeForTask(taskId: string): Session | null {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.taskId === taskId && (runtime.status === 'running' || runtime.status === 'idle')) {
        return this.get(id);
      }
    }
    return null;
  }

  async start(input: StartSessionInput): Promise<Session> {
    const task = this.tasks.get(input.taskId);
    const harness = this.harnesses.get(input.harnessId);

    const count = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM sessions WHERE task_id = ?')
          .get(task.id) as { count: number | bigint }
      ).count,
    );

    const id = newId();
    const timestamp = nowIso();
    const title = `${harness.label} ${count + 1}`;

    this.db
      .prepare(
        `INSERT INTO sessions (id, task_id, harness_id, title, status, cwd, exit_code, scrollback, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'starting', ?, NULL, '', ?, ?)`,
      )
      .run(id, task.id, harness.id, title, task.workspacePath, timestamp, timestamp);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    env.NEST = '1';
    env.NEST_TASK_ID = task.id;
    env.NEST_SESSION_ID = id;
    env.NEST_HARNESS = harness.id;
    delete env.ELECTRON_RUN_AS_NODE;

    let child: IPty;
    try {
      child = spawnHarness(harness.command, harness.args, task.workspacePath, {
        ...input,
        env,
      });
    } catch (error) {
      this.setStatus(id, 'failed');
      this.db
        .prepare('UPDATE sessions SET exit_code = ? WHERE id = ?')
        .run(null, id);
      throw new NestError(
        'session_spawn_failed',
        `Failed to start ${harness.label}`,
        (error as Error).message,
      );
    }

    const runtime: Runtime = {
      pty: child,
      taskId: task.id,
      buffer: '',
      status: 'running',
      stopping: false,
      idleTimer: null,
    };
    this.runtimes.set(id, runtime);

    child.onData((data) => {
      const active = this.runtimes.get(id);
      if (!active) return;
      active.buffer = (active.buffer + data).slice(-MAX_SCROLLBACK);
      this.emit({ type: 'session:data', sessionId: id, data });
      if (active.status === 'starting' || active.status === 'idle') {
        this.setStatus(id, 'running');
        active.status = 'running';
      }
      if (active.idleTimer) clearTimeout(active.idleTimer);
      active.idleTimer = setTimeout(() => {
        const current = this.runtimes.get(id);
        if (!current || current.status !== 'running') return;
        this.setStatus(id, 'idle');
        current.status = 'idle';
      }, IDLE_AFTER_MS);
    });

    child.onExit(({ exitCode }) => {
      const active = this.runtimes.get(id);
      if (active?.idleTimer) clearTimeout(active.idleTimer);
      const status: SessionStatus = active?.stopping || exitCode === 0 ? 'exited' : 'failed';
      this.persistScrollback(id, active?.buffer ?? '');
      this.runtimes.delete(id);
      this.setStatus(id, status, exitCode);
    });

    this.setStatus(id, 'running');
    return this.get(id);
  }

  write(sessionId: string, data: string): void {
    this.runtime(sessionId).pty.write(data);
  }

  writeText(sessionId: string, text: string): void {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\x1b\[201~/g, ''); // eslint-disable-line no-control-regex
    this.runtime(sessionId).pty.write(`\x1b[200~${normalized}\x1b[201~\r`);
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
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.stopping = true;
    try {
      runtime.pty.kill();
    } catch {
      // already gone
    }
  }

  stopForTask(taskId: string): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.taskId === taskId) {
        runtime.stopping = true;
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
    const row = this.db
      .prepare('SELECT scrollback FROM sessions WHERE id = ?')
      .get(sessionId) as { scrollback: string } | undefined;
    return row?.scrollback ?? '';
  }

  recoverStale(): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = 'exited', exit_code = NULL, updated_at = ?
         WHERE status IN ('starting', 'running', 'idle')`,
      )
      .run(nowIso());
  }

  shutdownAll(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.idleTimer) clearTimeout(runtime.idleTimer);
      this.persistScrollback(id, runtime.buffer);
      runtime.stopping = true;
      try {
        runtime.pty.kill();
      } catch {
        // already gone
      }
    }
    this.runtimes.clear();
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
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | SessionRow
      | undefined;
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
