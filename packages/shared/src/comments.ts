import { z } from 'zod';
import { ReviewCommentSchema } from './schemas.js';

/**
 * Why a saved note is not drawn on the patch the Diff panel is showing. A note
 * is real in all of these cases — the hunk simply is not part of this
 * comparison — so the panel keeps it reachable instead of hiding it.
 */
export const CommentOutsideReasonSchema = z.enum([
  /** The note was written against another comparison (staged vs unstaged vs base). */
  'other_mode',
  /** The change moved into the index, so the viewed side no longer shows it. */
  'staged',
  /** Nothing is left locally: the hunk is in history (or in the task base). */
  'committed',
  /** The note's file is not part of this patch at all. */
  'file_not_in_diff',
  /** Same file and comparison, but the line is outside the visible hunks. */
  'not_in_patch',
]);
export type CommentOutsideReason = z.infer<typeof CommentOutsideReasonSchema>;

/**
 * Where a note belongs in the panel: on a visible row, in the stale area, or in
 * the notes-outside-patch area with the reason it is off-patch.
 */
export const CommentPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline') }),
  z.object({ kind: z.literal('stale') }),
  z.object({ kind: z.literal('outside'), reason: CommentOutsideReasonSchema }),
]);
export type CommentPlacement = z.infer<typeof CommentPlacementSchema>;

export const CommentViewSchema = ReviewCommentSchema.extend({ placement: CommentPlacementSchema });
export type CommentView = z.infer<typeof CommentViewSchema>;
