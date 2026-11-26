import { useMemo, useState } from 'react';
import type { DiffFile, GitCommitDetail, NestClient } from '@nest/shared';
import { FileTree } from './FileTree';
import { absoluteTime, diffStatusLetter, diffStatusTone, errorMessage, shortHash } from '../utils';

/** One commit with an aria-label and a copyable hash. */
const MAX_PATCH_LINES = 2000;

interface CommitDetailProps {
  client: NestClient;
  detail: GitCommitDetail;
  onBack: () => void;
  onNotify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function CommitDetailView({ client, detail, onBack, onNotify }: CommitDetailProps) {
  const { commit, files } = detail;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { additions, deletions };
  }, [files]);

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  async function copyHash(): Promise<void> {
    try {
      await client.invoke('clipboard.write', { text: commit.hash });
      onNotify('info', 'Commit hash copied');
    } catch (error) {
      onNotify('error', errorMessage(error));
    }
  }

  return (
    <div className="panel-scroll commit-detail">
      <div className="commit-detail-head">
        <button className="mini-btn" onClick={onBack}>
          ← History
        </button>
        <button
          className="commit-detail-hash"
          title={`Copy ${commit.hash}`}
          onClick={() => void copyHash()}
        >
          {shortHash(commit.hash, 10)}
        </button>
      </div>

      <h3 className="commit-detail-subject">{commit.subject || '(no message)'}</h3>
      <div className="commit-detail-meta">
        {commit.authorName} &lt;{commit.authorEmail}&gt;
        <br />
        {absoluteTime(commit.authoredAt)}
      </div>

      {commit.body ? <pre className="commit-detail-body">{commit.body}</pre> : null}

      <div className="commit-detail-refs">
        {commit.refs.map((ref) => (
          <span key={ref} className={`commit-ref ${ref.startsWith('tag: ') ? 'tag' : ''}`}>
            {ref.replace(/^tag: /, '')}
          </span>
        ))}
        <span className="commit-detail-stat">
          {files.length} file{files.length === 1 ? '' : 's'} <em>+{totals.additions}</em>{' '}
          <del>-{totals.deletions}</del>
        </span>
      </div>

      <FileTree
        entries={files}
        emptyLabel="No file changes in this commit"
        renderFile={(file, depth) => (
          <CommitFileRow
            file={file}
            depth={depth}
            expanded={expanded.has(file.path)}
            onToggle={() => toggle(file.path)}
          />
        )}
      />
    </div>
  );
}

function CommitFileRow({
  file,
  depth,
  expanded,
  onToggle,
}: {
  file: DiffFile;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const name = file.path.split('/').pop() ?? file.path;
  return (
    <>
      <button
        type="button"
        className="git-file tree-row"
        style={{ paddingLeft: 6 + depth * 11 }}
        onClick={onToggle}
        title={file.path}
      >
        <span className={`tree-caret ${expanded ? 'open' : ''}`}>▸</span>
        <span className={`git-letter ${diffStatusTone(file.status)}`}>
          {diffStatusLetter(file.status)}
        </span>
        <span className="git-path">{name}</span>
        {file.oldPath ? <span className="commit-old-path">← {file.oldPath}</span> : null}
        <span className="git-stat">
          <em>+{file.additions}</em> <del>-{file.deletions}</del>
        </span>
      </button>
      {expanded ? <PatchView file={file} /> : null}
    </>
  );
}

function PatchView({ file }: { file: DiffFile }) {
  const lineCount = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
  const truncated = lineCount > MAX_PATCH_LINES;
  let budget = MAX_PATCH_LINES;

  if (file.hunks.length === 0) {
    if (file.binary) return <div className="diff-empty">Binary file</div>;
    if (file.modeChanged) return <div className="diff-empty">File mode changed</div>;
    return <div className="diff-empty">No textual changes</div>;
  }

  return (
    <div className="commit-patch">
      {file.hunks.map((hunk, hunkIndex) => {
        const lines = truncated ? hunk.lines.slice(0, Math.max(0, budget)) : hunk.lines;
        budget -= lines.length;
        if (lines.length === 0) return null;
        return (
          <div key={`${hunk.header}:${hunkIndex}`}>
            <div className="diff-hunk-head">{hunk.header}</div>
            {lines.map((line, lineIndex) => (
              <div className={`diff-line diff-${line.type}`} key={lineIndex}>
                <span className="diff-num old">{line.oldLine ?? ''}</span>
                <span className="diff-num new">{line.newLine ?? ''}</span>
                <span className="diff-sign">
                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                </span>
                <span className="diff-text">{line.text || ' '}</span>
                <span />
              </div>
            ))}
          </div>
        );
      })}
      {truncated ? (
        <div className="commit-patch-note">Patch truncated at {MAX_PATCH_LINES} lines</div>
      ) : null}
    </div>
  );
}
