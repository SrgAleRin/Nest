import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId } from '@nest/shared';

/**
 * How far before the recorded session start we still accept a discovered
 * conversation. Harness CLIs may create their session file a few seconds
 * before Nest persists the row, and filesystem timestamps are coarse.
 */
const CLOCK_SLACK_MS = 15_000;

const HEAD_BYTES = 256 * 1024;

export interface HarnessDiscoveryOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to a short-lived child process. */
  run?: (command: string, args: string[], cwd: string) => Promise<string>;
}

export interface FindOptions {
  /**
   * Also accept conversations whose last activity is recent. Needed after a
   * "continue latest" resume, where the CLI touches an existing conversation
   * instead of creating a new one (OpenCode keeps `created` unchanged).
   */
  includeUpdated?: boolean;
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

/**
 * Finds the harness conversation that belongs to a Nest session.
 *
 * Every adapter is a best-effort lookup: it returns the newest conversation
 * for the same working directory that appeared after the session started.
 * Returning null is normal and simply keeps the `latest` resume fallback.
 */
export class HarnessDiscovery {
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: (command: string, args: string[], cwd: string) => Promise<string>;

  constructor(options: HarnessDiscoveryOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.env = options.env ?? process.env;
    this.run = options.run ?? runCommand;
  }

  async find(
    harnessId: HarnessId,
    cwd: string,
    since: Date,
    options: FindOptions = {},
  ): Promise<string | null> {
    const sinceMs = since.getTime() - CLOCK_SLACK_MS;
    switch (harnessId) {
      case 'opencode':
        return this.findOpenCode(cwd, sinceMs, options.includeUpdated ?? false);
      case 'codex':
        return this.findCodex(cwd, sinceMs);
      case 'pi':
        return this.findPi(cwd, sinceMs);
      case 'copilot':
        return this.findCopilot(cwd, sinceMs);
      case 'claude':
        return this.findClaude(cwd, sinceMs);
      case 'qwen':
        return this.findQwen(cwd, sinceMs);
      case 'fake':
        return this.findFake(cwd, sinceMs);
      default:
        return null;
    }
  }

  private async findOpenCode(
    cwd: string,
    sinceMs: number,
    includeUpdated: boolean,
  ): Promise<string | null> {
    let output: string;
    try {
      output = await this.run(
        'opencode',
        ['session', 'list', '--format', 'json', '-n', '50'],
        cwd,
      );
    } catch {
      return null;
    }

    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start < 0 || end < start) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;

    let best: { id: string; stamp: number } | null = null;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = record.id;
      const directory = record.directory;
      const created = record.created;
      const updated = record.updated;
      if (typeof id !== 'string') continue;
      if (typeof directory !== 'string' || !samePath(directory, cwd)) continue;
      if (typeof created !== 'number') continue;

      const updatedAt = typeof updated === 'number' ? updated : created;
      const fresh = created >= sinceMs || (includeUpdated && updatedAt >= sinceMs);
      if (!fresh) continue;

