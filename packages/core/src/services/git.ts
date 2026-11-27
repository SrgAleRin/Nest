import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { DEFAULT_DIFF_MODE } from '@nest/shared';
import type {
  DiffDescriptor,
  DiffFile,
  DiffMode,
  GitBranches,
  GitBranch,
  GitCommit,
  GitCommitDetail,
  GitCompare,
  GitCompareDiff,
  GitDiff,
  GitFile,
  GitLog,
  GitRemote,
  GitStatus,
  NestEvent,
  Task,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git, gitOrNull, type GitResult } from '../git/exec.js';
import { BRANCH_FORMAT, parseBranches, type BranchRecord } from '../git/branches.js';
import { LOG_FORMAT, parseLog } from '../git/log.js';
import { parseNameStatus, toCompareFiles } from '../git/compare.js';
import { buildUntrackedDiff, parseUnifiedDiff } from '../git/diff.js';
import { parseNumstat, sumNumstat, type NumstatSides } from '../git/numstat.js';
import { assertRef } from '../git/refs.js';
import { parseStatus } from '../git/status.js';
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
/** The graph asks for a full page of every branch, so the cap matches the RPC contract. */
const MAX_LOG_LIMIT = 300;
/** `search` is applied in code, so the walk is capped to keep one page cheap. */
const SEARCH_SCAN_LIMIT = 2000;
const MAX_COMPARE_COMMITS = 100;
const MAX_COMPARE_FILES = 2000;
/** Reading untracked files costs IO; a huge untracked tree only needs a sample. */
const MAX_UNTRACKED_FILES = 200;
const DIFF_ARGS = ['--no-color', '-M', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'];

export interface DiffRequest {
  mode?: DiffMode;
  /** Restrict the diff to one workspace-relative path. */
  path?: string;
}

export interface LogRequest {
  ref?: string;
  /** Which history to walk; a `ref` wins over the scope. */
  scope?: 'head' | 'branches' | 'all';
  /** Case-insensitive substring of the message, author or hash prefix. */
  search?: string;
  limit?: number;
  skip?: number;
}

export interface CompareDiffRequest {
  base: string;
  head?: string;
  /** Restrict the patch to one path of the comparison. */
  path?: string;
}

/** Which side of a change `discard` drops. */
export type DiscardSide = 'staged' | 'unstaged' | 'both';

/**
 * One promise chain per workspace: the mutating git commands of the same
 * checkout run one after another, so two clicks (or a click racing a fetch)
 * cannot collide on `.git/index.lock`. Reads never wait.
 *
 * A failed mutation settles its slot and the chain moves on, so one broken
 * command does not block every later one.
 */
export class MutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // Forget the key once nothing is queued behind this operation anymore.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

export interface PushOptions {
  /** Lease-guarded force push; only the current branch is rewritten. */
  force?: boolean;
  /**
   * Publish the branch as its own remote branch even though its upstream names
   * something else. Without it a mismatched upstream is reported, never
   * rewritten silently.
   */
  publish?: boolean;
}

export class GitService {
  private readonly mutations = new MutationQueue();

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly emit: (event: NestEvent) => void,
  ) {}

  /**
   * Reading the status also reconciles the persisted branch: a switch made in
   * the UI or by an external git command is visible to the header and the
   * status bar as soon as they read the same status the Git panel reads.
   */
  async status(taskId: string): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    return this.readAndSync(task);
  }

  /** `git status` plus the branch mirror; the single source of truth is Git. */
  private async readAndSync(task: Task): Promise<GitStatus> {
    const status = await readStatus(task.workspacePath);
    this.tasks.syncBranch(task.id, status.branch);
    return status;
  }

  /**
   * The Diff panel's review view. Each mode names its two sides explicitly and
   * returns the descriptor it was computed with, so the panel never labels a
   * patch with a comparison it does not describe.
   *
   * - `unstaged`: index → working tree (untracked files as additions)
   * - `staged`: HEAD → index
   * - `both`: per-file union of the two; a partially staged file appears once
   *   per side, so the stage state is never hidden in a merged patch
   * - `base`: task base ref → working tree *including the index*
   */
  async diff(taskId: string, request: DiffRequest = {}): Promise<GitDiff> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const mode = request.mode ?? DEFAULT_DIFF_MODE;
    const pathspec = request.path ? ['--', request.path] : [];

    switch (mode) {
      case 'staged':
        return {
          descriptor: descriptorFor('staged', null),
          files: sortDiffFiles(
            await this.readDiff(cwd, ['diff', ...DIFF_ARGS, '--cached', ...pathspec], true),
          ),
        };

      case 'base': {
        const baseRef = await this.resolveDiffBase(cwd, task);
        const files = await this.readDiff(cwd, ['diff', ...DIFF_ARGS, baseRef, ...pathspec], false);
        await appendUntracked(cwd, files, request.path);
        return { descriptor: descriptorFor('base', baseRef), files: sortDiffFiles(files) };
      }

      case 'unstaged': {
        const files = await this.readDiff(cwd, ['diff', ...DIFF_ARGS, ...pathspec], false);
        await appendUntracked(cwd, files, request.path);
        return { descriptor: descriptorFor('unstaged', null), files: sortDiffFiles(files) };
      }

      case 'both': {
        const [unstaged, staged] = await Promise.all([
          this.readDiff(cwd, ['diff', ...DIFF_ARGS, ...pathspec], false),
          this.readDiff(cwd, ['diff', ...DIFF_ARGS, '--cached', ...pathspec], true),
        ]);
        const files = [...unstaged, ...staged];
        await appendUntracked(cwd, files, request.path);
        return { descriptor: descriptorFor('both', null), files: sortDiffFiles(files) };
      }
    }
  }

  private async readDiff(cwd: string, args: string[], staged: boolean): Promise<DiffFile[]> {
    const { stdout } = await git(cwd, args);
    return parseUnifiedDiff(stdout, { staged });
  }

  /**
   * Ref the task base mode compares against: the recorded branch point of a
   * worktree task, else the compare default. A checkout on its own base branch
   * would otherwise diff against itself, so HEAD is used and labelled instead.
   */
  private async resolveDiffBase(cwd: string, task: Task): Promise<string> {
    if (task.baseRef) {
      await assertRevision(cwd, task.baseRef, 'task base ref');
      return task.baseRef;
    }
    if (!(await hasHead(cwd))) {
      throw new NestError(
        'no_head',
        'Nothing is committed yet, so there is no base to compare against',
      );
    }
    const branches = await this.branches(task.id);
    const base = branches.baseRef;
    return !base || base === branches.current ? 'HEAD' : base;
  }

  async stage(taskId: string, paths: string[]): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    assertPathsInside(task.workspacePath, paths);
    return this.mutations.run(task.workspacePath, async () => {
      await git(task.workspacePath, ['add', '--', ...paths]);
      this.emit({ type: 'git:changed', taskId });
      return readStatus(task.workspacePath);
    });
  }

  async unstage(taskId: string, paths: string[]): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    assertPathsInside(task.workspacePath, paths);
    return this.mutations.run(task.workspacePath, async () => {
      // A rename lives in the index as an addition plus a deletion, so undoing
      // only the new path leaves the original staged as deleted.
      const status = await readStatus(task.workspacePath);
      const targets = expandChangedPaths(status.files, paths);
      await unstageTargets(task.workspacePath, targets);
      this.emit({ type: 'git:changed', taskId });
      return readStatus(task.workspacePath);
    });
  }

  async commit(
    taskId: string,
    message: string,
    stageAll = false,
    amend = false,
  ): Promise<{ hash: string; summary: string }> {
    const task = this.tasks.get(taskId);
    return this.mutations.run(task.workspacePath, async () => {
      // Amending replaces the current commit, so it needs one; the first commit
      // on an unborn branch does not (git creates the root commit without HEAD).
      if (amend && !(await hasHead(task.workspacePath))) {
        throw new NestError(
          'amend_without_head',
          'There is no commit to amend: this branch has no commits yet',
        );
      }
      // `stageAll` is the only path that touches the index; a normal commit
      // records exactly what is staged and leaves the worktree alone.
      if (stageAll) {
        await git(task.workspacePath, ['add', '-A']);
      }
      // Amending only the message is a valid operation, so the staged check is
      // skipped for it; a normal commit still needs something to record. A
      // conflict is let through so git explains the unmerged files instead of
      // Nest reporting an empty index.
      if (!amend && !(await indexHasChanges(task.workspacePath))) {
        const status = await readStatus(task.workspacePath);
        if (!status.files.some((file) => file.conflict)) {
          throw new NestError('nothing_staged', 'Nothing is staged for commit');
        }
      }
      await git(
        task.workspacePath,
        amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message],
      );
      const hash = (await git(task.workspacePath, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
      this.emit({ type: 'git:changed', taskId });
      return { hash, summary: message.split('\n')[0] ?? message };
    });
  }

  /**
   * Publishes the current branch. A task branch created with --no-track has no
   * upstream yet, so the first push names both the remote and the branch
   * explicitly; a plain `git push` would follow push.default and, for a branch
   * still tracking its base, try to update that base instead.
   */
  async push(taskId: string, options: PushOptions = {}): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    return this.mutations.run(cwd, async () => {
      const branch = (await gitOrNull(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim();
      if (!branch) {
        throw new NestError(
          'detached_head',
          'Check out a branch before pushing: a detached HEAD has no branch to publish',
        );
      }

      const remotes = ((await gitOrNull(cwd, ['remote'])) ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (remotes.length === 0) {
        throw new NestError('no_remotes', 'This repository has no remotes to push to');
      }

      const upstream =
        (
          await gitOrNull(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
        )?.trim() || null;
      const remote = pushRemote(remotes, upstream);
      const target = `${remote}/${branch}`;

      if (upstream && upstream !== target && !options.publish) {
        throw new NestError(
          'upstream_mismatch',
          `Branch ${branch} tracks ${upstream}, so a plain push would update ${upstream}`,
          `Nest never rewrites an upstream you did not choose.\n\n` +
            `Publish ${branch} as ${target} instead: the branch is pushed explicitly ` +
            `("git push -u ${remote} ${branch}") and ${upstream} is left untouched.`,
        );
      }

      // Force is lease-guarded: it rewrites the remote branch only if nobody
      // else pushed to it since the last fetch.
      const forceArgs = options.force ? ['--force-with-lease'] : [];
      const explicit = !upstream || upstream !== target;
      const result = explicit
        ? await git(cwd, ['push', ...forceArgs, '-u', remote, branch])
        : await git(cwd, ['push', ...forceArgs]);

      this.emit({ type: 'git:changed', taskId });
      return { output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim() };
    });
  }

  /**
   * Commits reachable from `ref` or from a whole scope (newest first), one page
   * at a time. `scope: 'all'` walks every branch, remote-tracking ref and tag,
   * which is what the graph needs to draw the repository without a checkout.
   */
  async log(taskId: string, options: LogRequest = {}): Promise<GitLog> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
    const skip = Math.max(options.skip ?? 0, 0);

    // An unborn repository has no HEAD to walk; the panel shows an empty state.
    if (!(await hasHead(cwd))) return { commits: [], hasMore: false };

    // An explicit `ref` wins over `scope` and is walked on its own.
    const ref = options.ref ? assertRef(options.ref, 'ref') : null;
    if (ref) await assertRevision(cwd, ref);

    const roots = logRootArguments(ref, options.scope);

    const search = options.search?.trim() ?? '';
    if (!search) {
      const { stdout } = await git(
        cwd,
        [
          'log',
          '--no-color',
          ...roots,
          `--max-count=${limit + 1}`,
          `--skip=${skip}`,
          `--format=${LOG_FORMAT}`,
          '--',
        ],
        { timeout: LOG_TIMEOUT_MS },
      );
      const commits = parseLog(stdout);
      return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
    }

    // Git has no single argument that ORs message and author, so the search runs
    // on the parsed page: walk `skip + SEARCH_SCAN_LIMIT` commits from the start
    // of the walk (one more, to tell a capped scan from a short walk), drop the
    // non-matching ones, then apply `skip` and `limit` to what is left. Running
    // out of the scan window is what `hasMore` then means.
    const scanWindow = skip + SEARCH_SCAN_LIMIT;
    const { stdout } = await git(
      cwd,
      [
        'log',
        '--no-color',
        ...roots,
        `--max-count=${scanWindow + 1}`,
        `--format=${LOG_FORMAT}`,
        '--',
      ],
      { timeout: LOG_TIMEOUT_MS },
    );
    const walked = parseLog(stdout);
    const capped = walked.length > scanWindow;
    const matches = (capped ? walked.slice(0, scanWindow) : walked).filter((commit) =>
      matchesLogSearch(commit, search),
    );

    return {
      commits: matches.slice(skip, skip + limit),
      hasMore: capped || matches.length > skip + limit,
    };
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

  /**
   * Patch between two revisions (three-dot: from their merge base), used to
   * read a branch that is not checked out here without touching the worktree.
   */
  async compareDiff(taskId: string, request: CompareDiffRequest): Promise<GitCompareDiff> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const base = assertRef(request.base, 'base ref');
    const head = assertRef(request.head ?? 'HEAD', 'head ref');
    await assertRevision(cwd, base, 'base ref');
    await assertRevision(cwd, head, 'head ref');
    const filePath = request.path ? assertRevisionPath(request.path) : null;

    // Same rule as `compare()`: start from the common ancestor when the two
    // revisions share one, otherwise compare the trees directly. Only the
    // object database is read, so the index and the worktree stay untouched.
    const mergeBase = await gitOrNull(cwd, ['merge-base', base, head]);
    const from = mergeBase?.trim() || base;
    const { stdout } = await git(
      cwd,
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '-M',
        '--unified=3',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        from,
        head,
        '--',
        ...(filePath ? [filePath] : []),
      ],
      { timeout: LOG_TIMEOUT_MS },
    );

    return {
      base,
      head,
      mergeBase: mergeBase?.trim() || null,
      files: parseUnifiedDiff(stdout).sort((a, b) => a.path.localeCompare(b.path)),
    };
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
    return this.mutations.run(task.workspacePath, async () => {
      const remotes = await gitOrNull(task.workspacePath, ['remote']);
      if (!remotes || !remotes.trim()) {
        throw new NestError('no_remotes', 'This repository has no remotes to fetch from');
      }
      const result = await git(task.workspacePath, ['fetch', '--prune'], {
        timeout: REMOTE_TIMEOUT_MS,
      });
      this.emit({ type: 'git:changed', taskId });
      return { output: combineOutput(result) };
    });
  }

  /** Fast-forward only: Nest never creates merge commits behind the user's back. */
  async pull(taskId: string): Promise<{ output: string }> {
    const task = this.tasks.get(taskId);
    return this.mutations.run(task.workspacePath, async () => {
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
        result = await git(task.workspacePath, ['pull', '--ff-only'], {
          timeout: PULL_TIMEOUT_MS,
        });
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
    });
  }

  async checkout(
    taskId: string,
    branch: string,
    options: { create?: boolean; from?: string } = {},
  ): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    const name = assertRef(branch, 'branch');

    return this.mutations.run(cwd, async () => {
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
      return this.readAndSync(task);
    });
  }

  /**
   * Throws away pending changes for the given paths. The paths must currently be
   * reported as changed, so a stale click cannot wipe an unrelated file.
   *
   * `side` names the part that goes away: `unstaged` restores only the working
   * tree from the index, so a staged part of the same file survives; `staged`
   * and `both` drop the path back to HEAD. Untracked files have no index or HEAD
   * entry at all, so every side deletes them from disk — that works on a branch
   * without commits too, where a tracked file instead fails with `no_head`.
   */
  async discard(taskId: string, paths: string[], side: DiscardSide = 'both'): Promise<GitStatus> {
    const task = this.tasks.get(taskId);
    const cwd = task.workspacePath;
    return this.mutations.run(cwd, async () => {
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
        if (file.untracked) {
          untracked.push(filePath);
          continue;
        }
        // A rename is restored as a pair: the original name comes back from HEAD
        // while the new one leaves the index and the workspace. A copy only
        // removes the new file; its source was never changed.
        for (const target of expandChangedPaths([file], [filePath])) tracked.push(target);
      }

      if (tracked.length > 0) {
        if (side === 'unstaged') {
          // The index is the baseline: restoring from it needs no HEAD, keeps a
          // staged part of the file, and works on an unborn branch.
          await git(cwd, ['restore', '--worktree', '--', ...tracked]);
        } else {
          if (!(await hasHead(cwd))) {
            throw new NestError(
              'no_head',
              'Nothing is committed yet, so tracked changes cannot be restored',
            );
          }
          await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
        }
      }
      if (untracked.length > 0) {
        await git(cwd, ['clean', '-f', '--', ...untracked]);
      }

      this.emit({ type: 'git:changed', taskId });
      return readStatus(cwd);
    });
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

/**
 * The sides each mode compares, stated once so the panel and the tests agree
 * with what the git command actually asked for.
 */
function descriptorFor(mode: DiffMode, baseRef: string | null): DiffDescriptor {
  switch (mode) {
    case 'staged':
      return { mode, baseRef: null, workspaceIncludesIndex: false, anchorSide: 'index' };
    case 'base':
      // `git diff <base>` reads the working tree with the index applied.
      return { mode, baseRef, workspaceIncludesIndex: true, anchorSide: 'worktree' };
    case 'both':
      // Each file carries its own side, hence the per-file anchor.
      return { mode, baseRef: null, workspaceIncludesIndex: false, anchorSide: 'mixed' };
    case 'unstaged':
      return { mode, baseRef: null, workspaceIncludesIndex: false, anchorSide: 'worktree' };
  }
}

/** Files by path; the same path appears at most once per side. */
function sortDiffFiles(files: DiffFile[]): DiffFile[] {
  return files.sort((a, b) => a.path.localeCompare(b.path) || Number(a.staged) - Number(b.staged));
}

/** Untracked files are missing from `git diff`, so they are built from disk. */
async function appendUntracked(cwd: string, files: DiffFile[], filePath?: string): Promise<void> {
  const status = await readStatus(cwd);
  const untracked = status.files
    .filter((file) => file.untracked && (!filePath || file.path === filePath))
    .slice(0, MAX_UNTRACKED_FILES);

  for (const file of untracked) {
    const synthetic = await buildUntrackedFile(cwd, file.path);
    if (synthetic) files.push(synthetic);
  }
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

/** True when the index holds changes against HEAD, or the first commit. */
async function indexHasChanges(cwd: string): Promise<boolean> {
  const { stdout } = await git(cwd, ['diff', '--cached', '--name-only', '-z']);
  return stdout.replace(/\0/g, '').trim().length > 0;
}

/**
 * Un-staging has no single command that works everywhere. `git restore
 * --staged` needs a resolvable HEAD, and on an unborn branch older git also
 * refuses `git reset HEAD --`. There is no baseline to restore from in that
 * case: the entry only exists in the index, so `git rm --cached` drops it and
 * keeps the file in the worktree, where status reports it as untracked.
 * Renames arrive as both halves (see `expandChangedPaths`), so the batch drops
 * the staged addition and the staged deletion together.
 */
async function unstageTargets(cwd: string, targets: string[]): Promise<void> {
  const cachedOnly = ['rm', '--cached', '-r', '--quiet', '--', ...targets];
  const restore = ['restore', '--staged', '--', ...targets];
  const reset = ['reset', 'HEAD', '--', ...targets];
  // With a commit there is a baseline to restore from; without one the entry
  // only lives in the index, so removing it from the index is the whole job.
  const commands: string[][] = (await hasHead(cwd))
    ? [restore, reset, cachedOnly]
    : [cachedOnly, reset, restore];
  let last: NestError | null = null;
  for (const args of commands) {
    try {
      await git(cwd, args);
      return;
    } catch (error) {
      last =
        error instanceof NestError
          ? error
          : new NestError('git_failed', `git ${args.join(' ')} failed`);
    }
  }
  throw last ?? new NestError('git_failed', 'Unstaging failed');
}

async function assertRevision(cwd: string, revision: string, label = 'ref'): Promise<void> {
  if (!(await revisionExists(cwd, revision))) {
    throw new NestError('ref_missing', `Unknown ${label}: ${revision}`);
  }
}

/** Which history `git log` walks: never `--all`, which also picks up `refs/stash`. */
function logRootArguments(ref: string | null, scope: LogRequest['scope']): string[] {
  if (ref) return ['--topo-order', ref];
  if (scope === 'all') return ['--topo-order', '--branches', '--remotes', '--tags'];
  if (scope === 'branches') return ['--topo-order', '--branches', '--tags'];
  return ['HEAD'];
}

/**
 * A path inside a revision (`<rev>:<path>`): relative, no empty segment and no
 * `..`, so the expression can never name an object outside the tree.
 */
function assertRevisionPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const invalid =
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (invalid) throw new NestError('invalid_path', `Invalid file path: ${filePath}`);
  return normalized;
}

/**
 * `git log` filters by message or by author, never by either, so `search` is a
 * case-insensitive substring of the subject or body, of the author name or
 * email, or a prefix of the commit hash.
 */
function matchesLogSearch(commit: GitCommit, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    commit.hash.toLowerCase().startsWith(needle) ||
    commit.subject.toLowerCase().includes(needle) ||
    commit.body.toLowerCase().includes(needle) ||
    commit.authorName.toLowerCase().includes(needle) ||
    commit.authorEmail.toLowerCase().includes(needle)
  );
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

function assertPathsInside(workspacePath: string, paths: string[]): void {
  for (const filePath of paths) assertInsideWorkspace(workspacePath, filePath);
}

/**
 * Expands the requested paths with the source side of a rename. Callers only
 * know the new path from the panel, but git needs both halves to undo or
 * unstage the change. A copy keeps its source untouched, so only its new path
 * is returned.
 */
function expandChangedPaths(files: readonly GitFile[], paths: readonly string[]): string[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const targets: string[] = [];
  for (const filePath of paths) {
    targets.push(filePath);
    const file = byPath.get(filePath);
    if (file?.oldPath && !file.copied && !targets.includes(file.oldPath)) {
      targets.push(file.oldPath);
    }
  }
  return targets;
}

/** Remote that carries the branch: the upstream's when it has one, else origin. */
function pushRemote(remotes: readonly string[], upstream: string | null): string {
  const fromUpstream = upstream?.split('/')[0];
  if (fromUpstream && remotes.includes(fromUpstream)) return fromUpstream;
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? 'origin');
}

