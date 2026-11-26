import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import type { FileContent, NestClient, Task, WorkspaceFiles } from '@nest/shared';
import { EmptyState, ErrorState } from '@nest/ui';
import { FileTree } from './FileTree';
import { FilesPanelSkeleton } from './PanelSkeletons';
import { highlightLines, tokenStyle } from '../highlight';
import { panelPhase } from '../panelState';
import { basename, errorMessage } from '../utils';

/** A file with more lines than this is shown as plain text to keep the panel responsive. */
const MAX_PREVIEW_LINES = 5000;
const MAX_HIGHLIGHT_LINES = 4000;

interface FilesPanelProps {
  client: NestClient;
  task: Task | null;
  refreshKey: number;
}

export function FilesPanel({ client, task, refreshKey }: FilesPanelProps) {
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
      setList(await client.invoke('files.list', { taskId: task.id }));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, task]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

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
      .invoke('files.read', { taskId: task.id, path: selected })
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
  }, [client, task, selected, refreshKey, readVersion]);

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
        <FilesHead count={null} loading={loading} onRefresh={() => void load()} />
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
      <FilesHead count={list.files.length} loading={loading} onRefresh={() => void load()} />

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
}: {
  count: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="files-head">
      <span className="section-label">Files{count !== null ? ` · ${count}` : ''}</span>
      <button className="mini-btn" onClick={onRefresh} disabled={loading}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
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
