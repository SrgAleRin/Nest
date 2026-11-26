import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId } from '@nest/shared';

/**
 * How far before the launch we still look for a conversation that an explicit
 * "continue latest" resume just touched: the CLI rewrites the file a moment
 * after Nest records the launch. A fresh start never uses this slack, so a
 * conversation that already existed when the tab started cannot be mistaken
 * for the new tab's own conversation.
 */
const CONTINUE_SLACK_MS = 15_000;

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
  /** Ids already bound to another Nest session; they are never returned. */
  claimedIds?: Iterable<string>;
  /**
   * Output of the launched process itself. A conversation id printed there is
   * the only positive proof that the conversation belongs to this process.
   */
  processOutput?: string;
  /**
   * Another tab runs the same harness in the same workspace. Timestamps then
   * prove nothing, so only a process-reported id may become `exact`.
   */
  hasSiblingSession?: boolean;
}

export type DiscoveryConfidence = 'exact' | 'heuristic';

export type DiscoveryReason =
  /** The launched process printed the conversation id itself. */
  | 'process_reported'
  /** Exactly one conversation for this cwd appeared after the launch. */
  | 'unique_after_launch'
  /** Several conversations for the same cwd are plausible. */
  | 'ambiguous_candidates'
  /** The only candidate was created before this tab started. */
  | 'predates_launch'
  /** The CLI was asked to continue its latest conversation. */
  | 'continued_latest'
  /** The candidate already belongs to another session or tab. */
  | 'claimed_elsewhere'
  | 'no_candidates';

