export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
}

export type Numstat = Map<string, NumstatEntry>;

/**
 * The two diffs a status row is made of: `HEAD → index` and `index → worktree`.
 * They are read separately, so a partially staged file keeps its own counters
 * per side instead of one `HEAD → worktree` sum shown twice.
 */
export interface NumstatSides {
  staged: Numstat;
  unstaged: Numstat;
}

/**
 * Parses `git diff --numstat -z` output. Records are NUL-terminated and look
 * like `12\t3\tpath`; renames carry an empty path followed by the old and the
 * new path, so the map is keyed by the new path (the one git status reports).
 * Binary files use `-` for both counters and become null.
 */
export function parseNumstat(raw: string): Numstat {
  const stats: Numstat = new Map();
  const tokens = raw.split('\0');

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const firstTab = token.indexOf('\t');
    if (firstTab < 0) continue;
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (secondTab < 0) continue;

    const added = token.slice(0, firstTab);
    const deleted = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);

    if (filePath === '') {
      // Rename/copy: skip the old path, the new path follows it.
      index += 2;
      filePath = tokens[index] ?? '';
    }
    if (!filePath) continue;

    stats.set(filePath, {
      additions: added === '-' ? null : Number(added),
      deletions: deleted === '-' ? null : Number(deleted),
    });
  }

  return stats;
}

/**
 * Adds one counter pair to another. A binary side has no line counts, so the
 * sum stays unknown unless that side reports nothing at all.
 */
function addCounts(left: number | null, right: number | null): number | null {
  if (left === null) return right === 0 ? 0 : null;
  if (right === null) return left === 0 ? 0 : null;
  return left + right;
}

/** Adds stats for the same file (the aggregate view, or a merged fallback). */
export function mergeNumstat(target: Numstat, source: Numstat): void {
  for (const [filePath, entry] of source) {
    const existing = target.get(filePath);
    if (!existing) {
      target.set(filePath, { ...entry });
      continue;
    }
    target.set(filePath, {
      additions: addCounts(existing.additions, entry.additions),
      deletions: addCounts(existing.deletions, entry.deletions),
    });
  }
}

/**
 * The aggregate `HEAD → worktree` counters a status row shows. A side without a
 * numstat record contributes nothing, so a file changed on one side only keeps
 * the counts of that side.
 */
export function sumNumstat(sides: NumstatSides): Numstat {
  const total: Numstat = new Map();
  mergeNumstat(total, sides.staged);
  mergeNumstat(total, sides.unstaged);
  return total;
}
