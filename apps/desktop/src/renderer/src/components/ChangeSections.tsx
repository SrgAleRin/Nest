import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type {
  ChangeRow,
  ChangeSections as ChangeSectionsModel,
  ChangeSide,
  ConflictRow,
} from '../sourceControl';
import { rowTone } from '../sourceControl';
import type { GitFileView, GitSelection } from '../state/gitSnapshot';
import { basename } from '../utils';
import { FileTree } from './FileTree';

type AnyRow = ChangeRow | ConflictRow;

interface ChangeSectionsProps {
  sections: ChangeSectionsModel;
  filter: string;
  view: GitFileView;
  selection: GitSelection | null;
  busy: boolean;
  /** The snapshot is stale: a discard reads the status again before it runs. */
  stale: boolean;
  onOpen: (path: string, mode: ChangeSide) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (row: AnyRow) => void;
  onClearSelection: () => void;
}

/**
 * `Staged`, `Unstaged`, `Untracked` and `Conflicts` as independent sections,
 * built from the explicit booleans of the status. Arrow keys walk the rows,
 * Enter opens the row's side as a patch and Escape clears the selection.
 */
export function ChangeList({
  sections,
  filter,
  view,
  selection,
  busy,
  stale,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onClearSelection,
}: ChangeSectionsProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClearSelection();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...(listRef.current?.querySelectorAll<HTMLButtonElement>('.change-open') ?? []),
    ];
    if (buttons.length === 0) return;
    event.preventDefault();
    const active = document.activeElement;
    const index = buttons.findIndex((button) => button === active || button.contains(active));
    const last = buttons.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown'
            ? index < 0
              ? 0
              : Math.min(index + 1, last)
            : index <= 0
              ? 0
              : index - 1;
    buttons[next]?.focus();
  };

  if (sections.total === 0) {
    return (
      <div className="change-list" ref={listRef}>
        <div className="git-files">
          <div className="panel-empty" data-testid="changes-empty">
            {filter.trim() ? `No change matches “${filter.trim()}”` : 'Working tree is clean'}
          </div>
        </div>
      </div>
    );
  }

  const groups: Array<{
    id: string;
    title: string;
    rows: AnyRow[];
    action: { label: string; title: string; run: (paths: string[]) => void } | null;
  }> = [
    {
      id: 'staged',
      title: 'Staged',
      rows: sections.staged,
      action: {
        label: 'Unstage all',
        title: 'Unstage every staged file (git restore --staged)',
        run: onUnstage,
      },
    },
    {
      id: 'unstaged',
      title: 'Unstaged',
      rows: sections.unstaged,
      action: {
        label: 'Stage group',
        title: 'Stage every file of this section (git add)',
        run: onStage,
      },
    },
    {
      id: 'untracked',
      title: 'Untracked',
      rows: sections.untracked,
      action: {
        label: 'Stage group',
        title: 'Stage every untracked file of this section (git add)',
        run: onStage,
      },
    },
    {
      id: 'conflicts',
      title: 'Conflicts',
      rows: sections.conflicts,
      action: null,
    },
  ];

  const renderRow = (row: AnyRow, depth: number): ReactNode => (
    <ChangeRowView
      key={`${row.path}:${'side' in row ? row.side : 'conflict'}`}
      row={row}
      depth={depth}
      view={view}
      busy={busy}
      stale={stale}
      selected={
        selection !== null &&
        selection.path === row.path &&
        'side' in row &&
        selection.mode === row.side
      }
      onOpen={onOpen}
      onStage={onStage}
      onUnstage={onUnstage}
      onDiscard={onDiscard}
    />
  );

  return (
    <div className="change-list" ref={listRef} onKeyDown={onKeyDown}>
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section className="change-section" key={group.id} data-testid={`changes-${group.id}`}>
            <div className="git-files-head change-group-head">
              <span className="section-label">
                {group.title} ({group.rows.length})
              </span>
              {group.action ? (
                <button
                  type="button"
                  className="mini-btn"
                  disabled={busy}
                  title={group.action.title}
                  onClick={() => group.action?.run(group.rows.map((row) => row.path))}
                >
                  {group.action.label}
                </button>
              ) : (
                <span className="change-group-hint">
                  Resolve the conflict, then stage the result
                </span>
              )}
            </div>
            {view === 'tree' ? (
              <FileTree<AnyRow>
                entries={group.rows}
                emptyLabel="No files"
                renderFile={(row, depth) => renderRow(row, depth)}
              />
            ) : (
              <div className="git-files">{group.rows.map((row) => renderRow(row, 0))}</div>
            )}
          </section>
        ))}
    </div>
  );
}

function ChangeRowView({
  row,
  depth,
  view,
  busy,
  stale,
  selected,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
}: {
  row: AnyRow;
  depth: number;
  view: GitFileView;
  busy: boolean;
  stale: boolean;
  selected: boolean;
  onOpen: (path: string, mode: ChangeSide) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (row: AnyRow) => void;
}) {
  const isConflict = !('side' in row);
  const side: ChangeSide = 'side' in row ? row.side : 'unstaged';
  const name = view === 'tree' ? basename(row.path) : row.path;
  const label = row.oldPath ? `${basename(row.oldPath)} → ${name}` : name;
  const title = row.oldPath ? `${row.oldPath} → ${row.path}` : row.path;

  return (
    <div
      className={`git-file tree-row change-row ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: 6 + depth * 11 }}
      data-testid="change-row"
      data-path={row.path}
      data-side={side}
      data-selected={selected ? 'true' : undefined}
      title={title}
    >
      <button
        type="button"
        className="change-open"
        aria-label={`${row.letter} ${row.path} — open ${isConflict ? 'conflict' : side} patch`}
        onClick={() => onOpen(row.path, isConflict ? 'unstaged' : side)}
      >
        <span className={`git-letter ${rowTone(row)}`}>{row.letter}</span>
        <span className="git-path">{label}</span>
        {row.additions !== null && row.deletions !== null ? (
          <span className="git-stat" title={`${row.additions} added, ${row.deletions} deleted`}>
            <em>+{row.additions}</em> <del>-{row.deletions}</del>
          </span>
        ) : null}
      </button>
      <span className="git-file-actions">
        {isConflict ? (
          <span className="change-group-hint">conflict</span>
        ) : (
          <>
            <button
              type="button"
              className="mini-btn"
              disabled={busy}
              title={side === 'staged' ? 'Unstage this file' : 'Stage this file'}
              onClick={() => (side === 'staged' ? onUnstage([row.path]) : onStage([row.path]))}
            >
              {side === 'staged' ? 'Unstage' : 'Stage'}
            </button>
            <button
              type="button"
              className="mini-btn danger git-discard"
              disabled={busy}
              title={
                stale
                  ? 'Discard this path: the snapshot is stale, so the git status is read again first and the discard stops if the path changed'
                  : 'Discard this path (restores it from HEAD, deletes untracked files)'
              }
              onClick={() => onDiscard(row)}
            >
              Discard
            </button>
          </>
        )}
      </span>
    </div>
  );
}
