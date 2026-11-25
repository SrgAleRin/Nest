import type { DiffFile, DiffHunk, DiffLine } from '@nest/shared';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPrefix(value: string): string {
  if (value === '/dev/null') return value;
  const clean = value.replace(/\t.*$/, '');
  if (clean.startsWith('a/') || clean.startsWith('b/')) return clean.slice(2);
  return clean;
}

function unquote(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  return inner.replace(/\\(["\\])/g, '$1').replace(/\\t/g, '\t');
}

export function parseUnifiedDiff(raw: string, options: { staged?: boolean } = {}): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let pendingSection = '';

  const flushFile = () => {
    if (current) {
      current.raw = current.raw.replace(/\n$/, '');
      files.push(current);
    }
    current = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = {
        path: match ? unquote(match[2] ?? '') : '',
        oldPath: null,
        status: 'modified',
        staged: options.staged ?? false,
        hunks: [],
        additions: 0,
        deletions: 0,
        raw: `${line}\n`,
      };
      pendingSection = '';
      continue;
    }

    if (!current) continue;
    current.raw += `${line}\n`;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquote(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.path = unquote(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('--- ')) {
      const value = unquote(line.slice(4));
      if (value === '/dev/null') {
        current.status = current.status === 'deleted' ? 'deleted' : 'added';
      } else {
        const oldPath = stripPrefix(value);
        if (!current.oldPath) current.oldPath = oldPath;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const value = unquote(line.slice(4));
      if (value === '/dev/null') {
        current.status = 'deleted';
      } else {
        current.path = stripPrefix(value);
      }
      continue;
    }

    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      pendingSection = hunk[5] ?? '';
      currentHunk = { header: line, section: pendingSection, lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    const marker = line.charAt(0);
    let parsed: DiffLine | null = null;
    if (marker === '+') {
      parsed = { type: 'add', oldLine: null, newLine, text: line.slice(1) };
      newLine += 1;
      current.additions += 1;
    } else if (marker === '-') {
      parsed = { type: 'del', oldLine, newLine: null, text: line.slice(1) };
      oldLine += 1;
      current.deletions += 1;
    } else if (marker === ' ') {
      parsed = { type: 'context', oldLine, newLine, text: line.slice(1) };
      oldLine += 1;
      newLine += 1;
    } else if (marker === '\\') {
      parsed = { type: 'meta', oldLine: null, newLine: null, text: line };
    }
    if (parsed) currentHunk.lines.push(parsed);
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
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
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
  };
}
