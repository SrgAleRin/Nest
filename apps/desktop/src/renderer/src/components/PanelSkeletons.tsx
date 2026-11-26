import { Skeleton } from '@nest/ui';

const GIT_ROW_WIDTHS = [52, 71, 44, 63, 58, 77];
const DIFF_LINE_WIDTHS = [64, 82, 46, 73, 58, 88, 69];
const FILE_ROW_WIDTHS = [58, 42, 67, 36, 74, 50, 63, 45, 70, 54];

export function SettingsListSkeleton() {
  return (
    <div className="settings-section" role="status" aria-label="Loading settings">
      <span className="section-label">Harnesses</span>
      <div className="settings-list">
        {[0, 1, 2, 3].map((row) => (
          <div className="settings-row" key={row}>
            <Skeleton width={13} height={13} radius={3} />
            <span className="settings-row-main">
              <Skeleton width={`${58 + row * 8}%`} height={10} />
              <Skeleton width={`${78 - row * 7}%`} height={8} />
            </span>
            <Skeleton width={40} height={8} />
          </div>
        ))}
      </div>
      <div className="field">
        <Skeleton width={124} height={9} />
        <Skeleton height={32} radius={6} />
        <Skeleton width={260} height={8} />
      </div>
      <span className="sr-only">Loading settings…</span>
    </div>
  );
}

export function SourceControlSkeleton() {
  return (
    <div className="source-control-skeleton" role="status" aria-label="Loading git status">
      <div className="source-control-head">
        <div className="source-control-head-top">
          <Skeleton width={132} height={10} />
          <Skeleton width={68} height={10} />
          <Skeleton width={58} height={16} radius={5} />
        </div>
      </div>
      <div className="change-toolbar">
        <Skeleton width={70} height={8} />
        <Skeleton width={148} height={18} radius={5} />
      </div>
      <div className="git-files">
        {GIT_ROW_WIDTHS.map((width, row) => (
          <div className="git-file" key={row}>
            <Skeleton width={14} height={10} radius={3} />
            <Skeleton width={`${width}%`} height={9} />
            <Skeleton width={34} height={14} radius={5} />
          </div>
        ))}
      </div>
      <div className="commit-box">
        <Skeleton width={58} height={8} />
        <Skeleton height={44} radius={6} />
        <Skeleton width={120} height={20} radius={6} />
      </div>
      <span className="sr-only">Loading git status…</span>
    </div>
  );
}

export function FilesPanelSkeleton() {
  return (
    <div className="files-panel" role="status" aria-label="Loading files">
      <div className="files-head">
        <Skeleton width={64} height={8} />
        <Skeleton width={52} height={16} radius={5} />
      </div>
      <div className="files-scroll">
        {FILE_ROW_WIDTHS.map((width, row) => (
          <div className="files-skeleton-row" key={row}>
            <Skeleton width={12} height={10} radius={3} />
            <Skeleton width={`${width}%`} height={9} />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading files…</span>
    </div>
  );
}

export function DiffPanelSkeleton() {
  return (
    <div className="diff-panel" role="status" aria-label="Loading diff">
      <div className="diff-head">
        <Skeleton width={84} height={9} />
        <Skeleton width={52} height={18} radius={5} />
      </div>
      <div className="panel-scroll boot-diff">
        {[0, 1].map((file) => (
          <div className="boot-diff-file" key={file}>
            <div className="diff-file-head">
              <Skeleton width={14} height={10} radius={3} />
              <Skeleton width={file === 0 ? 120 : 168} height={9} />
              <Skeleton width={48} height={9} />
            </div>
            {DIFF_LINE_WIDTHS.map((width, row) => (
              <div className="boot-diff-line" key={row}>
                <Skeleton width={18} height={8} />
                <Skeleton width={18} height={8} />
                <Skeleton width={`${width}%`} height={9} />
              </div>
            ))}
          </div>
        ))}
        <span className="sr-only">Loading diff…</span>
      </div>
    </div>
  );
}
