import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DEFAULT_DIFF_MODE } from '@nest/shared';
import type {
  CommentSide,
  CommentView,
  DiffDescriptor,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffMode,
  GitDiff,
  NestClient,
  ReviewComment,
  Session,
  Task,
} from '@nest/shared';
import { Button, EmptyState, ErrorState } from '@nest/ui';
import { CheckIcon, ChevronIcon, SendIcon, TrashIcon } from './Icons';
import { DiffPanelSkeleton } from './PanelSkeletons';
import { panelPhase } from '../panelState';
import {
  countSides,
  describeDiff,
  DIFF_MODE_OPTIONS,
  emptyDiffMessage,
  fileSideBadge,
  fileStageAction,
  isStaleDiff,
  type SideCounts,
} from '../diffMode';
import {
  batchSendSummary,
  groupOutsideComments,
  needsModeSwitch,
  openOutsideComments,
  openTargetMode,
  outsideSummary,
  sendFailureNotice,
  type OutsideSection,
} from '../commentPlacement';
import { diffStatusLetter, diffStatusTone, errorMessage } from '../utils';
import { highlightHunk, tokenStyle, type HunkHighlight } from '../highlight';

/**
 * Highlighting a whole diff is wasted work for generated files with tens of
 * thousands of lines, so large diffs stay plain text.
 */
const MAX_HIGHLIGHT_FILE_LINES = 4000;
const MAX_HIGHLIGHT_TOTAL_LINES = 20_000;

