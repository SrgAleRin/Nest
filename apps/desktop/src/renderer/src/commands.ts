export type CommandKind = 'task' | 'session' | 'harness' | 'action';

export interface CommandItem {
  id: string;
  title: string;
  /** Secondary line: project/branch, session status, target panel. */
  detail?: string;
  /** Extra words that should match without being shown. */
  keywords?: string;
  kind: CommandKind;
  run: () => void;
}

/**
 * Lowerscore is worse. Prefix beats a substring, a substring beats a
 * subsequence (typing "stp" for "Start palette"), so short queries keep the
 * obvious command on top.
 */
export function scoreMatch(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const haystack = text.toLowerCase();

  const direct = haystack.indexOf(q);
  if (direct === 0) return 1000 - Math.min(500, haystack.length);
  if (direct > 0) return 600 - Math.min(300, direct);

  let cursor = 0;
  let gaps = 0;
  for (const char of q) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return 0;
    if (found > cursor) gaps += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 200 - gaps);
}

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;

  return items
    .map((item) => ({
      item,
      score: scoreMatch(
        trimmed,
        [item.title, item.detail, item.keywords].filter(Boolean).join(' '),
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}
