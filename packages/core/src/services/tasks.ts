import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  MAIN_CHECKOUT_SLUG,
  newId,
  nowIso,
  slugify,
  type Task,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git, gitOrNull } from '../git/exec.js';
import { ProjectService } from './projects.js';
import { toTask, type TaskRow } from './rows.js';

export interface CreateTaskInput {
  projectId: string;
  title: string;
  baseBranch?: string;
}

export class TaskService {
  private beforeRemove: (task: Task) => void | Promise<void> = () => {};

  constructor(
    private readonly db: Db,
    private readonly projects: ProjectService,
    private readonly worktreesRoot: string,
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

  async create(input: CreateTaskInput): Promise<Task> {
    const project = this.projects.get(input.projectId);
    const checkout = this.projects.checkout(project.id);
    if (!checkout) throw new NestError('checkout_missing', 'Project has no main checkout');

    await mkdir(this.worktreesRoot, { recursive: true });

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

    return this.get(id);
  }

  async remove(taskId: string): Promise<void> {
    const task = this.get(taskId);
    if (task.kind === 'checkout' || task.slug === MAIN_CHECKOUT_SLUG) {
      throw new NestError('checkout_immutable', 'The main checkout cannot be removed');
    }

    await this.beforeRemove(task);
    const project = this.projects.get(task.projectId);

    await git(project.path, ['worktree', 'remove', '--force', task.workspacePath]).catch(
      async () => {
        await git(project.path, ['worktree', 'prune']).catch(() => {});
      },
    );

    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }

  private async resolveBaseBranch(repoPath: string, requested?: string): Promise<string> {
    if (requested) {
      const exists = await gitOrNull(repoPath, ['rev-parse', '--verify', `refs/heads/${requested}`]);
      if (!exists) throw new NestError('base_branch_missing', `Branch ${requested} does not exist`);
      return requested;
    }
    const current = await gitOrNull(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    if (!current) {
      throw new NestError('detached_head', 'Repository is in detached HEAD state');
    }
    return current;
  }
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const value = await gitOrNull(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  return Boolean(value);
}

function sanitizeDir(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.+$/g, '') || 'project';
}