async function readStatus(cwd: string): Promise<GitStatus> {
  const [{ stdout }, stats] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']),
    readNumstat(cwd),
  ]);

  const parsed = parseStatus(stdout);
  const totals = sumNumstat(stats);
  const files: GitFile[] = parsed.files.map((file) => {
    const total = totals.get(file.path);
    const staged = stats.staged.get(file.path);
    const unstaged = stats.unstaged.get(file.path);
    return {
      ...file,
      additions: total?.additions ?? null,
      deletions: total?.deletions ?? null,
      // Each side carries the counters of its own diff; a side without a
      // numstat record has nothing to report, so the row stays empty there.
      stagedAdditions: staged?.additions ?? null,
      stagedDeletions: staged?.deletions ?? null,
      unstagedAdditions: unstaged?.additions ?? null,
      unstagedDeletions: unstaged?.deletions ?? null,
    };
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  await countUntracked(files, cwd);
  return { ...parsed, files };
}

/**
 * Both diffs a status row is made of: `HEAD → index` (`--cached`) and
 * `index → worktree`. They are read separately, so a partially staged file
 * keeps its own counters per side instead of one sum shown twice.
 *
 * A repository without commits has no HEAD, but git compares the index against
 * the empty tree there, so the same two commands still describe an unborn
 * branch and no fallback is needed.
 */
async function readNumstat(cwd: string): Promise<NumstatSides> {
  const options = { timeout: NUMSTAT_TIMEOUT_MS };
  const [staged, unstaged] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M', '--no-color', '--cached'], options),
    git(cwd, ['diff', '--numstat', '-z', '-M', '--no-color'], options),
  ]);
  return { staged: parseNumstat(staged.stdout), unstaged: parseNumstat(unstaged.stdout) };
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
      // An untracked file has no index side; its whole content is the worktree,
      // so the counters land on the unstaged side only.
      file.additions = counted.additions;
      file.deletions = counted.deletions;
      file.unstagedAdditions = counted.additions;
      file.unstagedDeletions = counted.deletions;
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
