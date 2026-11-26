/**
 * How a multi-line block is written into a harness PTY.
 *
 * Agent TUIs that enable bracketed paste keep the pasted block as one input,
 * newlines included, and submit it once with a single Enter. A CLI that does
 * not understand `CSI 200~` shows those bytes literally, so it gets plain
 * lines instead: one submitted line per `\r`.
 */
export type PasteInputMode = 'bracketed-paste' | 'line';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** A terminator inside the note would end the paste early and split it. */
const STRAY_END = PASTE_END;

/**
 * The exact bytes written for a block of text.
 *
 * - `bracketed-paste`: `CSI 200~` + text (`\n` newlines) + `CSI 201~` + `\r`.
 * - `line`: every line terminated with `\r`, so each one is submitted on its
 *   own and the last `\r` submits the block. Blank lines are dropped: an empty
 *   input would only submit an empty prompt.
 *
 * Stray `CSI 201~` sequences inside the text are stripped either way: they
 * would end the paste early and split the note.
 */
export function buildPaste(text: string, mode: PasteInputMode): string {
  const normalized = text.split(STRAY_END).join('').replace(/\r\n/g, '\n');
  if (mode === 'bracketed-paste') {
    return `${PASTE_START}${normalized}${PASTE_END}\r`;
  }
  const lines = normalized.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => `${line}\r`).join('');
}
