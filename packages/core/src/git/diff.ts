import type { DiffFile, DiffHunk, DiffLine } from '@nest/shared';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const DIFF_GIT_PREFIX = 'diff --git ';
const BINARY_FILES_PREFIX = 'Binary files ';
const BINARY_FILES_SUFFIX = ' differ';
const GIT_BINARY_PATCH = 'GIT binary patch';
const DEV_NULL = '/dev/null';

/** C escapes Git uses in quoted paths (`quote_c_style`). */
const ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
};

function stripPrefix(value: string): string {
  if (value === DEV_NULL) return value;
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

/** Index of the closing quote of a Git-quoted path, or -1. */
function findClosingQuote(value: string): number {
  for (let index = 1; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') return index;
  }
  return -1;
}

/** Decodes the body of a Git-quoted path: octal bytes, `\t`, `\"`, `\\`, ... */
function decodeQuotedPath(raw: string): string {
  const bytes: number[] = [];
  const chars = Array.from(raw);

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] ?? '';
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }

    const next = chars[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      continue;
    }

    const escaped = ESCAPES[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
      index += 1;
      continue;
    }

    let octal = '';
    for (let offset = 1; offset <= 3; offset += 1) {
      const digit = chars[index + offset];
      if (digit === undefined || digit < '0' || digit > '7') break;
      octal += digit;
    }
    if (octal.length > 0) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length;
      continue;
    }

    // Unknown escape: keep the backslash and let the next round handle the char.
    bytes.push(0x5c);
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Decodes a path as Git writes it in headers: either `"a/\320\277..."` with C
 * escapes, or a plain path optionally followed by a tab and timestamp.
 */
export function decodeGitPath(value: string): string {
  if (value.startsWith('"')) {
    const end = findClosingQuote(value);
    const raw = end >= 0 ? value.slice(1, end) : value.slice(1);
    return decodeQuotedPath(raw);
  }
  const tab = value.indexOf('\t');
  return tab >= 0 ? value.slice(0, tab) : value;
}

