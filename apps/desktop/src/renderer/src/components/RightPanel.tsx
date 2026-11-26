import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { NestClient, Session, Task } from '@nest/shared';
import { ComparePanel } from './ComparePanel';
import { DiffPanel } from './DiffPanel';
import { FilesPanel } from './FilesPanel';
import { HistoryPanel } from './HistoryPanel';
import { SessionsPanel } from './SessionsPanel';
import { SourceControlPanel } from './SourceControlPanel';
import { ChevronIcon, FolderIcon, SourceControlIcon, TerminalIcon } from './Icons';
import type { GitSelection } from '../state/gitSnapshot';
import { useGitTaskMemory } from '../state/GitSnapshotProvider';
import {
  RIGHT_PANEL_MIN_WIDTH,
  rightPanelMaxWidth,
  rightPanelWidthForKey,
  rightPanelWidthFromPointer,
} from '../rightPanelLayout';

/** Everything the right column can show; only three of them are top-level. */
export type RightTab = 'files' | 'source-control' | 'sessions' | 'history' | 'compare' | 'diff';

export type RightSectionId = 'files' | 'source-control' | 'sessions';

export interface RightSection {
  id: RightSectionId;
  label: string;
  /** Tooltip of the tab button. */
  title: string;
}

/** The three top-level sections. `History`, `Compare` and `Diff` are views. */
export const RIGHT_SECTIONS: readonly RightSection[] = [
  { id: 'files', label: 'Files', title: 'Files of this workspace (read-only preview)' },
  {
    id: 'source-control',
    label: 'Source Control',
    title: 'Changes, staging, commits and the remote actions of this workspace',
  },
  { id: 'sessions', label: 'Sessions', title: 'Sessions running in this workspace' },
];

/** The section a tab belongs to; a sub-view keeps its owner selected. */
export function rightSectionOf(tab: RightTab): RightSectionId {
  if (tab === 'files') return 'files';
  if (tab === 'sessions') return 'sessions';
  return 'source-control';
}

const SUBVIEW_TITLES: Readonly<Record<'history' | 'compare' | 'diff', string>> = {
  history: 'History',
  compare: 'Compare',
  diff: 'Diff',
};

export interface RightPanelProps {
  client: NestClient;
  task: Task | null;
  sessions: Session[];
  selectedSessionId: string | null;
  unread: Record<string, number>;
  tab: RightTab;
  onTabChange: (tab: RightTab) => void;
  refreshKey: number;
  onGitChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  onSelectSession: (sessionId: string) => void;
  onStopSession: (sessionId: string) => void;
  onResumeSession: (session: Session) => void;
  onNewSession: (session: Session) => void;
  resumableHarnesses: ReadonlySet<string>;
  /** Unique changed paths of this task, for the section badge and the rail. */
  changeCount: number;
  // Layout: the width and the collapsed state are local UI preferences.
  open: boolean;
  drawer: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpenPanel: () => void;
  onWiden: () => void;
}

