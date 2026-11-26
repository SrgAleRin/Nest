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

  /** The singleton main checkout of a project; projects.add creates it. */
  ensureCheckout(projectId: string): Task {
    const checkout = this.projects.checkout(projectId);
    if (!checkout) throw new NestError('checkout_missing', 'Project has no main checkout');
    return checkout;
  }

  async create(input: CreateTaskInput): Promise<Task> {
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

    const projectDir = sanitizeDir(project.name);
    const worktreePath = path.join(this.worktreesRoot, projectDir, slug);

    this.emit({ type: 'task:progress', projectId: project.id, step: 'worktree' });
    await git(project.path, ['worktree', 'add', '-b', branch, worktreePath, base]);

    const id = newId();
    const timestamp = nowIso();
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
           VALUES (?, ?, 'worktree', ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          id,
          project.id,
          slug,
          input.title.trim(),
          branch,
          worktreePath,
          timestamp,
          timestamp,
        );
    } catch (error) {
      await git(project.path, ['worktree', 'remove', '--force', worktreePath]).catch(() => {});
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
