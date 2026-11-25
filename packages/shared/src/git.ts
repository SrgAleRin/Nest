import { z } from 'zod';

export const GitFileSchema = z.object({
  path: z.string(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
  untracked: z.boolean(),
  /** Lines added/deleted against HEAD; null for binary or unreadable files. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type GitFile = z.infer<typeof GitFileSchema>;

export const GitStatusSchema = z.object({
  branch: z.string(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileSchema),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const DiffLineTypeSchema = z.enum(['add', 'del', 'context', 'meta']);
export type DiffLineType = z.infer<typeof DiffLineTypeSchema>;

export const DiffLineSchema = z.object({
  type: DiffLineTypeSchema,
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffHunkSchema = z.object({
  header: z.string(),
  section: z.string(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileStatusSchema = z.enum(['modified', 'added', 'deleted', 'renamed', 'unknown']);
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: DiffFileStatusSchema,
  staged: z.boolean(),
  hunks: z.array(DiffHunkSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  raw: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const GitDiffSchema = z.object({
  files: z.array(DiffFileSchema),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;
