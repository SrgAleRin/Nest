import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import type {
  FileContent,
  GitBranch,
  GitBranches,
  NestClient,
  Task,
  WorkspaceFiles,
} from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { FileTree } from './FileTree';
import { FilesPanelSkeleton } from './PanelSkeletons';
import { ChevronIcon } from './Icons';
import { highlightLines, tokenStyle } from '../highlight';
import { panelPhase } from '../panelState';
import { filesViewActions, useInspectedRef } from '../state/filesView';
import { useGitSnapshot, useGitSnapshotStore } from '../state/GitSnapshotProvider';
import { basename, errorMessage } from '../utils';

/** A file with more lines than this is shown as plain text to keep the panel responsive. */
const MAX_PREVIEW_LINES = 5000;
const MAX_HIGHLIGHT_LINES = 4000;

interface FilesPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
}

/**
 * The workspace file tree, optionally at another revision. The revision is a
 * branch read from git objects, so browsing another task's branch never checks
 * it out and never touches the working tree the session writes to. The
 * inspected revision lives in `filesView`, which the center `Browse files`
 * action writes to, so a handoff between the two panels needs no prop.
 */
export function FilesPanel({ client, task, refreshKey }: FilesPanelProps) {
  const taskId = task?.id ?? null;
  const store = useGitSnapshotStore();
  const snapshot = useGitSnapshot(taskId);
  const branches = snapshot?.branches.data ?? null;
  const branchesLoading = snapshot?.branches.loading ?? false;
  const branchesError = snapshot?.branches.error ?? null;
  const inspectedRef = useInspectedRef(taskId);

  // The branch list comes from the snapshot the whole right panel reads; the
  // picker never starts a second `git.branches` call of its own.
  useEffect(() => {
    if (!taskId || branches || branchesLoading || branchesError) return;
    void store.requestBranches(taskId);
  }, [branches, branchesError, branchesLoading, store, taskId]);

  const [list, setList] = useState<WorkspaceFiles | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<{ path: string; message: string } | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);

  const load = useCallback(async () => {
    if (!task) {
      setList(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setList(
        await client.invoke('files.list', {
          taskId: task.id,
          ...(inspectedRef ? { ref: inspectedRef } : {}),
        }),
      );
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, inspectedRef, task]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // A different revision (or task) is a different tree: the old selection and
  // preview belong to the previous tree and must not survive the switch. A
  // plain refresh keeps the open preview.
  useEffect(() => {
    setSelected(null);
  }, [inspectedRef, taskId]);

  // A changed file is re-read after the watcher reports the workspace change.
  useEffect(() => {
    if (!task || !selected) {
      setContent(null);
      setContentError(null);
      setTokens(null);
      return;
    }

    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    void client
      .invoke('files.read', {
        taskId: task.id,
        path: selected,
        ...(inspectedRef ? { ref: inspectedRef } : {}),
      })
      .then((next) => {
        if (!cancelled) setContent(next);
      })
      .catch((readError) => {
        if (cancelled) return;
        setContent(null);
        setContentError({ path: selected, message: errorMessage(readError) });
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, inspectedRef, task, selected, refreshKey, readVersion]);

  // Escape leaves the preview and returns to the tree; the drawer's own Escape
  // only runs when the preview did not consume the key.
  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setSelected(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  // Content is tagged with its path, so a slow read for the previous file can
  // never appear under the newly selected one.
  const current = content && content.path === selected ? content : null;
  const currentError = contentError && contentError.path === selected ? contentError.message : null;

  const preview = useMemo(() => {
    if (!current || current.binary) return { lines: [], truncated: false };
    const text = current.text.replace(/\r\n/g, '\n');
    const all =
      text === '' ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    return { lines: all.slice(0, MAX_PREVIEW_LINES), truncated: all.length > MAX_PREVIEW_LINES };
  }, [current]);

  useEffect(() => {
    if (
      !current ||
      current.binary ||
      !selected ||
      preview.lines.length === 0 ||
      preview.lines.length > MAX_HIGHLIGHT_LINES
    ) {
      setTokens(null);
      return;
    }

    let cancelled = false;
    void highlightLines(preview.lines.join('\n'), selected).then((next) => {
      if (!cancelled) setTokens(next);
    });
    return () => {
      cancelled = true;
    };
  }, [current, selected, preview]);

  const phase = panelPhase({ loading, error, hasData: list !== null });

  const pickRef = useCallback(
    (next: string | null) => {
      if (!taskId) return;
      filesViewActions.setInspectedRef(taskId, next);
    },
    [taskId],
  );

  const readonlyBanner =
    inspectedRef && task ? (
      <div className="files-readonly" data-testid="files-readonly" role="status">
        <span className="files-readonly-label">
          Viewing <code>{inspectedRef}</code> (read-only)
        </span>
        <button
          type="button"
          className="mini-btn"
          title="Show the working tree again"
          onClick={() => pickRef(null)}
        >
          × Working tree
        </button>
      </div>
    ) : null;

  if (!task) {
    return (
      <EmptyState title="No workspace selected">Select a task to browse its files.</EmptyState>
    );
  }

  if (selected) {
    return (
      <div className="files-panel">
        <div className="files-head">
          <button
            className="mini-btn"
            onClick={() => setSelected(null)}
            title="Back to the file list"
          >
            ← Files
          </button>
          <span className="files-preview-path" title={selected}>
            {selected}
          </span>
          {current ? <span className="files-size">{formatBytes(current.size)}</span> : null}
        </div>
        {readonlyBanner}

        {currentError ? (
          <ErrorState title="File unavailable" onRetry={() => setReadVersion((value) => value + 1)}>
            {currentError}
          </ErrorState>
        ) : contentLoading && !current ? (
          <div className="files-preview">
            <div className="panel-loading">Loading…</div>
          </div>
        ) : current ? (
          <FilePreview
            content={current}
            lines={preview.lines}
            tokens={tokens}
            truncated={preview.truncated}
          />
        ) : null}
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="files-panel">
        <FilesHead
          count={null}
          loading={loading}
          onRefresh={() => void load()}
          inspectedRef={inspectedRef}
          branches={branches}
          branchesLoading={branchesLoading}
          onPickRef={pickRef}
        />
        {readonlyBanner}
        <ErrorState title="Files unavailable" onRetry={() => void load()}>
          {error}
        </ErrorState>
      </div>
    );
  }

  if (phase !== 'ready' || !list) {
    return <FilesPanelSkeleton />;
  }

  return (
    <div className="files-panel">
      <FilesHead
        count={list.files.length}
        loading={loading}
        onRefresh={() => void load()}
        inspectedRef={inspectedRef}
        branches={branches}
        branchesLoading={branchesLoading}
        onPickRef={pickRef}
      />
      {readonlyBanner}

      {list.truncated ? (
        <div className="files-note">Only the first {list.files.length} files are listed.</div>
      ) : null}

      <div className="files-scroll">
        {list.files.length === 0 ? (
          <div className="panel-empty">No files</div>
        ) : (
          <FileTree
            entries={list.files}
            emptyLabel="No files"
            renderFile={(file, depth) => (
              <button
                type="button"
                className="files-row"
                style={{ paddingLeft: 6 + depth * 11 }}
                title={file.path}
                onClick={() => setSelected(file.path)}
              >
                <span className="files-name">{basename(file.path)}</span>
              </button>
            )}
          />
        )}
      </div>
    </div>
  );
}

function FilesHead({
  count,
  loading,
  onRefresh,
  inspectedRef,
  branches,
  branchesLoading,
  onPickRef,
}: {
  count: number | null;
  loading: boolean;
  onRefresh: () => void;
  inspectedRef: string | null;
  branches: GitBranches | null;
  branchesLoading: boolean;
  onPickRef: (ref: string | null) => void;
}) {
  return (
    <div className="files-head">
      <span className="section-label">Files{count !== null ? ` · ${count}` : ''}</span>
      <RevisionPicker
        value={inspectedRef}
        branches={branches}
        loading={branchesLoading}
        onSelect={onPickRef}
      />
      <button className="mini-btn" onClick={onRefresh} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  );
}

/**
 * `Working tree` plus every local and remote branch, with a filter. Choosing a
 * branch does not check it out: the tree below is read from git objects.
 */
function RevisionPicker({
  value,
  branches,
  loading,
  onSelect,
}: {
  value: string | null;
  branches: GitBranches | null;
  loading: boolean;
  onSelect: (ref: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
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

  const needle = filter.trim().toLowerCase();
  const matches = (branch: GitBranch): boolean =>
    !needle || branch.name.toLowerCase().includes(needle);
  const local = (branches?.local ?? []).filter(matches);
  const remote = (branches?.remote ?? []).filter(matches);

  function choose(next: string | null): void {
    setOpen(false);
    setFilter('');
    onSelect(next);
  }

  return (
    <div className="revision-picker" ref={rootRef}>
      <button
        type="button"
        className="revision-button"
        title="Revision shown in the Files panel"
        aria-expanded={open}
        onClick={() => {
          setFilter('');
          setOpen((previous) => !previous);
        }}
      >
        <span className="revision-label">{value ?? 'Working tree'}</span>
        <ChevronIcon size={10} />
      </button>

      {open ? (
        <div className="revision-menu">
          <div className="branch-menu-search">
            <input
              className="branch-input"
              type="search"
              value={filter}
              placeholder="Filter branches"
              aria-label="Filter revisions"
              autoFocus
              onChange={(event) => setFilter(event.target.value)}
            />
          </div>
          <div className="branch-menu-list">
            <button
              type="button"
              className={`branch-item ${value === null ? 'current' : ''}`}
              onClick={() => choose(null)}
            >
              <span className="branch-item-name">Working tree</span>
              {value === null ? <span className="branch-item-badge">current</span> : null}
            </button>
          </div>

          <div className="branch-menu-head">Local</div>
          <div className="branch-menu-list">
            {loading || branches === null ? (
              <div className="branch-menu-empty">Loading branches…</div>
            ) : local.length === 0 ? (
              <div className="branch-menu-empty">
                {needle ? 'No local branch matches the filter' : 'No local branches'}
              </div>
            ) : (
              local.map((branch) => (
                <RevisionRow
                  key={`local:${branch.name}`}
                  branch={branch}
                  selected={value === branch.name}
                  onSelect={() => choose(branch.name)}
                />
              ))
            )}
          </div>

          {remote.length > 0 ? (
            <>
              <div className="branch-menu-head">Remote</div>
              <div className="branch-menu-list">
                {remote.map((branch) => (
                  <RevisionRow
                    key={`remote:${branch.name}`}
                    branch={branch}
                    selected={value === branch.name}
                    onSelect={() => choose(branch.name)}
                  />
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RevisionRow({
  branch,
  selected,
  onSelect,
}: {
  branch: GitBranch;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`branch-item ${selected ? 'current' : ''}`}
      onClick={onSelect}
      title={branch.subject}
    >
      <span className="branch-item-name">{branch.name}</span>
      {selected ? <span className="branch-item-badge">viewing</span> : null}
      {branch.worktreePath ? (
        <span className="branch-item-badge worktree" title={branch.worktreePath}>
          worktree
        </span>
      ) : null}
    </button>
  );
}

function FilePreview({
  content,
  lines,
  tokens,
  truncated,
}: {
  content: FileContent;
  lines: string[];
  tokens: ThemedToken[][] | null;
  truncated: boolean;
}) {
  if (content.binary) {
    return (
      <div className="files-preview">
        <div className="panel-empty">Binary file · {formatBytes(content.size)}</div>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="files-preview">
        <div className="panel-empty">Empty file</div>
      </div>
    );
  }

  const tokenLines = tokens && tokens.length === lines.length ? tokens : null;

  return (
    <div className="files-preview">
      <div className="code-lines">
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span className="code-num">{index + 1}</span>
            <span className="code-text">
              {tokenLines
                ? (tokenLines[index] ?? []).map((token, tokenIndex) => (
                    <span key={tokenIndex} style={tokenStyle(token)}>
                      {token.content}
                    </span>
                  ))
                : line || ' '}
            </span>
          </div>
        ))}
      </div>
      {content.truncated ? <div className="files-note">Preview truncated.</div> : null}
      {truncated ? (
        <div className="files-note">Showing the first {MAX_PREVIEW_LINES} lines.</div>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
