import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestEvent, Project, Task } from '@nest/shared';
import { migrate, openDatabase } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';
import { createCore, NestError, type Core } from '../src/index.js';
import './gitEnv.js';
import { spawnPipedPty } from './pipedPty.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-sidebar-')));
const events: NestEvent[] = [];
let core: Core | null = null;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true })
    .replace(/\r\n/g, '\n')
    .trim();
}

/** A fresh repository with one commit on main. */
function makeRepo(name: string): string {
  const repo = path.join(tempRoot, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n', 'utf8');
  git(['add', '.'], repo);
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'], repo);
  return repo;
}

async function addProject(name: string): Promise<Project> {
  if (!core) throw new Error('core was not created');
  const { project } = await core.projects.add(makeRepo(name));
  return project;
}

async function createTask(project: Project, title: string): Promise<Task> {
  if (!core) throw new Error('core was not created');
  return core.tasks.create({ projectId: project.id, title, setupScript: null });
}

async function failureOf(run: () => Promise<unknown> | unknown): Promise<NestError> {
  const error = await Promise.resolve()
    .then(run)
    .then(
      () => null,
      (reason: unknown) => reason,
    );
  if (!(error instanceof NestError)) throw error ?? new Error('expected an error, got success');
  return error;
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}

beforeAll(() => {
  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
    sessions: { spawnPty: spawnPipedPty },
    onEvent: (event) => events.push(event),
  });
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('migration 13', () => {
  it('adds the sidebar columns with defaults to a database created at migration 12', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of migrations.filter((candidate) => candidate.id <= 12)) {
        db.exec(migration.sql);
        db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
          migration.id,
          migration.name,
          '2026-01-01T00:00:00.000Z',
        );
      }
      db.prepare(
        'INSERT INTO projects (id, name, path, default_base_ref, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('p1', 'repo', 'C:/repo', 'origin/main', '2026-01-01T00:00:00.000Z');
      db.prepare(
        `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
         VALUES (?, ?, 'worktree', ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        't1',
        'p1',
        'task',
        'Task',
        'nest/task',
        'C:/worktrees/task',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );

      migrate(db);

      const projectColumns = (
        db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(projectColumns).toEqual(expect.arrayContaining(['sort_order', 'hidden']));

      const taskColumns = (
        db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(taskColumns).toEqual(
        expect.arrayContaining([
          'workflow_status',
          'pinned',
          'sort_order',
          'notes',
          'archived_at',
          'unread',
        ]),
      );

      const project = db
        .prepare('SELECT sort_order, hidden FROM projects WHERE id = ?')
        .get('p1') as { sort_order: number; hidden: number };
      expect(Number(project.sort_order)).toBe(0);
      expect(Number(project.hidden)).toBe(0);

      const task = db
        .prepare(
          'SELECT workflow_status, pinned, sort_order, notes, archived_at, unread FROM tasks WHERE id = ?',
        )
        .get('t1') as {
        workflow_status: string;
        pinned: number;
        sort_order: number;
        notes: string | null;
        archived_at: string | null;
        unread: number;
      };
      expect(task.workflow_status).toBe('in_progress');
      expect(Number(task.pinned)).toBe(0);
      expect(Number(task.sort_order)).toBe(0);
      expect(task.notes).toBeNull();
      expect(task.archived_at).toBeNull();
      expect(Number(task.unread)).toBe(0);

      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('tasks_project_status');
      expect(index).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('rejects an unknown workflow status', () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db);
      db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        'p1',
        'repo',
        'C:/repo',
        '2026-01-01T00:00:00.000Z',
      );
      expect(() =>
        db
          .prepare(
            `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, workflow_status, created_at, updated_at)
             VALUES (?, ?, 'worktree', ?, ?, ?, ?, 'active', 'bogus', ?, ?)`,
          )
          .run(
            't1',
            'p1',
            'task',
            'Task',
            'nest/task',
            'C:/worktrees/task',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          ),
      ).toThrow(/workflow_status|CHECK/i);
    } finally {
      db.close();
    }
  });
});

describe('project sidebar metadata', () => {
  it('updates name, base ref, setup script and hidden state', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('project-update');
    events.length = 0;

    const renamed = core.projects.update(project.id, {
      name: '  renamed  ',
      defaultBaseRef: '  origin/main  ',
      setupScript: 'pnpm install',
      hidden: true,
    });

    expect(renamed.name).toBe('renamed');
    expect(renamed.defaultBaseRef).toBe('origin/main');
    expect(renamed.setupScript).toBe('pnpm install');
    expect(renamed.hidden).toBe(true);
    expect(events).toContainEqual({ type: 'project:updated', project: renamed });

    const cleared = core.projects.update(project.id, { defaultBaseRef: '   ', hidden: false });
    expect(cleared.defaultBaseRef).toBeNull();
    expect(cleared.hidden).toBe(false);
    expect(cleared.name).toBe('renamed');
  });

  it('rejects an empty name and an over-long base ref', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('project-invalid');

    expect((await failureOf(() => core!.projects.update(project.id, { name: '   ' }))).code).toBe(
      'invalid_project_name',
    );
    expect(
      (await failureOf(() => core!.projects.update(project.id, { defaultBaseRef: 'x'.repeat(251) })))
        .code,
    ).toBe('invalid_base_ref');
    const original = core.projects.get(project.id);
    expect(original.name).toBe(project.name);
    expect(original.defaultBaseRef).toBe(project.defaultBaseRef);
  });

  it('stores the sidebar order of projects', async () => {
    if (!core) throw new Error('core was not created');
    const first = await addProject('order-a');
    const second = await addProject('order-b');
    const third = await addProject('order-c');

    core.projects.reorder([third.id, first.id, second.id]);

    const listed = core.projects
      .list()
      .map((project) => project.id)
      .filter((id) => [first.id, second.id, third.id].includes(id));
    expect(listed).toEqual([third.id, first.id, second.id]);
    expect(core.projects.list().map((project) => project.sortOrder)).toEqual(
      expect.arrayContaining([0, 1, 2]),
    );
  });
});

describe('task sidebar metadata', () => {
  it('renames a task without touching its slug, branch or workspace path', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-rename');
    const task = await createTask(project, 'original title');

    const updated = core.tasks.update(task.id, { title: '  renamed title  ' });

    expect(updated.title).toBe('renamed title');
    expect(updated.slug).toBe(task.slug);
    expect(updated.branch).toBe(task.branch);
    expect(updated.workspacePath).toBe(task.workspacePath);
  });

  it('refuses to rename the main checkout', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-rename-checkout');
    const checkout = core.tasks.ensureCheckout(project.id);

    const failure = await failureOf(() => core!.tasks.update(checkout.id, { title: 'other' }));
    expect(failure.code).toBe('checkout_immutable');
    expect(core.tasks.get(checkout.id).title).toBe(checkout.title);
  });

  it('updates workflow status, pin, notes, unread flag and sort order', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-fields');
    const task = await createTask(project, 'fields');
    events.length = 0;

    const updated = core.tasks.update(task.id, {
      workflowStatus: 'in_review',
      pinned: true,
      notes: 'look at the diff first',
      unread: true,
      sortOrder: 7,
    });

    expect(updated.workflowStatus).toBe('in_review');
    expect(updated.pinned).toBe(true);
    expect(updated.notes).toBe('look at the diff first');
    expect(updated.unread).toBe(true);
    expect(updated.sortOrder).toBe(7);
    expect(events).toContainEqual({ type: 'task:updated', task: updated });

    const cleared = core.tasks.update(task.id, { notes: '   ', unread: false, pinned: false });
    expect(cleared.notes).toBeNull();
    expect(cleared.unread).toBe(false);
    expect(cleared.pinned).toBe(false);
    expect(cleared.workflowStatus).toBe('in_review');
  });

  it('orders tasks by sort order inside a project', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-reorder');
    const first = await createTask(project, 'first');
    const second = await createTask(project, 'second');

    core.tasks.reorder([second.id, first.id]);

    const ids = core.tasks
      .list(project.id, { includeArchived: false })
      .map((task) => task.id)
      .filter((id) => id === first.id || id === second.id);
    // The main checkout always stays first.
    expect(ids).toEqual([second.id, first.id]);
  });
});

describe('task archive and restore', () => {
  it('archives a task, stops its live PTY and clears the pin', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-archive');
    const task = await createTask(project, 'archivable');
    core.tasks.update(task.id, { pinned: true });

    const session = await core.sessions.start({
      taskId: task.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => core!.sessions.scrollback(session.id).includes('FakeHarness'));

    const archived = await core.tasks.archive(task.id);

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.pinned).toBe(false);
    expect(core.sessions.liveSessions([task.id])).toEqual([]);
    const row = core.db
      .prepare('SELECT stop_requested FROM sessions WHERE id = ?')
      .get(session.id) as { stop_requested: number };
    expect(Number(row.stop_requested)).toBe(1);

    // Archiving twice is a no-op that keeps the stored timestamp.
    const again = await core.tasks.archive(task.id);
    expect(again.archivedAt).toBe(archived.archivedAt);
  });

  it('refuses to archive the main checkout', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-archive-checkout');
    const checkout = core.tasks.ensureCheckout(project.id);

    const failure = await failureOf(() => core!.tasks.archive(checkout.id));
    expect(failure.code).toBe('cannot_archive_checkout');
    expect(core.tasks.get(checkout.id).status).toBe('active');
  });

  it('restores an archived task', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-restore');
    const task = await createTask(project, 'restorable');
    await core.tasks.archive(task.id);

    const restored = core.tasks.restore(task.id);

    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
    expect(core.tasks.restore(task.id).status).toBe('active');
  });

  it('hides archived tasks only when asked', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('task-list');
    const active = await createTask(project, 'active one');
    const archived = await createTask(project, 'archived one');
    await core.tasks.archive(archived.id);

    const all = core.tasks.list(project.id).map((task) => task.id);
    expect(all).toEqual(expect.arrayContaining([active.id, archived.id]));

    const withoutArchived = core.tasks.list(project.id, { includeArchived: false });
    expect(withoutArchived.map((task) => task.id)).toContain(active.id);
    expect(withoutArchived.map((task) => task.id)).not.toContain(archived.id);
    expect(withoutArchived.every((task) => task.status === 'active')).toBe(true);
    // The global list respects the flag as well.
    expect(core.tasks.list(undefined, { includeArchived: false }).map((task) => task.id)).not.toContain(
      archived.id,
    );
  });
});

describe('task removal with branch cleanup', () => {
  it('deletes the task branch when nothing else uses it', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('branch-delete');
    const task = await createTask(project, 'branch delete');

    expect(git(['branch', '--list', task.branch], project.path)).toContain(task.branch);
    await core.tasks.remove(task.id, { deleteBranch: true });

    expect(git(['branch', '--list', task.branch], project.path)).toBe('');
  });

  it('keeps the branch when it is the project base ref', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('branch-base');
    const task = await createTask(project, 'branch base');
    core.projects.update(project.id, { defaultBaseRef: task.branch });

    await core.tasks.remove(task.id, { deleteBranch: true });

    expect(git(['branch', '--list', task.branch], project.path)).toContain(task.branch);
  });

  it('keeps the branch while another worktree still uses it', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('branch-in-use');
    const task = await createTask(project, 'branch in use');

    // Free the branch from the task's own worktree, then give it to another.
    git(['checkout', '--detach'], task.workspacePath);
    const otherWorktree = path.join(tempRoot, 'branch-in-use-other');
    git(['worktree', 'add', otherWorktree, task.branch], project.path);

    await core.tasks.remove(task.id, { deleteBranch: true });

    expect(git(['branch', '--list', task.branch], project.path)).toContain(task.branch);
  });

  it('leaves the branch alone by default', async () => {
    if (!core) throw new Error('core was not created');
    const project = await addProject('branch-kept');
    const task = await createTask(project, 'branch kept');

    await core.tasks.remove(task.id);

    expect(git(['branch', '--list', task.branch], project.path)).toContain(task.branch);
  });
});
