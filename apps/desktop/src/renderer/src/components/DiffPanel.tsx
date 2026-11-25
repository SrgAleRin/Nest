import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  CommentSide,
  DiffFile,
  DiffHunk,
  DiffLine,
  GitDiff,
  NestClient,
  ReviewComment,
  Session,
  Task,
} from '@nest/shared';
import { Button, EmptyState, ErrorState } from '@nest/ui';
import { CheckIcon, SendIcon, TrashIcon } from './Icons';
import { DiffPanelSkeleton } from './PanelSkeletons';
import { panelPhase } from '../panelState';
import { errorMessage } from '../utils';
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
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface ComposerState {
  filePath: string;
  /** First line of the range; equals endLine for a single-line comment. */
  line: number;
  endLine: number;
  side: CommentSide;
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
  onNotify,
}: DiffPanelProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [highlights, setHighlights] = useState<Map<DiffHunk, HunkHighlight>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(() => {
    const running = sessions.filter(
      (session) => session.status === 'running' || session.status === 'idle',
    );
    return running.find((session) => session.id === selectedSessionId) ?? running[0] ?? null;
  }, [sessions, selectedSessionId]);

  const load = useCallback(async () => {
    if (!task) {
      setDiff(null);
      setComments([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextDiff, nextComments] = await Promise.all([
        client.invoke('git.diff', { taskId: task.id }),
        client.invoke('comments.list', { taskId: task.id }),
      ]);
      setDiff(nextDiff);
      setComments(nextComments);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, task]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

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
      return { filePath: file.path, line: number, endLine: number, side };
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
      });
      setComments((prev) => [...prev, comment]);
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
      setComments((prev) => prev.map((item) => (item.id === next.id ? next : item)));
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
      setComments((prev) => prev.filter((item) => item.id !== comment.id));
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendComment(comment: ReviewComment): Promise<void> {
    if (!activeSession) return;
    setBusy(true);
    try {
      const result = await client.invoke('comments.send', {
        commentId: comment.id,
        sessionId: activeSession.id,
      });
      if (result.sent) {
        onNotify('info', `Comment sent to ${activeSession.title}`);
      } else {
        onNotify(
          'warn',
          result.reason === 'no_active_session'
            ? 'No running session for this task'
            : `Not sent: ${result.reason ?? 'unknown reason'}`,
        );
      }
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function renderRow(row: DiffRow) {
    switch (row.kind) {
      case 'file':
        return <DiffFileHeader file={row.file} />;
      case 'empty':
        return <div className="diff-empty">Binary file or no textual hunks</div>;
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
            onSend={() => void sendComment(row.comment)}
            onResolve={() =>
              void updateComment(row.comment, {
                status: row.comment.status === 'resolved' ? 'open' : 'resolved',
              })
            }
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
          count={diff?.files.length ?? null}
          loading={loading}
          onRefresh={() => void load()}
        />
        <ErrorState title="Diff unavailable" onRetry={() => void load()}>
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
      <DiffHead count={diff.files.length} loading={loading} onRefresh={() => void load()} />

      <div className="diff-body">
        <div className="diff-scroll" ref={scrollRef}>
          {diff.files.length === 0 ? <div className="panel-empty">No changes to review</div> : null}

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

        {stickyFile ? <DiffFileHeader file={stickyFile} sticky /> : null}
      </div>
    </div>
  );
}

function DiffHead({
  count,
  loading,
  onRefresh,
}: {
  count: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="diff-head">
      <span className="section-label">
        Diff
        {count !== null ? ` · ${count} file${count === 1 ? '' : 's'}` : ''}
      </span>
      <button className="mini-btn" onClick={onRefresh} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  );
}

function DiffFileHeader({ file, sticky = false }: { file: DiffFile; sticky?: boolean }) {
  return (
    <header className={`diff-file-head ${sticky ? 'diff-file-head-sticky' : ''}`}>
      <span className={`git-letter ${diffTone(file)}`}>{diffLetter(file)}</span>
      <span className="diff-path" title={file.path}>
        {file.path}
      </span>
      <span className="diff-stat">
        <em>+{file.additions}</em> <del>-{file.deletions}</del>
      </span>
    </header>
  );
}

function CommentThread({
  comment,
  activeSession,
  busy,
  onSend,
  onResolve,
  onDelete,
}: {
  comment: ReviewComment;
  activeSession: Session | null;
  busy: boolean;
  onSend: () => void;
  onResolve: () => void;
  onDelete: () => void;
}) {
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
      <div className="comment-body">{comment.body}</div>
      <div className="comment-actions">
        <button
          className="comment-action primary"
          onClick={onSend}
          disabled={busy || !activeSession}
          title={activeSession ? `Send to ${activeSession.title}` : 'No running session'}
        >
          <SendIcon size={11} />
          {activeSession ? `Send to ${activeSession.title}` : 'No session'}
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
  comments: ReviewComment[],
  composer: ComposerState | null,
): DiffRow[] {
  if (!diff) return [];

  const byAnchor = new Map<string, ReviewComment[]>();
  const staleByFile = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.stale) {
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

function diffLetter(file: DiffFile): string {
  switch (file.status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return 'M';
  }
}

function diffTone(file: DiffFile): string {
  switch (file.status) {
    case 'added':
      return 'tone-added';
    case 'deleted':
      return 'tone-deleted';
    case 'renamed':
      return 'tone-renamed';
    default:
      return 'tone-modified';
  }
}
