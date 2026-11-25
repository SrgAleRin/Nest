import type {
  CommentSide,
  CommentStatus,
  HarnessId,
  Project,
  ReviewComment,
  Session,
  SessionStatus,
  Task,
  TaskKind,
  TaskStatus,
} from '@nest/shared';

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  kind: TaskKind;
  slug: string;
  title: string;
  branch: string;
  workspace_path: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  task_id: string;
  harness_id: HarnessId;
  title: string;
  status: SessionStatus;
  cwd: string;
  exit_code: number | null;
  scrollback: string;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  task_id: string;
  file_path: string;
  line: number;
  side: CommentSide;
  body: string;
  status: CommentStatus;
  created_at: string;
  updated_at: string;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    branch: row.branch,
    workspacePath: row.workspace_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    taskId: row.task_id,
    harnessId: row.harness_id,
    title: row.title,
    status: row.status,
    cwd: row.cwd,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toComment(row: CommentRow): ReviewComment {
  return {
    id: row.id,
    taskId: row.task_id,
    filePath: row.file_path,
    line: Number(row.line),
    side: row.side,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
