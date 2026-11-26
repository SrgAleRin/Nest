import { useEffect, useRef, useState } from 'react';
import type { GitBranch, GitBranches } from '@nest/shared';
import { BranchIcon, ChevronIcon } from './Icons';

interface BranchSwitcherProps {
  branches: GitBranches | null;
  busy: boolean;
  onSwitch: (branch: string) => void;
  onCreate: (name: string) => void;
}

/** Branch label in the panel head; opens a list of local and remote branches. */
export function BranchSwitcher({ branches, busy, onSwitch, onCreate }: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const current = branches?.current ?? null;

  function choose(branch: string): void {
    setOpen(false);
    onSwitch(branch);
  }

  return (
    <div className="branch-switcher" ref={rootRef}>
      <button
        type="button"
        className="branch-button"
        onClick={() => setOpen((value) => !value)}
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
          <div className="branch-menu-head">Local</div>
          <div className="branch-menu-list">
            {(branches?.local ?? []).length === 0 ? (
              <div className="branch-menu-empty">No local branches</div>
            ) : (
              (branches?.local ?? []).map((branch) => (
                <BranchItem
                  key={branch.name}
                  branch={branch}
                  disabled={busy || branch.current}
                  onClick={() => choose(branch.name)}
                />
              ))
            )}
          </div>

          {(branches?.remote ?? []).length > 0 ? (
            <>
              <div className="branch-menu-head">Remote</div>
              <div className="branch-menu-list">
                {(branches?.remote ?? []).map((branch) => (
                  <BranchItem
                    key={branch.name}
                    branch={branch}
                    disabled={busy}
                    onClick={() => choose(branch.name)}
                  />
                ))}
              </div>
            </>
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

function BranchItem({
  branch,
  disabled,
  onClick,
}: {
  branch: GitBranch;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`branch-item ${branch.current ? 'current' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={branch.subject}
    >
      <span className="branch-item-name">{branch.name}</span>
      {branch.current ? <span className="branch-item-badge">current</span> : null}
      {branch.gone ? <span className="branch-item-badge gone">gone</span> : null}
      {branch.ahead > 0 ? <span className="branch-item-track">↑{branch.ahead}</span> : null}
      {branch.behind > 0 ? <span className="branch-item-track">↓{branch.behind}</span> : null}
    </button>
  );
}
