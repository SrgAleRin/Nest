import {
  DEFAULT_DIFF_MODE,
  newId,
  nowIso,
  type CommentOutsideReason,
  type CommentPlacement,
  type CommentSide,
  type CommentStatus,
  type CommentView,
  type DiffMode,
  type GitDiff,
  type ReviewComment,
} from '@nest/shared';
import type { Db } from '../db/database.js';
import { NestError } from '../errors.js';
import { readSideLines, sidesFor, type AnchorDescriptor, type SideSource } from '../git/sides.js';
import { anchorBlockText, findAnchorLine } from './anchor.js';
import { toComment, type CommentRow } from './rows.js';
import type { GitService } from './git.js';
import type { SessionService } from './sessions.js';
import type { TaskService } from './tasks.js';

export interface CommentAnchorInput {
  /** Comparison the commented line numbers came from. */
  mode: DiffMode;
  /** Base ref of the comparison on screen; used by `base` mode. */
  baseRef?: string | null;
  /** The commented row was the staged side of a `both` view. */
  staged?: boolean;
}

export interface CreateCommentInput {
  taskId: string;
  filePath: string;
  line: number;
  endLine?: number;
  side: CommentSide;
  body: string;
  anchor?: CommentAnchorInput;
}

export type CommentSendFailure =
  | 'no_active_session'
  | 'session_not_running'
  | 'session_belongs_to_another_task';

export interface CommentSendResult {
  sent: boolean;
  reason?: CommentSendFailure;
  /** Formatted note, also when nothing was sent: the panel copies it instead. */
  text: string;
}

