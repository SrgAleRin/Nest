import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import type {
  HarnessProfile,
  NestClient,
  Session,
  Task,
  TerminalPreferences,
  TerminalTheme,
} from '@nest/shared';
import { Button, EmptyState } from '@nest/ui';
import { ChevronIcon, CloseIcon, PlayIcon, PlusIcon, TerminalIcon } from './Icons';
import { onSessionData } from '../state/terminalBus';
import { errorMessage, resumeActionLabel, resumeShortLabel, resumeTone } from '../utils';

const SEARCH_DECORATIONS = {
  matchBackground: '#2a3a55',
  matchBorder: '#3b5375',
  matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#7aa2f7',
  activeMatchBorder: '#e7ecf6',
  activeMatchColorOverviewRuler: '#e0af68',
} as const;

export const TERMINAL_THEMES: Record<TerminalTheme, ITheme> = {
  nest: {
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
  solarized: {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#b58900',
    selectionBackground: 'rgba(147, 161, 161, 0.25)',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightWhite: '#fdf6e3',
  },
  paper: {
    background: '#fbfbfa',
    foreground: '#24292f',
    cursor: '#0969da',
    selectionBackground: 'rgba(9, 105, 218, 0.2)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightWhite: '#24292f',
  },
};

/**
 * Mounted xterm instances. A PTY keeps running regardless; evicted terminals
 * are disposed and replayed from scrollback when the tab is selected again.
 */
const MOUNT_LIMIT = 8;

interface TerminalPaneProps {
  client: NestClient;
  task: Task | null;
  /** Drives the first-run empty state instead of the generic "no task" one. */
  hasProjects: boolean;
  sessions: Session[];
  selectedSessionId: string | null;
  unread: Record<string, number>;
  harnesses: HarnessProfile[];
  /** Every known profile is switched off in Settings. */
  allHarnessesDisabled: boolean;
  /** Fonts, cursor and colours for the xterm instances. */
  terminal: TerminalPreferences;
  busy: boolean;
  onSelectSession: (sessionId: string) => void;
  onStart: (harnessId: string) => void;
  onCloseSession: (session: Session) => void;
  /** Harness started by the plus button without opening the picker, or `ask`. */
  newSessionDefault: string;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
  resumableHarnesses: ReadonlySet<string>;
  onError: (message: string) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onAddProject: () => void;
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
            <div
              key={session.id}
              role="tab"
              aria-selected={session.id === selectedSessionId}
              tabIndex={0}
              className={`terminal-tab ${session.id === selectedSessionId ? 'selected' : ''}`}
              onClick={() => props.onSelectSession(session.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  props.onSelectSession(session.id);
                }
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  props.onCloseSession(session);
                }
              }}
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
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={`Close ${session.title}`}
                title="Close tab (stops the session)"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCloseSession(session);
                }}
              >
                <CloseIcon size={10} />
              </button>
            </div>
          ))}
          {sessions.length === 0 ? <span className="terminal-tab-muted">no sessions</span> : null}
        </div>

        <div className="terminal-actions">
          <NewTabControl
            harnesses={props.harnesses}
            busy={props.busy}
            disabled={!task}
            defaultId={props.newSessionDefault}
            onStart={props.onStart}
            onOpenSettings={props.onOpenSettings}
          />
        </div>
      </div>

      <div className="terminal-body">
        {!task ? (
          <EmptyState title={props.hasProjects ? 'No task selected' : 'Add your first repository'}>
            {props.hasProjects ? (
              'Pick a project or task in the left column to open a workspace.'
            ) : (
              <>
                Nest creates isolated worktrees for every task.
                <br />
                <Button
                  variant="primary"
                  size="sm"
                  className="empty-state-action"
                  onClick={props.onAddProject}
                >
                  Add project
                </Button>
              </>
            )}
          </EmptyState>
        ) : null}

        {task && sessions.length === 0 ? (
          <StartScreen
            harnesses={props.harnesses}
            busy={props.busy}
            allDisabled={props.allHarnessesDisabled}
            onStart={props.onStart}
            onOpenSettings={props.onOpenSettings}
          />
        ) : null}

        {mountedSessions.map((session) => (
          <TerminalView
            key={session.id}
            client={props.client}
            session={session}
            terminal={props.terminal}
            active={session.id === activeSession?.id}
            canResume={props.resumableHarnesses.has(session.harnessId)}
            onResume={props.onResume}
            onNewSession={props.onNewSession}
            onError={props.onError}
            onOpenPalette={props.onOpenPalette}
          />
        ))}
      </div>
    </section>
  );
}