export interface DiscoveryResult {
  id: string | null;
  confidence: DiscoveryConfidence;
  reason: DiscoveryReason;
  /** Conversations found for the same cwd inside the time window. */
  candidates: number;
  createdAtMs: number | null;
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

interface Conversation {
  id: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/**
 * Finds the harness conversation that belongs to a Nest session.
 *
 * Every adapter gathers the conversations for the working directory that
 * appeared inside the time window; the shared resolver then decides how strong
 * the ownership evidence is. `exact` means the launched process named the
 * conversation itself, or it is the only conversation that appeared after the
 * launch and nobody else claims it. Everything else is `heuristic` and must
 * never be applied automatically. Returning no id is normal and simply keeps
 * the `latest` resume fallback.
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
  ): Promise<DiscoveryResult> {
    const includeUpdated = options.includeUpdated ?? false;
    const launchMs = since.getTime();
    const windowStartMs = includeUpdated ? launchMs - CONTINUE_SLACK_MS : launchMs;
    const conversations = await this.collect(harnessId, cwd, windowStartMs, includeUpdated);

    return resolveCandidates(conversations, {
      includeUpdated,
      launchMs,
      claimedIds: options.claimedIds ?? [],
      processOutput: options.processOutput ?? '',
      hasSiblingSession: options.hasSiblingSession ?? false,
    });
  }

  private collect(
    harnessId: HarnessId,
    cwd: string,
    windowStartMs: number,
    includeUpdated: boolean,
  ): Promise<Conversation[]> {
    switch (harnessId) {
      case 'opencode':
        return this.findOpenCode(cwd, windowStartMs, includeUpdated);
      case 'codex':
        return this.findCodex(cwd, windowStartMs);
      case 'pi':
        return this.findPi(cwd, windowStartMs);
      case 'copilot':
        return this.findCopilot(cwd, windowStartMs);
      case 'claude':
        return this.findClaude(cwd, windowStartMs);
      case 'qwen':
        return this.findQwen(cwd, windowStartMs);
      case 'fake':
        return this.findFake(cwd, windowStartMs);
      default:
        return Promise.resolve([]);
    }
  }

  private async findOpenCode(
    cwd: string,
    sinceMs: number,
    includeUpdated: boolean,
  ): Promise<Conversation[]> {
    let output: string;
    try {
      output = await this.run('opencode', ['session', 'list', '--format', 'json', '-n', '50'], cwd);
    } catch {
      return [];
    }

    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start < 0 || end < start) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(output.slice(start, end + 1));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const found: Conversation[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const id = record.id;
      const directory = record.directory;
      const created = record.created;
      const updated = record.updated;
      if (typeof id !== 'string') continue;
      if (typeof directory !== 'string' || !samePath(directory, cwd)) continue;

      const createdAtMs = typeof created === 'number' ? created : null;
      const updatedAtMs = typeof updated === 'number' ? updated : createdAtMs;
      const fresh =
        (createdAtMs !== null && createdAtMs >= sinceMs) ||
        (includeUpdated && updatedAtMs !== null && updatedAtMs >= sinceMs);
      if (!fresh) continue;

      found.push({ id, createdAtMs, updatedAtMs });
    }
    return found;
  }

  private async findCodex(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const root = this.env.CODEX_HOME
      ? path.join(this.env.CODEX_HOME, 'sessions')
      : path.join(this.homeDir, '.codex', 'sessions');

    const files = await recentFiles(
      root,
      sinceMs,
      (candidate) =>
        candidate.path.endsWith('.jsonl') && path.basename(candidate.path).startsWith('rollout-'),
    );

    const found: Conversation[] = [];
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
          found.push(fileConversation(id, file));
        }
      }
    }
    return found;
  }

  private async findPi(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const root = path.join(this.homeDir, '.pi', 'agent', 'sessions');
    const files = await recentFiles(root, sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );

    const found: Conversation[] = [];
    for (const file of files) {
      const head = await readHead(file.path);
      if (!head) continue;
      for (const line of firstLines(head, 5)) {
        const record = parseJsonObject(line);
        if (!record) continue;
        const id = record.id;
        const sessionCwd = record.cwd;
        if (typeof id === 'string' && typeof sessionCwd === 'string' && samePath(sessionCwd, cwd)) {
          found.push(fileConversation(id, file));
        }
      }
    }
    return found;
  }

  private async findCopilot(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const root = path.join(this.homeDir, '.copilot', 'session-state');
    const files = await recentFiles(
      root,
      sinceMs,
      (candidate) => path.basename(candidate.path) === 'workspace.yaml',
    );

    const found: Conversation[] = [];
    for (const file of files) {
      const text = await readText(file.path);
      if (!text) continue;
      const id = yamlField(text, 'id') ?? path.basename(path.dirname(file.path));
      const sessionCwd = yamlField(text, 'cwd');
      if (sessionCwd && samePath(sessionCwd, cwd)) found.push(fileConversation(id, file));
    }
    return found;
  }

  private async findClaude(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const root = path.join(this.homeDir, '.claude', 'projects');
    const files = await recentFiles(root, sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );
    const encodedDir = encodeCwd(cwd);

    const found: Conversation[] = [];
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
      if (sessionCwd && samePath(sessionCwd, cwd)) {
        found.push(fileConversation(id, file));
      } else if (!sessionCwd && path.basename(path.dirname(file.path)) === encodedDir) {
        found.push(fileConversation(id, file));
      }
    }
    return found;
  }

  private async findQwen(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const base =
      this.env.QWEN_HOME || this.env.QWEN_RUNTIME_DIR || path.join(this.homeDir, '.qwen');
    const projectDir = path.join(base, 'projects', encodeQwenCwd(cwd));
    if (!(await directoryExists(projectDir))) return [];

    const files = await recentFiles(path.join(projectDir, 'chats'), sinceMs, (candidate) =>
      candidate.path.endsWith('.jsonl'),
    );
    return files.map((file) => fileConversation(path.basename(file.path, '.jsonl'), file));
  }

  private async findFake(cwd: string, sinceMs: number): Promise<Conversation[]> {
    const root = this.env.NEST_FAKE_SESSION_DIR;
    if (!root) return [];

    const files = await recentFiles(root, sinceMs, (candidate) => candidate.path.endsWith('.json'));

    const found: Conversation[] = [];
    for (const file of files) {
      const text = await readText(file.path);
      if (!text) continue;
      const record = parseJsonObject(text);
      if (!record) continue;
      const id = record.id;
      const sessionCwd = record.cwd;
      if (typeof id === 'string' && typeof sessionCwd === 'string' && samePath(sessionCwd, cwd)) {
        found.push(fileConversation(id, file));
      }
    }
    return found;
  }
}

/**
 * Turns the candidate list into a binding decision.
 *
 * Only a conversation id that the launched process printed is `exact` on its
 * own; a lone conversation created after the launch is `exact` too, but only
 * while it is the only tab on that workspace. Any second candidate for the same
 * cwd, a parallel tab, a candidate that predates the launch or an id claimed by
 * another session downgrades the answer to `heuristic`. Heuristic ids stay
 * usable on request but are never applied automatically.
 */
function resolveCandidates(
  conversations: Conversation[],
  input: {
    includeUpdated: boolean;
    launchMs: number;
    claimedIds: Iterable<string>;
    processOutput: string;
    hasSiblingSession: boolean;
  },
): DiscoveryResult {
  const claimed = new Set(input.claimedIds);
  const ordered = [...conversations].sort(
    (left, right) => stamp(right, input.includeUpdated) - stamp(left, input.includeUpdated),
  );
  const candidates = ordered.length;
  if (candidates === 0) {
    return {
      id: null,
      confidence: 'heuristic',
      reason: 'no_candidates',
      candidates,
      createdAtMs: null,
    };
  }

  const output = stripAnsi(input.processOutput);
  const reported = output
    ? ordered.find(
        (conversation) => !claimed.has(conversation.id) && output.includes(conversation.id),
      )
    : undefined;
  if (reported) {
    return {
      id: reported.id,
      confidence: 'exact',
      reason: 'process_reported',
      candidates,
      createdAtMs: reported.createdAtMs,
    };
  }

  const best = ordered.find((conversation) => !claimed.has(conversation.id));
  if (!best) {
    return {
      id: null,
      confidence: 'heuristic',
      reason: 'claimed_elsewhere',
      candidates,
      createdAtMs: null,
    };
  }

  const unbound = (reason: DiscoveryReason): DiscoveryResult => ({
    id: null,
    confidence: 'heuristic',
    reason,
    candidates,
    createdAtMs: null,
  });

  // "Continue latest" means the CLI picked the conversation, not us: the id is
  // a hint the user may act on, never an automatic choice.
  if (input.includeUpdated) {
    return {
      id: best.id,
      confidence: 'heuristic',
      reason: 'continued_latest',
      candidates,
      createdAtMs: best.createdAtMs,
    };
  }

  // Ambiguity is judged on every conversation for the cwd, not only on the
  // unclaimed ones: a parallel tab may simply not have bound its id yet. A
  // guess here would let two tabs adopt each other's conversation, so no id is
  // stored at all and the session keeps the "latest" fallback.
  if (candidates > 1 || input.hasSiblingSession) return unbound('ambiguous_candidates');
  if (best.createdAtMs === null || best.createdAtMs < input.launchMs) {
    return unbound('predates_launch');
  }

  return {
    id: best.id,
    confidence: 'exact',
    reason: 'unique_after_launch',
    candidates,
    createdAtMs: best.createdAtMs,
  };
}

function stamp(conversation: Conversation, includeUpdated: boolean): number {
  const primary = includeUpdated ? conversation.updatedAtMs : conversation.createdAtMs;
  return primary ?? conversation.createdAtMs ?? conversation.updatedAtMs ?? 0;
}

function fileConversation(id: string, file: Candidate): Conversation {
  // File adapters only know the file timestamp; the scan window already limits
  // it to the launch, so it is good enough for ordering and the freshness test.
  return { id, createdAtMs: file.mtimeMs, updatedAtMs: file.mtimeMs };
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
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

    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
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
