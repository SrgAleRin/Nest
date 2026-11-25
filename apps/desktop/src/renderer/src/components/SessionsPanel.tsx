import type { Session } from '@nest/shared';
import { EmptyState } from '@nest/ui';
import { StopIcon, TerminalIcon } from './Icons';
import { relativeTime } from '../utils';

interface SessionsPanelProps {
  sessions: Session[];
  selectedSessionId: string | null;
  resumableHarnesses: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
}

export function SessionsPanel({
  sessions,
  selectedSessionId,
  resumableHarnesses,
  onSelect,
  onStop,
  onResume,
  onNewSession,
}: SessionsPanelProps) {
  if (sessions.length === 0) {
    return (
      <EmptyState title="No sessions yet">
        Start a harness from the terminal toolbar. Sessions are killed when the app exits.
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
              <span className={`session-status status-${session.status}`}>{session.status}</span>
            </div>
            <div className="session-card-meta">
              <span>{session.harnessId}</span>
              <span>{session.cwd}</span>
              <span>updated {relativeTime(session.updatedAt)}</span>
              {session.exitCode !== null ? <span>exit {session.exitCode}</span> : null}
              {!live ? (
                <span
                  className={`resume-mode ${session.harnessSessionId ? 'exact' : 'latest'}`}
                  title={session.harnessSessionId ?? undefined}
                >
                  resume {session.harnessSessionId ? 'exact' : 'latest'}
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
                      {session.resumeMode === 'exact' && session.harnessSessionId
                        ? 'Resume exact'
                        : 'Resume latest'}
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
