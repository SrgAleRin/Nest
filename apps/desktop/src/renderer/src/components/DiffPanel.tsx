import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CommentSide,
  DiffFile,
  DiffLine,
  GitDiff,
  NestClient,
  ReviewComment,
  Session,
  Task,
} from '@nest/shared';
import { Button, EmptyState, Spinner } from '@nest/ui';
import { CheckIcon, SendIcon, TrashIcon } from './Icons';
import { errorMessage } from '../utils';

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
  line: number;
  side: CommentSide;
}

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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [draft, setDraft] = useState('');

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
      return;
    }
    setLoading(true);
    try {
      const [nextDiff, nextComments] = await Promise.all([
        client.invoke('git.diff', { taskId: task.id }),
        client.invoke('comments.list', { taskId: task.id }),
      ]);
      setDiff(nextDiff);
      setComments(nextComments);
    } catch (error) {
      onNotify('error', errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [client, task, onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  function openComposer(file: DiffFile, line: DiffLine): void {
    const side: CommentSide = line.type === 'del' ? 'old' : 'new';
    const number = side === 'old' ? line.oldLine : line.newLine;
    if (!number) return;
    setComposer({ filePath: file.path, line: number, side });
    setDraft('');
  }

  async function addComment(): Promise<void> {
    if (!task || !composer || !draft.trim()) return;
    setBusy(true);
    try {
      const comment = await client.invoke('comments.create', {
        taskId: task.id,
        filePath: composer.filePath,
        line: composer.line,
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

  if (!task) {
    return <EmptyState title="No workspace selected">Select a task to review its diff.</EmptyState>;
  }

  return (
    <div className="panel-scroll diff-panel">
      <div className="diff-head">
        <span className="section-label">
          Diff {diff ? `· ${diff.files.length} file${diff.files.length === 1 ? '' : 's'}` : ''}
        </span>
        <button className="mini-btn" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {loading && !diff ? (
        <div className="panel-loading">
          <Spinner /> Loading diff
        </div>
      ) : null}

      {diff && diff.files.length === 0 ? (
        <div className="panel-empty">No changes to review</div>
      ) : null}

      {diff?.files.map((file) => (
        <section className="diff-file" key={`${file.path}-${file.staged}`}>
          <header className="diff-file-head">
            <span className={`git-letter ${diffTone(file)}`}>{diffLetter(file)}</span>
            <span className="diff-path" title={file.path}>
              {file.path}
            </span>
            <span className="diff-stat">
              <em>+{file.additions}</em> <del>-{file.deletions}</del>
            </span>
          </header>

          {file.hunks.length === 0 ? (
            <div className="diff-empty">Binary file or no textual hunks</div>
          ) : null}

          {file.hunks.map((hunk, hunkIndex) => (
            <div className="diff-hunk" key={`${file.path}-${hunkIndex}`}>
              <div className="diff-hunk-head">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => {
                const side: CommentSide = line.type === 'del' ? 'old' : 'new';
                const anchor = side === 'old' ? line.oldLine : line.newLine;
                const lineComments =
                  anchor === null
                    ? []
                    : comments.filter(
                        (comment) =>
                          comment.filePath === file.path &&
                          comment.side === side &&
                          comment.line === anchor,
                      );
                const composerHere =
                  composer !== null &&
                  composer.filePath === file.path &&
                  composer.side === side &&
                  composer.line === anchor;

                return (
                  <Fragment key={`${file.path}-${hunkIndex}-${lineIndex}`}>
                    <div className={`diff-line diff-${line.type}`}>
                      <span className="diff-num old">{line.oldLine ?? ''}</span>
                      <span className="diff-num new">{line.newLine ?? ''}</span>
                      <span className="diff-sign">
                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                      </span>
                      <span className="diff-text">{line.text || ' '}</span>
                      {anchor !== null ? (
                        <button
                          className="diff-comment-btn"
                          title={`Comment on ${side} line ${anchor}`}
                          onClick={() => openComposer(file, line)}
                        >
                          +
                        </button>
                      ) : null}
                    </div>

                    {lineComments.map((comment) => (
                      <CommentThread
                        key={comment.id}
                        comment={comment}
                        activeSession={activeSession}
                        busy={busy}
                        onSend={() => void sendComment(comment)}
                        onResolve={() =>
                          void updateComment(comment, {
                            status: comment.status === 'resolved' ? 'open' : 'resolved',
                          })
                        }
                        onDelete={() => void removeComment(comment)}
                      />
                    ))}

                    {composerHere ? (
                      <div className="comment-composer">
                        <div className="comment-composer-head">
                          {file.path}:{composer.line}{' '}
                          <span className="muted">({composer.side} line)</span>
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
                    ) : null}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </div>
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
          {comment.filePath}:{comment.line}
        </span>
      </div>
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
