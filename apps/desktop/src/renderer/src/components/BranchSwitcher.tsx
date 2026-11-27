import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { GitBranch, GitBranches } from '@nest/shared';
import { BranchIcon, ChevronIcon } from './Icons';

interface BranchSwitcherProps {
  branches: GitBranches | null;
  busy: boolean;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
  /** Opens a branch read-only in the center `Graph`, without switching. */
  onInspect?: (ref: string) => void;
}

/**
 * Branch label in the panel head; opens a filterable list of local and remote
 * branches. A branch that another worktree already holds cannot be switched to
 * (git refuses a second checkout), so it is marked as taken, the click explains
 * why, and `Inspect` stays available to read it without touching the workspace.
 */
export function BranchSwitcher({
  branches,
  busy,
  onSwitch,
  onCreate,
  onInspect,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // The menu owns Escape while it is open, before the drawer sees it.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = branches?.current ?? null;
  const needle = filter.trim().toLowerCase();
  const matches = (branch: GitBranch): boolean =>
    !needle || branch.name.toLowerCase().includes(needle);
  const local = (branches?.local ?? []).filter(matches);
  const remote = (branches?.remote ?? []).filter(matches);
  const loading = branches === null;

  function toggle(): void {
    setBlocked(null);
    setFilter('');
    setOpen((value) => !value);
  }

  function choose(branch: string): void {
    setOpen(false);
    onSwitch(branch);
  }

  function inspect(branch: string): void {
    setOpen(false);
    onInspect?.(branch);
  }

  /** A taken branch is not switched to; the menu stays open and says why. */
  function refuse(branch: GitBranch): void {
    setBlocked(
      `${branch.name} is checked out in ${branch.worktreePath}. Git refuses a second checkout of the same branch; inspect it read-only or switch that worktree instead.`,
    );
  }

  const renderBranch = (branch: GitBranch): ReactNode => (
    <BranchRow
      key={`${branch.remote ? 'remote' : 'local'}:${branch.name}`}
      branch={branch}
      busy={busy}
      onSelect={() =>
        branch.worktreePath && !branch.current ? refuse(branch) : choose(branch.name)
      }
      {...(onInspect ? { onInspect: () => inspect(branch.name) } : {})}
    />
  );

  return (
    <div className="branch-switcher" ref={rootRef}>
      <button
        type="button"
        className="branch-button"
        onClick={toggle}
        title="Switch branch"
        aria-expanded={open}
      >
        <BranchIcon />
        <span className="git-branch-name">
          {current ?? (branches?.detached ? 'detached HEAD' : '…')}
        </span>
        <ChevronIcon size={10} />
      </button>

      {open ? (
        <div className="branch-menu">
          <div className="branch-menu-search">
            <input
              className="branch-input"
              type="search"
              value={filter}
              placeholder="Filter branches"
              aria-label="Filter branches"
              autoFocus
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>

          <div className="branch-menu-head">Local</div>
          <div className="branch-menu-list">
            {loading ? (
              <div className="branch-menu-empty">Loading branches…</div>
            ) : local.length === 0 ? (
              <div className="branch-menu-empty">
                {needle ? 'No local branch matches the filter' : 'No local branches'}
              </div>
            ) : (
              local.map(renderBranch)
            )}
          </div>

          {!loading && remote.length > 0 ? (
            <>
              <div className="branch-menu-head">Remote</div>
              <div className="branch-menu-list">{remote.map(renderBranch)}</div>
            </>
          ) : null}

          {blocked ? (
            <div className="branch-menu-note" role="status">
              {blocked}
            </div>
          ) : null}

          <form
            className="branch-new"
            onSubmit={(event) => {
              event.preventDefault();
              const value = name.trim();
              if (!value) return;
              setOpen(false);
              setName('');
              onCreate(value);
            }}
          >
            <input
              className="branch-input"
              placeholder="New branch name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="mini-btn" disabled={busy || !name.trim()}>
              Create
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function BranchRow({
  branch,
  busy,
  onSelect,
  onInspect,
}: {
  branch: GitBranch;
  busy: boolean;
  onSelect: () => void;
  onInspect?: () => void;
}) {
  const taken = branch.worktreePath !== null && !branch.current;
  return (
    <div className={`branch-row ${branch.current ? 'current' : ''}`}>
      <button
        type="button"
        className={`branch-item ${branch.current ? 'current' : ''} ${taken ? 'taken' : ''}`}
        disabled={busy || branch.current}
        aria-disabled={taken ? true : undefined}
        onClick={onSelect}
        title={taken ? `Checked out in ${branch.worktreePath}` : branch.subject}
      >
        <span className="branch-item-name">{branch.name}</span>
        {branch.current ? <span className="branch-item-badge">current</span> : null}
        {taken ? <span className="branch-item-badge worktree">worktree</span> : null}
        {branch.gone ? <span className="branch-item-badge gone">gone</span> : null}
        {branch.ahead > 0 ? <span className="branch-item-track">↑{branch.ahead}</span> : null}
        {branch.behind > 0 ? <span className="branch-item-track">↓{branch.behind}</span> : null}
      </button>
      {onInspect ? (
        <button
          type="button"
          className="mini-btn branch-inspect"
          disabled={busy}
          title={`Inspect ${branch.name} without switching`}
          onClick={onInspect}
        >
          Inspect
        </button>
      ) : null}
    </div>
  );
}
