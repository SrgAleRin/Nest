import type { CommentView, DiffDescriptor, DiffFile, DiffMode } from '@nest/shared';
import { isStaleDiff, type SideCounts } from './diffMode';
import type { GitSelection } from './state/gitSnapshot';

/**
 * The step from a change-list row to the diff viewer: one file, one side, one
 * request. The store remembers the selection and the panel opens it; these
 * helpers are pure so the guarantees — the requested side opens in one step, a
 * late answer never labels another file, a file that left the comparison says
 * so — are testable without a window.
 */

/** No side counts known: used before the snapshot or a patch is available. */
export const EMPTY_SIDE_COUNTS: SideCounts = { staged: 0, unstaged: 0 };

/** Exactly one `git.diff` call: the task, the comparison and the file. */
export interface DiffRequest {
  taskId: string;
  mode: DiffMode;
  /** Workspace-relative file when one row is open; `null` for the whole patch. */
  path: string | null;
}

/** Stable identity of a request; two calls with the same key are the same view. */
export function diffRequestKey(request: DiffRequest): string {
  return `${request.taskId}\u0000${request.mode}\u0000${request.path ?? ''}`;
}

/**
 * True when an answer may be drawn: it belongs to the request the panel still
 * wants — same task, same comparison, same file — and the server confirmed the
 * comparison. A late answer for the file that was open a moment ago is dropped
 * instead of being labelled as the new one.
 */
export function isCurrentDiffAnswer(
  made: DiffRequest,
  wanted: DiffRequest | null,
  descriptor: DiffDescriptor | null,
): boolean {
  if (!wanted) return false;
  if (diffRequestKey(made) !== diffRequestKey(wanted)) return false;
  return !isStaleDiff(descriptor, wanted.mode);
}

/**
 * The file a selection points at, from the answer of a restricted diff. `null`
 * means the file is not in that comparison; the panel must say so rather than
 * show whatever else the answer contains.
 */
export function pickTargetFile(files: readonly DiffFile[], path: string | null): DiffFile | null {
  if (!path) return null;
  return files.find((file) => file.path === path) ?? null;
}

/** Head label of the single-file view: the file and the side it was opened on. */
export function targetLabel(target: GitSelection): string {
  return `${target.path} · ${target.mode} side`;
}

/** The comparison in the panel's words, lower case for use inside a sentence. */
function comparisonName(mode: DiffMode): string {
  switch (mode) {
    case 'both':
      return 'staged or unstaged';
    case 'unstaged':
      return 'unstaged';
    case 'staged':
      return 'staged';
    case 'base':
      return 'base';
  }
}

/**
 * The selected file has no change on the side the panel now compares. The view
 * says so and offers the way back; it never falls back to another patch.
 */
export function missingTargetMessage(target: GitSelection, mode: DiffMode): string {
  return `Not in this comparison: ${target.path} has no ${comparisonName(mode)} change.`;
}

/**
 * Core places notes against the whole comparison. With one file on screen the
 * notes of the other files are not on this patch: they keep their text and
 * become `Outside this patch` entries with the reason instead of disappearing.
 */
export function restrictComments(
  comments: readonly CommentView[],
  path: string | null,
): CommentView[] {
  if (path === null) return [...comments];
  return comments.map((comment) =>
    comment.placement.kind === 'inline' && comment.filePath !== path
      ? { ...comment, placement: { kind: 'outside', reason: 'file_not_in_diff' } }
      : comment,
  );
}

/**
 * Side counters derived from a patch, for the mode switch badges. `both` mixes
 * both sides and is exact; a single-side view speaks only for its own side, so
 * the other one stays zero until the shared snapshot answers.
 */
export function diffSideCounts(diff: { files: readonly DiffFile[] } | null): SideCounts {
  if (!diff) return EMPTY_SIDE_COUNTS;
  let staged = 0;
  let unstaged = 0;
  for (const file of diff.files) {
    if (file.staged) staged += 1;
    else unstaged += 1;
  }
  return { staged, unstaged };
}

/**
 * Escape leaves the single-file view, so it must not fire while the user types
 * in a field: the field owns that key.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!element) return false;
  const tag = typeof element.tagName === 'string' ? element.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return element.isContentEditable === true;
}

/** The mode the panel opens with for a selection; the whole patch otherwise. */
export function initialMode(target: GitSelection | null, fallback: DiffMode): DiffMode {
  return target?.mode ?? fallback;
}
