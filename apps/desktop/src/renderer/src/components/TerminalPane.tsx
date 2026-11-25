import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { HarnessProfile, NestClient, Session, Task } from '@nest/shared';
import { EmptyState } from '@nest/ui';
import { PlayIcon, TerminalIcon } from './Icons';
import { onSessionData } from '../state/terminalBus';
import { errorMessage } from '../utils';

const SEARCH_DECORATIONS = {
  matchBackground: '#2a3a55',
  matchBorder: '#3b5375',
  matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#7aa2f7',
  activeMatchBorder: '#e7ecf6',
  activeMatchColorOverviewRuler: '#e0af68',
} as const;

/**
 * Mounted xterm instances. A PTY keeps running regardless; evicted terminals
 * are disposed and replayed from scrollback when the tab is selected again.
 */
const MOUNT_LIMIT = 8;

interface TerminalPaneProps {
  client: NestClient;
  task: Task | null;
  sessions: Session[];
  selectedSessionId: string | null;
  unread: Record<string, number>;
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
  const [mounted, setMounted] = useState<string[]>([]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setMounted((prev) => {
      const next = [selectedSessionId, ...prev.filter((id) => id !== selectedSessionId)];
      return next.slice(0, MOUNT_LIMIT);
    });
  }, [selectedSessionId]);

  useEffect(() => {
    const existing = new Set(sessions.map((session) => session.id));
    setMounted((prev) => {
      const next = prev.filter((id) => existing.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [sessions]);

  const mountedSessions = sessions.filter((session) => mounted.includes(session.id));

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
              {props.unread[session.id] ? (
                <span className="unread-badge" title="Finished while you were away">
                  {props.unread[session.id]}
                </span>
              ) : null}
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
          <StartScreen harnesses={props.harnesses} busy={props.busy} onStart={props.onStart} />
        ) : null}

        {mountedSessions.map((session) => (
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
  const searchRef = useRef<SearchAddon | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const applyFitRef = useRef<() => void>(() => {});
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const warnedRef = useRef(false);
  const statusRef = useRef(session.status);
  statusRef.current = session.status;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [findResults, setFindResults] = useState({ index: -1, count: 0 });
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  const queryRef = useRef(query);
  queryRef.current = query;

  const runFind = (direction: 'next' | 'prev', value = queryRef.current): void => {
    const search = searchRef.current;
    if (!search) return;
    const term = value.trim();
    if (!term) {
      search.clearDecorations();
      setFindResults({ index: -1, count: 0 });
      return;
    }
    const options = {
      caseSensitive: false,
      incremental: direction === 'next',
      decorations: SEARCH_DECORATIONS,
    };
    if (direction === 'next') search.findNext(term, options);
    else search.findPrevious(term, options);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    searchRef.current?.clearDecorations();
    setFindResults({ index: -1, count: 0 });
    termRef.current?.focus();
  };

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
    if (queryRef.current.trim()) runFind('next');
    // Only react to opening the bar; typing is handled by the input itself.
  }, [findOpen]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      // SearchAddon highlights matches through the decorations API, which xterm
      // still exposes behind allowProposedApi. xterm is pinned, so the surface
      // cannot drift between releases.
      allowProposedApi: true,
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

    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const searchResults = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setFindResults({ index: resultIndex, count: resultCount });
    });

    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void client
          .invoke('app.openExternal', { url: uri })
          .catch((error) => onErrorRef.current(errorMessage(error)));
      }),
    );

    const copySelection = (): void => {
      const text = term.getSelection();
      if (!text) return;
      void client
        .invoke('clipboard.write', { text })
        .catch((error) => onErrorRef.current(`Copy: ${errorMessage(error)}`));
    };

    const pasteClipboard = (): void => {
      void client
        .invoke('clipboard.read', {})
        .then(({ text }) => {
          if (text) term.paste(text);
        })
        .catch((error) => onErrorRef.current(`Paste: ${errorMessage(error)}`));
    };

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && event.shiftKey && key === 'c') {
        copySelection();
        return false;
      }
      if (mod && event.shiftKey && key === 'v') {
        pasteClipboard();
        return false;
      }
      // Ctrl+C is SIGINT unless the user selected text first.
      if (mod && !event.shiftKey && key === 'c' && term.hasSelection()) {
        copySelection();
        return false;
      }
      if (mod && key === 'f') {
        setFindOpen(true);
        return false;
      }
      if (event.key === 'Escape' && findOpenRef.current) {
        setFindOpen(false);
        search.clearDecorations();
        setFindResults({ index: -1, count: 0 });
        term.focus();
        return false;
      }
      return true;
    });

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
      void client.invoke('sessions.resize', { sessionId: session.id, cols, rows }).catch(() => {});
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
      searchResults.dispose();
      offData();
      input.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
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
      {findOpen ? (
        <div className="terminal-find">
          <input
            ref={findInputRef}
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              setQuery(value);
              runFind('next', value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runFind(event.shiftKey ? 'prev' : 'next');
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
            placeholder="Find in terminal"
            aria-label="Find in terminal"
            spellCheck={false}
          />
          <span className="find-count">
            {findResults.count === 0
              ? '0/0'
              : `${findResults.index < 0 ? '…' : findResults.index + 1}/${findResults.count}`}
          </span>
          <button className="mini-btn" title="Previous match" onClick={() => runFind('prev')}>
            ↑
          </button>
          <button className="mini-btn" title="Next match" onClick={() => runFind('next')}>
            ↓
          </button>
          <button className="icon-btn" title="Close search" onClick={closeFind}>
            ×
          </button>
        </div>
      ) : null}
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
