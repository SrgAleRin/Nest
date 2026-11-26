import type { GitCommit } from '@nest/shared';
import { relativeTime, shortHash } from '../utils';

interface CommitRowProps {
  commit: GitCommit;
  onSelect: () => void;
  compact?: boolean;
}

export function CommitRow({ commit, onSelect, compact = false }: CommitRowProps) {
  const refs = commit.refs.slice(0, compact ? 2 : 3);
  const hidden = commit.refs.length - refs.length;

  return (
    <button
      type="button"
      className={`commit-row ${compact ? 'compact' : ''}`}
      onClick={onSelect}
      title={`${shortHash(commit.hash)} ${commit.subject}`}
    >
      <span className="commit-subject">{commit.subject || '(no message)'}</span>
      <span className="commit-bottom">
        <span className="commit-hash">{shortHash(commit.hash)}</span>
        <span className="commit-meta">
          {commit.authorName} · {relativeTime(commit.committedAt)}
        </span>
        {refs.map((ref) => (
          <span
            key={ref}
            className={`commit-ref ${ref.startsWith('tag: ') ? 'tag' : ''}`}
            title={ref}
          >
            {ref.replace(/^tag: /, '')}
          </span>
        ))}
        {hidden > 0 ? <span className="commit-ref more">+{hidden}</span> : null}
      </span>
    </button>
  );
}