interface DiffPanelProps {
  client: NestClient;
  task: Task | null;
  sessions: Session[];
  selectedSessionId: string | null;
  refreshKey: number;
  onChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface ComposerState {
  filePath: string;
  /** First line of the range; equals endLine for a single-line comment. */
  line: number;
  endLine: number;
  side: CommentSide;
  /** The row was the staged side of a mixed view, which decides its anchor. */
  staged: boolean;
}

type DiffRow =
  | { kind: 'file'; key: string; file: DiffFile }
  | { kind: 'empty'; key: string; file: DiffFile }
  | { kind: 'stale-file'; key: string; filePath: string }
  | { kind: 'hunk'; key: string; hunk: DiffHunk }
  | {
      kind: 'line';
      key: string;
      file: DiffFile;
      hunk: DiffHunk;
      line: DiffLine;
      lineIndex: number;
      side: CommentSide;
      /** Line number of the anchor side, null for hunk meta lines. */
      anchor: number | null;
      comments: ReviewComment[];
    }
  | { kind: 'comment'; key: string; comment: ReviewComment }
  | { kind: 'composer'; key: string; composer: ComposerState };

export function DiffPanel({
  client,
  task,
  sessions,
  selectedSessionId,
  refreshKey,
  onChanged,
  onNotify,
}: DiffPanelProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const [highlights, setHighlights] = useState<Map<DiffHunk, HunkHighlight>>(new Map());
  const [mode, setMode] = useState<DiffMode>(DEFAULT_DIFF_MODE);
  const [counts, setCounts] = useState<SideCounts>({ staged: 0, unstaged: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [draft, setDraft] = useState('');
  /** Saved note the panel is scrolling to, after "Open" from the off-patch area. */
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [outsideOpen, setOutsideOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Only the newest request may write state; mode switches race with reloads. */
  const requestSeq = useRef(0);
  /**
   * Bumped by every note the panel writes itself. A reload that started before
   * that write still answers with the old list, and applying it would make a
   * note the user just saved disappear until the next refresh.
   */
  const commentsEpoch = useRef(0);

  const activeSession = useMemo(() => {
    const running = sessions.filter(
      (session) => session.status === 'running' || session.status === 'idle',
    );
    return running.find((session) => session.id === selectedSessionId) ?? running[0] ?? null;
  }, [sessions, selectedSessionId]);

  const load = useCallback(
    async (requested: DiffMode) => {
      if (!task) {
        setDiff(null);
        setComments([]);
        setError(null);
        return;
      }
      const seq = (requestSeq.current += 1);
      const epoch = commentsEpoch.current;
      setLoading(true);
      setError(null);
      try {
        const [nextDiff, nextComments, nextStatus] = await Promise.all([
          client.invoke('git.diff', { taskId: task.id, mode: requested }),
          client.invoke('comments.list', { taskId: task.id, mode: requested }),
          client.invoke('git.status', { taskId: task.id }),
        ]);
        // A response for another mode must not replace the selected view.
        if (seq !== requestSeq.current || isStaleDiff(nextDiff.descriptor, requested)) return;
        setDiff(nextDiff);
        // Notes written while this request was in flight win over its answer.
        if (commentsEpoch.current === epoch) setComments(nextComments);
        setCounts(countSides(nextStatus.files));
      } catch (loadError) {
        if (seq !== requestSeq.current) return;
        setError(errorMessage(loadError));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [client, task],
  );

  useEffect(() => {
    void load(mode);
  }, [load, mode, refreshKey]);

  // Switching tasks starts at the top of the new diff.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [task?.id]);

  useEffect(() => {
    if (!diff) {
      setHighlights(new Map());
      return;
    }

    let cancelled = false;
    const hunks: Array<{ file: DiffFile; hunk: DiffHunk }> = [];
    let budget = MAX_HIGHLIGHT_TOTAL_LINES;
    for (const file of diff.files) {
      const lines = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
      if (lines === 0 || lines > MAX_HIGHLIGHT_FILE_LINES || lines > budget) continue;
      budget -= lines;
      for (const hunk of file.hunks) hunks.push({ file, hunk });
    }

    void Promise.all(
      hunks.map(async ({ file, hunk }) => ({
        hunk,
        result: await highlightHunk(hunk, file.path),
      })),
    ).then((results) => {
      if (cancelled) return;
      const next = new Map<DiffHunk, HunkHighlight>();
      for (const { hunk, result } of results) {
        if (result) next.set(hunk, result);
      }
      setHighlights(next);
    });

    return () => {
      cancelled = true;
    };
  }, [diff]);

  const rows = useMemo(() => buildRows(diff, comments, composer), [diff, comments, composer]);

  /** Notes that are real but not on this patch, grouped by why. */
  const outsideGroups = useMemo(() => groupOutsideComments(comments), [comments]);
  const outsideOpenNotes = useMemo(() => openOutsideComments(comments), [comments]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      return row ? estimateRowSize(row) : 0;
    },
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 10,
  });

  // The composer row can be added below the viewport; bring it into view.
  useEffect(() => {
    if (!composer) return;
    const index = rows.findIndex((row) => row.kind === 'composer');
    if (index >= 0) virtualizer.scrollToIndex(index);
  }, [composer, rows, virtualizer]);

  // "Open" on an off-patch note scrolls to it once the matching mode has loaded.
  useEffect(() => {
    if (!focusCommentId) return;
    const index = rows.findIndex(
      (row) => row.kind === 'comment' && row.comment.id === focusCommentId,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index);
      setFocusCommentId(null);
      return;
    }
    // The target view is loaded and the note is still off-patch (committed, or
    // outside the hunks): its excerpt in the outside area is all there is.
    if (!loading) setFocusCommentId(null);
  }, [focusCommentId, loading, rows, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  // Which file the viewport currently sits in, for the sticky header overlay.
  const stickyFile = useMemo(() => {
    const first = virtualItems[0];
    if (!first) return null;
    for (let index = first.index; index >= 0; index -= 1) {
      const row = rows[index];
      if (row?.kind === 'file') return index === first.index ? null : row.file;
    }
    return null;
  }, [virtualItems, rows]);

  function openComposer(file: DiffFile, line: DiffLine, extend: boolean): void {
    const side: CommentSide = line.type === 'del' ? 'old' : 'new';
    const number = side === 'old' ? line.oldLine : line.newLine;
    if (!number) return;
    setComposer((current) => {
      // Shift+click on another line grows the draft range on the same side.
      if (extend && current && current.filePath === file.path && current.side === side) {
        return {
          ...current,
          line: Math.min(current.line, number),
          endLine: Math.max(current.endLine, number),
        };
      }
      return { filePath: file.path, line: number, endLine: number, side, staged: file.staged };
    });
    if (!extend) setDraft('');
  }

  async function addComment(): Promise<void> {
    if (!task || !composer || !draft.trim()) return;
    setBusy(true);
    try {
      const comment = await client.invoke('comments.create', {
        taskId: task.id,
        filePath: composer.filePath,
        line: composer.line,
        endLine: composer.endLine,
        side: composer.side,
        body: draft.trim(),
        // The comparison is stored with the note: its sides decide what the
        // anchor follows after the file or the index moves.
        anchor: {
          mode,
          baseRef: diff?.descriptor.baseRef ?? null,
          staged: composer.staged,
        },
      });
      // The note was just written on a visible row of this view.
      commentsEpoch.current += 1;
      setComments((prev) => [...prev, { ...comment, placement: { kind: 'inline' } }]);
      setComposer(null);
      setDraft('');
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateComment(
    comment: ReviewComment,
    patch: { body?: string; status?: 'open' | 'resolved' },
  ): Promise<void> {
    setBusy(true);
    try {
      const next = await client.invoke('comments.update', {
        commentId: comment.id,
        ...(patch.body ? { body: patch.body } : {}),
        ...(patch.status ? { status: patch.status } : {}),
      });
      // Editing or resolving a note does not move it; keep the placement.
      commentsEpoch.current += 1;
      setComments((prev) =>
        prev.map((item) =>
          item.id === next.id
            ? {
                ...item,
                body: next.body,
                status: next.status,
                excerpt: next.excerpt,
                updatedAt: next.updatedAt,
              }
            : item,
        ),
      );
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(comment: ReviewComment): Promise<void> {
    setBusy(true);
    try {
      await client.invoke('comments.remove', { commentId: comment.id });
      commentsEpoch.current += 1;
      setComments((prev) => prev.filter((item) => item.id !== comment.id));
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Sends one note or a batch. Without a live session the note is copied to the
   * clipboard and the panel says so: a saved note is never silently dropped.
   */
  async function sendComments(targets: ReviewComment[]): Promise<void> {
    if (targets.length === 0 || busy) return;
    setBusy(true);
    try {
      const sentTexts: string[] = [];
      const unsentTexts: string[] = [];
      let failure: string | undefined;

      for (const comment of targets) {
        const result = await client.invoke('comments.send', {
          commentId: comment.id,
          ...(activeSession ? { sessionId: activeSession.id } : {}),
        });
        if (result.sent) sentTexts.push(result.text);
        else {
          unsentTexts.push(result.text);
          failure = result.reason ?? failure;
        }
      }

      if (targets.length === 1) {
        const notice = sendFailureNotice(
          sentTexts.length === 1 ? undefined : failure,
          activeSession?.title ?? null,
        );
        if (notice.copy) await copyNotes(unsentTexts);
        onNotify(notice.level, notice.message);
      } else {
        if (unsentTexts.length > 0) await copyNotes(unsentTexts);
        const level = unsentTexts.length === 0 ? 'info' : 'warn';
        onNotify(
          level,
          batchSendSummary(sentTexts.length, unsentTexts.length, activeSession?.title ?? null),
        );
      }
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyNotes(texts: string[]): Promise<void> {
    if (texts.length === 0) return;
    try {
      await client.invoke('clipboard.write', { text: texts.join('\n') });
    } catch {
      // clipboard access is a convenience here; the message already explains it
    }
  }

  /** Opens an off-patch note: switch to its comparison, then scroll to it. */
  function openComment(comment: CommentView): void {
    setFocusCommentId(comment.id);
    if (needsModeSwitch(comment, mode)) setMode(openTargetMode(comment, mode));
  }

  /** Stage or unstage one file without leaving the diff; the file stays on disk. */
  async function changeStage(file: DiffFile, action: 'stage' | 'unstage'): Promise<void> {
    if (!task) return;
    setBusy(true);
    try {
      await client.invoke(action === 'stage' ? 'git.stage' : 'git.unstage', {
        taskId: task.id,
        paths: [file.path],
      });
      // Other panels show the same index, so the whole window refreshes.
      onChanged();
      await load(mode);
    } catch (stageError) {
      onNotify('error', errorMessage(stageError));
    } finally {
      setBusy(false);
    }
  }

  function renderRow(row: DiffRow) {
    switch (row.kind) {
      case 'file':
        return (
          <DiffFileHeader
            file={row.file}
            mode={mode}
            busy={busy}
            onStage={(action) => void changeStage(row.file, action)}
          />
        );
      case 'empty':
        return <div className="diff-empty">{emptyDiffLabel(row.file)}</div>;
      case 'stale-file':
        return (
          <header className="diff-file-head">
            <span className="git-letter tone-deleted">?</span>
            <span className="diff-path" title={row.filePath}>
              {row.filePath}
            </span>
            <span className="diff-stat">outdated</span>
          </header>
        );
      case 'hunk':
        return <div className="diff-hunk-head">{row.hunk.header}</div>;
      case 'line': {
        const tokens = highlights.get(row.hunk)?.lines[row.lineIndex] ?? null;
        const selected =
          composer !== null &&
          composer.filePath === row.file.path &&
          composer.side === row.side &&
          row.anchor !== null &&
          row.anchor >= composer.line &&
          row.anchor <= composer.endLine;
        return (
          <div
            className={`diff-line diff-${row.line.type} ${selected ? 'diff-line-selected' : ''}`}
          >
            <span className="diff-num old">{row.line.oldLine ?? ''}</span>
            <span className="diff-num new">{row.line.newLine ?? ''}</span>
            <span className="diff-sign">
              {row.line.type === 'add' ? '+' : row.line.type === 'del' ? '-' : ' '}
            </span>
            <span className="diff-text">
              {tokens
                ? tokens.map((token, index) => (
                    <span key={index} style={tokenStyle(token)}>
                      {token.content}
                    </span>
                  ))
                : row.line.text || ' '}
            </span>
            {row.anchor !== null ? (
              <button
                className="diff-comment-btn"
                title={`Comment on ${row.side} line ${row.anchor} (Shift+click to extend a range)`}
                onClick={(event) => openComposer(row.file, row.line, event.shiftKey)}
              >
                +
              </button>
            ) : null}
          </div>
        );
      }
      case 'comment':
        return (
          <CommentThread
            comment={row.comment}
            activeSession={activeSession}
            busy={busy}
            onSend={() => void sendComments([row.comment])}
            onResolve={() =>
              void updateComment(row.comment, {
                status: row.comment.status === 'resolved' ? 'open' : 'resolved',
              })
            }
            onSaveEdit={(body) => void updateComment(row.comment, { body })}
            onDelete={() => void removeComment(row.comment)}
          />
        );
      case 'composer':
        return (
          <div className="comment-composer">
            <div className="comment-composer-head">
              {row.composer.filePath}:{formatRange(row.composer)}{' '}
              <span className="muted">({row.composer.side} line)</span>
            </div>
            <textarea
              autoFocus
              rows={3}
              value={draft}
              placeholder="Leave a review note…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void addComment();
                }
                if (event.key === 'Escape') setComposer(null);
              }}
            />
            <div className="comment-composer-hint">
              Shift+click another + to extend the range; Esc cancels.
            </div>
            <div className="comment-composer-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !draft.trim()}
                onClick={() => void addComment()}
              >
                Add comment
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setComposer(null)}>
                Cancel
              </Button>
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  const phase = panelPhase({ loading, error, hasData: diff !== null });

  if (!task) {
    return <EmptyState title="No workspace selected">Select a task to review its diff.</EmptyState>;
  }

  if (phase === 'error') {
    return (
      <div className="diff-panel">
        <DiffHead
          descriptor={diff?.descriptor ?? null}
          count={diff?.files.length ?? null}
          mode={mode}
          counts={counts}
          loading={loading}
          onMode={setMode}
          onRefresh={() => void load(mode)}
        />
        <ErrorState title="Diff unavailable" onRetry={() => void load(mode)}>
          {error}
        </ErrorState>
      </div>
    );
  }

  if (phase !== 'ready' || !diff) {
    return <DiffPanelSkeleton />;
  }

  return (
    <div className="diff-panel">
      <DiffHead
        descriptor={diff.descriptor}
        count={diff.files.length}
        mode={mode}
        counts={counts}
        loading={loading}
        onMode={setMode}
        onRefresh={() => void load(mode)}
      />

      <OutsidePatchNotes
        comments={comments}
        groups={outsideGroups}
        openCount={outsideOpenNotes.length}
        expanded={outsideOpen}
        busy={busy}
        activeSession={activeSession}
        onToggle={() => setOutsideOpen((open) => !open)}
        onOpen={openComment}
        onSend={(comment) => void sendComments([comment])}
        onSendAll={() => void sendComments(outsideOpenNotes)}
        onResolve={(comment) =>
          void updateComment(comment, {
            status: comment.status === 'resolved' ? 'open' : 'resolved',
          })
        }
        onSaveEdit={(comment, body) => void updateComment(comment, { body })}
        onDelete={(comment) => void removeComment(comment)}
      />

      <div className="diff-body">
        <div className="diff-scroll" ref={scrollRef}>
          {diff.files.length === 0 ? (            <div className="panel-empty">
              {emptyDiffMessage(mode, counts, diff.descriptor.baseRef)}
            </div>
          ) : null}

          <div className="diff-rows" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="diff-row"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {renderRow(row)}
                </div>
              );
            })}
          </div>
        </div>

        {stickyFile ? <DiffFileHeader file={stickyFile} mode={mode} sticky /> : null}
      </div>
    </div>
  );
}

function DiffHead({
  descriptor,
  count,
  mode,
  counts,
  loading,
  onMode,
  onRefresh,
}: {
  descriptor: DiffDescriptor | null;
  count: number | null;
  mode: DiffMode;
  counts: SideCounts;
  loading: boolean;
  onMode: (mode: DiffMode) => void;
  onRefresh: () => void;
}) {
  const hint = DIFF_MODE_OPTIONS.find((option) => option.mode === mode)?.hint ?? '';
  return (
    <>
      <div className="diff-head">
        <span className="section-label">
          Diff
          {count !== null ? ` · ${count} file${count === 1 ? '' : 's'}` : ''}
        </span>
        <button className="mini-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* The switch is part of the panel: the compared side is explicit, never inferred. */}
      <div className="diff-modes" role="tablist" aria-label="Diff comparison">
        {DIFF_MODE_OPTIONS.map((option) => (
          <button
            key={option.mode}
            role="tab"
            aria-selected={mode === option.mode}
            className={`mini-btn diff-mode ${mode === option.mode ? 'selected' : ''}`}
            title={option.hint}
            onClick={() => onMode(option.mode)}
          >
            {option.label}
            {option.mode === 'staged' && counts.staged > 0 ? ` ${counts.staged}` : ''}
            {option.mode === 'unstaged' && counts.unstaged > 0 ? ` ${counts.unstaged}` : ''}
          </button>
        ))}
      </div>
      <div className="diff-mode-hint">{describeDiff(descriptor)}</div>
      <div className="diff-mode-hint muted">{hint}</div>
    </>
  );
}

function emptyDiffLabel(file: DiffFile): string {
  if (file.binary) return 'Binary file';
  if (file.modeChanged) return 'File mode changed';
  return 'No textual hunks';
}

function DiffFileHeader({
  file,
  mode,
  busy = false,
  sticky = false,
  onStage,
}: {
  file: DiffFile;
  mode: DiffMode;
  busy?: boolean;
  sticky?: boolean;
  onStage?: (action: 'stage' | 'unstage') => void;
}) {
  // `both` mixes sides, so the row says which one it is; in the single-side
  // modes the mode switch above already does.
  const badge = fileSideBadge(file, mode);
  const action = onStage ? fileStageAction(file, mode) : null;
  return (
    <header className={`diff-file-head ${sticky ? 'diff-file-head-sticky' : ''}`}>
      <span className={`git-letter ${diffStatusTone(file.status)}`}>
        {diffStatusLetter(file.status)}
      </span>
      <span
        className="diff-path"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        {file.path}
      </span>
      {badge ? <span className={`diff-side ${badge}`}>{badge}</span> : null}
      <span className="diff-stat">
        <em>+{file.additions}</em> <del>-{file.deletions}</del>
      </span>
      {action && onStage ? (
        <button
          className="mini-btn"
          disabled={busy}
          title={
            action === 'stage'
              ? 'Stage this file; the working tree copy stays as it is'
              : 'Unstage this file; the working tree copy stays as it is'
          }
          onClick={() => onStage(action)}
        >
          {action === 'stage' ? 'Stage' : 'Unstage'}
        </button>
      ) : null}
    </header>
  );
}

function CommentThread({
  comment,
  activeSession,
  busy,
  onSend,
  onResolve,
  onSaveEdit,
  onDelete,
}: {
  comment: ReviewComment;
  activeSession: Session | null;
  busy: boolean;
  onSend: () => void;
  onResolve: () => void;
  onSaveEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.body);

  function save(): void {
    const body = editDraft.trim();
    if (!body || body === comment.body) {
      setEditing(false);
      return;
    }
    onSaveEdit(body);
    setEditing(false);
  }

  return (
    <div className={`comment-thread ${comment.status === 'resolved' ? 'resolved' : ''}`}>
      <div className="comment-head">
        <span className={`comment-status ${comment.status}`}>{comment.status}</span>
        <span className="comment-anchor">
          {comment.filePath}:{formatRange(comment)}
        </span>
      </div>
      {comment.stale ? (
        <div className="comment-stale">
          The anchored line was removed or changed; this note may no longer apply.
        </div>
      ) : null}
      {editing ? (
        <div className="comment-edit">
          <textarea
            autoFocus
            rows={3}
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <div className="comment-actions">
            <button className="comment-action primary" onClick={save} disabled={busy}>
              Save
            </button>
            <button className="comment-action" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">{comment.body}</div>
      )}
      <div className="comment-actions">
        <button
          className="comment-action primary"
          onClick={onSend}
          disabled={busy}
          title={
            activeSession
              ? `Send to ${activeSession.title}`
              : 'No running session: the note goes to the clipboard instead'
          }
        >
          <SendIcon size={11} />
          {activeSession ? `Send to ${activeSession.title}` : 'Send (no session)'}
        </button>
        <button
          className="comment-action"
          onClick={() => {
            setEditDraft(comment.body);
            setEditing(true);
          }}
          disabled={busy}
        >
          Edit
        </button>
        <button className="comment-action" onClick={onResolve} disabled={busy}>
          <CheckIcon size={11} />
          {comment.status === 'resolved' ? 'Reopen' : 'Resolve'}
        </button>
        <button className="comment-action danger" onClick={onDelete} disabled={busy}>
          <TrashIcon size={11} />
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Notes that are real but not on the current patch: staged away, committed,
 * written against another comparison, or on a file this patch does not touch.
 * Distinct from the stale notes (whose text is gone), always counted, and with
 * the same actions as an inline note: open, send, edit, resolve, delete.
 */
function OutsidePatchNotes({
  comments,
  groups,
  openCount,
  expanded,
  busy,
  activeSession,
  onToggle,
  onOpen,
  onSend,
  onSendAll,
  onResolve,
  onSaveEdit,
  onDelete,
}: {
  comments: CommentView[];
  groups: OutsideSection[];
  openCount: number;
  expanded: boolean;
  busy: boolean;
  activeSession: Session | null;
  onToggle: () => void;
  onOpen: (comment: CommentView) => void;
  onSend: (comment: CommentView) => void;
  onSendAll: () => void;
  onResolve: (comment: CommentView) => void;
  onSaveEdit: (comment: CommentView, body: string) => void;
  onDelete: (comment: CommentView) => void;
}) {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) return null;

  return (
    <section
      className={`outside-notes ${expanded ? 'expanded' : ''}`}
      aria-label="Notes outside this patch"
    >
      <header className="outside-head">
        <button className="outside-toggle" onClick={onToggle} aria-expanded={expanded}>
          <ChevronIcon size={11} />
          <span className="section-label">Outside this patch</span>
        </button>
        <span className="outside-counts">{outsideSummary(comments)}</span>
        {expanded && openCount > 0 ? (
          <button
            className="mini-btn"
            onClick={onSendAll}
            disabled={busy}
            title={
              activeSession
                ? `Send ${openCount} open note(s) to ${activeSession.title}`
                : 'No running session: the notes go to the clipboard instead'
            }
          >
            Send open ({openCount})
          </button>
        ) : null}
      </header>

      {expanded
        ? groups.map((group) => (
            <div className="outside-group" key={group.reason}>
              <div className="outside-group-head">
                <span className={`outside-reason ${group.reason}`}>{group.label}</span>
                <span className="outside-group-count">{group.count}</span>
                <span className="outside-group-hint">{group.hint}</span>
              </div>
              {group.comments.map((comment) => (
                <OutsideNote
                  key={comment.id}
                  comment={comment}
                  busy={busy}
                  onOpen={() => onOpen(comment)}
                  onSend={() => onSend(comment)}
                  onResolve={() => onResolve(comment)}
                  onSaveEdit={(body) => onSaveEdit(comment, body)}
                  onDelete={() => onDelete(comment)}
                />
              ))}
            </div>
          ))
        : null}
    </section>
  );
}

function OutsideNote({
  comment,
  busy,
  onOpen,
  onSend,
  onResolve,
  onSaveEdit,
  onDelete,
}: {
  comment: CommentView;
  busy: boolean;
  onOpen: () => void;
  onSend: () => void;
  onResolve: () => void;
  onSaveEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(comment.body);

  function save(): void {
    const body = editDraft.trim();
    if (!body || body === comment.body) {
      setEditing(false);
      return;
    }
    onSaveEdit(body);
    setEditing(false);
  }

  return (
    <div className={`outside-note ${comment.status === 'resolved' ? 'resolved' : ''}`}>
      <div className="comment-head">
        <span className={`comment-status ${comment.status}`}>{comment.status}</span>
        <span className="comment-anchor">
          {comment.filePath}:{formatRange(comment)}
        </span>
        <span className="outside-side">{comment.side}</span>
      </div>

      {comment.excerpt ? <pre className="outside-excerpt">{comment.excerpt}</pre> : null}

      {editing ? (
        <div className="comment-edit">
          <textarea
            autoFocus
            rows={3}
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') setEditing(false);
            }}
          />
          <div className="comment-actions">
            <button className="comment-action primary" onClick={save} disabled={busy}>
              Save
            </button>
            <button className="comment-action" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">{comment.body}</div>
      )}

      <div className="comment-actions">
        <button className="comment-action primary" onClick={onSend} disabled={busy}>
          <SendIcon size={11} />
          Send
        </button>
        <button className="comment-action" onClick={onOpen} disabled={busy}>
          Open
        </button>
        <button
          className="comment-action"
          onClick={() => {
            setEditDraft(comment.body);
            setEditing(true);
          }}
          disabled={busy}
        >
          Edit
        </button>
        <button className="comment-action" onClick={onResolve} disabled={busy}>
          <CheckIcon size={11} />
          {comment.status === 'resolved' ? 'Reopen' : 'Resolve'}
        </button>
        <button className="comment-action danger" onClick={onDelete} disabled={busy}>
          <TrashIcon size={11} />
          Delete
        </button>
      </div>
    </div>
  );
}

function buildRows(
  diff: GitDiff | null,
  comments: CommentView[],
  composer: ComposerState | null,
): DiffRow[] {
  if (!diff) return [];

  // Core already decided where each note belongs in this view; the panel only
  // draws the ones that matched a row or lost their text. Off-patch notes live
  // in their own area and never disappear.
  const byAnchor = new Map<string, ReviewComment[]>();
  const staleByFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.placement.kind === 'outside') continue;
    if (comment.placement.kind === 'stale') {
      const stale = staleByFile.get(comment.filePath);
      if (stale) stale.push(comment);
      else staleByFile.set(comment.filePath, [comment]);
      continue;
    }
    const key = anchorKey(comment.filePath, comment.side, comment.line);
    const list = byAnchor.get(key);
    if (list) list.push(comment);
    else byAnchor.set(key, [comment]);
  }

  const rows: DiffRow[] = [];
  diff.files.forEach((file, fileIndex) => {
    rows.push({ kind: 'file', key: `file:${fileIndex}`, file });

    // Comments whose anchor text disappeared are shown at the top of their
    // file, because there is no line left to attach them to.
    for (const comment of staleByFile.get(file.path) ?? []) {
      rows.push({ kind: 'comment', key: `stale:${comment.id}`, comment });
    }
    staleByFile.delete(file.path);

    if (file.hunks.length === 0) {
      rows.push({ kind: 'empty', key: `empty:${fileIndex}`, file });
      return;
    }

    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ kind: 'hunk', key: `hunk:${fileIndex}:${hunkIndex}`, hunk });

      hunk.lines.forEach((line, lineIndex) => {
        const side: CommentSide = line.type === 'del' ? 'old' : 'new';
        const anchor = side === 'old' ? line.oldLine : line.newLine;
        const lineComments =
          anchor === null ? [] : (byAnchor.get(anchorKey(file.path, side, anchor)) ?? []);

        rows.push({
          kind: 'line',
          key: `line:${fileIndex}:${hunkIndex}:${lineIndex}`,
          file,
          hunk,
          line,
          lineIndex,
          side,
          anchor,
          comments: lineComments,
        });

        for (const comment of lineComments) {
          rows.push({ kind: 'comment', key: `comment:${comment.id}`, comment });
        }

        if (
          composer &&
          composer.filePath === file.path &&
          composer.side === side &&
          composer.endLine === anchor
        ) {
          rows.push({
            kind: 'composer',
            key: `composer:${fileIndex}:${hunkIndex}:${lineIndex}`,
            composer,
          });
        }
      });
    });
  });

  // Outdated comments on files that are no longer in the diff still stay
  // visible, under a synthetic header.
  for (const [filePath, list] of staleByFile) {
    rows.push({ kind: 'stale-file', key: `stale-file:${filePath}`, filePath });
    for (const comment of list) {
      rows.push({ kind: 'comment', key: `stale:${comment.id}`, comment });
    }
  }

  return rows;
}

function anchorKey(filePath: string, side: CommentSide, line: number): string {
  return `${filePath}\u0000${side}\u0000${line}`;
}

function formatRange(value: { line: number; endLine: number }): string {
  return value.endLine > value.line ? `${value.line}-${value.endLine}` : `${value.line}`;
}

function estimateRowSize(row: DiffRow): number {
  switch (row.kind) {
    case 'file':
      return 36;
    case 'stale-file':
      return 36;
    case 'hunk':
      return 22;
    case 'empty':
      return 30;
    case 'line':
      return 18;
    case 'comment':
      return 96;
    case 'composer':
      return 128;
    default:
      return 24;
  }
}
