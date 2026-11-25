import { newId, nowIso, type CommentSide, type CommentStatus, type ReviewComment } from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { toComment, type CommentRow } from './rows.js';
import type { SessionService } from './sessions.js';
import type { TaskService } from './tasks.js';

export interface CreateCommentInput {
  taskId: string;
  filePath: string;
  line: number;
  side: CommentSide;
  body: string;
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly sessions: SessionService,
  ) {}

  list(taskId: string): ReviewComment[] {
    this.tasks.get(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM review_comments WHERE task_id = ?
         ORDER BY file_path, line, created_at`,
      )
      .all(taskId) as unknown as CommentRow[];
    return rows.map(toComment);
  }

  get(commentId: string): ReviewComment {
    const row = this.db
      .prepare('SELECT * FROM review_comments WHERE id = ?')
      .get(commentId) as CommentRow | undefined;
    if (!row) throw new NestError('comment_not_found', `Comment ${commentId} was not found`);
    return toComment(row);
  }

  create(input: CreateCommentInput): ReviewComment {
    this.tasks.get(input.taskId);
    const id = newId();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO review_comments (id, task_id, file_path, line, side, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.filePath,
        input.line,
        input.side,
        input.body,
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  update(
    commentId: string,
    patch: { body?: string; status?: CommentStatus },
  ): ReviewComment {
    const existing = this.get(commentId);
    this.db
      .prepare('UPDATE review_comments SET body = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.body ?? existing.body,
        patch.status ?? existing.status,
        nowIso(),
        commentId,
      );
    return this.get(commentId);
  }

  remove(commentId: string): void {
    this.get(commentId);
    this.db.prepare('DELETE FROM review_comments WHERE id = ?').run(commentId);
  }

  send(commentId: string, sessionId?: string): { sent: boolean; reason?: string } {
    const comment = this.get(commentId);
    const task = this.tasks.get(comment.taskId);

    const target = sessionId
      ? this.sessions.get(sessionId)
      : this.sessions.activeForTask(comment.taskId);

    if (!target) {
      return { sent: false, reason: 'no_active_session' };
    }
    if (target.taskId !== task.id) {
      return { sent: false, reason: 'session_belongs_to_another_task' };
    }
    if (target.status !== 'running' && target.status !== 'idle') {
      return { sent: false, reason: 'session_not_running' };
    }

    const text = [
      `Review comment — ${comment.filePath}:${comment.line}`,
      '',
      comment.body,
      '',
    ].join('\n');
    this.sessions.writeText(target.id, text);
    return { sent: true };
  }
}
