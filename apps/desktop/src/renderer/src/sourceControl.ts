import type { GitFile } from '@nest/shared';

/**
 * The side of a change. `staged` is the index (HEAD → index), `unstaged` is the
 * working tree (index → worktree). A partially staged file belongs to both.
 */
export type ChangeSide = 'staged' | 'unstaged';

/** One row of the change list: a file on one side, never both. */
export interface ChangeRow {
  /** Path after the change; the new name of a rename or copy. */
  path: string;
  /** Source path of a rename or copy, null for every other change. */
  oldPath: string | null;
  copied: boolean;
  side: ChangeSide;
  /** Porcelain letter of this side (`M`, `A`, `D`, `R`, `C`, `T`, `?`). */
  letter: string;
  additions: number | null;
  deletions: number | null;
}

/** An unmerged entry: it is neither staged nor unstaged, so it has no side. */
export interface ConflictRow {
  path: string;
  oldPath: string | null;
  copied: boolean;
  /** Both porcelain letters, e.g. `UU` or `AA`. */
  letter: string;
  additions: number | null;
  deletions: number | null;
}

export interface ChangeSections {
  staged: ChangeRow[];
  unstaged: ChangeRow[];
  untracked: ChangeRow[];
  conflicts: ConflictRow[];
  /** Unique changed paths; a partially staged file counts once, not twice. */
  total: number;
}

export const EMPTY_CHANGE_SECTIONS: ChangeSections = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
  total: 0,
};

/** The porcelain letter of one side; `·` when that side has no change. */
export function sideLetter(file: GitFile, side: ChangeSide): string {
  const raw = side === 'staged' ? file.indexStatus : file.worktreeStatus;
  return raw.trim() || '·';
}

/** Both letters of an unmerged entry, e.g. `UU`. */
export function conflictLetter(file: GitFile): string {
  return `${file.indexStatus}${file.worktreeStatus}`.trim() || 'U';
}

/** Row letter for the list; untracked files read as `?`, not as `A`. */
export function rowLetter(row: ChangeRow | ConflictRow): string {
  return row.letter;
}

/**
 * Projects the flat `GitFile[]` of one status into the four sections the panel
 * shows. The explicit booleans decide, never the letters: a partially staged
 * file appears in `Staged` **and** `Unstaged` with that side's letter, an
 * untracked file only in `Untracked`, and a conflict only in `Conflicts`.
 */
export function projectChanges(files: readonly GitFile[]): ChangeSections {
  const staged: ChangeRow[] = [];
  const unstaged: ChangeRow[] = [];
  const untracked: ChangeRow[] = [];
  const conflicts: ConflictRow[] = [];
  const paths = new Set<string>();

  for (const file of files) {
    paths.add(file.path);
    const shared = {
      path: file.path,
      oldPath: file.oldPath,
      copied: file.copied,
      additions: file.additions,
      deletions: file.deletions,
    };
    if (file.conflict) {
      conflicts.push({ ...shared, letter: conflictLetter(file) });
      continue;
    }
    if (file.staged) {
      staged.push({ ...shared, side: 'staged', letter: sideLetter(file, 'staged') });
    }
    if (file.untracked) {
      untracked.push({ ...shared, side: 'unstaged', letter: '?' });
    } else if (file.unstaged) {
      unstaged.push({ ...shared, side: 'unstaged', letter: sideLetter(file, 'unstaged') });
    }
  }

  return {
    staged: sortRows(staged),
    unstaged: sortRows(unstaged),
    untracked: sortRows(untracked),
    conflicts: sortRows(conflicts),
    total: paths.size,
  };
}

function sortRows<T extends { path: string }>(rows: T[]): T[] {
  return rows.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { numeric: true }),
  );
}

/** Case-insensitive match on the path and on the source path of a rename. */
export function matchesFilter(
  row: { path: string; oldPath?: string | null },
  filter: string,
): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  if (row.path.toLowerCase().includes(needle)) return true;
  return Boolean(row.oldPath && row.oldPath.toLowerCase().includes(needle));
}

/** The same sections with the filter applied; counters follow the visible rows. */
export function filterSections(sections: ChangeSections, filter: string): ChangeSections {
  if (!filter.trim()) return sections;
  const staged = sections.staged.filter((row) => matchesFilter(row, filter));
  const unstaged = sections.unstaged.filter((row) => matchesFilter(row, filter));
  const untracked = sections.untracked.filter((row) => matchesFilter(row, filter));
  const conflicts = sections.conflicts.filter((row) => matchesFilter(row, filter));
  return {
    staged,
    unstaged,
    untracked,
    conflicts,
    total: countPaths([...staged, ...unstaged, ...untracked, ...conflicts]),
  };
}

/** Unique paths of the given rows. */
export function countPaths(rows: ReadonlyArray<ChangeRow | ConflictRow>): number {
  return new Set(rows.map((row) => row.path)).size;
}

/** True when the filter shows less than the status has. */
export function isEmptySections(sections: ChangeSections): boolean {
  return sections.total === 0;
}

/** Stable identity of a row, used for the selected row and for React keys. */
export function rowKey(row: ChangeRow): string {
  return `${row.side}:${row.path}`;
}

/** Tone class of a row; conflicts read as their own colour. */
export function rowTone(row: ChangeRow | ConflictRow): string {
  if ((row as ConflictRow).letter.length > 1) return 'tone-conflict';
  switch (row.letter) {
    case 'A':
      return 'tone-added';
    case 'D':
      return 'tone-deleted';
    case 'R':
    case 'C':
      return 'tone-renamed';
    case 'M':
    case 'T':
      return 'tone-modified';
    default:
      return 'tone-untracked';
  }
}

/** Paths an explicit `Stage all` act on: everything not in conflict. */
export function stageablePaths(files: readonly GitFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (file.conflict) continue;
    if (file.unstaged || file.untracked) paths.add(file.path);
  }
  return [...paths];
}

/** Unique changed paths of a status; the badge counts paths, not rows. */
export function changedPathCount(files: readonly GitFile[]): number {
  return new Set(files.map((file) => file.path)).size;
}

/**
 * The scope of `Discard` in words. Core restores tracked paths from HEAD with
 * `git restore --source=HEAD --staged --worktree`, so it drops the staged and
 * the unstaged side of that path; untracked files are deleted instead. Without
 * HEAD the restore cannot run at all.
 */
export function discardWarning(
  row: ChangeRow | ConflictRow,
  options: { hasHead: boolean },
): string {
  const target = row.oldPath ? `${row.oldPath} → ${row.path}` : row.path;
  if (!options.hasHead) {
    return `Discard ${target}? This branch has no commits yet, so there is no HEAD to restore from and the operation will fail.`;
  }
  if (row.letter === '?' || row.letter === '') {
    return `Discard ${target}? This deletes the untracked file from disk. This cannot be undone.`;
  }
  return [
    `Discard ${target}?`,
    '',
    'Restores the path from HEAD (git restore --source=HEAD --staged --worktree),',
    'so it drops the staged and the unstaged changes of this path, not only the',
    'unstaged side. This cannot be undone.',
  ].join('\n');
}
