import type { DiffFileStatus, GitCompareFile } from '@nest/shared';
import type { Numstat } from './numstat.js';

export interface NameStatusEntry {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
}

function mapStatus(letter: string): DiffFileStatus {
  switch (letter) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'M':
    case 'T':
      return 'modified';
    default:
      return 'unknown';
  }
}

/**
 * Parses `git diff --name-status -z -M`: NUL separated `status`, `path`, and
 * for renames or copies the old path followed by the new one.
 */
export function parseNameStatus(raw: string): NameStatusEntry[] {
  const tokens = raw.split('\u0000');
  const entries: NameStatusEntry[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    const status = mapStatus(token.charAt(0));
    const firstPath = tokens[index + 1] ?? '';
    index += 1;
    if (!firstPath) continue;

    if (token.charAt(0) === 'R' || token.charAt(0) === 'C') {
      const newPath = tokens[index + 1] ?? '';
      index += 1;
      if (!newPath) continue;
      entries.push({ path: newPath, oldPath: firstPath, status });
      continue;
    }

    entries.push({ path: firstPath, oldPath: null, status });
  }

  return entries;
}

/** Joins name-status records with line counts; binary files keep null counts. */
export function toCompareFiles(entries: NameStatusEntry[], stats: Numstat): GitCompareFile[] {
  return entries.map((entry) => {
    const stat = stats.get(entry.path);
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
    };
  });
}
