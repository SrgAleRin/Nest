import type { GitCommit } from '@nest/shared';
import { parseRefDecorations } from './refs.js';

/**
 * One NUL field per value and a record separator after each commit; the commit
 * body may contain newlines, so splitting on lines would corrupt it.
 */
export const LOG_FORMAT =
  ['%H', '%P', '%an', '%ae', '%aI', '%cI', '%D', '%s', '%b'].join('%x00') + '%x1e';

const FIELD_SEPARATOR = '\u0000';
const RECORD_SEPARATOR = '\u001e';

export function parseLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];

  for (const chunk of raw.split(RECORD_SEPARATOR)) {
    const record = chunk.replace(/^\r?\n/, '').replace(/\s+$/, '');
    if (!record) continue;

    const fields = record.split(FIELD_SEPARATOR);
    if (fields.length < 9) continue;

    const [hash, parents, authorName, authorEmail, authoredAt, committedAt, refs, subject, body] =
      fields as [string, string, string, string, string, string, string, string, string];

    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      authorName,
      authorEmail,
      authoredAt,
      committedAt,
      subject,
      body: body.trim(),
      refs: parseRefDecorations(refs),
    });
  }

  return commits;
}