      const stamp = includeUpdated ? updatedAt : created;
      if (!best || stamp > best.stamp) best = { id, stamp };
    }
    return best?.id ?? null;
  }

  private async findCodex(cwd: string, sinceMs: number): Promise<string | null> {
    const root = this.env.CODEX_HOME
      ? path.join(this.env.CODEX_HOME, 'sessions')
      : path.join(this.homeDir, '.codex', 'sessions');

    const files = await recentFiles(
      root,
      sinceMs,
      (candidate) =>
        candidate.path.endsWith('.jsonl') &&
        path.basename(candidate.path).startsWith('rollout-'),
    );

    for (const file of files) {
      const head = await readHead(file.path);
      if (!head) continue;
      for (const line of firstLines(head, 5)) {
        const record = parseJsonObject(line);
        if (!record) continue;
        if (record.type !== 'session_meta') continue;
        const payload = asRecord(record.payload);
        if (!payload) continue;
        const id = payload.id;
        const sessionCwd = payload.cwd;
        if (typeof id === 'string' && typeof sessionCwd === 'string' && samePath(sessionCwd, cwd)) {
          return id;
        }
      }
    }
    return null;
  }

  private async findPi(cwd: string, sinceMs: number): Promise<string | null> {
    const root = path.join(this.homeDir, '.pi', 'agent', 'sessions');
    const files = await recentFiles(root, sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );

    for (const file of files) {
      const head = await readHead(file.path);
      if (!head) continue;
      for (const line of firstLines(head, 5)) {
        const record = parseJsonObject(line);
        if (!record) continue;
        const id = record.id;
        const sessionCwd = record.cwd;
        if (typeof id === 'string' && typeof sessionCwd === 'string' && samePath(sessionCwd, cwd)) {
          return id;
        }
      }
    }
    return null;
  }

  private async findCopilot(cwd: string, sinceMs: number): Promise<string | null> {
    const root = path.join(this.homeDir, '.copilot', 'session-state');
    const files = await recentFiles(
      root,
      sinceMs,
      (candidate) => path.basename(candidate.path) === 'workspace.yaml',
    );

    for (const file of files) {
      const text = await readText(file.path);
      if (!text) continue;
      const id = yamlField(text, 'id') ?? path.basename(path.dirname(file.path));
      const sessionCwd = yamlField(text, 'cwd');
      if (sessionCwd && samePath(sessionCwd, cwd)) return id;
    }
    return null;
  }

  private async findClaude(cwd: string, sinceMs: number): Promise<string | null> {
    const root = path.join(this.homeDir, '.claude', 'projects');
    const files = await recentFiles(root, sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );
    const encodedDir = encodeCwd(cwd);

    for (const file of files) {
      const head = await readHead(file.path);
      if (!head) continue;

      let sessionId: string | null = null;
      let sessionCwd: string | null = null;
      for (const line of firstLines(head, 20)) {
        const record = parseJsonObject(line);
        if (!record) continue;
        if (typeof record.sessionId === 'string') sessionId = record.sessionId;
        if (typeof record.cwd === 'string') sessionCwd = record.cwd;
        if (sessionId && sessionCwd) break;
      }

      const id = sessionId ?? path.basename(file.path, '.jsonl');
      if (sessionCwd && samePath(sessionCwd, cwd)) return id;
      if (!sessionCwd && path.basename(path.dirname(file.path)) === encodedDir) return id;
    }
    return null;
  }

  private async findQwen(cwd: string, sinceMs: number): Promise<string | null> {
    const base =
      this.env.QWEN_HOME || this.env.QWEN_RUNTIME_DIR || path.join(this.homeDir, '.qwen');
    const projectDir = path.join(base, 'projects', encodeQwenCwd(cwd));
    if (!(await directoryExists(projectDir))) return null;

    const files = await recentFiles(path.join(projectDir, 'chats'), sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );
    const newest = files[0];
    return newest ? path.basename(newest.path, '.jsonl') : null;
  }

  private async findFake(cwd: string, sinceMs: number): Promise<string | null> {
    const root = this.env.NEST_FAKE_SESSION_DIR;
    if (!root) return null;

    const files = await recentFiles(root, sinceMs, (candidate) =>
      candidate.path.endsWith('.json'),
    );

    for (const file of files) {
      const text = await readText(file.path);
      if (!text) continue;
      const record = parseJsonObject(text);
      if (!record) continue;
      const id = record.id;
      const sessionCwd = record.cwd;
      if (typeof id === 'string' && typeof sessionCwd === 'string' && samePath(sessionCwd, cwd)) {
        return id;
      }
    }
    return null;
  }
}

export function samePath(left: string, right: string): boolean {
  return normalizeCwd(left) === normalizeCwd(right);
}

export function normalizeCwd(value: string): string {
  let normalized = path.resolve(value);
  normalized = normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function encodeCwd(cwd: string): string {
  return normalizeCwd(cwd).replace(/[^a-z0-9]/g, '-');
}

function encodeQwenCwd(cwd: string): string {
  return normalizeCwd(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function recentFiles(
  root: string,
  sinceMs: number,
  accept: (candidate: Candidate) => boolean,
): Promise<Candidate[]> {
  const files = await walkFiles(root);
  return files
    .filter((candidate) => candidate.mtimeMs >= sinceMs && accept(candidate))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function walkFiles(root: string, maxDepth = 6): Promise<Candidate[]> {
  const result: Candidate[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          result.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {
          // the file may disappear while we scan
        }
      }
    }
  };

  await visit(root, 0);
  return result;
}

async function readHead(filePath: string): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function firstLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/);
  return lines.length <= count ? lines : lines.slice(0, count);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return asRecord(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function yamlField(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text);
  if (!match?.[1]) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      cwd,
      timeout: 4000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    };

    const executable =
      process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
    const execArgs =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', [command, ...args].map(quoteArgument).join(' ')]
        : args;

    execFile(executable, execArgs, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function quoteArgument(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