function NewTabControl({
  harnesses,
  busy,
  disabled,
  defaultId,
  onStart,
  onOpenSettings,
}: {
  harnesses: HarnessProfile[];
  busy: boolean;
  disabled: boolean;
  defaultId: string;
  onStart: (harnessId: string) => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Terminal first, agents after it; the registry order is kept otherwise.
  const ordered = [...harnesses].sort((left, right) => {
    if (left.id === 'shell') return -1;
    if (right.id === 'shell') return 1;
    return 0;
  });
  const terminal = ordered.find((harness) => harness.id === 'shell') ?? null;
  const agents = ordered.filter((harness) => harness.id !== 'shell');
  const defaultHarness = harnesses.find((harness) => harness.id === defaultId) ?? null;

  const start = (harnessId: string) => {
    setOpen(false);
    onStart(harnessId);
  };

  const startDefault = () => {
    if (defaultId !== 'ask' && defaultHarness?.available) start(defaultHarness.id);
    else setOpen((current) => !current);
  };

  const renderItem = (harness: HarnessProfile) => (
    <button
      key={harness.id}
      type="button"
      role="menuitem"
      className="new-tab-item"
      data-harness-id={harness.id}
      disabled={busy || !harness.available}
      onClick={() => start(harness.id)}
      title={harness.available ? harness.description : `${harness.command} was not found on PATH`}
    >
      <span className="new-tab-item-icon">
        <TerminalIcon size={13} />
      </span>
      <span className="new-tab-item-text">
        <strong>{harness.label}</strong>
        <em>{harness.available ? harness.description : 'Not found on PATH'}</em>
      </span>
      {!harness.available ? <span className="new-tab-item-badge">not found</span> : null}
    </button>
  );

  return (
    <div className="terminal-new" ref={rootRef}>
      <button
        type="button"
        className="terminal-new-main"
        disabled={disabled || busy}
        onClick={startDefault}
        title={
          defaultId === 'ask'
            ? 'New tab'
            : `New ${defaultHarness?.label ?? 'session'} (right arrow for other profiles)`
        }
        aria-label="New tab"
      >
        <PlusIcon size={14} />
      </button>
      <button
        type="button"
        className="terminal-new-caret"
        disabled={disabled || busy}
        onClick={() => setOpen((current) => !current)}
        title="Choose what to open"
        aria-label="Choose what to open"
        aria-expanded={open}
      >
        <ChevronIcon size={10} />
      </button>

      {open ? (
        <div className="new-tab-menu" role="menu" aria-label="New tab">
          <div className="new-tab-heading">Terminal</div>
          {terminal ? renderItem(terminal) : null}
          <div className="new-tab-heading">Agents</div>
          {agents.length > 0 ? (
            agents.map(renderItem)
          ) : (
            <div className="new-tab-empty">No agent profiles are enabled.</div>
          )}
          <div className="new-tab-foot">
            <span>
              Default:{' '}
              {defaultId === 'ask' ? 'ask every time' : (defaultHarness?.label ?? defaultId)}
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Change
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StartScreen({
  harnesses,
  busy,
  allDisabled,
  onStart,
  onOpenSettings,
}: {
  harnesses: HarnessProfile[];
  busy: boolean;
  allDisabled: boolean;
  onStart: (harnessId: string) => void;
  onOpenSettings: () => void;
}) {
  const available = harnesses
    .filter((harness) => harness.available)
    .sort((left, right) => {
      if (left.id === 'shell') return -1;
      if (right.id === 'shell') return 1;
      return 0;
    });
  return (
    <div className="start-screen">
      <div className="start-icon">
        <TerminalIcon size={22} />
      </div>
      <h2>Start an agent or a terminal</h2>
      <p>
        A session runs inside this task workspace and dies with the app. Scrollback and metadata are
        stored locally. Use the plus button above to open more tabs at any time.
      </p>
      <div className="start-grid">
        {available.length === 0 ? (
          <div className="start-hint">
            {allDisabled ? (
              <>
                Every harness profile is disabled. Turn one on in{' '}
                <button className="link-btn" onClick={onOpenSettings}>
                  Settings
                </button>
                .
              </>
            ) : (
              <>
                No harness commands found on PATH. Install Claude Code, Codex, Qwen Code or
                OpenCode, or add a custom command in Settings.
              </>
            )}
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
  terminal,
  active,
  canResume,
  onError,
  onResume,
  onNewSession,
  onOpenPalette,
}: {
  client: NestClient;
  session: Session;
  terminal: TerminalPreferences;
  active: boolean;
  canResume: boolean;
  onError: (message: string) => void;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
  onOpenPalette: () => void;
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
  const onOpenPaletteRef = useRef(onOpenPalette);
  onOpenPaletteRef.current = onOpenPalette;

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
      cursorBlink: terminal.cursorBlink,
      cursorStyle: terminal.cursorStyle,
      fontFamily: terminal.fontFamily,
      fontSize: terminal.fontSize,
      lineHeight: terminal.lineHeight,
      scrollback: terminal.scrollback,
      // SearchAddon highlights matches through the decorations API, which xterm
      // still exposes behind allowProposedApi. xterm is pinned, so the surface
      // cannot drift between releases.
      allowProposedApi: true,
      theme: TERMINAL_THEMES[terminal.theme],
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
      if (mod && event.shiftKey && key === 'p') {
        onOpenPaletteRef.current();
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

  // Settings save updates an already-open terminal without remounting it.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = terminal.fontFamily;
    term.options.fontSize = terminal.fontSize;
    term.options.lineHeight = terminal.lineHeight;
    term.options.scrollback = terminal.scrollback;
    term.options.cursorStyle = terminal.cursorStyle;
    term.options.cursorBlink = terminal.cursorBlink;
    term.options.theme = TERMINAL_THEMES[terminal.theme];
    applyFitRef.current();
  }, [terminal]);

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
              {resumeShortLabel(session)}
            </span>
          ) : null}
          {canResume ? (
            <button className="mini-btn primary" onClick={() => onResume(session)}>
              {resumeActionLabel(session)}
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
