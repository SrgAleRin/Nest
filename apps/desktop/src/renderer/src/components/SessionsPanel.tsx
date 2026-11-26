import type { Session } from '@nest/shared';
import { EmptyState } from '@nest/ui';
import { StopIcon, TerminalIcon } from './Icons';
import { relativeTime, resumeActionLabel, resumeShortLabel, resumeTone } from '../utils';

interface SessionsPanelProps {
  sessions: Session[];
  hasTask: boolean;
  selectedSessionId: string | null;
  unread: Record<string, number>;
  resumableHarnesses: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
}

export function SessionsPanel({
  sessions,
  hasTask,
  selectedSessionId,
  unread,
  resumableHarnesses,
  onSelect,
  onStop,
  onResume,
  onNewSession,
}: SessionsPanelProps) {
  if (!hasTask) {
    return (
      <EmptyState title="No workspace selected">
        Select a task to see the sessions running in it.
      </EmptyState>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState title="No sessions yet">
        Start a session with the plus button above the terminal. Sessions are killed when the app
        exits.
      </EmptyState>
    );
  }

  return (
    <div className="panel-scroll sessions-panel">
      {sessions.map((session) => {
        const live = session.status === 'running' || session.status === 'idle';
        return (
          <div
            className={`session-card ${session.id === selectedSessionId ? 'selected' : ''}`}
            key={session.id}
          >
            <div className="session-card-head">
              <span className={`dot dot-${session.status}`} />
              <TerminalIcon size={12} />
              <span className="session-card-title">{session.title}</span>
              {unread[session.id] ? (
                <span className="unread-badge" title="Finished while you were away">
                  {unread[session.id]}
                </span>
              ) : null}
              <span className={`session-status status-${session.status}`}>{session.status}</span>
            </div>
            <div className="session-card-meta">
              <span>{session.harnessId}</span>
              <span>{session.cwd}</span>
              <span>updated {relativeTime(session.updatedAt)}</span>
              {session.exitCode !== null ? <span>exit {session.exitCode}</span> : null}
              {!live ? (
                <span
                  className={`resume-mode ${resumeTone(session)}`}
                  title={
                    session.harnessSessionId
                      ? `continues ${session.harnessSessionId}${
                          resumeTone(session) === 'heuristic'
                            ? ' (unverified: not resumed automatically)'
                            : ''
                        }`
                      : 'continues the latest conversation in this workspace'
                  }
                >
                  resume {resumeShortLabel(session)}
                </span>
              ) : null}
              {!live && session.harnessSessionId ? (
                <span className="session-harness-id">{session.harnessSessionId.slice(0, 8)}</span>
              ) : null}
            </div>
            <div className="session-card-actions">
              <button className="mini-btn" onClick={() => onSelect(session.id)}>
                Open
              </button>
              {live ? (
                <button className="mini-btn danger" onClick={() => onStop(session.id)}>
                  <StopIcon size={11} />
                  Stop
                </button>
              ) : (
                <>
                  {resumableHarnesses.has(session.harnessId) ? (
                    <button className="mini-btn primary" onClick={() => onResume(session)}>
                      {resumeActionLabel(session)}
                    </button>
                  ) : null}
                  <button className="mini-btn" onClick={() => onNewSession(session)}>
                    New session
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
