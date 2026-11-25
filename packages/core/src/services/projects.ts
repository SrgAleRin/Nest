import path from 'node:path';
import { stat } from 'node:fs/promises';
import {
  MAIN_CHECKOUT_SLUG,
  MAIN_CHECKOUT_TITLE,
  newId,
  nowIso,
  type Project,
  type Task,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git } from '../git/exec.js';
import { toProject, toTask, type ProjectRow, type TaskRow } from './rows.js';

export class ProjectService {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  get(projectId: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | ProjectRow
      | undefined;
    if (!row) throw new NestError('project_not_found', `Project ${projectId} was not found`);
    return toProject(row);
  }

  findByPath(projectPath: string): Project | null {
    const rows = this.db.prepare('SELECT * FROM projects').all() as unknown as ProjectRow[];
    const normalized = normalizePath(projectPath);
    const row = rows.find((candidate) => normalizePath(candidate.path) === normalized);
    return row ? toProject(row) : null;
  }

  checkout(projectId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? AND kind = 'checkout'")
      .get(projectId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  async add(inputPath: string): Promise<{ project: Project; checkout: Task }> {
    const resolved = path.resolve(inputPath);
    const info = await stat(resolved).catch(() => null);
    if (!info?.isDirectory()) {
      throw new NestError('not_a_directory', `${resolved} is not a directory`);
    }

    const root = (await git(resolved, ['rev-parse', '--show-toplevel'])).stdout.trim();
    if (!root) throw new NestError('not_a_repository', `${resolved} is not a git repository`);

    const projectPath = path.resolve(root);
    if (this.findByPath(projectPath)) {
      throw new NestError('project_exists', `${projectPath} is already added to Nest`);
    }

    const head = await git(projectPath, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
    if (!head) {
      throw new NestError(
        'empty_repository',
        'Repository has no commits yet. Create an initial commit before adding it to Nest.',
      );
    }

    const branch = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    const projectId = newId();
    const checkoutId = newId();
    const createdAt = nowIso();
    const name = path.basename(projectPath) || projectPath;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)')
        .run(projectId, name, projectPath, createdAt);
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
           VALUES (?, ?, 'checkout', ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          checkoutId,
          projectId,
          MAIN_CHECKOUT_SLUG,
          MAIN_CHECKOUT_TITLE,
          branch,
          projectPath,
          createdAt,
          createdAt,
        );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const project = this.get(projectId);
    const checkout = this.checkout(projectId);
    if (!checkout) throw new NestError('checkout_missing', 'Failed to create main checkout');
    return { project, checkout };
  }

  remove(projectId: string): void {
    this.get(projectId);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }
}

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
