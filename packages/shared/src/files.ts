import { z } from 'zod';

/** One file of the task workspace; the path is relative to its root. */
export const WorkspaceFileSchema = z.object({
  path: z.string().min(1),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

export const WorkspaceFilesSchema = z.object({
  files: z.array(WorkspaceFileSchema),
  /** True when the workspace has more files than the panel lists. */
  truncated: z.boolean(),
});
export type WorkspaceFiles = z.infer<typeof WorkspaceFilesSchema>;

export const FileContentSchema = z.object({
  path: z.string().min(1),
  /** Size on disk in bytes, even when the preview is truncated. */
  size: z.number().int().nonnegative(),
  /** UTF-8 text; empty for binary files. */
  text: z.string(),
  binary: z.boolean(),
  /** True when only the first bytes of a large file are included. */
  truncated: z.boolean(),
});
export type FileContent = z.infer<typeof FileContentSchema>;
