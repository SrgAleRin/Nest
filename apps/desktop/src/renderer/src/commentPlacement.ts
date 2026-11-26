import type { CommentOutsideReason, CommentView, DiffMode } from '@nest/shared';

/**
 * Notes that are real but not on the patch the Diff panel is showing. Core
 * decides the placement (it is the only side that may read git); this module
 * turns that into the groups, labels and messages the panel renders.
 *
 * The area is deliberately separate from the `stale` notes: a stale note lost
 * its text, an off-patch note did not — its content is simply on another side
 * (index, history, another comparison, another file).
 */

/** Most actionable group first. */
export const OUTSIDE_REASON_ORDER: readonly CommentOutsideReason[] = [
  'staged',
  'committed',
  'other_mode',
  'file_not_in_diff',
  'not_in_patch',
];

export interface OutsideGroup {
  reason: CommentOutsideReason;
  /** Group heading, short. */
  label: string;
  /** One line that says what the reason means in this view. */
  hint: string;
  comments: CommentView[];
}

const LABELS: Record<CommentOutsideReason, { label: string; hint: string }> = {
  staged: {
    label: 'Staged',
    hint: 'The change moved into the index; the Staged view shows the line.',
  },
  committed: {
    label: 'Committed',
    hint: 'Nothing is left locally: this hunk is in history or in the base.',
  },
  other_mode: {
    label: 'Other comparison',
    hint: 'Written against a different view of the diff; open it to switch.',
  },
  file_not_in_diff: {
    label: 'File not in this patch',
    hint: 'The file has no change on the compared side right now.',
  },
  not_in_patch: {
    label: 'Outside the hunks',
    hint: 'The line is unchanged context, outside the visible hunks.',
  },
};

export function outsideReasonLabel(reason: CommentOutsideReason): string {
  return LABELS[reason].label;
}

export function outsideReasonHint(reason: CommentOutsideReason): string {
  return LABELS[reason].hint;
}

/** An outside group with its heading; groups are ordered and never empty. */
export interface OutsideSection {
  reason: CommentOutsideReason;
  label: string;
  hint: string;
  count: number;
  comments: CommentView[];
}

/** Comments core placed outside the patch, grouped by reason with counts. */
export function groupOutsideComments(comments: readonly CommentView[]): OutsideSection[] {
  const byReason = new Map<CommentOutsideReason, CommentView[]>();
  for (const comment of comments) {
    if (comment.placement.kind !== 'outside') continue;
    const list = byReason.get(comment.placement.reason);
    if (list) list.push(comment);
    else byReason.set(comment.placement.reason, [comment]);
  }

  const sections: OutsideSection[] = [];
  for (const reason of OUTSIDE_REASON_ORDER) {
    const list = byReason.get(reason);
    if (!list || list.length === 0) continue;
    list.sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line,
    );
    sections.push({
      reason,
      label: outsideReasonLabel(reason),
      hint: outsideReasonHint(reason),
      count: list.length,
      comments: list,
    });
  }
  return sections;
}

/** Notes the panel draws inline, on a visible row of the current patch. */
export function inlineComments(comments: readonly CommentView[]): CommentView[] {
  return comments.filter((comment) => comment.placement.kind === 'inline');
}

/** Notes whose anchored text is gone, kept apart from the off-patch ones. */
export function staleComments(comments: readonly CommentView[]): CommentView[] {
  return comments.filter((comment) => comment.placement.kind === 'stale');
}

/** Open notes of the off-patch area, the batch the "send open notes" button covers. */
export function openOutsideComments(comments: readonly CommentView[]): CommentView[] {
  return comments.filter(
    (comment) => comment.placement.kind === 'outside' && comment.status === 'open',
  );
}

/** Header of the outside area; counts stay visible while it is collapsed. */
export function outsideSummary(comments: readonly CommentView[]): string {
  const outside = comments.filter((comment) => comment.placement.kind === 'outside');
  if (outside.length === 0) return 'No notes outside this patch';
  const open = outside.filter((comment) => comment.status === 'open').length;
  const stale = comments.filter((comment) => comment.placement.kind === 'stale').length;
  const parts = [
    `${outside.length} note${outside.length === 1 ? '' : 's'} outside this patch`,
    `${open} open`,
  ];
  if (stale > 0) parts.push(`${stale} stale`);
  return parts.join(' · ');
}

export interface SendNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
  /** The panel copies the formatted note instead of dropping it silently. */
  copy: boolean;
}

/**
 * What to say after a send attempt. A note without a live session is never
 * dropped: the text goes to the clipboard and the message says so
 * (product §5.4, step 8).
 */
export function sendFailureNotice(
  reason: string | undefined,
  sessionTitle: string | null,
): SendNotice {
  switch (reason) {
    case 'no_active_session':
      return {
        level: 'warn',
        message:
          'No running session for this task. Start a session to send it, ' +
          'or paste the note from the clipboard.',
        copy: true,
      };
    case 'session_not_running':
      return {
        level: 'warn',
        message: 'That session is not running. The note is on the clipboard instead.',
        copy: true,
      };
    case 'session_belongs_to_another_task':
      return {
        level: 'warn',
        message: 'That session belongs to another task. The note is on the clipboard instead.',
        copy: true,
      };
    default:
      return {
        level: 'info',
        message: sessionTitle ? `Sent to ${sessionTitle}` : 'Sent',
        copy: false,
      };
  }
}

/** One line for a batch send: how many notes left, how many did not. */
export function batchSendSummary(
  sent: number,
  failed: number,
  sessionTitle: string | null,
): string {
  const where = sessionTitle ? `to ${sessionTitle}` : 'to the session';
  const notes = (count: number): string => `${count} note${count === 1 ? '' : 's'}`;
  if (failed === 0) return `Sent ${notes(sent)} ${where}`;
  if (sent === 0) {
    return `No notes sent: no running session. ${notes(failed)} copied to the clipboard.`;
  }
  return `Sent ${sent} of ${sent + failed} notes ${where}; ${failed} copied to the clipboard.`;
}

/**
 * Where "Open" should take the user: the staged side once the hunk moved into
 * the index, otherwise the comparison the note was written against.
 */
export function openTargetMode(comment: CommentView, current: DiffMode): DiffMode {
  if (comment.placement.kind === 'outside' && comment.placement.reason === 'staged') {
    return 'staged';
  }
  return comment.anchorMode ?? current;
}

/** True when "Open" has to switch the panel to another comparison. */
export function needsModeSwitch(comment: CommentView, current: DiffMode): boolean {
  return openTargetMode(comment, current) !== current;
}
