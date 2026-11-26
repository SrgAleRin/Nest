import type { GitBranch } from '@nest/shared';

/** One record per ref, NUL separated; subjects never contain newlines. */
export const BRANCH_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:iso-strict)',
  '%(subject)',
  '%(HEAD)',
  '%(symref)',
].join('%00');

const FIELD_SEPARATOR = '\u0000';
const HEADS_PREFIX = 'refs/heads/';
const REMOTES_PREFIX = 'refs/remotes/';

export interface BranchRecord extends GitBranch {
  /** Full ref name, used to tell local and remote-tracking refs apart. */
  refname: string;
}

export function parseTrack(value: string): { ahead: number; behind: number; gone: boolean } {
  return {
    ahead: Number(/ahead (\d+)/.exec(value)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(value)?.[1] ?? 0),
    gone: value.includes('gone'),
  };
}

export function parseBranches(raw: string): BranchRecord[] {
  const branches: BranchRecord[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length < 8) continue;

    const [refname, tip, upstream, track, committedAt, subject, head, symref] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    // `origin/HEAD` and other symbolic refs only point at another branch and
    // would show up twice in the branch list.
    if (symref) continue;

    const remote = refname.startsWith(REMOTES_PREFIX);
    if (!remote && !refname.startsWith(HEADS_PREFIX)) continue;

    const name = refname.slice(remote ? REMOTES_PREFIX.length : HEADS_PREFIX.length);
    if (!name || name.endsWith('/HEAD')) continue;

    const parsedTrack = parseTrack(track);
    branches.push({
      refname,
      name,
      remote,
      current: head === '*',
      upstream: upstream || null,
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      gone: parsedTrack.gone,
      tip,
      subject,
      committedAt,
    });
  }

  return branches;
}
