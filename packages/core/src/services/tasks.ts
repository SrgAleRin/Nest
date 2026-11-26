import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  MAIN_CHECKOUT_SLUG,
  newId,
  nowIso,
  slugify,
  type NestEvent,
  type Task,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git, gitOrNull } from '../git/exec.js';
import { ProjectService, normalizePath } from './projects.js';
import { prepareWorkspace } from './setup.js';
import { toTask, type TaskRow } from './rows.js';

export interface CreateTaskInput {
  projectId: string;
  title: string;
  baseBranch?: string;
  /** Replaces the project setup script when provided (undefined keeps it). */
  setupScript?: string | null;
}

const FETCH_TIMEOUT_MS = 60_000;

export class TaskService {
  private beforeRemove: (task: Task) => void | Promise<void> = () => {};
  /**
   * One tail per project: two concurrent creations would otherwise race for the
   * same slug, workspace path and branch. The stored promise never rejects, so
   * a failed creation does not block the next one.
   */
  private readonly creating = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectService,
    private readonly worktreesRoot: string,
    private readonly emit: (event: NestEvent) => void = () => {},
  ) {}

  onBeforeRemove(handler: (task: Task) => void | Promise<void>): void {
    this.beforeRemove = handler;
  }

  list(projectId?: string): Task[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT * FROM tasks WHERE project_id = ? ORDER BY
               CASE kind WHEN 'checkout' THEN 0 ELSE 1 END, created_at`,
          )
          .all(projectId) as unknown as TaskRow[])
      : (this.db
          .prepare(
            `SELECT * FROM tasks ORDER BY
               CASE kind WHEN 'checkout' THEN 0 ELSE 1 END, created_at`,
          )
          .all() as unknown as TaskRow[]);
    return rows.map(toTask);
  }

  get(taskId: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new NestError('task_not_found', `Task ${taskId} was not found`);
    return toTask(row);
  }

  /**
   * Git is the source of truth for the branch a workspace is on; the row only
   * mirrors it for the places that read task metadata (sidebar, palette,
   * notifications, restart). `base_ref` keeps the original branch, so a switch
   * never rewrites it. Detached HEAD has no branch name to record.
   */
  syncBranch(taskId: string, branch: string): Task | null {
    if (!branch || branch === 'HEAD') return null;
    const task = this.get(taskId);
    if (task.branch === branch) return null;
    this.db
      .prepare('UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?')
      .run(branch, nowIso(), taskId);
    const updated = this.get(taskId);
    this.emit({ type: 'task:updated', task: updated });
    return updated;
  }

  /** The singleton main checkout of a project; projects.add creates it. */
  ensureCheckout(projectId: string): Task {
    const checkout = this.projects.checkout(projectId);
    if (!checkout) throw new NestError('checkout_missing', 'Project has no main checkout');
    return checkout;
  }

  /** Creates a task, serialized per project. */
  async create(input: CreateTaskInput): Promise<Task> {
    const previous = this.creating.get(input.projectId) ?? Promise.resolve();
    const run = previous.then(
      () => this.createTask(input),
      () => this.createTask(input),
    );
    const tail = run.catch(() => {});
    this.creating.set(input.projectId, tail);
    try {
      return await run;
    } finally {
      if (this.creating.get(input.projectId) === tail) this.creating.delete(input.projectId);
    }
  }

  private async createTask(input: CreateTaskInput): Promise<Task> {
    let project = this.projects.get(input.projectId);
    if (input.setupScript !== undefined) {
      project = this.projects.update(project.id, { setupScript: input.setupScript });
    }
    const checkout = this.projects.checkout(project.id);
    if (!checkout) throw new NestError('checkout_missing', 'Project has no main checkout');

    await mkdir(this.worktreesRoot, { recursive: true });

    // Refresh remote refs so a task created from origin/main does not start on
    // a stale base. Best effort: offline or remote-less repos still work.
    this.emit({ type: 'task:progress', projectId: project.id, step: 'fetch' });
    await this.fetch(project.path);

    const base = await this.resolveBaseBranch(project.path, input.baseBranch);
    const existing = new Set(
      (this.db
        .prepare('SELECT slug FROM tasks WHERE project_id = ?')
        .all(project.id) as Array<{ slug: string }>).map((row) => row.slug),
    );

    const baseSlug = slugify(input.title);
    let slug = baseSlug === 'main' ? 'main-task' : baseSlug;
    let counter = 2;
    while (existing.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    let branch = `nest/${slug}`;
    let branchCounter = 2;
    while (await branchExists(project.path, branch)) {
      branch = `nest/${slug}-${branchCounter}`;
      branchCounter += 1;
    }

    const worktreePath = path.join(this.worktreesRoot, projectDirName(project), slug);
    const worktreeExisted = existsSync(worktreePath);
    const branchExisted = await branchExists(project.path, branch);

    this.emit({ type: 'task:progress', projectId: project.id, step: 'worktree' });
    try {
      // --no-track keeps base and upstream apart: nest/<slug> starts at
      // origin/main without inheriting it as its own upstream, so push.default
      // cannot turn the first push into an update of main.
      await git(project.path, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
    } catch (error) {
      // git may have created the branch or a half-made directory first.
      await this.rollbackCreate(project.path, worktreePath, branch, {
        worktree: !worktreeExisted && existsSync(worktreePath),
        branch: !branchExisted,
      });
      throw error;
    }

    const id = newId();
    const timestamp = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, slug, title, branch, base_ref, workspace_path, status, created_at, updated_at)
           VALUES (?, ?, 'worktree', ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          project.id,
          slug,
          input.title.trim(),
          branch,
          base,
          worktreePath,
          timestamp,
          timestamp,
        );
    } catch (error) {
      // Only this call's artifacts: the worktree created just above and, if
      // nobody else uses it, the branch. Other tasks are never touched.
      await this.rollbackCreate(project.path, worktreePath, branch, {
        worktree: true,
        branch: !branchExisted,
      });
      throw error;
    }

    // Setup runs after the row exists, so a failing script leaves a visible
    // task with its worktree and an explanation instead of an orphan folder.
    this.emit({ type: 'task:progress', projectId: project.id, step: 'setup' });
    const setupError = await prepareWorkspace({
      projectPath: project.path,
      workspacePath: worktreePath,
      setupScript: project.setupScript,
    });
    if (setupError) {
      this.db
        .prepare('UPDATE tasks SET setup_error = ?, updated_at = ? WHERE id = ?')
        .run(setupError, nowIso(), id);
    }

    return this.get(id);
  }

  async remove(taskId: string, options: { force?: boolean } = {}): Promise<void> {
    const task = this.get(taskId);
    if (task.kind === 'checkout' || task.slug === MAIN_CHECKOUT_SLUG) {
      throw new NestError('checkout_immutable', 'The main checkout cannot be removed');
    }

    if (!options.force) {
      const changes = await this.worktreeChanges(task.workspacePath);
      if (changes.length > 0) {
        const preview = changes.slice(0, 20).join('\n');
        const more =
          changes.length > 20 ? `\n…and ${changes.length - 20} more changed files` : '';
        throw new NestError(
          'workspace_dirty',
          `Worktree has ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}`,
          `${preview}${more}\n\nRemove the task only if these changes are not needed.`,
        );
      }
    }

    // Sessions stop first: a live PTY under a deleted row cannot be managed
    // from the UI any more, so an unconfirmed stop keeps the task as it is.
    await this.beforeRemove(task);
    const project = this.projects.get(task.projectId);

    if (!existsSync(task.workspacePath)) {
      await this.removeMissingWorktree(project.path, task.workspacePath);
      this.deleteRow(taskId);
      return;
    }

    const args = options.force
      ? ['worktree', 'remove', '--force', task.workspacePath]
      : ['worktree', 'remove', task.workspacePath];
    try {
      await git(project.path, args);
    } catch (error) {
      throw new NestError(
        'worktree_remove_failed',
        `Could not remove worktree ${task.workspacePath}`,
        `${gitDetails(error)}\n\nClose anything holding files in the worktree, ` +
          'unlock it with "git worktree unlock <path>", or retry with force to discard ' +
          'local changes. The task and its worktree were kept.',
      );
    }

    // A zero exit code alone is not proof that the workspace is gone. Anything
    // still on disk or still registered by Git keeps the task row.
    const stillOnDisk = existsSync(task.workspacePath);
    const stillRegistered = await this.isRegistered(project.path, task.workspacePath);
    if (stillOnDisk || stillRegistered) {
      const state = [
        stillOnDisk ? 'The directory still exists.' : '',
        stillRegistered ? 'Git still lists it as a worktree.' : '',
      ]
        .filter(Boolean)
        .join(' ');
      throw new NestError(
        'worktree_remove_failed',
        `git worktree remove reported success but ${task.workspacePath} is still present`,
        `${state}\n\nClose programs using the folder, run "git worktree prune" in the ` +
          'repository, then retry. The task was kept.',
      );
    }

    this.deleteRow(taskId);
  }

  /**
   * The workspace path is gone. Only Git's own registration decides whether the
   * row can be cleaned up; the repo-local prune is a repair step, never a
   * substitute for the check that follows it.
   */
  private async removeMissingWorktree(repoPath: string, workspacePath: string): Promise<void> {
    if (!(await this.isRegistered(repoPath, workspacePath))) return;

    await gitOrNull(repoPath, ['worktree', 'prune']);
    if (await this.isRegistered(repoPath, workspacePath)) {
      throw new NestError(
        'worktree_remove_failed',
        `Worktree ${workspacePath} is missing on disk but still registered in ${repoPath}`,
        'Run "git worktree prune" in the repository and retry. The task was kept so ' +
          'its sessions and comments are not lost.',
      );
    }
  }

  /**
   * Undoes the artifacts of a creation that failed before its row existed. A
   * branch is deleted only when this call created it and no worktree uses it,
   * so another task's worktree or branch is never removed.
   */
  private async rollbackCreate(
    repoPath: string,
    worktreePath: string,
    branch: string,
    created: { worktree: boolean; branch: boolean },
  ): Promise<void> {
    if (created.worktree) {
      await gitOrNull(repoPath, ['worktree', 'remove', '--force', worktreePath]);
      await gitOrNull(repoPath, ['worktree', 'prune']);
    }
    if (created.branch && !(await this.branchInUse(repoPath, branch))) {
      await gitOrNull(repoPath, ['branch', '-D', branch]);
    }
  }

  /** True when any worktree of the repo has this branch checked out. */
  private async branchInUse(repoPath: string, branch: string): Promise<boolean> {
    const listing = await gitOrNull(repoPath, [
      '-c',
      'core.quotepath=false',
      'worktree',
      'list',
      '--porcelain',
    ]);
    // An unreadable list makes the answer unknown; never delete on a guess.
    if (listing === null) return true;
    return listing.split('\n').some((line) => line.trim() === `branch refs/heads/${branch}`);
  }

  private deleteRow(taskId: string): void {
    // Sessions and comments are removed by the schema cascade.
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  /** Whether Git still registers this exact path as a worktree of the repo. */
  private async isRegistered(repoPath: string, workspacePath: string): Promise<boolean> {
    // core.quotepath=false keeps Cyrillic and spaced paths readable; a failed
    // call throws instead of pretending the worktree is unregistered.
    const { stdout } = await git(repoPath, [
      '-c',
      'core.quotepath=false',
      'worktree',
      'list',
      '--porcelain',
    ]);
    const wanted = normalizePath(workspacePath);
    return stdout.split('\n').some((line) => {
      if (!line.startsWith('worktree ')) return false;
      const listed = line.slice('worktree '.length).trim();
      const unquoted =
        listed.startsWith('"') && listed.endsWith('"') && !listed.includes('\\')
          ? listed.slice(1, -1)
          : listed;
      return normalizePath(unquoted) === wanted;
    });
  }

  /** Tracked, staged and untracked changes; only a missing path counts as clean. */
  private async worktreeChanges(workspacePath: string): Promise<string[]> {
    if (!existsSync(workspacePath)) return [];
    let output: string;
    try {
      output = (await git(workspacePath, ['status', '--porcelain'])).stdout;
    } catch (error) {
      throw new NestError(
        'worktree_status_failed',
        `Could not read the status of ${workspacePath}`,
        `${gitDetails(error)}\n\nThe task was kept. Retry once the repository is reachable.`,
      );
    }
    return output
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3).trim() || line.trim())
      .filter(Boolean);
  }

  private async fetch(repoPath: string): Promise<void> {
    const remotes = await gitOrNull(repoPath, ['remote']);
    if (!remotes) return;
    await gitOrNull(repoPath, ['fetch', '--prune'], { timeout: FETCH_TIMEOUT_MS });
  }

  private async resolveBaseBranch(repoPath: string, requested?: string): Promise<string> {
    if (requested) {
      // Accept both a local branch (main) and a remote-tracking one (origin/main):
      // without a remote, or when the base only exists upstream, the latter is
      // the only usable ref.
      if (await refExists(repoPath, `refs/heads/${requested}`)) return requested;
      if (await refExists(repoPath, `refs/remotes/${requested}`)) return requested;
      throw new NestError(
        'base_branch_missing',
        `Branch ${requested} does not exist locally or on a remote`,
      );
    }
    const current = await gitOrNull(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    if (!current) {
      throw new NestError('detached_head', 'Repository is in detached HEAD state');
    }
    return current;
  }
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  const value = await gitOrNull(repoPath, ['rev-parse', '--verify', ref]);
  return Boolean(value);
}

function gitDetails(error: unknown): string {
  if (error instanceof NestError) return error.details ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return refExists(repoPath, `refs/heads/${branch}`);
}

function sanitizeDir(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.+$/g, '') || 'project';
}

/**
 * Directory for a project's worktrees. The basename alone is not an identity:
 * two checkouts named `repo` would share it, and so would two of their tasks.
 * A short project-id suffix keeps new paths apart; paths already stored on
 * existing tasks are left as they are.
 */
function projectDirName(project: { id: string; name: string }): string {
  return `${sanitizeDir(project.name)}-${project.id.replace(/-/g, '').slice(0, 8)}`;
}
