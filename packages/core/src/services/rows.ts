import type {
  CommentSide,
  CommentStatus,
  HarnessId,
  Project,
  ResumeMode,
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
  setup_script: string | null;
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
  setup_error: string | null;
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
  stream_position: number;
  resume_on_start: number;
  stop_requested: number;
  harness_session_id: string | null;
  resume_mode: ResumeMode;
  created_at: string;
  updated_at: string;
}

export interface CommentRow {
  id: string;
  task_id: string;
  file_path: string;
  line: number;
  end_line: number | null;
  anchor_text: string | null;
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
    setupScript: row.setup_script,
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
    setupError: row.setup_error,
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
    harnessSessionId: row.harness_session_id,
    resumeMode: row.resume_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toComment(row: CommentRow): ReviewComment {
  const line = Number(row.line);
  return {
    id: row.id,
    taskId: row.task_id,
    filePath: row.file_path,
    line,
    endLine: row.end_line === null ? line : Number(row.end_line),
    side: row.side,
    body: row.body,
    status: row.status,
    stale: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
