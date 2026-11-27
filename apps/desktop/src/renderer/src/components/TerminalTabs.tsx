import { useEffect, useRef, useState } from 'react';
import type { HarnessProfile, Session } from '@nest/shared';
import { ChevronIcon, CloseIcon, PlusIcon, TerminalIcon } from './Icons';
import { hasOverflow, revealTab, scrollTabsBy } from '../tabScroll';
import type { CenterSurface, CenterTabId } from '../state/centerTabs';

/**
 * The one header strip of the center: the session tabs and the plus control on
 * the left, the tool tabs of the workbench on the right. It is a separate
 * component because neither half belongs to the terminals: the strip survives
 * a surface switch while the xterm layer only hides.
 */
export interface SessionTabStripProps {
  sessions: Session[];
  selectedSessionId: string | null;
  unread: Record<string, number>;
  onSelect: (sessionId: string) => void;
  onClose: (session: Session) => void;
}

export function SessionTabStrip({
  sessions,
  selectedSessionId,
  unread,
  onSelect,
  onClose,
}: SessionTabStripProps) {
  const tabListRef = useRef<HTMLDivElement>(null);

  // The strip hides its scrollbar, so a tab that overflows on the right (a
  // freshly opened one especially) would stay half cut off and its close
  // button unreachable. Keep the selected tab in view instead.
  useEffect(() => {
    const list = tabListRef.current;
    if (!list || !selectedSessionId) return;
    const tab = list.querySelector<HTMLElement>(
      `[data-session-id="${CSS.escape(selectedSessionId)}"]`,
    );
    if (!tab) return;
    // `offsetLeft` is measured from the offset parent, not the strip, so the
    // tab's content offset comes from the two client rects instead.
    const listRect = list.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const scrollLeft = revealTab(
      {
        scrollLeft: list.scrollLeft,
        scrollWidth: list.scrollWidth,
        clientWidth: list.clientWidth,
      },
      {
        left: tabRect.left - listRect.left + list.scrollLeft,
        width: tabRect.width,
      },
    );
    if (scrollLeft !== list.scrollLeft) list.scrollLeft = scrollLeft;
  }, [selectedSessionId, sessions]);

  return (
    <div
      className="terminal-tab-list"
      ref={tabListRef}
      // A vertical wheel is the only gesture most users try, and a horizontal
      // box ignores it; translate it instead of hiding the overflow behind an
      // invisible scrollbar.
      onWheel={(event) => {
        const list = event.currentTarget;
        const metrics = {
          scrollLeft: list.scrollLeft,
          scrollWidth: list.scrollWidth,
          clientWidth: list.clientWidth,
        };
        if (!hasOverflow(metrics)) return;
        const next = scrollTabsBy(metrics, event.deltaY || event.deltaX);
        if (next === list.scrollLeft) return;
        list.scrollLeft = next;
        event.preventDefault();
      }}
    >
      {sessions.map((session) => (
        <div
          key={session.id}
          role="tab"
          aria-selected={session.id === selectedSessionId}
          tabIndex={0}
          data-session-id={session.id}
          className={`terminal-tab ${session.id === selectedSessionId ? 'selected' : ''}`}
          onClick={() => onSelect(session.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(session.id);
            }
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onClose(session);
            }
          }}
          title={`${session.harnessId} · ${session.status}`}
        >
          <span className={`dot dot-${session.status}`} />
          <span className="terminal-tab-title">{session.title}</span>
          {unread[session.id] ? (
            <span className="unread-badge" title="Finished while you were away">
              {unread[session.id]}
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
              onClose(session);
            }}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
      {sessions.length === 0 ? <span className="terminal-tab-muted">no sessions</span> : null}
    </div>
  );
}

/** The plus button and its harness menu; it starts a session in the task. */
export function NewTabControl({
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

/** The tool tabs of the workbench: `Diff` and `Graph`, each with its own close. */
export interface CenterToolTabsProps {
  open: { diff: boolean; graph: boolean };
  active: CenterSurface;
  onSelect: (tab: CenterTabId) => void;
  onClose: (tab: CenterTabId) => void;
}

const TOOL_TABS: readonly { id: CenterTabId; label: string; title: string }[] = [
  { id: 'diff', label: 'Diff', title: 'The patch of this task in the center' },
  { id: 'graph', label: 'Graph', title: 'Every branch of this repository, read-only' },
];

export function CenterToolTabs({ open, active, onSelect, onClose }: CenterToolTabsProps) {
  const tabs = TOOL_TABS.filter((tab) => open[tab.id]);
  if (tabs.length === 0) return null;
  return (
    <div className="center-tool-tabs" role="tablist" aria-label="Center tools">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          tabIndex={0}
          aria-selected={active === tab.id}
          data-testid={`center-${tab.id}-tab`}
          data-tool={tab.id}
          className={`center-tool-tab ${active === tab.id ? 'selected' : ''}`}
          title={tab.title}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(tab.id);
            }
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onClose(tab.id);
            }
          }}
        >
          <span className="center-tool-tab-label">{tab.label}</span>
          <button
            type="button"
            className="center-tool-tab-close"
            aria-label={`Close ${tab.label}`}
            title={`Close ${tab.label} (Escape)`}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            <CloseIcon size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
