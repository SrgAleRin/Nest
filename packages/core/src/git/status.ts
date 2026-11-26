export interface StatusFile {
  path: string;
  /** Source path of a rename or copy; null for every other kind of change. */
  oldPath: string | null;
  /** True for a detected copy (C) instead of a rename (R). */
  copied: boolean;
  indexStatus: string;
  worktreeStatus: string;
  /** Unmerged entry; neither staged nor unstaged. */
  conflict: boolean;
  /** Index side has changes. Independent of `unstaged`. */
  staged: boolean;
  /** Worktree side has changes, or the file is untracked. */
  unstaged: boolean;
  untracked: boolean;
}

/** Porcelain v1 status pairs that mean the path is unmerged. */
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export interface ParsedStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
}

/**
 * Parses `git status --porcelain=v1 -z --branch --untracked-files=all` output.
 *
 * Records are NUL-terminated. For a rename or a copy the record holds the new
 * path and the *next* one carries the original path, so both halves stay
 * attached to the entry; without the source path, discarding or unstaging the
 * change leaves the other half behind.
 */
export function parseStatus(raw: string): ParsedStatus {
  const tokens = raw.split('\0');
  let branch = 'HEAD';
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: StatusFile[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.startsWith('## ')) {
      const header = token.slice(3);
      if (header.startsWith('No commits yet on ')) {
        branch = header.slice('No commits yet on '.length);
      } else if (header.startsWith('HEAD (no branch)')) {
        branch = 'HEAD';
      } else {
        const [left, right] = header.split('...');
        branch = left ?? 'HEAD';
        if (right) {
          const upstreamMatch = /^([^\s[]+)/.exec(right);
          upstream = upstreamMatch?.[1] ?? null;
          ahead = Number(/ahead (\d+)/.exec(right)?.[1] ?? 0);
          behind = Number(/behind (\d+)/.exec(right)?.[1] ?? 0);
        }
      }
      continue;
    }

    if (token.length < 4) continue;
    const indexStatus = token[0] ?? ' ';
    const worktreeStatus = token[1] ?? ' ';
    const filePath = token.slice(3);
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const conflict = CONFLICT_PAIRS.has(`${indexStatus}${worktreeStatus}`);
    // Both sides are reported, not one classifier: a partially staged file has
    // staged and unstaged work at the same time. A conflict has neither until
    // the user resolves it.
    const staged = !conflict && !untracked && indexStatus !== ' ' && indexStatus !== '?';
    const unstaged = !conflict && (untracked || worktreeStatus !== ' ');
    const renamed = indexStatus === 'R' || worktreeStatus === 'R';
    const copied = indexStatus === 'C' || worktreeStatus === 'C';
    let oldPath: string | null = null;
    if (renamed || copied) {
      oldPath = tokens[index + 1] ?? null;
      index += 1;
    }

    files.push({
      path: filePath,
      oldPath,
      copied,
      indexStatus,
      worktreeStatus,
      conflict,
      staged,
      unstaged,
      untracked,
    });
  }

  return { branch, upstream, ahead, behind, files };
}
