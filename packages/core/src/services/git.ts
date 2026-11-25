import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DiffFile, GitDiff, GitFile, GitStatus, NestEvent } from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git, gitOrNull } from '../git/exec.js';
import { buildUntrackedDiff, parseUnifiedDiff } from '../git/diff.js';
import { mergeNumstat, parseNumstat, type Numstat } from '../git/numstat.js';
import type { TaskService } from './tasks.js';

const BINARY_CHECK_BYTES = 8000;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** Counting untracked lines reads files; a huge untracked tree only needs a hint. */
const MAX_COUNTED_UNTRACKED = 200;
const NUMSTAT_TIMEOUT_MS = 20_000;

export class GitService {
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly emit: (event: NestEvent) => void,
  ) {}

  async status(taskId: string): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    return readStatus(task.workspacePath);
  }

  async diff(taskId: string, filePath?: string, staged = false): Promise<GitDiff> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const args = ['diff', '--no-color', '-M', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'];
    if (staged) args.push('--cached');
    if (filePath) args.push('--', filePath);

    const { stdout } = await git(cwd, args);
    const files = parseUnifiedDiff(stdout, { staged });

    if (!staged) {
      const status = await readStatus(cwd);
      const untracked = status.files
        .filter((file) => file.untracked && (!filePath || file.path === filePath))
        .slice(0, 200);

      for (const file of untracked) {
        const synthetic = await buildUntrackedFile(cwd, file.path);
        if (synthetic) files.push(synthetic);
      }
    }

    return { files };
  }

  async stage(taskId: string, paths: string[]): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    await git(task.workspacePath, ['add', '--', ...paths]);
    this.emit({ type: 'git:changed', taskId });
    return readStatus(task.workspacePath);
  }

  async unstage(taskId: string, paths: string[]): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    await git(task.workspacePath, ['restore', '--staged', '--', ...paths]).catch(async () => {
      await git(task.workspacePath, ['reset', 'HEAD', '--', ...paths]);
    });
    this.emit({ type: 'git:changed', taskId });
    return readStatus(task.workspacePath);
  }

  async commit(
    taskId: string,
    message: string,
    stageAll = false,
  ): Promise<{ hash: string; summary: string }> {
    const task = this.tasks.get(taskId);
    if (stageAll) {
      await git(task.workspacePath, ['add', '-A']);
    }
    const status = await readStatus(task.workspacePath);
    if (!status.files.some((file) => file.staged)) {
      throw new NestError('nothing_staged', 'Nothing is staged for commit');
    }
    await git(task.workspacePath, ['commit', '-m', message]);
    const hash = (await git(task.workspacePath, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    this.emit({ type: 'git:changed', taskId });
    return { hash, summary: message.split('\n')[0] ?? message };
  }

  async push(taskId: string): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    const upstream = await git(task.workspacePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]).catch(() => null);

    const result = upstream
      ? await git(task.workspacePath, ['push'])
      : await git(task.workspacePath, ['push', '-u', 'origin', 'HEAD']);

    this.emit({ type: 'git:changed', taskId });
    return { output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim() };
  }
}

async function readStatus(cwd: string): Promise<GitStatus> {
  const [{ stdout }, stats] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
    readNumstat(cwd),
  ]);

  const tokens = stdout.split('\0');
  let branch = 'HEAD';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.startsWith('## ')) {
      const header = token.slice(3);
      if (header.startsWith('No commits yet on ')) {
        branch = header.slice('No commits yet on '.length);
      } else if (header.startsWith('HEAD (no branch)')) {
        branch = 'HEAD';
      } else {
        const [left, right] = header.split('...');
        branch = left ?? 'HEAD';
        if (right) {
          const upstreamMatch = /^([^\s[]+)/.exec(right);
          upstream = upstreamMatch?.[1] ?? null;
          ahead = Number(/ahead (\d+)/.exec(right)?.[1] ?? 0);
          behind = Number(/behind (\d+)/.exec(right)?.[1] ?? 0);
        }
      }
      continue;
    }

    if (token.length < 4) continue;
    const indexStatus = token[0] ?? ' ';
    const worktreeStatus = token[1] ?? ' ';
    const filePath = token.slice(3);
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const staged = !untracked && indexStatus !== ' ' && indexStatus !== '?';
    const stat = stats.get(filePath);

    files.push({
      path: filePath,
      indexStatus,
      worktreeStatus,
      staged,
      untracked,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
    });

    if (indexStatus === 'R' || indexStatus === 'C') {
      index += 1;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  await countUntracked(files, cwd);
  return { branch, upstream, ahead, behind, files };
}

/**
 * `git diff HEAD` covers staged and unstaged changes against the last commit.
 * Repositories without commits have no HEAD, so both diffs are merged instead.
 */
async function readNumstat(cwd: string): Promise<Numstat> {
  const options = { timeout: NUMSTAT_TIMEOUT_MS };
  const againstHead = await gitOrNull(
    cwd,
    ['diff', '--numstat', '-z', '-M', '--no-color', 'HEAD'],
    options,
  );
  if (againstHead !== null) return parseNumstat(againstHead);

  const [worktree, staged] = await Promise.all([
    gitOrNull(cwd, ['diff', '--numstat', '-z', '--no-color'], options),
    gitOrNull(cwd, ['diff', '--numstat', '-z', '--no-color', '--cached'], options),
  ]);
  const stats: Numstat = new Map();
  if (staged) mergeNumstat(stats, parseNumstat(staged));
  if (worktree) mergeNumstat(stats, parseNumstat(worktree));
  return stats;
}

/** Untracked files are missing from git diff, so their lines are counted here. */
async function countUntracked(files: GitFile[], cwd: string): Promise<void> {
  let budget = MAX_COUNTED_UNTRACKED;
  await Promise.all(
    files.map(async (file) => {
      if (!file.untracked || budget <= 0) return;
      budget -= 1;
      const counted = await countLines(path.join(cwd, file.path));
      if (!counted) return;
      file.additions = counted.additions;
      file.deletions = counted.deletions;
    }),
  );
}

async function countLines(
  absolutePath: string,
): Promise<{ additions: number; deletions: number } | null> {
  try {
    const buffer = await readFile(absolutePath);
    if (buffer.byteLength > MAX_UNTRACKED_BYTES) return null;
    if (buffer.subarray(0, BINARY_CHECK_BYTES).includes(0)) return null;
    const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
    const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
    return { additions: body.length === 0 ? 0 : body.split('\n').length, deletions: 0 };
  } catch {
    return null;
  }
}

async function buildUntrackedFile(repoPath: string, filePath: string): Promise<DiffFile | null> {
  const absolute = path.join(repoPath, filePath);
  try {
    const buffer = await readFile(absolute);
    if (buffer.byteLength > MAX_UNTRACKED_BYTES) return null;
    if (buffer.subarray(0, BINARY_CHECK_BYTES).includes(0)) return null;
    return buildUntrackedDiff(filePath, buffer.toString('utf8'));
  } catch {
    return null;
  }
}
