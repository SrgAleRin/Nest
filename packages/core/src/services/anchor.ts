/**
 * Comment anchors are stored as the text of the commented line block plus the
 * old line numbers. After the file changes, the text is searched again so a
 * comment can follow its line; when the text is gone the comment is stale.
 */

export function anchorBlockText(lines: string[], line: number, endLine: number): string | null {
  const start = line - 1;
  if (start < 0 || endLine > lines.length || endLine < line) return null;
  return lines
    .slice(start, endLine)
    .map((value) => value.trimEnd())
    .join('\n');
}

/**
 * Returns the 1-based line where the anchor block now starts, or null when the
 * text no longer exists. Among several matches the one closest to the old
 * position wins, which keeps duplicated snippets predictable.
 */
export function findAnchorLine(
  lines: string[],
  anchorText: string,
  preferredLine: number,
): number | null {
  const block = anchorText.split('\n');
  if (block.length === 0 || lines.length < block.length) return null;

  let best: number | null = null;
  for (let start = 0; start + block.length <= lines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < block.length; offset += 1) {
      if ((lines[start + offset] ?? '').trimEnd() !== block[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const line = start + 1;
    if (line === preferredLine) return line;
    if (best === null || Math.abs(line - preferredLine) < Math.abs(best - preferredLine)) {
      best = line;
    }
  }

  return best;
}
