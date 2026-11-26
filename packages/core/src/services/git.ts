import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  DiffFile,
  GitBranches,
  GitBranch,
  GitCommitDetail,
  GitCompare,
  GitDiff,
  GitFile,
  GitLog,
  GitRemote,
  GitStatus,
  NestEvent,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git, gitOrNull, type GitResult } from '../git/exec.js';
import { BRANCH_FORMAT, parseBranches, type BranchRecord } from '../git/branches.js';
import { LOG_FORMAT, parseLog } from '../git/log.js';
import { parseNameStatus, toCompareFiles } from '../git/compare.js';
import { buildUntrackedDiff, parseUnifiedDiff } from '../git/diff.js';
import { mergeNumstat, parseNumstat, type Numstat } from '../git/numstat.js';
import { assertRef } from '../git/refs.js';
import type { TaskService } from './tasks.js';

const BINARY_CHECK_BYTES = 8000;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
/** Counting untracked lines reads files; a huge untracked tree only needs a hint. */
const MAX_COUNTED_UNTRACKED = 200;
const NUMSTAT_TIMEOUT_MS = 20_000;
const LOG_TIMEOUT_MS = 20_000;
const REMOTE_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_COMPARE_COMMITS = 100;
const MAX_COMPARE_FILES = 2000;

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
    amend = false,
  ): Promise<{ hash: string; summary: string }> {
    const task = this.tasks.get(taskId);
    if (stageAll) {
      await git(task.workspacePath, ['add', '-A']);
    }
    const status = await readStatus(task.workspacePath);
    // Amending only the message is a valid operation, so the staged check is
    // skipped for it; a normal commit still needs something to record.
    if (!amend && !status.files.some((file) => file.staged)) {
      throw new NestError('nothing_staged', 'Nothing is staged for commit');
    }
    await git(
      task.workspacePath,
      amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message],
    );
    const hash = (await git(task.workspacePath, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    this.emit({ type: 'git:changed', taskId });
    return { hash, summary: message.split('\n')[0] ?? message };
  }

  async push(taskId: string, force = false): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    const upstream = await git(task.workspacePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]).catch(() => null);

    // Force is lease-guarded: it rewrites the remote branch only if nobody
    // else pushed to it since the last fetch.
    const options = force ? ['push', '--force-with-lease'] : ['push'];
    const result = upstream
      ? await git(task.workspacePath, options)
      : await git(task.workspacePath, [...options, '-u', 'origin', 'HEAD']);

    this.emit({ type: 'git:changed', taskId });
    return { output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim() };
  }

  /** Commits reachable from `ref` (newest first), one page at a time. */
  async log(
    taskId: string,
    options: { ref?: string; limit?: number; skip?: number } = {},
  ): Promise<GitLog> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
    const skip = Math.max(options.skip ?? 0, 0);

    // An unborn repository has no HEAD to walk; the panel shows an empty state.
    if (!(await hasHead(cwd))) return { commits: [], hasMore: false };

    const ref = options.ref ? assertRef(options.ref, 'ref') : 'HEAD';
    if (options.ref) await assertRevision(cwd, ref);

    const { stdout } = await git(
      cwd,
      [
        'log',
        '--no-color',
        `--max-count=${limit + 1}`,
        `--skip=${skip}`,
        `--format=${LOG_FORMAT}`,
        ref,
        '--',
      ],
      { timeout: LOG_TIMEOUT_MS },
    );
    const commits = parseLog(stdout);
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
  }

  /** Commit metadata plus its patch against the first parent. */
  async commitDetail(taskId: string, hash: string): Promise<GitCommitDetail> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const ref = assertRef(hash, 'commit');
    if (!(await hasHead(cwd)))
      throw new NestError('commit_missing', `Commit ${hash} was not found`);
    await assertRevision(cwd, ref, 'commit');

    const metaRaw = await git(
      cwd,
      ['log', '-1', '--no-color', `--format=${LOG_FORMAT}`, ref, '--'],
      {
        timeout: LOG_TIMEOUT_MS,
      },
    );
    const commit = parseLog(metaRaw.stdout)[0];
    if (!commit) throw new NestError('commit_missing', `Commit ${hash} was not found`);

    const diffArgs = [
      '--no-color',
      '--no-ext-diff',
      '-M',
      '--unified=3',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ];
    const parent = commit.parents[0];
    // Root commits have no parent to diff against; merges are shown against
    // their first parent, which is what the branch actually changed.
    const { stdout } = parent
      ? await git(cwd, ['diff', ...diffArgs, parent, commit.hash, '--'], {
          timeout: LOG_TIMEOUT_MS,
        })
      : await git(cwd, ['show', ...diffArgs, '--format=', commit.hash, '--'], {
          timeout: LOG_TIMEOUT_MS,
        });

    return { commit, files: parseUnifiedDiff(stdout) };
  }

  async branches(taskId: string): Promise<GitBranches> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const [refs, remotesRaw, currentRaw, headRaw] = await Promise.all([
      git(cwd, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], {
        timeout: LOG_TIMEOUT_MS,
      }),
      gitOrNull(cwd, ['remote', '-v']),
      gitOrNull(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
      gitOrNull(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    ]);

    const records = parseBranches(refs.stdout);
    const local = records
      .filter((record) => !record.remote)
      .map(toPublicBranch)
      .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
    const remote = records
      .filter((record) => record.remote)
      .map(toPublicBranch)
      .sort((a, b) => a.name.localeCompare(b.name));

    const current = currentRaw?.trim() || null;
    const baseRef = await this.resolveCompareBase(cwd, current, local, remote);

    return {
      current,
      detached: current === null,
      unborn: !headRaw || !headRaw.trim(),
      baseRef,
      remotes: parseRemotes(remotesRaw ?? ''),
      local,
      remote,
    };
  }

  /**
   * Branch-to-branch comparison: commits that `head` adds on top of the
   * merge-base with `base`, plus the files those commits touch. This is the
   * three-dot view, so commits merged into `base` after the divergence are not
   * reported as deletions of `head`'s work.
   */
  async compare(taskId: string, baseInput: string, headInput?: string): Promise<GitCompare> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const base = assertRef(baseInput, 'base ref');
    const head = assertRef(headInput ?? 'HEAD', 'head ref');
    await assertRevision(cwd, base, 'base ref');
    await assertRevision(cwd, head, 'head ref');

    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${head}`], {
      timeout: LOG_TIMEOUT_MS,
    });
    const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
    const mergeBaseRaw = await gitOrNull(cwd, ['merge-base', base, head]);

    const logRaw = await git(
      cwd,
      [
        'log',
        '--no-color',
        `--max-count=${MAX_COMPARE_COMMITS + 1}`,
        `--format=${LOG_FORMAT}`,
        `${base}..${head}`,
        '--',
      ],
      { timeout: LOG_TIMEOUT_MS },
    );
    const allCommits = parseLog(logRaw.stdout);
    const commits = allCommits.slice(0, MAX_COMPARE_COMMITS);

    // Without a common ancestor there is no merge base; comparing the two trees
    // directly still tells the user which files differ.
    const diffBase = mergeBaseRaw?.trim() || base;
    const [numstatRaw, nameStatusRaw] = await Promise.all([
      git(cwd, ['diff', '--numstat', '-z', '-M', '--no-color', diffBase, head], {
        timeout: NUMSTAT_TIMEOUT_MS,
      }),
      git(cwd, ['diff', '--name-status', '-z', '-M', '--no-color', diffBase, head], {
        timeout: NUMSTAT_TIMEOUT_MS,
      }),
    ]);

    const files = toCompareFiles(
      parseNameStatus(nameStatusRaw.stdout),
      parseNumstat(numstatRaw.stdout),
    )
      .slice(0, MAX_COMPARE_FILES)
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      base,
      head,
      mergeBase: mergeBaseRaw?.trim() || null,
      ahead: Number(aheadRaw ?? 0),
      behind: Number(behindRaw ?? 0),
      commits,
      commitsTruncated: allCommits.length > MAX_COMPARE_COMMITS,
      files,
    };
  }

  async fetch(taskId: string): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    const remotes = await gitOrNull(task.workspacePath, ['remote']);
    if (!remotes || !remotes.trim()) {
      throw new NestError('no_remotes', 'This repository has no remotes to fetch from');
    }
    const result = await git(task.workspacePath, ['fetch', '--prune'], {
      timeout: REMOTE_TIMEOUT_MS,
    });
    this.emit({ type: 'git:changed', taskId });
    return { output: combineOutput(result) };
  }

  /** Fast-forward only: Nest never creates merge commits behind the user's back. */
  async pull(taskId: string): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    const upstream = await gitOrNull(task.workspacePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]);
    if (!upstream || !upstream.trim()) {
      throw new NestError('no_upstream', 'The current branch has no upstream to pull from');
    }
    let result: GitResult;
    try {
      result = await git(task.workspacePath, ['pull', '--ff-only'], { timeout: PULL_TIMEOUT_MS });
    } catch (error) {
      if (
        error instanceof NestError &&
        /fast-forward|diverg|reconcile/i.test(error.details ?? '')
      ) {
        throw new NestError(
          'pull_not_fast_forward',
          'The branch has diverged from its upstream; merge or rebase it manually',
          error.details,
        );
      }
      throw error;
    }
    this.emit({ type: 'git:changed', taskId });
    return { output: combineOutput(result) };
  }

  async checkout(
    taskId: string,
    branch: string,
    options: { create?: boolean; from?: string } = {},
  ): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const name = assertRef(branch, 'branch');

    if (options.create) {
      await git(cwd, ['check-ref-format', '--branch', name]).catch((error) => {
        if (error instanceof NestError) {
          throw new NestError('invalid_ref', `Invalid branch name: ${name}`, error.details);
        }
        throw error;
      });
      if (await revisionExists(cwd, `refs/heads/${name}`)) {
        throw new NestError('branch_exists', `Branch ${name} already exists`);
      }
      const from = options.from ? assertRef(options.from, 'start point') : null;
      if (from) await assertRevision(cwd, from, 'start point');
      await git(cwd, from ? ['switch', '-c', name, from] : ['switch', '-c', name]);
    } else if (await revisionExists(cwd, `refs/heads/${name}`)) {
      await git(cwd, ['switch', name]);
    } else if (await revisionExists(cwd, `refs/remotes/${name}`)) {
      const localName = name.slice(name.indexOf('/') + 1);
      if (await revisionExists(cwd, `refs/heads/${localName}`)) {
        throw new NestError(
          'branch_exists',
          `Local branch ${localName} already exists; switch to it instead`,
        );
      }
      await git(cwd, ['switch', '--track', name]);
    } else {
      throw new NestError('branch_missing', `Branch ${name} was not found`);
    }

    this.emit({ type: 'git:changed', taskId });
    return readStatus(cwd);
  }

  /**
   * Throws away working tree changes for the given paths. Tracked files go back
   * to HEAD; untracked files are deleted. The paths must currently be reported
   * as changed, so a stale click cannot wipe an unrelated file.
   */
  async discard(taskId: string, paths: string[]): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const status = await readStatus(cwd);
    const changed = new Map(status.files.map((file) => [file.path, file]));

    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const filePath of paths) {
      assertInsideWorkspace(cwd, filePath);
      const file = changed.get(filePath);
      if (!file) {
        throw new NestError('path_not_changed', `${filePath} has no pending changes`);
      }
      if (file.untracked) untracked.push(filePath);
      else tracked.push(filePath);
    }

    if (tracked.length > 0) {
      if (!(await hasHead(cwd))) {
        throw new NestError(
          'no_head',
          'Nothing is committed yet, so tracked changes cannot be restored',
        );
      }
      await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
    }
    if (untracked.length > 0) {
      await git(cwd, ['clean', '-f', '--', ...untracked]);
    }

    this.emit({ type: 'git:changed', taskId });
    return readStatus(cwd);
  }

  /** Default ref for the compare panel: the upstream, then the remote default branch. */
  private async resolveCompareBase(
    cwd: string,
    current: string | null,
    local: GitBranch[],
    remote: GitBranch[],
  ): Promise<string | null> {
    const upstream = local.find((branch) => branch.name === current)?.upstream ?? null;
    if (upstream) return upstream;

    const originHead = await gitOrNull(cwd, [
      'symbolic-ref',
      '--short',
      '-q',
      'refs/remotes/origin/HEAD',
    ]);
    if (originHead?.trim()) return originHead.trim();

    const remoteDefault = remote.find(
      (branch) => branch.name === 'origin/main' || branch.name === 'origin/master',
    );
    if (remoteDefault) return remoteDefault.name;

    const localDefault = local.find((branch) => branch.name === 'main' || branch.name === 'master');
    if (localDefault) return localDefault.name;

    return local[0]?.name ?? remote[0]?.name ?? null;
  }
}

function toPublicBranch(record: BranchRecord): GitBranch {
  const { refname: _refname, ...branch } = record;
  return branch;
}

function combineOutput(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n');
}

async function revisionExists(cwd: string, revision: string): Promise<boolean> {
  return Boolean(await gitOrNull(cwd, ['rev-parse', '--verify', '-q', revision]));
}

async function hasHead(cwd: string): Promise<boolean> {
  return revisionExists(cwd, 'HEAD');
}

async function assertRevision(cwd: string, revision: string, label = 'ref'): Promise<void> {
  if (!(await revisionExists(cwd, revision))) {
    throw new NestError('ref_missing', `Unknown ${label}: ${revision}`);
  }
}

function parseRemotes(raw: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>();
  for (const line of raw.split('\n')) {
    const match = /^(\S+)\t(.+?) \((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const name = match[1] ?? '';
    const url = match[2] ?? '';
    const kind = match[3];
    if (!name) continue;
    const entry = remotes.get(name) ?? { name, fetchUrl: '', pushUrl: '' };
    if (kind === 'fetch') entry.fetchUrl = url;
    else entry.pushUrl = url;
    remotes.set(name, entry);
  }
  return [...remotes.values()];
}

/** The renderer may only name files inside the task workspace, never `..`. */
function assertInsideWorkspace(workspacePath: string, filePath: string): void {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, filePath);
  if (path.isAbsolute(filePath) || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
    throw new NestError('invalid_path', `Path is outside the workspace: ${filePath}`);
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
