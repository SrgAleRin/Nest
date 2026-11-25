export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
}

export type Numstat = Map<string, NumstatEntry>;

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

/** Adds staged and unstaged stats for the same file (used without a HEAD commit). */
export function mergeNumstat(target: Numstat, source: Numstat): void {
  for (const [filePath, entry] of source) {
    const existing = target.get(filePath);
    if (!existing) {
      target.set(filePath, { ...entry });
      continue;
    }
    target.set(filePath, {
      additions:
        existing.additions === null || entry.additions === null
          ? null
          : existing.additions + entry.additions,
      deletions:
        existing.deletions === null || entry.deletions === null
          ? null
          : existing.deletions + entry.deletions,
    });
  }
}