export class CommentsService {
  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly sessions: SessionService,
    private readonly git: GitService,
  ) {}

  /**
   * Every saved note of the task, re-anchored against the content of the side
   * it was written on, plus where it belongs in the requested view: on a
   * visible row, stale, or outside the patch with the reason.
   *
   * A note is never dropped because its hunk left the current diff (staged,
   * committed, another mode): it is real, so it stays listed and sendable.
   */
  async list(taskId: string, options: { mode?: DiffMode } = {}): Promise<CommentView[]> {
    const task = this.tasks.get(taskId);
    const rows = this.db
      .prepare(
        `SELECT * FROM review_comments WHERE task_id = ?
         ORDER BY file_path, line, created_at`,
      )
      .all(taskId) as unknown as CommentRow[];

    const mode = options.mode ?? DEFAULT_DIFF_MODE;
    const contentCache = new Map<string, Promise<string[] | null>>();
    const comments: ReviewComment[] = [];

    for (const row of rows) {
      const comment = toComment(row);
      if (!row.anchor_text) {
        comments.push(comment);
        continue;
      }

      const source = sourceForRow(row);
      if (!source) {
        comments.push({ ...comment, stale: true });
        continue;
      }

      const cacheKey = `${row.file_path}\u0000${sourceKey(source)}`;
      let lines = contentCache.get(cacheKey);
      if (!lines) {
        lines = readSideLines(task.workspacePath, row.file_path, source);
        contentCache.set(cacheKey, lines);
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

    const placements = await this.place(taskId, mode, comments);
    return comments.map((comment, index) => ({
      ...comment,
      placement: placements[index] ?? { kind: 'inline' },
    }));
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
    const descriptor = this.descriptorFor(task.baseRef, input.anchor);
    const sides = sidesFor(descriptor);

    // The line text is stored as the anchor: it is what re-anchoring follows
    // after the file changes. Without readable content the comment still works,
    // it just cannot move.
    const lines = await readSideLines(task.workspacePath, input.filePath, sides[input.side]);
    const anchorText = lines ? anchorBlockText(lines, input.line, endLine) : null;

    const id = newId();
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO review_comments
           (id, task_id, file_path, line, end_line, anchor_text, side, body, status,
            anchor_mode, anchor_base, anchor_staged, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
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
        descriptor.mode,
        descriptor.baseRef,
        descriptor.staged ? 1 : 0,
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

  /**
   * Sends one note to a session. A missing or finished session is reported,
   * never dropped: the caller keeps the formatted text and offers the
   * clipboard (product §5.4, step 8).
   */
  send(commentId: string, sessionId?: string): CommentSendResult {
    const comment = this.get(commentId);
    const task = this.tasks.get(comment.taskId);
    const text = formatSendText(comment);

    const target = sessionId
      ? this.sessions.get(sessionId)
      : this.sessions.activeForTask(comment.taskId);

    if (!target) {
      return { sent: false, reason: 'no_active_session', text };
    }
    if (target.taskId !== task.id) {
      return { sent: false, reason: 'session_belongs_to_another_task', text };
    }
    if (target.status !== 'running' && target.status !== 'idle') {
      return { sent: false, reason: 'session_not_running', text };
    }

    this.sessions.writeText(target.id, text);
    return { sent: true, text };
  }

  /** Comparison a new note is anchored against; `both` when the caller omits it. */
  private descriptorFor(
    taskBaseRef: string | null,
    anchor: CommentAnchorInput | undefined,
  ): AnchorDescriptor {
    if (!anchor) {
      // Legacy callers commented on the default view. Its old side is the
      // index, so anchoring no longer reads HEAD for old-side notes.
      return { mode: DEFAULT_DIFF_MODE, baseRef: null, staged: false };
    }
    const baseRef =
      anchor.mode === 'base' ? (anchor.baseRef ?? taskBaseRef ?? 'HEAD') : (anchor.baseRef ?? null);
    return {
      mode: anchor.mode,
      baseRef,
      staged: anchor.staged ?? false,
    };
  }

  /**
   * Decides where each note belongs in the view the panel is showing. The
   * answer is computed here because only core may read git: the renderer just
   * groups what it is given.
   */
  private async place(
    taskId: string,
    mode: DiffMode,
    comments: ReviewComment[],
  ): Promise<CommentPlacement[]> {
    if (comments.length === 0) return [];

    let viewed: GitDiff | null = null;
    try {
      viewed = await this.git.diff(taskId, { mode });
    } catch {
      // Without a diff nothing can be matched to a row; notes stay reachable
      // in the outside-patch area instead of disappearing.
      viewed = null;
    }

    const anchors = viewed ? visibleAnchors(viewed) : new Set<string>();
    const onPatch = new Set(viewed?.files.map((file) => file.path) ?? []);
    const localChanges = new Map<string, Promise<LocalChange>>();
    const indexText = new Map<string, Promise<string[] | null>>();

    const placements: CommentPlacement[] = [];
    for (const comment of comments) {
      if (comment.stale) {
        placements.push({ kind: 'stale' });
        continue;
      }
      if (anchors.has(anchorKey(comment.filePath, comment.side, comment.line))) {
        placements.push({ kind: 'inline' });
        continue;
      }

      let changes = localChanges.get(comment.filePath);
      if (!changes) {
        changes = this.localChange(taskId, comment.filePath);
        localChanges.set(comment.filePath, changes);
      }
      const local = await changes;

      const reason = await this.outsideReason({
        comment,
        mode,
        fileOnPatch: onPatch.has(comment.filePath),
        local,
        taskId,
        indexText,
      });
      placements.push({ kind: 'outside', reason });
    }
    return placements;
  }

  private async outsideReason(input: {
    comment: ReviewComment;
    mode: DiffMode;
    fileOnPatch: boolean;
    local: LocalChange;
    taskId: string;
    indexText: Map<string, Promise<string[] | null>>;
  }): Promise<CommentOutsideReason> {
    const { comment, mode, fileOnPatch, local } = input;

    // The whole change of this file sits in the index, so the viewed side
    // (unstaged or both) has nothing left to show for it.
    if (!fileOnPatch && local.staged && !local.unstaged) return 'staged';
    // No local change at all: the hunk the note was written on is in history.
    if (!fileOnPatch && !local.staged && !local.unstaged) return 'committed';
    // The note belongs to another comparison; say so instead of guessing.
    if (comment.anchorMode !== null && comment.anchorMode !== mode) return 'other_mode';
    if (fileOnPatch) {
      // Same file and comparison, but this hunk moved into the index while
      // other hunks of the file are still unstaged.
      if (local.staged && (await this.anchorInIndex(input.taskId, comment, input.indexText))) {
        return 'staged';
      }
      return 'not_in_patch';
    }
    return 'file_not_in_diff';
  }

  /** True when the note's block is part of the staged content of its file. */
  private async anchorInIndex(
    taskId: string,
    comment: ReviewComment,
    cache: Map<string, Promise<string[] | null>>,
  ): Promise<boolean> {
    if (!comment.excerpt) return false;
    const task = this.tasks.get(taskId);
    let lines = cache.get(comment.filePath);
    if (!lines) {
      lines = readSideLines(task.workspacePath, comment.filePath, { kind: 'index' });
      cache.set(comment.filePath, lines);
    }
    const content = await lines;
    return content !== null && findAnchorLine(content, comment.excerpt, comment.line) !== null;
  }

  /** Which of the two local diffs still touch this file. */
  private async localChange(taskId: string, filePath: string): Promise<LocalChange> {
    try {
      const diff = await this.git.diff(taskId, { mode: 'both', path: filePath });
      return {
        staged: diff.files.some((file) => file.staged),
        unstaged: diff.files.some((file) => !file.staged),
      };
    } catch {
      return { staged: false, unstaged: false };
    }
  }
}

interface LocalChange {
  staged: boolean;
  unstaged: boolean;
}

/**
 * Anchor keys of every line the patch actually draws. The rule matches the
 * Diff panel: a removed line belongs to the old side, everything else to the
 * new side.
 */
function visibleAnchors(diff: GitDiff): Set<string> {
  const anchors = new Set<string>();
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        const side: CommentSide = line.type === 'del' ? 'old' : 'new';
        const anchor = side === 'old' ? line.oldLine : line.newLine;
        if (anchor !== null) anchors.add(anchorKey(file.path, side, anchor));
      }
    }
  }
  return anchors;
}

function anchorKey(filePath: string, side: CommentSide, line: number): string {
  return `${filePath}\u0000${side}\u0000${line}`;
}

/** Side a stored note is read from, from the comparison it was written on. */
function sourceForRow(row: CommentRow): SideSource | null {
  try {
    return sidesFor({
      mode: toDiffMode(row.anchor_mode) ?? DEFAULT_DIFF_MODE,
      baseRef: row.anchor_base,
      staged: Number(row.anchor_staged) === 1,
    })[row.side];
  } catch {
    return null;
  }
}

function toDiffMode(value: string | null): DiffMode | null {
  switch (value) {
    case 'both':
    case 'unstaged':
    case 'staged':
    case 'base':
      return value;
    default:
      return null;
  }
}

function sourceKey(source: SideSource): string {
  return source.kind === 'ref' ? `ref:${source.ref}` : source.kind;
}

export function formatSendText(comment: ReviewComment): string {
  return [
    `Review comment — ${comment.filePath}:${formatRange(comment)} (${comment.side})`,
    '',
    comment.body,
    '',
  ].join('\n');
}

export function formatRange(comment: Pick<ReviewComment, 'line' | 'endLine'>): string {
  return comment.endLine > comment.line ? `${comment.line}-${comment.endLine}` : `${comment.line}`;
}
