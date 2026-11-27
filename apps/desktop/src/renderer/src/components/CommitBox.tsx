import type { KeyboardEvent } from 'react';
import { Button } from '@nest/ui';
import { PanelMenu, type PanelMenuItem } from './PanelMenu';
import type { SyncKind, SyncPlan } from '../gitSync';

interface CommitBoxProps {
  taskId: string | null;
  stagedCount: number;
  /** `false` when the branch has no commits yet, `null` while unknown. */
  hasHead: boolean | null;
  draft: string;
  amend: boolean;
  busy: boolean;
  plan: SyncPlan;
  onDraft: (value: string) => void;
  onAmend: (value: boolean) => void;
  onCommit: () => void;
  onSync: (kind: SyncKind) => void;
}

/**
 * The pinned commit block. A normal commit records the index only: `stageAll`
 * is never sent from here, so unstaged and untracked work cannot slip into a
 * commit. The draft and `Amend` live in the store's per-task memory, so a task
 * switch, a failed commit or a remount do not lose them.
 */
export function CommitBox({
  taskId,
  stagedCount,
  hasHead,
  draft,
  amend,
  busy,
  plan,
  onDraft,
  onAmend,
  onCommit,
  onSync,
}: CommitBoxProps) {
  const canCommit =
    taskId !== null && !busy && draft.trim().length > 0 && (stagedCount > 0 || amend);
  const disabledReason = !taskId
    ? 'Select a task first'
    : draft.trim().length === 0
      ? 'Write a commit message'
      : !amend && stagedCount === 0
        ? 'Nothing staged'
        : null;

  const amendDisabled = hasHead !== true;

  /**
   * `Ctrl+Enter` / `Cmd+Enter` commits, the gesture the terminal and the diff
   * composer use. A plain Enter keeps its textarea meaning: a new line.
   */
  const onMessageKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    if (canCommit) onCommit();
  };
  const items: PanelMenuItem[] = [
    {
      id: 'amend',
      label: 'Amend last commit',
      detail: amendDisabled
        ? hasHead === null
          ? 'The commit state is still loading'
          : 'This branch has no commits yet'
        : 'Replace the previous commit with the staged changes',
      checked: amend,
      disabled: amendDisabled,
      onSelect: () => onAmend(!amend),
    },
  ];
  // The header already carries the primary remote action, so the commit menu
  // only adds Push when that is not what the header shows. `Publish branch`
  // lives in the header alone: it is never offered for a branch with upstream.
  if (plan.kind !== 'push' && plan.kind !== 'publish') {
    const behind = plan.kind === 'pull';
    items.push({
      id: 'push',
      label: 'Push',
      detail:
        plan.disabledReason ?? (behind ? 'The branch is behind upstream: pull first' : undefined),
      disabled: plan.disabledReason !== null || plan.kind === null || behind,
      onSelect: () => onSync('push'),
    });
  }

  return (
    <div className="commit-box" data-testid="commit-box">
      <div className="commit-box-head">
        <span className="section-label">Commit</span>
        <span
          className={`commit-scope ${stagedCount > 0 ? '' : 'muted'}`}
          data-testid="commit-scope"
        >
          {stagedCount > 0 ? `${stagedCount} staged` : 'Nothing staged'}
        </span>
        <PanelMenu
          label="More commit actions"
          title="More commit actions"
          items={items}
          align="right"
          placement="up"
        />
      </div>

      <textarea
        className="commit-message"
        rows={2}
        value={draft}
        placeholder="Commit message"
        aria-label="Commit message"
        disabled={taskId === null || busy}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={onMessageKeyDown}
      />

      <div className="commit-actions">
        <Button
          variant="primary"
          size="sm"
          className="commit-submit"
          disabled={!canCommit}
          title={disabledReason ?? (amend ? 'Amend the last commit' : 'Commit the staged changes')}
          onClick={onCommit}
        >
          {busy ? 'Working…' : amend ? 'Amend commit' : 'Commit'}
        </Button>
        {amend ? <span className="commit-amend-flag">Amend</span> : null}
        {disabledReason && !busy ? (
          <span className="commit-reason" data-testid="commit-reason">
            {disabledReason}
          </span>
        ) : null}
      </div>
    </div>
  );
}
