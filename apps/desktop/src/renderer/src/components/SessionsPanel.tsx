import type { Session } from '@nest/shared';
import { EmptyState } from '@nest/ui';
import { StopIcon, TerminalIcon } from './Icons';
import { relativeTime } from '../utils';

interface SessionsPanelProps {
  sessions: Session[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
}

export function SessionsPanel({
  sessions,
  selectedSessionId,
  onSelect,
  onStop,
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
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