export function RightPanel(props: RightPanelProps) {
  const tab = props.tab;
  const setTab = props.onTabChange;
  const taskId = props.task?.id ?? null;
  const subview = tab === 'history' || tab === 'compare' || tab === 'diff' ? tab : null;
  const memory = useGitTaskMemory(taskId);
  const [restoreFocus, setRestoreFocus] = useState<GitSelection | null>(null);
  const railButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(props.open);

  // The target is tagged with the task it belongs to: a commit hash from
  // another workspace must never be requested against the current one.
  const [commitTarget, setCommitTarget] = useState<{ taskId: string; hash: string } | null>(null);
  const commitHash = commitTarget && commitTarget.taskId === taskId ? commitTarget.hash : null;

  const openCommit = useCallback(
    (hash: string) => {
      if (!taskId) return;
      setCommitTarget({ taskId, hash });
      setTab('history');
    },
    [setTab, taskId],
  );

  const { onWiden } = props;

  /** `Open diff`: the selection is already in the task memory. */
  const openDiff = useCallback(() => {
    // Widening also opens the panel, and the drawer in a narrow window.
    onWiden();
    setTab('diff');
  }, [onWiden, setTab]);

  /**
   * Back from a patch: the list comes back with the row that was open still
   * selected and focused, so `Open diff` keeps its target without a second
   * click. Dropping the selection stays an explicit action of the list itself.
   */
  const backToList = useCallback(() => {
    setRestoreFocus(memory.selection);
    setTab('source-control');
  }, [memory.selection, setTab]);

  // Closing the panel puts the focus back on the rail button that opens it
  // again; the terminal is untouched, because only the layout changed.
  useEffect(() => {
    if (wasOpen.current && !props.open) railButtonRef.current?.focus();
    wasOpen.current = props.open;
  }, [props.open]);

  // A drawer is dismissed with Escape, the way every overlay is — except where
  // the section already owns that key: a patch marks it as handled to go back to
  // the list, and the list itself clears its selection. Those run first and set
  // `defaultPrevented`, which is why this listens on the document and not on the
  // panel. It stays above the collapsed-rail return: every hook runs every render.
  useEffect(() => {
    if (!props.drawer || subview !== null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [props.drawer, props.onClose, subview]);

  const onResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = rightPanelWidthForKey(props.width, event.key, window.innerWidth);
    if (next === null) return;
    event.preventDefault();
    props.onWidthChange(next);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent): void => {
      props.onWidthChange(rightPanelWidthFromPointer(moveEvent.clientX, window.innerWidth));
    };
    const stop = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  };

  // Collapsed: a rail with the expand button, so the terminal keeps the width.
  // In a narrow window the rail stays behind the drawer: it is the opener the
  // focus returns to when the drawer closes.
  const rail = (
    <aside className="right right-rail" aria-label="Right panel">
      <button
        ref={railButtonRef}
        type="button"
        className="rail-toggle"
        aria-expanded={props.open}
        aria-label={props.open ? 'Right panel is open' : 'Expand right panel'}
        title="Expand right panel"
        onClick={props.onOpenPanel}
      >
        <span className="rail-chevron" aria-hidden="true">
          <ChevronIcon size={12} />
        </span>
      </button>
      <div className="rail-labels" aria-hidden="true">
        <SourceControlIcon size={13} />
        <span className="rail-label">Source Control · {props.changeCount}</span>
      </div>
    </aside>
  );

  if (!props.open) return rail;

  const section = rightSectionOf(tab);

  const panel = (
    <aside className={`right ${props.drawer ? 'right-drawer' : ''}`} aria-label="Right panel">
      {props.drawer ? null : (
        <div
          className="right-resizer"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize right panel"
          aria-valuenow={props.width}
          aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
          aria-valuemax={rightPanelMaxWidth(
            typeof window === 'undefined' ? 1440 : window.innerWidth,
          )}
          title="Drag or use the arrow keys to resize"
          onPointerDown={startDrag}
          onKeyDown={onResizeKeyDown}
        />
      )}

      <div className="right-head">
        <div className="right-tabs" role="tablist" aria-label="Right panel sections">
          {RIGHT_SECTIONS.map((item) => {
            const selected = section === item.id;
            const count =
              item.id === 'source-control'
                ? props.changeCount
                : item.id === 'sessions'
                  ? props.sessions.length
                  : 0;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`right-tab-${item.id}`}
                aria-selected={selected}
                aria-controls="right-panel-body"
                aria-label={`${item.label}${count > 0 ? `, ${count}` : ''}`}
                title={item.title}
                className={`right-tab ${selected ? 'selected' : ''}`}
                onClick={() => {
                  setRestoreFocus(null);
                  setTab(item.id);
                }}
              >
                <span className="right-tab-icon" aria-hidden="true">
                  {item.id === 'files' ? (
                    <FolderIcon size={12} />
                  ) : item.id === 'sessions' ? (
                    <TerminalIcon size={12} />
                  ) : (
                    <SourceControlIcon size={12} />
                  )}
                </span>
                <span className="right-tab-label">{item.label}</span>
                {count > 0 ? (
                  <span className="right-tab-count" data-testid={`right-tab-count-${item.id}`}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="icon-btn right-collapse"
          aria-expanded={true}
          aria-label="Collapse right panel"
          title="Collapse right panel"
          onClick={props.onClose}
        >
          <span className="rail-chevron flipped" aria-hidden="true">
            <ChevronIcon size={12} />
          </span>
        </button>
      </div>

      <div
        className="right-body"
        id="right-panel-body"
        role="tabpanel"
        aria-labelledby={`right-tab-${section}`}
      >
        {subview ? (
          <div className="right-subhead">
            <button type="button" className="mini-btn" onClick={backToList}>
              ← Source Control
            </button>
            <span className="right-subhead-title">{SUBVIEW_TITLES[subview]}</span>
          </div>
        ) : null}

        {section === 'source-control' && subview === null ? (
          <SourceControlPanel
            key={`${taskId ?? 'none'}:source-control`}
            client={props.client}
            task={props.task}
            refreshKey={props.refreshKey}
            onChanged={props.onGitChanged}
            onNotify={props.onNotify}
            onOpenPatch={() => setTab('diff')}
            onOpenDiff={openDiff}
            onOpenHistory={() => {
              setCommitTarget(null);
              setTab('history');
            }}
            onOpenCompare={() => setTab('compare')}
            initialFocus={restoreFocus}
          />
        ) : null}

        {section === 'files' ? (
          <FilesPanel
            key={`${taskId ?? 'none'}:files`}
            client={props.client}
            task={props.task}
            refreshKey={props.refreshKey}
          />
        ) : null}

        {section === 'sessions' ? (
          <SessionsPanel
            sessions={props.sessions}
            hasTask={props.task !== null}
            selectedSessionId={props.selectedSessionId}
            unread={props.unread}
            resumableHarnesses={props.resumableHarnesses}
            onSelect={props.onSelectSession}
            onStop={props.onStopSession}
            onResume={props.onResumeSession}
            onNewSession={props.onNewSession}
          />
        ) : null}

        {subview === 'history' ? (
          <HistoryPanel
            key={`${taskId ?? 'none'}:history`}
            client={props.client}
            task={props.task}
            refreshKey={props.refreshKey}
            selectedHash={commitHash}
            onSelectCommit={(hash) => setCommitTarget(hash && taskId ? { taskId, hash } : null)}
            onNotify={props.onNotify}
          />
        ) : null}

        {subview === 'compare' ? (
          <ComparePanel
            key={`${taskId ?? 'none'}:compare`}
            client={props.client}
            task={props.task}
            refreshKey={props.refreshKey}
            onOpenCommit={openCommit}
            onNotify={props.onNotify}
          />
        ) : null}

        {subview === 'diff' ? (
          <DiffPanel
            key={`${taskId ?? 'none'}:diff`}
            client={props.client}
            task={props.task}
            sessions={props.sessions}
            selectedSessionId={props.selectedSessionId}
            refreshKey={props.refreshKey}
            onChanged={props.onGitChanged}
            onNotify={props.onNotify}
            target={memory.selection}
            onBackToList={backToList}
          />
        ) : null}
      </div>
    </aside>
  );

  if (!props.drawer) return panel;

  return (
    <>
      {rail}
      <div className="right-drawer-layer">
        <div
          className="right-drawer-backdrop"
          onClick={props.onClose}
          role="presentation"
          data-testid="right-drawer-backdrop"
        />
        {panel}
      </div>
    </>
  );
}
