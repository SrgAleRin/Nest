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
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
  resumableHarnesses: ReadonlySet<string>;
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
            canResume={props.resumableHarnesses.has(session.harnessId)}
            onResume={props.onResume}
            onNewSession={props.onNewSession}
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

function resumeLabel(session: Session): string {
  return session.resumeMode === 'exact' && session.harnessSessionId
    ? 'Resume exact'
    : 'Resume latest';
}

function TerminalView({
  client,
  session,
  active,
  canResume,
  onError,
  onResume,
  onNewSession,
}: {
  client: NestClient;
  session: Session;
  active: boolean;
  canResume: boolean;
  onError: (message: string) => void;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const applyFitRef = useRef<() => void>(() => {});
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const warnedRef = useRef(false);
  const statusRef = useRef(session.status);
  statusRef.current = session.status;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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
      if (statusRef.current === 'exited' || statusRef.current === 'failed') {
        if (!warnedRef.current) {
          warnedRef.current = true;
          onErrorRef.current(
            canResume
              ? 'This session is paused. Press Resume to continue it in this tab.'
              : 'This session ended when Nest closed. Scrollback is read-only — start a new session.',
          );
        }
        return;
      }
      void client
        .invoke('sessions.write', { sessionId: session.id, data })
        .catch((error) => onErrorRef.current(`Terminal input: ${errorMessage(error)}`));
    });

    void client
      .invoke('sessions.scrollback', { sessionId: session.id })
      .then(({ data }) => {
        if (data) term.write(data);
      })
      .catch((error) => onErrorRef.current(errorMessage(error)));

    const sendResize = (cols: number, rows: number) => {
      if (cols <= 0 || rows <= 0) return;
      const last = lastSizeRef.current;
      if (last?.cols === cols && last.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      void client
        .invoke('sessions.resize', { sessionId: session.id, cols, rows })
        .catch(() => {});
    };

    const applyFit = () => {
      try {
        fit.fit();
        sendResize(term.cols, term.rows);
      } catch {
        // element is hidden or not measured yet
      }
    };
    applyFitRef.current = applyFit;

    let frame = 0;
    const scheduleFit = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        applyFit();
      });
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    const initialFrame = requestAnimationFrame(applyFit);

    return () => {
      cancelAnimationFrame(initialFrame);
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      offData();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      applyFitRef.current = () => {};
      lastSizeRef.current = null;
    };
  }, [client, session.id]);

  useEffect(() => {
    if (!active) return;
    termRef.current?.focus();
    applyFitRef.current();
  }, [active]);

  const previousStatusRef = useRef(session.status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = session.status;
    if (
      (previous === 'exited' || previous === 'failed') &&
      (session.status === 'starting' || session.status === 'running')
    ) {
      lastSizeRef.current = null;
      termRef.current?.focus();
      applyFitRef.current();
    }
  }, [session.status]);

  return (
    <div className={`terminal-view ${active ? 'active' : ''}`}>
      <div className="terminal-host" ref={hostRef} />
      {session.status === 'exited' || session.status === 'failed' ? (
        <div className={`terminal-exit ${session.status}`}>
          <span>
            session {session.status}
            {session.exitCode === null ? '' : ` · exit ${session.exitCode}`}
          </span>
          {canResume ? (
            <span
              className={`resume-mode ${session.harnessSessionId ? 'exact' : 'latest'}`}
              title={
                session.harnessSessionId
                  ? `continues ${session.harnessSessionId}`
                  : 'continues the latest conversation in this workspace'
              }
            >
              {session.harnessSessionId ? 'exact' : 'latest'}
            </span>
          ) : null}
          {canResume ? (
            <button className="mini-btn primary" onClick={() => onResume(session)}>
              {resumeLabel(session)}
            </button>
          ) : null}
          <button className="mini-btn" onClick={() => onNewSession(session)}>
            New session
          </button>
        </div>
      ) : null}
    </div>
  );
}
