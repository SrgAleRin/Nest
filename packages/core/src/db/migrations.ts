export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'baseline',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('checkout', 'worktree')),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        branch TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, slug)
      );

      CREATE UNIQUE INDEX tasks_single_checkout
        ON tasks (project_id) WHERE kind = 'checkout';

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        harness_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'idle', 'exited', 'failed')),
        cwd TEXT NOT NULL,
        exit_code INTEGER,
        scrollback TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX sessions_task ON sessions (task_id);

      CREATE TABLE review_comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL CHECK (line > 0),
        side TEXT NOT NULL CHECK (side IN ('old', 'new')),
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX review_comments_task ON review_comments (task_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'session_resume_on_start',
    sql: `
      ALTER TABLE sessions
        ADD COLUMN resume_on_start INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 3,
    name: 'session_harness_id',
    sql: `
      ALTER TABLE sessions
        ADD COLUMN harness_session_id TEXT;

      ALTER TABLE sessions
        ADD COLUMN resume_mode TEXT NOT NULL DEFAULT 'latest';
    `,
  },
  {
    id: 4,
    name: 'task_setup',
    sql: `
      ALTER TABLE projects
        ADD COLUMN setup_script TEXT;

      ALTER TABLE tasks
        ADD COLUMN setup_error TEXT;
    `,
  },
  {
    id: 5,
    name: 'comment_ranges',
    sql: `
      ALTER TABLE review_comments
        ADD COLUMN end_line INTEGER;

      ALTER TABLE review_comments
        ADD COLUMN anchor_text TEXT;
    `,
  },
  {
    id: 6,
    name: 'strip_session_title_numbers',
    sql: `
      -- The old title generator appended a per-task counter. The tab label
      -- only needs the profile name, so drop a trailing " 1", " 2", ...
      UPDATE sessions
      SET title = rtrim(rtrim(title, '0123456789'), ' ')
      WHERE title GLOB '* [0-9]*';
    `,
  },
  {
    id: 7,
    name: 'session_resume_mode_heuristic',
    sql: `
      -- Every "exact" id stored before this migration came from directory
      -- discovery, which cannot prove ownership. Downgrade instead of deleting
      -- so a manual resume still works.

      -- One conversation per project: keep the oldest row, clear the rest.
      UPDATE sessions
      SET harness_session_id = NULL, resume_mode = 'latest'
      WHERE harness_session_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM sessions older
          JOIN tasks older_task ON older_task.id = older.task_id
          JOIN tasks own_task ON own_task.id = sessions.task_id
          WHERE older.harness_session_id = sessions.harness_session_id
            AND older.id <> sessions.id
            AND older_task.project_id = own_task.project_id
            AND (older.created_at < sessions.created_at
              OR (older.created_at = sessions.created_at AND older.id < sessions.id))
        );

      UPDATE sessions
      SET resume_mode = 'heuristic'
      WHERE resume_mode = 'exact';
    `,
  },
  {
    id: 8,
    name: 'task_base_ref',
    sql: `
      -- The ref a worktree task was branched from, so the Diff panel can review
      -- the workspace against the task base instead of HEAD.
      ALTER TABLE tasks
        ADD COLUMN base_ref TEXT;
    `,
  },
  {
    id: 9,
    name: 'session_stream_position',
    sql: `
      -- Monotonic position of the session output stream, always equal to the
      -- end of the stored scrollback snapshot. Older rows start at 0.

      ALTER TABLE sessions
        ADD COLUMN stream_position INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 10,
    name: 'session_stop_requested',
    sql: `
      -- Explicit "the user stopped this session" marker. Recovery reads it
      -- instead of deriving resumability from an unfinished status, so a stop
      -- that races a quit can never make the session resumable again.

      ALTER TABLE sessions
        ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 11,
    name: 'comment_anchor_descriptor',
    sql: `
      -- The comparison a note was written against. Re-anchoring reads the old
      -- and new side of *that* diff (index/worktree for unstaged, HEAD/index
      -- for staged, task base for base) instead of a fixed HEAD -> workspace
      -- pair, which pointed an old-side anchor at the wrong content in a
      -- partially staged file.

      ALTER TABLE review_comments
        ADD COLUMN anchor_mode TEXT;

      ALTER TABLE review_comments
        ADD COLUMN anchor_base TEXT;

      -- 1 when the anchored row was the staged side of a mixed "both" view.
      ALTER TABLE review_comments
        ADD COLUMN anchor_staged INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 12,
    name: 'project_default_base_ref',
    sql: `
      -- Base ref new tasks of this project branch from. Resolved once when the
      -- project is registered: origin/HEAD when it exists, otherwise the branch
      -- that was checked out. Rows added before this migration stay NULL and are
      -- resolved on first use, so an existing project behaves as it did.

      ALTER TABLE projects
        ADD COLUMN default_base_ref TEXT;
    `,
  },
];
