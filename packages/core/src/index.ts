import { mkdirSync } from 'node:fs';
import type { NestEvent } from '@nest/shared';
import { migrate, openDatabase, type Db } from './db/database.js';
import { HarnessDiscovery } from './harness/discovery.js';
import { HarnessRegistry } from './harness/registry.js';
import { CommentsService } from './services/comments.js';
import { FilesService } from './services/files.js';
import { GitService } from './services/git.js';
import { ProjectService } from './services/projects.js';
import { SessionService, type SessionServiceOptions } from './services/sessions.js';
import { SettingsService } from './services/settings.js';
import { TaskService } from './services/tasks.js';

export interface CoreOptions {
  dbPath: string;
  worktreesRoot: string;
  fakeHarnessScript: string;
  customCommand?: string;
  /** Test seams: PTY factory and crash-snapshot tuning. */
  sessions?: SessionServiceOptions;
  onEvent?: (event: NestEvent) => void;
}

export interface Core {
  db: Db;
  projects: ProjectService;
  tasks: TaskService;
  git: GitService;
  files: FilesService;
  sessions: SessionService;
  comments: CommentsService;
  settings: SettingsService;
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

  const settings = new SettingsService(db);
  const harnesses = new HarnessRegistry({
    fakeHarnessScript: options.fakeHarnessScript,
    customCommand: options.customCommand,
    getSettings: () => settings.get(),
  });
  const projects = new ProjectService(db, emit);
  const tasks = new TaskService(db, projects, options.worktreesRoot, emit, () => {
    const current = settings.get();
    return { worktreeRoot: current.worktreeRoot, copyEnvFiles: current.copyEnvFiles };
  });
  const git = new GitService(db, tasks, emit);
  const files = new FilesService(tasks);
  const discovery = new HarnessDiscovery();
  const sessions = new SessionService(db, tasks, harnesses, discovery, emit, options.sessions);
  sessions.recoverStale();
  sessions.resumePending();
  const comments = new CommentsService(db, tasks, sessions, git);

  tasks.onBeforeRemove((task) =>
    sessions.stopTasksAndWait([task.id], { subject: 'task' }),
  );

  tasks.onBeforeArchive((task) =>
    sessions.stopTasksAndWait([task.id], { subject: 'task' }),
  );

  // A project deletion owns every PTY of every task, including the main
  // checkout. Unconfirmed stops throw and keep the project and its rows.
  projects.onBeforeRemove(async (project) => {
    const taskIds = tasks.list(project.id).map((task) => task.id);
    await sessions.stopTasksAndWait(taskIds, { subject: 'project' });
  });

  return {
    db,
    projects,
    tasks,
    git,
    files,
    sessions,
    comments,
    settings,
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
export { DEFAULT_SETTINGS, SettingsService, resolveWorktreesRoot } from './services/settings.js';
export { parseUnifiedDiff, buildUntrackedDiff } from './git/diff.js';
