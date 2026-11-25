import { mkdirSync } from 'node:fs';
import type { NestEvent } from '@nest/shared';
import { migrate, openDatabase, type Db } from './db/database.js';
import { HarnessRegistry } from './harness/registry.js';
import { CommentsService } from './services/comments.js';
import { GitService } from './services/git.js';
import { ProjectService } from './services/projects.js';
import { SessionService } from './services/sessions.js';
import { TaskService } from './services/tasks.js';

export interface CoreOptions {
  dbPath: string;
  worktreesRoot: string;
  fakeHarnessScript: string;
  customCommand?: string;
  onEvent?: (event: NestEvent) => void;
}

export interface Core {
  db: Db;
  projects: ProjectService;
  tasks: TaskService;
  git: GitService;
  sessions: SessionService;
  comments: CommentsService;
  harnesses: HarnessRegistry;
  close(): void;
}

export function createCore(options: CoreOptions): Core {
  mkdirSync(options.worktreesRoot, { recursive: true });

  const db = openDatabase(options.dbPath);
  migrate(db);

  const emit = (event: NestEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // renderer may be gone during shutdown
    }
  };

  const harnesses = new HarnessRegistry({
    fakeHarnessScript: options.fakeHarnessScript,
    customCommand: options.customCommand,
  });
  const projects = new ProjectService(db);
  const tasks = new TaskService(db, projects, options.worktreesRoot);
  const git = new GitService(db, tasks, emit);
  const sessions = new SessionService(db, tasks, harnesses, emit);
  sessions.recoverStale();
  const comments = new CommentsService(db, tasks, sessions);

  tasks.onBeforeRemove((task) => sessions.stopForTask(task.id));

  return {
    db,
    projects,
    tasks,
    git,
    sessions,
    comments,
    harnesses,
    close: () => {
      sessions.shutdownAll();
      db.close();
    },
  };
}

export { NestError } from './errors.js';
export type { Db } from './db/database.js';
export { migrate, openDatabase } from './db/database.js';
export { migrations } from './db/migrations.js';
export { parseUnifiedDiff, buildUntrackedDiff } from './git/diff.js';
