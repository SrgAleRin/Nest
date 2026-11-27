import type { GitBranches, GitStatus, Task } from '@nest/shared';
import { Badge } from '@nest/ui';
import { BranchSwitcher } from './BranchSwitcher';
import { PanelMenu } from './PanelMenu';
import { RefreshIcon } from './Icons';
import {
  syncBusyLabel,
  trackSummary,
  upstreamLabel,
  type SyncKind,
  type SyncPlan,
} from '../gitSync';

interface SourceControlHeaderProps {
  task: Task | null;
  status: GitStatus | null;
  branches: GitBranches | null;
  branchesError: string | null;
  branchesLoading: boolean;
  plan: SyncPlan;
  busy: boolean;
  /** The remote action in flight: the control says what it is doing. */
  pendingSync: SyncKind | null;
  stale: boolean;
  onSync: (kind: SyncKind) => void;
  onRefresh: () => void;
  onOpenDiff: () => void;
  onOpenGraph: () => void;
  onInspectBranch?: (ref: string) => void;
  onOpenHistory: () => void;
  onOpenCompare: () => void;
  onSwitchBranch: (branch: string) => void;
  onCreateBranch: (name: string) => void;
}

/**
 * Branch, upstream and the one remote action the current state allows. Nothing
 * here asks the network on mount: every value comes from the snapshot the store
 * already read, and `Publish`/`Push`/`Pull` only run when pressed.
 */
export function SourceControlHeader({
  task,
  status,
  branches,
  branchesError,
  branchesLoading,
  plan,
  busy,
  pendingSync,
  stale,
  onSync,
  onRefresh,
  onOpenDiff,
  onOpenGraph,
  onInspectBranch,
  onOpenHistory,
  onOpenCompare,
  onSwitchBranch,
  onCreateBranch,
}: SourceControlHeaderProps) {
  const remoteCount = branches?.remotes.length ?? 0;
  const canPush = remoteCount > 0 && !(branches?.detached ?? false) && !(branches?.unborn ?? false);
  const canPublish = canPush && !status?.upstream;
  const track = trackSummary(status);
  const note = plan.disabledReason ?? plan.detail;

  return (
    <div className="source-control-head" data-testid="source-control-head">
      <div className="source-control-head-top">
        <BranchSwitcher
          branches={branches}
          busy={busy}
          onSwitch={onSwitchBranch}
          onCreate={onCreateBranch}
          {...(onInspectBranch ? { onInspect: onInspectBranch } : {})}
        />

        {task?.kind === 'checkout' ? (
          <Badge tone="accent">
            <span className="main-checkout-badge">Main checkout</span>
          </Badge>
        ) : null}

        <span className="git-upstream" title={`Upstream: ${upstreamLabel(status)}`}>
          {upstreamLabel(status)}
        </span>

        {track.map((part) => (
          <span className="track-pill" key={part}>
            {part}
          </span>
        ))}

        <div className="source-control-head-actions">
          <button
            type="button"
            className="mini-btn primary sync-action"
            data-testid="sync-action"
            disabled={busy || plan.disabledReason !== null || plan.kind === null}
            title={plan.disabledReason ?? (plan.detail || plan.label)}
            onClick={() => plan.kind && onSync(plan.kind)}
          >
            {pendingSync ? syncBusyLabel(pendingSync) : plan.label}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Refresh the git status"
            aria-label="Refresh git status"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshIcon />
          </button>
          <PanelMenu
            label="More source control actions"
            title="More source control actions"
            items={[
              { id: 'diff', label: 'Open diff', onSelect: onOpenDiff },
              { id: 'graph', label: 'Git graph (all branches)', onSelect: onOpenGraph },
              { id: 'history', label: 'History', onSelect: onOpenHistory },
              { id: 'compare', label: 'Compare branches', onSelect: onOpenCompare },
              {
                id: 'fetch',
                label: 'Fetch from remote',
                detail: remoteCount > 0 ? 'git fetch --prune' : 'This repository has no remotes',
                disabled: busy || remoteCount === 0,
                onSelect: () => onSync('fetch'),
              },
              {
                id: 'push',
                label: 'Push',
                detail: canPush ? undefined : 'No branch to push',
                disabled: busy || !canPush,
                onSelect: () => onSync('push'),
              },
              {
                id: 'publish',
                label: 'Publish branch',
                detail: canPublish ? undefined : 'The branch already has an upstream',
                disabled: busy || !canPublish,
                onSelect: () => onSync('publish'),
              },
            ]}
          />
        </div>
      </div>

      {stale ? (
        <div className="source-control-note warn" role="status">
          Showing the last snapshot: git reported changes and it is being read again.
        </div>
      ) : null}

      {branchesError ? (
        <div className="source-control-note warn">
          Branches could not be read, so the remote state is unknown.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={onRefresh}
            disabled={branchesLoading || busy}
          >
            Retry
          </button>
        </div>
      ) : note ? (
        <div className={`source-control-note ${plan.disabledReason ? 'muted' : ''}`}>{note}</div>
      ) : null}
    </div>
  );
}
