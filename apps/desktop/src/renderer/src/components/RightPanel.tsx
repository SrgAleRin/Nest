import { useState } from 'react';
import type { NestClient, Session, Task } from '@nest/shared';
import { DiffPanel } from './DiffPanel';
import { GitPanel } from './GitPanel';
import { SessionsPanel } from './SessionsPanel';

export type RightTab = 'git' | 'diff' | 'sessions';

interface RightPanelProps {
  client: NestClient;
  task: Task | null;
  sessions: Session[];
  selectedSessionId: string | null;
  refreshKey: number;
  onGitChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onRestartSession: (session: Session) => void;
}

export function RightPanel(props: RightPanelProps) {
  const [tab, setTab] = useState<RightTab>('git');

  return (
    <aside className="right">
      <div className="right-tabs" role="tablist">
        {(
          [
            ['git', 'Git'],
            ['diff', 'Diff'],
            ['sessions', `Sessions${props.sessions.length ? ` ${props.sessions.length}` : ''}`],
          ] as Array<[RightTab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`right-tab ${tab === id ? 'selected' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="right-body">
        {tab === 'git' ? (
          <GitPanel
            client={props.client}
            task={props.task}
            refreshKey={props.refreshKey}
            onChanged={props.onGitChanged}
            onNotify={props.onNotify}
          />
        ) : null}

        {tab === 'diff' ? (
          <DiffPanel
            client={props.client}
            task={props.task}
            sessions={props.sessions}
            selectedSessionId={props.selectedSessionId}
            refreshKey={props.refreshKey}
            onNotify={props.onNotify}
          />
        ) : null}

        {tab === 'sessions' ? (
          <SessionsPanel
            sessions={props.sessions}
            selectedSessionId={props.selectedSessionId}
            onSelect={props.onSelectSession}
            onStop={props.onStopSession}
            onRestart={props.onRestartSession}
          />
        ) : null}
      </div>
    </aside>
  );
}
