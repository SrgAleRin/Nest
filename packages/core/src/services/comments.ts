import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  newId,
  nowIso,
  type CommentSide,
  type CommentStatus,
  type ReviewComment,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { git } from '../git/exec.js';
import { anchorBlockText, findAnchorLine } from './anchor.js';
import { toComment, type CommentRow } from './rows.js';
import type { SessionService } from './sessions.js';
import type { TaskService } from './tasks.js';

export interface CreateCommentInput {
  taskId: string;
  filePath: string;
  line: number;
  endLine?: number;
  side: CommentSide;
  body: string;
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Returns comments with their anchors refreshed against the current file:
   * a comment follows the text it was written on, and is flagged stale when the
   * text no longer exists.
   */
  async list(taskId: string): Promise<ReviewComment[]> {
    const task = this.tasks.get(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM review_comments WHERE task_id = ?
         ORDER BY file_path, line, created_at`,
      )
      .all(taskId) as unknown as CommentRow[];

    const sideCache = new Map<string, Promise<string[] | null>>();
    const comments: ReviewComment[] = [];

    for (const row of rows) {
      const comment = toComment(row);
      if (!row.anchor_text) {
        comments.push(comment);
        continue;
      }

      const cacheKey = `${row.file_path}\u0000${row.side}`;
      let lines = sideCache.get(cacheKey);
      if (!lines) {
        lines = this.sideLines(task.workspacePath, row.file_path, row.side);
        sideCache.set(cacheKey, lines);
      }
      const content = await lines;

      const length = comment.endLine - comment.line + 1;
      const line = content ? findAnchorLine(content, row.anchor_text, comment.line) : null;
      if (line === null) {
        comments.push({ ...comment, stale: true });
        continue;
      }
      if (line === comment.line) {
        comments.push(comment);
        continue;
      }

      // The text moved: follow it and keep the same range length.
      const endLine = line + length - 1;
      this.db
        .prepare('UPDATE review_comments SET line = ?, end_line = ? WHERE id = ?')
        .run(line, endLine, row.id);
      comments.push({ ...comment, line, endLine });
    }

    comments.sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line ||
        a.createdAt.localeCompare(b.createdAt),
    );
    return comments;
  }

  get(commentId: string): ReviewComment {
    const row = this.db.prepare('SELECT * FROM review_comments WHERE id = ?').get(commentId) as
      CommentRow | undefined;
    if (!row) throw new NestError('comment_not_found', `Comment ${commentId} was not found`);
    return toComment(row);
  }

  async create(input: CreateCommentInput): Promise<ReviewComment> {
    const task = this.tasks.get(input.taskId);
    const endLine = Math.max(input.line, input.endLine ?? input.line);

    // The line text is stored as the anchor: it is what re-anchoring follows
    // after the file changes. Without readable content the comment still works,
    // it just cannot move.
    const lines = await this.sideLines(task.workspacePath, input.filePath, input.side);
    const anchorText = lines ? anchorBlockText(lines, input.line, endLine) : null;

    const id = newId();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO review_comments
           (id, task_id, file_path, line, end_line, anchor_text, side, body, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.filePath,
        input.line,
        endLine,
        anchorText,
        input.side,
        input.body,
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  update(commentId: string, patch: { body?: string; status?: CommentStatus }): ReviewComment {
    const existing = this.get(commentId);
    this.db
      .prepare('UPDATE review_comments SET body = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(patch.body ?? existing.body, patch.status ?? existing.status, nowIso(), commentId);
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
      `Review comment — ${comment.filePath}:${formatRange(comment)}`,
      '',
      comment.body,
      '',
    ].join('\n');
    this.sessions.writeText(target.id, text);
    return { sent: true };
  }

  /** Lines of one diff side: the workspace file for `new`, HEAD for `old`. */
  private async sideLines(
    workspacePath: string,
    filePath: string,
    side: CommentSide,
  ): Promise<string[] | null> {
    if (!isSafeRelativePath(filePath)) return null;
    try {
      if (side === 'new') {
        const content = await readFile(path.join(workspacePath, filePath), 'utf8');
        return splitLines(content);
      }
      const { stdout } = await git(workspacePath, ['show', `HEAD:${filePath}`]);
      return splitLines(stdout);
    } catch {
      // A deleted file (new side) or a file absent from HEAD (old side).
      return null;
    }
  }
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.split('\n');
}

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || path.isAbsolute(filePath)) return false;
  return !filePath.split(/[\\/]/).includes('..');
}

export function formatRange(comment: Pick<ReviewComment, 'line' | 'endLine'>): string {
  return comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
}
