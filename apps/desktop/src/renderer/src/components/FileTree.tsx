import { useMemo, useState, type ReactNode } from 'react';
import { buildFileTree, type TreeNode } from '../fileTree';

interface FileTreeProps<T extends { path: string }> {
  entries: readonly T[];
  /** Row for one file; `depth` is the nesting level, starting at 0. */
  renderFile: (entry: T, depth: number) => ReactNode;
  emptyLabel: string;
}

/**
 * Flat git paths rendered as a collapsible tree. Directories start expanded:
 * the common case is a handful of changed files, and collapsing by default
 * would hide them behind clicks.
 */
export function FileTree<T extends { path: string }>({
  entries,
  renderFile,
  emptyLabel,
}: FileTreeProps<T>) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const tree = useMemo(() => buildFileTree(entries), [entries]);

  if (entries.length === 0) {
    return <div className="panel-empty">{emptyLabel}</div>;
  }

  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNodes = (nodes: TreeNode<T>[], depth: number): ReactNode[] =>
    nodes.map((node) => {
      if (node.kind === 'file') {
        return (
          <div key={`file:${node.path}`} className="tree-file">
            {renderFile(node.entry, depth)}
          </div>
        );
      }

      const open = !collapsed.has(node.path);
      return (
        <div key={`dir:${node.path}`} className="tree-group">
          <button
            type="button"
            className="tree-dir"
            style={{ paddingLeft: 4 + depth * 11 }}
            onClick={() => toggle(node.path)}
            title={node.path}
          >
            <span className={`tree-caret ${open ? 'open' : ''}`}>▸</span>
            <span className="tree-name">{node.name}</span>
            <span className="tree-count">{node.fileCount}</span>
          </button>
          {open ? renderNodes(node.children, depth + 1) : null}
        </div>
      );
    });

  return <div className="file-tree">{renderNodes(tree, 0)}</div>;
}
