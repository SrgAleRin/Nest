import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { HarnessProfile, NestClient, Session, Task } from '@nest/shared';
import { EmptyState } from '@nest/ui';
import { PlayIcon, TerminalIcon } from './Icons';
import { onSessionData } from '../state/terminalBus';
import { errorMessage } from '../utils';

interface TerminalPaneProps {
  client: NestClient;
  task: Task | null;
  sessions: Session[];
  selectedSessionId: string | null;
  harnesses: HarnessProfile[];
  busy: boolean;
  onSelectSession: (sessionId: string) => void;
  onStart: (harnessId: string) => void;
  onError: (message: string) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  const { task, sessions, selectedSessionId } = props;
  const activeSession = sessions.find((session) => session.id === selectedSessionId) ?? null;

  return (
    <section className="center">
      <div className="terminal-tabs">
        <div className="terminal-tab-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`terminal-tab ${session.id === selectedSessionId ? 'selected' : ''}`}
              onClick={() => props.onSelectSession(session.id)}
              title={`${session.harnessId} · ${session.status}`}
            >
              <span className={`dot dot-${session.status}`} />
              <span className="terminal-tab-title">{session.title}</span>
              {session.status === 'failed' ? <span className="tab-exit">!</span> : null}
            </button>
          ))}
          {sessions.length === 0 ? <span className="terminal-tab-muted">no sessions</span> : null}
        </div>

        <div className="terminal-actions">
          <select
            className="select"
            value=""
            disabled={!task || props.busy}
            onChange={(event) => {
              const value = event.target.value;
              if (value) props.onStart(value);
            }}
          >
            <option value="">{props.busy ? 'Starting…' : 'Start harness…'}</option>
            {props.harnesses.map((harness) => (
              <option key={harness.id} value={harness.id} disabled={!harness.available}>
                {harness.label}
                {harness.available ? '' : ' (not found)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="terminal-body">
        {!task ? (
          <EmptyState title="No task selected">
            Pick a project or task in the left column to open a workspace.
          </EmptyState>
        ) : null}

        {task && sessions.length === 0 ? (
          <StartScreen
            harnesses={props.harnesses}
            busy={props.busy}
            onStart={props.onStart}
          />
        ) : null}

        {sessions.map((session) => (
          <TerminalView
            key={session.id}
            client={props.client}
            session={session}
            active={session.id === activeSession?.id}
            onError={props.onError}
          />
        ))}
      </div>
    </section>
  );
}

function StartScreen({
  harnesses,
  busy,
  onStart,
}: {
  harnesses: HarnessProfile[];
  busy: boolean;
  onStart: (harnessId: string) => void;
}) {
  const available = harnesses.filter((harness) => harness.available);
  return (
    <div className="start-screen">
      <div className="start-icon">
        <TerminalIcon size={22} />
      </div>
      <h2>Start a harness</h2>
      <p>
        The session runs inside this task workspace and dies with the app. Scrollback and metadata
        are stored locally.
      </p>
      <div className="start-grid">
        {available.length === 0 ? (
          <div className="start-hint">
            No harness commands found on PATH. Install Claude Code, Codex or OpenCode, or use the
            built-in Fake harness in development.
          </div>
        ) : null}
        {available.map((harness) => (
          <button
            key={harness.id}
            className="start-card"
            disabled={busy}
            onClick={() => onStart(harness.id)}
          >
            <PlayIcon size={12} />
            <span>{harness.label}</span>
            <em>{harness.description}</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function TerminalView({
  client,
  session,
  active,
  onError,
}: {
  client: NestClient;
  session: Session;
  active: boolean;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const statusRef = useRef(session.status);
  statusRef.current = session.status;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      allowProposedApi: false,
      theme: {
        background: '#080a0e',
        foreground: '#e7ecf6',
        cursor: '#7aa2f7',
        selectionBackground: 'rgba(122, 162, 247, 0.25)',
        black: '#1b2230',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#c3cbd9',
        brightBlack: '#5d6676',
        brightWhite: '#e7ecf6',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const offData = onSessionData(session.id, (data) => term.write(data));
    const input = term.onData((data) => {
      if (statusRef.current === 'exited' || statusRef.current === 'failed') return;
      void client
        .invoke('sessions.write', { sessionId: session.id, data })
        .catch((error) => onError(`Terminal input: ${errorMessage(error)}`));
    });

    void client
      .invoke('sessions.scrollback', { sessionId: session.id })
      .then(({ data }) => {
        if (data) term.write(data);
      })
      .catch((error) => onError(errorMessage(error)));

    const fitAndResize = () => {
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          void client
            .invoke('sessions.resize', {
              sessionId: session.id,
              cols: term.cols,
              rows: term.rows,
            })
            .catch(() => {});
        }
      } catch {
        // element is hidden or not measured yet
      }
    };

    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(host);
    const frame = requestAnimationFrame(fitAndResize);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      offData();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [client, session.id, onError]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      term.focus();
      if (term.cols > 0 && term.rows > 0) {
        void client
          .invoke('sessions.resize', { sessionId: session.id, cols: term.cols, rows: term.rows })
          .catch(() => {});
      }
    } catch {
      // ignore measurement races
    }
  }, [active, client, session.id]);

  return (
    <div className={`terminal-view ${active ? 'active' : ''}`}>
      <div className="terminal-host" ref={hostRef} />
      {session.status === 'exited' || session.status === 'failed' ? (
        <div className="terminal-exit">
          session {session.status}
          {session.exitCode === null ? '' : ` · exit ${session.exitCode}`}
        </div>
      ) : null}
    </div>
  );
}
