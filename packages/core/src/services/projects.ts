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
import { resolveDefaultBase } from '../git/base.js';
import { git } from '../git/exec.js';
import { toProject, toTask, type ProjectRow, type TaskRow } from './rows.js';
import { normalizeSetupScript } from './setup.js';

export class ProjectService {
  private beforeRemove: (project: Project) => void | Promise<void> = () => {};

  constructor(private readonly db: Db) {}

  /**
   * Runs before a project row is deleted. Composition uses it to stop and verify
   * the PTYs of every task of the project.
   */
  onBeforeRemove(handler: (project: Project) => void | Promise<void>): void {
    this.beforeRemove = handler;
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  get(projectId: string): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      ProjectRow | undefined;
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
    // The base is resolved once, here, and stored: a checkout of another branch
    // later must not silently move where new tasks branch from.
    const defaultBaseRef = await resolveDefaultBase(projectPath);
    const projectId = newId();
    const checkoutId = newId();
    const createdAt = nowIso();
    const name = path.basename(projectPath) || projectPath;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO projects (id, name, path, default_base_ref, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(projectId, name, projectPath, defaultBaseRef, createdAt);
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

  /**
   * Removes the project and its rows (tasks, sessions, comments, settings).
   * Every live PTY of the project must confirm exit first; if that fails the
   * project stays registered and nothing is deleted. Checkouts and worktrees are
   * never removed from disk here: they stay exactly as they are.
   */
  async remove(projectId: string): Promise<void> {
    const project = this.get(projectId);
    await this.beforeRemove(project);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  }

  /**
   * Default base ref of the project, resolved once and then reused. Rows that
   * predate migration 12 have no value yet, so the first read resolves and
   * stores one; a repository that cannot answer (no commit, no HEAD) keeps NULL
   * and `tasks.create` falls back to the current branch as before.
   */
  async ensureDefaultBase(projectId: string): Promise<string | null> {
    const project = this.get(projectId);
    if (project.defaultBaseRef) return project.defaultBaseRef;
    const resolved = await resolveDefaultBase(project.path);
    if (!resolved) return null;
    this.db
      .prepare('UPDATE projects SET default_base_ref = ? WHERE id = ?')
      .run(resolved, projectId);
    return resolved;
  }

  update(projectId: string, patch: { setupScript?: string | null }): Project {
    this.get(projectId);
    if (patch.setupScript !== undefined) {
      const script = normalizeSetupScript(patch.setupScript);
      if (script && script.length > 2000) {
        throw new NestError('invalid_setup_script', 'Setup script is too long (max 2000 chars)');
      }
      this.db.prepare('UPDATE projects SET setup_script = ? WHERE id = ?').run(script, projectId);
    }
    return this.get(projectId);
  }
}

export function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
