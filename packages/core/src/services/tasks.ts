import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import {
  MAIN_CHECKOUT_SLUG,
  newId,
  nowIso,
  slugify,
  type NestEvent,
  type Project,
  type Task,
  type TaskWorkflowStatus,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { baseRefExists, currentBranch } from '../git/base.js';
import { git, gitOrNull } from '../git/exec.js';
import { ProjectService, normalizePath } from './projects.js';
import { prepareWorkspace } from './setup.js';
import { resolveWorktreesRoot } from './settings.js';
import { toTask, type TaskRow } from './rows.js';

export interface CreateTaskInput {
  projectId: string;
  title: string;
  /** Overrides the project default base ref. */
  baseRef?: string;
  /** Replaces the project setup script when provided (undefined keeps it). */
  setupScript?: string | null;
  /**
   * Renderer-generated handle for progress events and `tasks.abort`. Optional
   * for internal callers; every creation still runs as one operation.
   */
  operationId?: string;
}

export interface PreviewTaskInput {
  projectId: string;
  title?: string;
  baseRef?: string;
}

export interface TaskPreview {
  /** Null while the title is still empty: no slug, no branch, no path yet. */
  branch: string | null;
  slug: string | null;
  workspacePath: string | null;
  baseRef: string | null;
  baseSource: 'explicit' | 'project' | 'current';
  baseAvailable: boolean;
}

/**
 * One `tasks.create` call. The renderer generates the id, listens for
 * `task:progress` events tagged with it, and can abort it through
 * `tasks.abort` even after the dialog was closed.
 */
interface Operation {
  projectId: string;
  state: 'running' | 'settled';
  aborted: boolean;
  taskId: string | null;
  startedAt: number;
}

/** How long a finished operation stays abortable (its task removable again). */
const OPERATION_TTL_MS = 5 * 60_000;
const MAX_SETTLED_OPERATIONS = 20;

const FETCH_TIMEOUT_MS = 60_000;

/** The settings that shape where and how a new worktree is created. */
export interface TaskWorkspaceSettings {
  /** Saved worktree root; empty keeps the default root of this instance. */
  worktreeRoot: string;
  copyEnvFiles: boolean;
}

const DEFAULT_WORKSPACE_SETTINGS: TaskWorkspaceSettings = {
  worktreeRoot: '',
  copyEnvFiles: false,
};

export class TaskService {
  private beforeRemove: (task: Task) => void | Promise<void> = () => {};
  private beforeArchive: (task: Task) => void | Promise<void> = () => {};
  /**
   * One tail per project: two concurrent creations would otherwise race for the
   * same slug, workspace path and branch. The stored promise never rejects, so
   * a failed creation does not block the next one.
   */
  private readonly creating = new Map<string, Promise<unknown>>();
  /** Live and recently finished creations, keyed by the renderer's operation id. */
  private readonly operations = new Map<string, Operation>();

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectService,
    /** Root used while no worktree root is saved in settings. */
    private readonly defaultWorktreesRoot: string,
    private readonly emit: (event: NestEvent) => void = () => {},
    /** Read per creation, so a saved root applies to the next task. */
    private readonly workspaceSettings: () => TaskWorkspaceSettings = () =>
      DEFAULT_WORKSPACE_SETTINGS,
  ) {}

  onBeforeRemove(handler: (task: Task) => void | Promise<void>): void {
    this.beforeRemove = handler;
  }

  /**
   * Runs before an archive writes its row. Composition uses it to stop and
   * verify the task's PTYs, the same way removal does.
   */
  onBeforeArchive(handler: (task: Task) => void | Promise<void>): void {
    this.beforeArchive = handler;
  }

  /**
   * `includeArchived` defaults to true so existing callers keep seeing every
   * task; the sidebar asks for the active ones with `{ includeArchived: false }`.
   */
  list(projectId?: string, options: { includeArchived?: boolean } = {}): Task[] {
    const activeOnly = options.includeArchived === false;
    const filters = [
      projectId ? 'project_id = ?' : '',
      activeOnly ? "status = 'active'" : '',
    ].filter(Boolean);
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `SELECT * FROM tasks ${where} ORDER BY
      CASE kind WHEN 'checkout' THEN 0 ELSE 1 END, sort_order ASC, created_at ASC`;
    const statement = this.db.prepare(sql);
    const rows = (projectId ? statement.all(projectId) : statement.all()) as unknown as TaskRow[];
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

  /**
   * What `tasks.create` would produce right now, so the dialog can show the
   * branch, the worktree path and the effective base before anything exists.
   * Read-only: nothing is fetched, created or stored (except a lazily resolved
   * project default, which is the same value `create` would use).
   */
  async preview(input: PreviewTaskInput): Promise<TaskPreview> {
    const project = this.projects.get(input.projectId);
    const base = await this.effectiveBase(project, input.baseRef);
    const baseAvailable = base.ref ? await baseRefExists(project.path, base.ref) : false;
    const title = input.title?.trim() ?? '';
    if (!title) {
      return {
        branch: null,
        slug: null,
        workspacePath: null,
        baseRef: base.ref,
        baseSource: base.source,
        baseAvailable,
      };
    }
    const plan = await this.planNames(project, title, this.worktreesRoot());
    return {
      branch: plan.branch,
      slug: plan.slug,
      workspacePath: plan.worktreePath,
      baseRef: base.ref,
      baseSource: base.source,
      baseAvailable,
    };
  }

  /** Creates a task, serialized per project. */
  async create(input: CreateTaskInput): Promise<Task> {
    const operationId = input.operationId ?? newId();
    const operation: Operation = {
      projectId: input.projectId,
      state: 'running',
      aborted: false,
      taskId: null,
      startedAt: Date.now(),
    };
    this.pruneOperations();
    this.operations.set(operationId, operation);

    const previous = this.creating.get(input.projectId) ?? Promise.resolve();
    const run = previous.then(
      () => this.createTask(input, operation, operationId),
      () => this.createTask(input, operation, operationId),
    );
    const tail = run.catch(() => {});
    this.creating.set(input.projectId, tail);
    try {
      const task = await run;
      operation.state = 'settled';
      operation.taskId = task.id;
      this.emit({
        type: 'task:operation',
        operationId,
        projectId: input.projectId,
        state: 'done',
        taskId: task.id,
      });
      return task;
    } catch (error) {
      operation.state = 'settled';
      const aborted = isAbort(error);
      this.emit({
        type: 'task:operation',
        operationId,
        projectId: input.projectId,
        state: aborted ? 'aborted' : 'failed',
        ...(operation.taskId ? { taskId: operation.taskId } : {}),
        ...(aborted ? {} : { message: errorText(error) }),
      });
      throw error;
    } finally {
      if (this.creating.get(input.projectId) === tail) this.creating.delete(input.projectId);
    }
  }

  /**
   * Cancels a creation. A running operation is flagged and unwinds at its next
   * checkpoint, removing only the worktree, branch and row it created itself.
   * A just-finished operation can be cancelled too, as long as nobody started a
   * session in its task yet: then the same artefacts are removed here.
   */
  async abort(operationId: string): Promise<{ aborted: boolean }> {
    const operation = this.operations.get(operationId);
    if (!operation) return { aborted: false };

    if (operation.state === 'running') {
      operation.aborted = true;
      return { aborted: true };
    }

    if (!operation.taskId || this.hasSessions(operation.taskId)) return { aborted: false };
    const taskId = operation.taskId;
    const task = this.get(taskId);
    if (task.kind === 'checkout') return { aborted: false };
    const project = this.projects.get(task.projectId);
    // The same rollback an interrupted creation uses: worktree, then the row,
    // then the branch if no worktree uses it any more.
    await this.rollbackCreate(project.path, task.workspacePath, task.branch, {
      worktree: existsSync(task.workspacePath),
      branch: true,
    });
    this.operations.delete(operationId);
    this.deleteRow(taskId);
    this.emit({
      type: 'task:operation',
      operationId,
      projectId: operation.projectId,
      state: 'aborted',
      taskId,
    });
    return { aborted: true };
  }

  private async createTask(
    input: CreateTaskInput,
    operation: Operation,
    operationId: string,
  ): Promise<Task> {
    let project = this.projects.get(input.projectId);
    if (input.setupScript !== undefined) {
      project = this.projects.update(project.id, { setupScript: input.setupScript });
    }
    const checkout = this.projects.checkout(project.id);
    if (!checkout) throw new NestError('checkout_missing', 'Project has no main checkout');

    const workspaceSettings = this.workspaceSettings();
    const worktreesRoot = resolveWorktreesRoot(
      this.defaultWorktreesRoot,
      workspaceSettings.worktreeRoot,
    );
    // An unusable root is reported here instead of falling back to another
    // directory the user did not choose.
    await ensureWorktreesRoot(worktreesRoot);

    // Refresh remote refs so a task created from origin/main does not start on
    // a stale base. Best effort: offline or remote-less repos still work.
    this.emit({ type: 'task:progress', operationId, projectId: project.id, step: 'fetch' });
    await this.fetch(project.path);
    this.throwIfAborted(operation);

    const base = await this.resolveBase(project, input.baseRef);
    const plan = await this.planNames(project, input.title, worktreesRoot);
    const { slug, branch, worktreePath } = plan;
    const worktreeExisted = existsSync(worktreePath);
    const branchExisted = await branchExists(project.path, branch);

    this.emit({ type: 'task:progress', operationId, projectId: project.id, step: 'worktree' });
    try {
      this.throwIfAborted(operation);
      // --no-track keeps base and upstream apart: nest/<slug> starts at
      // origin/main without inheriting it as its own upstream, so push.default
      // cannot turn the first push into an update of main.
      await git(project.path, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, base]);
      this.throwIfAborted(operation);
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
      operation.taskId = id;
      // Cancelled between the worktree and the row: the row is this operation's
      // own, so it goes away together with the worktree and the branch.
      this.throwIfAborted(operation);
    } catch (error) {
      // Only this call's artifacts: the worktree created just above and, if
      // nobody else uses it, the branch. Other tasks are never touched.
      if (operation.taskId === id) {
        this.deleteRow(id);
        operation.taskId = null;
      }
      await this.rollbackCreate(project.path, worktreePath, branch, {
        worktree: true,
        branch: !branchExisted,
      });
      throw error;
    }

    // Setup runs after the row exists, so a failing script leaves a visible
    // task with its worktree and an explanation instead of an orphan folder.
    this.emit({ type: 'task:progress', operationId, projectId: project.id, step: 'setup' });
    const setupError = await prepareWorkspace({
      projectPath: project.path,
      workspacePath: worktreePath,
      setupScript: project.setupScript,
      copyEnvFiles: workspaceSettings.copyEnvFiles,
    });
    if (setupError) {
      this.db
        .prepare('UPDATE tasks SET setup_error = ?, updated_at = ? WHERE id = ?')
        .run(setupError, nowIso(), id);
    }

    // A cancel that arrived while setup ran still removes everything.
    if (operation.aborted) {
      this.deleteRow(id);
      operation.taskId = null;
      await this.rollbackCreate(project.path, worktreePath, branch, {
        worktree: true,
        branch: !branchExisted,
      });
      throw new NestError('task_aborted', 'Task creation was cancelled');
    }

    return this.get(id);
  }

  private throwIfAborted(operation: Operation): void {
    if (operation.aborted) {
      throw new NestError('task_aborted', 'Task creation was cancelled');
    }
  }

  /** Slug and branch stay unique inside the project, exactly as `create` needs them. */
  /** Also used by `preview`, which must not create the directory. */
  private worktreesRoot(): string {
    return resolveWorktreesRoot(this.defaultWorktreesRoot, this.workspaceSettings().worktreeRoot);
  }

  private async planNames(
    project: Project,
    title: string,
    worktreesRoot: string,
  ): Promise<{ slug: string; branch: string; worktreePath: string }> {
    const existing = new Set(
      (
        this.db.prepare('SELECT slug FROM tasks WHERE project_id = ?').all(project.id) as Array<{
          slug: string;
        }>
      ).map((row) => row.slug),
    );

    const baseSlug = slugify(title);
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

    return {
      slug,
      branch,
      worktreePath: path.join(worktreesRoot, projectDirName(project), slug),
    };
  }

  /**
   * Explicit base, else the stored project default, else the current branch for
   * projects registered before the default was stored.
   */
  private async effectiveBase(
    project: Project,
    requested?: string,
  ): Promise<{ ref: string | null; source: 'explicit' | 'project' | 'current' }> {
    const explicit = requested?.trim();
    if (explicit) return { ref: explicit, source: 'explicit' };
    const stored = await this.projects.ensureDefaultBase(project.id);
    if (stored) return { ref: stored, source: 'project' };
    return { ref: await currentBranch(project.path), source: 'current' };
  }

  /** The base ref must exist locally or as a remote-tracking branch. */
  private async resolveBase(project: Project, requested?: string): Promise<string> {
    const base = await this.effectiveBase(project, requested);
    if (!base.ref) {
      throw new NestError('detached_head', 'Repository is in detached HEAD state');
    }
    if (!(await baseRefExists(project.path, base.ref))) {
      throw new NestError(
        'base_branch_missing',
        `Branch ${base.ref} does not exist locally or on a remote`,
      );
    }
    return base.ref;
  }

  private hasSessions(taskId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM sessions WHERE task_id = ?').get(taskId) as
      { found: number } | undefined;
    return Boolean(row);
  }

  /** Keeps the operation map small: finished operations expire after a while. */
  private pruneOperations(): void {
    const cutoff = Date.now() - OPERATION_TTL_MS;
    const settled: Array<[string, Operation]> = [];
    for (const [key, operation] of this.operations) {
      if (operation.state === 'running') continue;
      if (operation.startedAt < cutoff) this.operations.delete(key);
      else settled.push([key, operation]);
    }
    settled
      .sort((a, b) => a[1].startedAt - b[1].startedAt)
      .slice(0, Math.max(0, settled.length - MAX_SETTLED_OPERATIONS))
      .forEach(([key]) => this.operations.delete(key));
  }

  async remove(
    taskId: string,
    options: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<void> {
    const task = this.get(taskId);
    if (task.kind === 'checkout' || task.slug === MAIN_CHECKOUT_SLUG) {
      throw new NestError('checkout_immutable', 'The main checkout cannot be removed');
    }

    if (!options.force) {
      const changes = await this.worktreeChanges(task.workspacePath);
      if (changes.length > 0) {
        const preview = changes.slice(0, 20).join('\n');
        const more = changes.length > 20 ? `\n…and ${changes.length - 20} more changed files` : '';
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
      await this.deleteTaskBranch(project, task, options.deleteBranch);
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
    await this.deleteTaskBranch(project, task, options.deleteBranch);
  }

  /**
   * Drops the branch of a removed task, but only when it is this task's own:
   * never the main checkout branch, never the project base ref, and never a
   * branch another worktree still has checked out. An unreadable state keeps
   * the branch.
   */
  private async deleteTaskBranch(
    project: Project,
    task: Task,
    deleteBranch?: boolean,
  ): Promise<void> {
    if (!deleteBranch) return;
    if (!task.branch || task.branch === 'HEAD') return;
    const checkout = this.projects.checkout(project.id);
    if (task.branch === checkout?.branch) return;
    if (task.branch === project.defaultBaseRef) return;
    if (!(await branchExists(project.path, task.branch))) return;
    if (await this.branchInUse(project.path, task.branch)) return;
    await gitOrNull(project.path, ['branch', '-D', task.branch]);
  }

  update(
    taskId: string,
    patch: {
      title?: string;
      workflowStatus?: TaskWorkflowStatus;
      pinned?: boolean;
      notes?: string | null;
      unread?: boolean;
      sortOrder?: number;
    },
  ): Task {
    const task = this.get(taskId);
    const values: Array<string | number | null> = [];
    const assignments: string[] = [];

    if (patch.title !== undefined) {
      if (task.kind === 'checkout' || task.slug === MAIN_CHECKOUT_SLUG) {
        throw new NestError('checkout_immutable', 'Main checkout cannot be renamed');
      }
      const title = patch.title.trim();
      if (!title) throw new NestError('invalid_task_title', 'Task title cannot be empty');
      // The slug, the branch and the workspace path stay as they are: they are
      // the task's identity on disk, not part of its label.
      assignments.push('title = ?');
      values.push(title);
    }
    if (patch.workflowStatus !== undefined) {
      assignments.push('workflow_status = ?');
      values.push(patch.workflowStatus);
    }
    if (patch.pinned !== undefined) {
      assignments.push('pinned = ?');
      values.push(patch.pinned ? 1 : 0);
    }
    if (patch.notes !== undefined) {
      const notes = patch.notes === null || patch.notes.trim() === '' ? null : patch.notes;
      assignments.push('notes = ?');
      values.push(notes);
    }
    if (patch.unread !== undefined) {
      assignments.push('unread = ?');
      values.push(patch.unread ? 1 : 0);
    }
    if (patch.sortOrder !== undefined) {
      assignments.push('sort_order = ?');
      values.push(patch.sortOrder);
    }

    if (assignments.length > 0) {
      this.db
        .prepare(`UPDATE tasks SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, nowIso(), taskId);
    }

    const updated = this.get(taskId);
    this.emit({ type: 'task:updated', task: updated });
    return updated;
  }

  /** Hides a task from the active list; its worktree, branch and sessions stay. */
  async archive(taskId: string): Promise<Task> {
    const task = this.get(taskId);
    if (task.kind === 'checkout' || task.slug === MAIN_CHECKOUT_SLUG) {
      throw new NestError('cannot_archive_checkout', 'Main checkout cannot be archived');
    }
    if (task.status === 'archived') return task;

    // A live PTY under an archived task would keep writing to a row the UI no
    // longer lists, so it is stopped first, exactly like removal.
    await this.beforeArchive(task);
    const timestamp = nowIso();
    this.db
      .prepare(
        "UPDATE tasks SET status = 'archived', archived_at = ?, pinned = 0, updated_at = ? WHERE id = ?",
      )
      .run(timestamp, timestamp, taskId);
    const updated = this.get(taskId);
    this.emit({ type: 'task:updated', task: updated });
    return updated;
  }

  restore(taskId: string): Task {
    const task = this.get(taskId);
    if (task.status === 'active') return task;
    this.db
      .prepare("UPDATE tasks SET status = 'active', archived_at = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), taskId);
    const updated = this.get(taskId);
    this.emit({ type: 'task:updated', task: updated });
    return updated;
  }

  /** Stores the sidebar order exactly as given: index becomes `sort_order`. */
  reorder(taskIds: string[]): void {
    const update = this.db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      taskIds.forEach((taskId, index) => update.run(index, taskId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
}

function isAbort(error: unknown): boolean {
  return error instanceof NestError && error.code === 'task_aborted';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Creates the worktree root and proves it is a usable directory. A path that
 * cannot be created (a file in the way, a missing drive, no permission) is a
 * structured error for the creation, never a silent switch to another folder.
 */
async function ensureWorktreesRoot(root: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error('the path is not a directory');
  } catch (error) {
    throw new NestError(
      'worktree_root_unusable',
      `The worktree root ${root} cannot be used`,
      `${error instanceof Error ? error.message : String(error)}\n\n` +
        'Choose another folder in Settings, or clear the field to use the default root.',
    );
  }
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
