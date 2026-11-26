export interface TreeFile<T> {
  kind: 'file';
  /** Last path segment. */
  name: string;
  path: string;
  entry: T;
}

export interface TreeDir<T> {
  kind: 'dir';
  /** One or more segments, joined with `/` when single-child chains collapse. */
  name: string;
  path: string;
  children: Array<TreeDir<T> | TreeFile<T>>;
  /** Files below this directory, used for the collapsed summary. */
  fileCount: number;
}

export type TreeNode<T> = TreeDir<T> | TreeFile<T>;

interface DirBuilder<T> {
  name: string;
  path: string;
  dirs: Map<string, DirBuilder<T>>;
  files: TreeFile<T>[];
}

function createDir<T>(name: string, parentPath: string): DirBuilder<T> {
  return {
    name,
    path: parentPath ? `${parentPath}/${name}` : name,
    dirs: new Map(),
    files: [],
  };
}

function sortNodes<T>(nodes: Array<TreeDir<T> | TreeFile<T>>): Array<TreeDir<T> | TreeFile<T>> {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Turns flat git paths into a directory tree. Directory chains with a single
 * child directory and no files of their own collapse into one row (`src/main`),
 * which is what editors do and what keeps narrow side panels readable.
 */
export function buildFileTree<T extends { path: string }>(
  entries: readonly T[],
  options: { compact?: boolean } = {},
): TreeNode<T>[] {
  const root: DirBuilder<T> = { name: '', path: '', dirs: new Map(), files: [] };

  for (const entry of entries) {
    const segments = entry.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1] ?? entry.path;
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = createDir(segment, dir.path);
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push({ kind: 'file', name: fileName, path: entry.path, entry });
  }

  const toNodes = (dir: DirBuilder<T>): Array<TreeDir<T> | TreeFile<T>> => {
    const dirs: TreeDir<T>[] = [...dir.dirs.values()].map((child) => {
      const children = toNodes(child);
      return {
        kind: 'dir' as const,
        name: child.name,
        path: child.path,
        children,
        fileCount: countFiles(children),
      };
    });
    return sortNodes([...dirs, ...dir.files]);
  };

  const nodes = toNodes(root);
  return options.compact === false ? nodes : compactChains(nodes);
}

function countFiles<T>(nodes: Array<TreeDir<T> | TreeFile<T>>): number {
  let total = 0;
  for (const node of nodes) {
    total += node.kind === 'file' ? 1 : node.fileCount;
  }
  return total;
}

function compactChains<T>(nodes: Array<TreeDir<T> | TreeFile<T>>): Array<TreeDir<T> | TreeFile<T>> {
  return nodes.map((node) => {
    if (node.kind !== 'dir') return node;
    const children = compactChains(node.children);
    let current: TreeDir<T> = { ...node, children };

    while (current.children.length === 1 && current.children[0]?.kind === 'dir') {
      const only = current.children[0];
      current = {
        kind: 'dir',
        name: `${current.name}/${only.name}`,
        path: only.path,
        children: only.children,
        fileCount: only.fileCount,
      };
    }

    return current;
  });
}

/** Directories are expanded by default; the panel stores the collapsed ones. */
export function isTreeFile<T>(node: TreeNode<T>): node is TreeFile<T> {
  return node.kind === 'file';
}
