import type { ReactNode } from 'react';
import { Button, Skeleton } from '@nest/ui';

const SIDEBAR_PROJECTS: Array<{ name: number; cards: Array<[number, number]> }> = [
  {
    name: 112,
    cards: [
      [118, 74],
      [96, 62],
    ],
  },
  {
    name: 94,
    cards: [
      [108, 68],
      [84, 58],
      [112, 70],
    ],
  },
  { name: 104, cards: [[100, 66]] },
];

/**
 * The layout appears immediately with placeholders, so the first paint already
 * looks like Nest instead of an empty window or a lone spinner.
 */
export function BootSkeleton() {
  return (
    <div className="boot-shell" role="status" aria-busy="true" aria-label="Starting Nest">
      <header className="titlebar">
        <div className="brand">
          <div className="logo">n</div>
          <span className="brand-name">Nest</span>
        </div>
        <Skeleton width={170} height={9} />
        <div className="titlebar-actions">
          <Skeleton width={18} height={18} radius={4} />
        </div>
      </header>

      <main className="columns">
        <aside className="sidebar">
          <div className="boot-sidebar-toolbar">
            <Skeleton width={132} height={22} radius={6} />
            <Skeleton width={22} height={22} radius={6} />
            <Skeleton width={22} height={22} radius={6} />
          </div>
          <div className="sidebar-scroll boot-sidebar">
            {SIDEBAR_PROJECTS.map((project, projectIndex) => (
              <div className="boot-project" key={projectIndex}>
                <div className="boot-project-row">
                  <Skeleton width={10} height={10} />
                  <Skeleton width={project.name} height={10} />
                </div>
                <div className="boot-task-list">
                  {project.cards.map(([title, meta], cardIndex) => (
                    <div className="boot-task-card" key={cardIndex}>
                      <div className="boot-task-row">
                        <Skeleton width={8} height={8} radius={2} />
                        <Skeleton width={title} height={9} />
                      </div>
                      <div className="boot-task-row boot-task-meta">
                        <Skeleton width={meta} height={7} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="sidebar-foot boot-sidebar-foot">
            <Skeleton width={96} height={20} radius={6} />
            <Skeleton width={78} height={20} radius={6} />
          </div>
        </aside>

        <section className="center">
          <div className="terminal-tabs">
            <Skeleton width={92} height={16} radius={5} />
            <Skeleton width={104} height={16} radius={5} />
            <span className="boot-spacer" />
            <Skeleton width={112} height={22} radius={6} />
          </div>
          <div className="boot-terminal">
            <div className="boot-start">
              <Skeleton width={44} height={44} radius={12} />
              <Skeleton width={150} height={12} />
              <Skeleton width={300} height={8} />
              <Skeleton width={256} height={8} />
              <div className="boot-cards">
                {[0, 1, 2].map((card) => (
                  <div className="boot-card" key={card}>
                    <Skeleton width={12} height={12} />
                    <Skeleton width={70} height={9} />
                    <Skeleton width={96} height={7} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <aside className="right">
          <div className="right-tabs">
            {[52, 42, 70].map((width, tab) => (
              <div className={`boot-right-tab ${tab === 0 ? 'active' : ''}`} key={tab}>
                <Skeleton width={width} height={9} />
              </div>
            ))}
          </div>
          <div className="panel-scroll boot-panel">
            <div className="boot-git-head">
              <Skeleton width={132} height={10} />
              <Skeleton width={16} height={16} radius={4} />
            </div>
            {[68, 82, 54, 74, 61, 88].map((width, row) => (
              <div className="boot-git-row" key={row}>
                <Skeleton width={14} height={10} radius={3} />
                <Skeleton width={`${width}%`} height={9} />
              </div>
            ))}
            <div className="boot-commit">
              <Skeleton width={58} height={8} />
              <Skeleton height={52} radius={6} />
              <Skeleton width={120} height={20} radius={6} />
            </div>
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <Skeleton width={96} height={8} />
        <Skeleton width={160} height={8} />
        <span className="status-spacer" />
        <Skeleton width={190} height={8} />
      </footer>

      <span className="sr-only">Starting Nest…</span>
    </div>
  );
}

/**
 * Full-window failure that leaves no usable interface: a failed first load or
 * a renderer crash. Panel failures stay inline and use `ErrorState` instead.
 */
export function FatalScreen({
  title,
  message,
  hint,
  details,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  hint?: ReactNode;
  details?: string | null;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="boot">
      <div className="logo large">n</div>
      <div className="fatal-card" role="alert">
        <div className="fatal-title">{title}</div>
        <pre className="fatal-message">{message}</pre>
        {details ? (
          <details className="fatal-details">
            <summary>Details</summary>
            <pre>{details}</pre>
          </details>
        ) : null}
        {hint ? <p className="fatal-hint">{hint}</p> : null}
        <Button variant="primary" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
