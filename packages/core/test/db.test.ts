import { describe, expect, it } from 'vitest';
import { openDatabase, migrate } from '../src/db/database.js';
import { migrations } from '../src/db/migrations.js';

describe('baseline migration', () => {
  it('applies from scratch and is idempotent', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    migrate(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'schema_migrations',
        'projects',
        'tasks',
        'sessions',
        'review_comments',
        'settings',
      ]),
    );

    const sessionColumns = (
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(sessionColumns).toEqual(
      expect.arrayContaining(['harness_session_id', 'resume_mode', 'resume_on_start']),
    );

    const projectColumns = (
      db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(projectColumns).toContain('setup_script');

    const taskColumns = (
      db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(taskColumns).toContain('setup_error');

    const applied = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
      count: number | bigint;
    };
    expect(Number(applied.count)).toBe(migrations.length);
    db.close();
  });

  it('enforces a single checkout and cascades deletes', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'repo',
      'C:/repo',
      '2026-01-01T00:00:00.000Z',
    );
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
       VALUES (?, 'p1', ?, ?, ?, ?, ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    insertTask.run('t1', 'checkout', '@main', 'main', 'main', 'C:/repo');
    expect(() =>
      insertTask.run('t2', 'checkout', '@main-2', 'main', 'main', 'C:/repo'),
    ).toThrow();

    insertTask.run('t3', 'worktree', 'feature', 'feature', 'nest/feature', 'C:/worktrees/feature');
    db.prepare(
      `INSERT INTO review_comments (id, task_id, file_path, line, side, body, status, created_at, updated_at)
       VALUES ('c1', 't3', 'src/a.ts', 1, 'new', 'note', 'open', '2026-01-01', '2026-01-01')`,
    ).run();

    db.prepare('DELETE FROM tasks WHERE id = ?').run('t3');
    const remaining = db.prepare('SELECT COUNT(*) AS count FROM review_comments').get() as {
      count: number | bigint;
    };
    expect(Number(remaining.count)).toBe(0);
    db.close();
  });
});
