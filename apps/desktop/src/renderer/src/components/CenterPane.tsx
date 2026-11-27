import { useEffect } from 'react';
import type { HarnessProfile, NestClient, Session, Task, TerminalPreferences } from '@nest/shared';
import { DiffPanel } from './DiffPanel';
import { GitGraphPanel, type GraphActions } from './GitGraphPanel';
import { TerminalPane } from './TerminalPane';
import { CenterToolTabs, NewTabControl, SessionTabStrip } from './TerminalTabs';
import { useGitTaskMemory } from '../state/GitSnapshotProvider';
import type { CenterSurface, CenterTabId, TaskCenterState } from '../state/centerTabs';

/**
 * The class of one layer of the center. Layers are stacked in one box and the
 * inactive ones are hidden with CSS only: the terminals stay mounted under
 * every surface, so switching to `Diff` or `Graph` never kills an xterm.
 */
export function centerLayerClass(active: CenterSurface, layer: CenterSurface): string {
  return `center-layer center-layer-${layer}${active === layer ? ' is-active' : ' is-hidden'}`;
}

export interface CenterPaneProps {
  client: NestClient;
  task: Task | null;
  hasProjects: boolean;
  sessions: Session[];
  selectedSessionId: string | null;
  unread: Record<string, number>;
  harnesses: HarnessProfile[];
  allHarnessesDisabled: boolean;
  terminal: TerminalPreferences;
  busy: boolean;
  newSessionDefault: string;
  resumableHarnesses: ReadonlySet<string>;
  /** Bumped by every local git operation; the open patch and graph reload. */
  refreshKey: number;
  /** The workbench state of the selected task. */
  center: TaskCenterState;
  /** A palette command that opens the graph and focuses its ref picker. */
  graphPickerNonce: number;
  onSelectSession: (sessionId: string) => void;
  onStart: (harnessId: string) => void;
  onCloseSession: (session: Session) => void;
  onResume: (session: Session) => void;
  onNewSession: (session: Session) => void;
  onError: (message: string) => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  onAddProject: () => void;
  onGitChanged: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
  onActivateSurface: (surface: CenterSurface) => void;
  onCloseTab: (tab: CenterTabId) => void;
  /** Everything the graph may ask for: scope, ref, commit, compare, browse, task. */
  graph: GraphActions;
}

/**
 * The center workbench: one header strip with the session tabs and the tool
 * tabs, and a body of stacked layers. The terminal layer always exists; the
 * tool layers exist only while their tab is open.
 */
export function CenterPane(props: CenterPaneProps) {
  const { center, task } = props;
  const surface = center.active;
  const taskId = task?.id ?? null;
  const memory = useGitTaskMemory(taskId);
  const onCloseTab = props.onCloseTab;

  // Escape closes the active tool tab. A panel that owns the key first (the
  // comment composer) marks the event handled, and the terminal surface is
  // never closed this way.
  useEffect(() => {
    if (surface === 'terminal') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onCloseTab(surface);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCloseTab, surface]);

  const selectSession = (sessionId: string): void => {
    props.onSelectSession(sessionId);
    props.onActivateSurface('terminal');
  };

  return (
    <section className="center">
      <div className="terminal-tabs">
        <SessionTabStrip
          sessions={props.sessions}
          selectedSessionId={props.selectedSessionId}
          unread={props.unread}
          onSelect={selectSession}
          onClose={props.onCloseSession}
        />

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

        <CenterToolTabs
          open={{ diff: center.diffOpen, graph: center.graphOpen }}
          active={surface}
          onSelect={props.onActivateSurface}
          onClose={props.onCloseTab}
        />
      </div>

      <div className="center-layers">
        <div className={centerLayerClass(surface, 'terminal')} data-testid="center-terminal-layer">
          <TerminalPane
            client={props.client}
            task={task}
            hasProjects={props.hasProjects}
            sessions={props.sessions}
            selectedSessionId={props.selectedSessionId}
            harnesses={props.harnesses}
            allHarnessesDisabled={props.allHarnessesDisabled}
            terminal={props.terminal}
            busy={props.busy}
            visible={surface === 'terminal'}
            onStart={props.onStart}
            newSessionDefault={props.newSessionDefault}
            onResume={props.onResume}
            onNewSession={props.onNewSession}
            resumableHarnesses={props.resumableHarnesses}
            onError={props.onError}
            onOpenPalette={props.onOpenPalette}
            onOpenSettings={props.onOpenSettings}
            onAddProject={props.onAddProject}
          />
        </div>

        {center.diffOpen ? (
          <div className={centerLayerClass(surface, 'diff')} data-testid="center-diff-layer">
            <DiffPanel
              client={props.client}
              task={task}
              sessions={props.sessions}
              selectedSessionId={props.selectedSessionId}
              refreshKey={props.refreshKey}
              onChanged={props.onGitChanged}
              onNotify={props.onNotify}
              target={memory.selection}
              compareTarget={center.compareTarget}
            />
          </div>
        ) : null}

        {center.graphOpen && taskId !== null ? (
          <div className={centerLayerClass(surface, 'graph')} data-testid="center-graph-layer">
            <GitGraphPanel
              key={taskId}
              client={props.client}
              task={task}
              refreshKey={props.refreshKey}
              center={center}
              pickerNonce={props.graphPickerNonce}
              onNotify={props.onNotify}
              onGitChanged={props.onGitChanged}
              actions={props.graph}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