/** Encodes a path the way Git would quote it in a header. */
export function encodeGitPath(value: string): string {
  if (!/[^\x20-\x7e]|["\\]/.test(value)) return value;

  let quoted = '"';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += '\\\\';
    else if (byte === 0x09) quoted += '\\t';
    else if (byte === 0x0a) quoted += '\\n';
    else if (byte === 0x0d) quoted += '\\r';
    else if (byte >= 0x20 && byte <= 0x7e) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

interface PathPair {
  oldPath: string;
  newPath: string;
}

/**
 * Splits two paths written by Git. Unquoted paths may contain spaces, so a
 * plain separator is ambiguous; the split where both sides name the same path
 * (the common modified-file case) wins over the first match.
 */
function splitPair(
  input: string,
  separator: string,
  quotedSeparator: string,
  quotedSecond: string,
): PathPair | null {
  if (input.startsWith('"')) {
    const end = findClosingQuote(input);
    if (end < 0) return null;
    const remainder = input.slice(end + 1);
    if (!remainder.startsWith(quotedSeparator)) return null;
    return {
      oldPath: decodeGitPath(input.slice(0, end + 1)),
      newPath: decodeGitPath(remainder.slice(quotedSeparator.length)),
    };
  }

  const candidates: number[] = [];
  for (const needle of [separator, quotedSecond]) {
    for (let index = input.indexOf(needle); index >= 0; index = input.indexOf(needle, index + 1)) {
      candidates.push(index);
    }
  }
  candidates.sort((left, right) => left - right);
  if (candidates.length === 0) return null;

  const symmetric = candidates.find((index) => {
    const first = stripPrefix(input.slice(0, index));
    const second = stripPrefix(decodeGitPath(input.slice(index + quotedSeparator.length)));
    return first === second;
  });
  const split = symmetric ?? candidates[0] ?? -1;
  if (split < 0) return null;
  return {
    oldPath: decodeGitPath(input.slice(0, split)),
    newPath: decodeGitPath(input.slice(split + quotedSeparator.length)),
  };
}

/** Splits `a/x b/y` / `"a/x" "b/y"` from a `diff --git` line. */
function splitDiffGitPaths(rest: string): PathPair | null {
  return splitPair(rest, ' b/', ' ', ' "b/');
}

/** Splits `a/x and b/y` / `"a/x" and "b/y"` from a `Binary files ... differ` line. */
function splitBinaryPaths(inner: string): PathPair | null {
  return splitPair(inner, ' and ', ' and ', ' and ');
}

/**
 * Applies a non-hunk header line. Called only outside a hunk so that content
 * lines such as `--- before` / `+++ after` stay content.
 */
function applyHeader(file: DiffFile, line: string): void {
  if (line.startsWith('new file mode')) {
    file.status = 'added';
    return;
  }
  if (line.startsWith('deleted file mode')) {
    file.status = 'deleted';
    return;
  }
  if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
    file.modeChanged = true;
    return;
  }
  if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
    if (file.status === 'modified') file.status = 'renamed';
    return;
  }
  if (line.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = decodeGitPath(line.slice('rename from '.length));
    return;
  }
  if (line.startsWith('rename to ')) {
    file.status = 'renamed';
    file.path = decodeGitPath(line.slice('rename to '.length));
    return;
  }
  if (line.startsWith('copy from ')) {
    // A copy is reported as a new file with its source recorded in oldPath.
    file.status = 'added';
    file.oldPath = decodeGitPath(line.slice('copy from '.length));
    return;
  }
  if (line.startsWith('copy to ')) {
    file.status = 'added';
    file.path = decodeGitPath(line.slice('copy to '.length));
    return;
  }
  if (line.startsWith(BINARY_FILES_PREFIX) && line.endsWith(BINARY_FILES_SUFFIX)) {
    file.binary = true;
    const inner = line.slice(BINARY_FILES_PREFIX.length, -BINARY_FILES_SUFFIX.length);
    const paths = splitBinaryPaths(inner);
    if (paths) {
      // `/dev/null` marks the absent side of an added or deleted file.
      file.oldPath = paths.oldPath === DEV_NULL ? null : stripPrefix(paths.oldPath);
      if (paths.newPath !== DEV_NULL) file.path = stripPrefix(paths.newPath);
    }
    return;
  }
  if (line === GIT_BINARY_PATCH) {
    file.binary = true;
    return;
  }
  if (line.startsWith('--- ')) {
    const value = decodeGitPath(line.slice(4));
    if (value === DEV_NULL) {
      // A new file: there is no old side to anchor comments to.
      file.oldPath = null;
      if (file.status !== 'deleted') file.status = 'added';
    } else {
      file.oldPath = stripPrefix(value);
    }
    return;
  }
  if (line.startsWith('+++ ')) {
    const value = decodeGitPath(line.slice(4));
    if (value === DEV_NULL) {
      file.status = 'deleted';
    } else {
      file.path = stripPrefix(value);
    }
  }
}

export function parseUnifiedDiff(raw: string, options: { staged?: boolean } = {}): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const flushFile = (): void => {
    if (current) {
      if (!current.path && current.oldPath) current.path = current.oldPath;
      current.raw = current.raw.replace(/\n$/, '');
      files.push(current);
    }
    current = null;
    currentHunk = null;
    oldRemaining = 0;
    newRemaining = 0;
  };

  for (const line of lines) {
    // Header checks only apply outside a hunk: within a hunk the declared line
    // counts decide what is content, so `--- before` / `+++ after` stay content.
    const hunkActive = currentHunk !== null && (oldRemaining > 0 || newRemaining > 0);

    if (line.startsWith(DIFF_GIT_PREFIX) && !hunkActive) {
      flushFile();
      const paths = splitDiffGitPaths(line.slice(DIFF_GIT_PREFIX.length));
      current = {
        path: paths ? stripPrefix(paths.newPath) : '',
        oldPath: paths ? stripPrefix(paths.oldPath) : null,
        status: 'modified',
        staged: options.staged ?? false,
        hunks: [],
        additions: 0,
        deletions: 0,
        raw: `${line}\n`,
        binary: false,
        modeChanged: false,
      };
      continue;
    }

    if (!current) continue;
    current.raw += `${line}\n`;

    if (!hunkActive) {
      const hunk = HUNK_RE.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
        currentHunk = { header: line, section: hunk[5] ?? '', lines: [] };
        current.hunks.push(currentHunk);
        continue;
      }

      if (currentHunk && line.startsWith('\\')) {
        currentHunk.lines.push({ type: 'meta', oldLine: null, newLine: null, text: line });
        continue;
      }

      applyHeader(current, line);
      continue;
    }

    const hunk = currentHunk;
    if (!hunk) continue;

    const marker = line.charAt(0);
    if (marker === '\\') {
      hunk.lines.push({ type: 'meta', oldLine: null, newLine: null, text: line });
      continue;
    }

    let parsed: DiffLine | null = null;
    if (marker === '+') {
      parsed = { type: 'add', oldLine: null, newLine, text: line.slice(1) };
      newLine += 1;
      newRemaining -= 1;
      current.additions += 1;
    } else if (marker === '-') {
      parsed = { type: 'del', oldLine, newLine: null, text: line.slice(1) };
      oldLine += 1;
      oldRemaining -= 1;
      current.deletions += 1;
    } else if (marker === ' ' || marker === '') {
      parsed = { type: 'context', oldLine, newLine, text: line.slice(1) };
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
    if (parsed) hunk.lines.push(parsed);
  }

  flushFile();
  return files.filter((file) => file.path.length > 0);
}

export function buildUntrackedDiff(path: string, content: string, staged = false): DiffFile {
  const normalized = content.replace(/\r\n/g, '\n');
  const hasTrailingNewline = normalized.endsWith('\n');
  const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = body.length === 0 ? [] : body.split('\n');
  const hunkLines: DiffLine[] = lines.map((text, index) => ({
    type: 'add',
    oldLine: null,
    newLine: index + 1,
    text,
  }));
  const header = `@@ -0,0 +1,${lines.length} @@`;
  const raw = [
    `diff --git ${encodeGitPath(`a/${path}`)} ${encodeGitPath(`b/${path}`)}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${encodeGitPath(`b/${path}`)}`,
    header,
    ...lines.map((text) => `+${text}`),
  ].join('\n');
  return {
    path,
    oldPath: null,
    status: 'added',
    staged,
    hunks: [{ header, section: '', lines: hunkLines }],
    additions: lines.length,
    deletions: 0,
    raw,
    binary: false,
    modeChanged: false,
  };
}
