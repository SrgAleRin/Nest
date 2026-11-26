import { NestError } from '../errors.js';

/**
 * Branch names, tags and SHA-1s that may be passed to git as a single
 * revision. Refs are never concatenated into a command line, but a value
 * starting with `-` would still be read as an option and `..`/`@{` turn a
 * single revision into a range or a reflog lookup, so the allowlist stays
 * narrow.
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

export function assertRef(value: string, label = 'ref'): string {
  const invalid =
    value.length === 0 ||
    value.length > 250 ||
    !REF_RE.test(value) ||
    value.includes('..') ||
    value.includes('@{') ||
    value.includes('//') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock');
  if (invalid) {
    throw new NestError('invalid_ref', `Invalid ${label}: ${value}`);
  }
  return value;
}

/** `%D` decorations: `HEAD -> main, origin/main, tag: v1.0`. */
export function parseRefDecorations(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(', ')
    .map((entry) => entry.replace(/^HEAD -> /, '').trim())
    .filter((entry) => entry.length > 0);
}
