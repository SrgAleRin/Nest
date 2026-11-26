import { z } from 'zod';

export const GitFileSchema = z.object({
  path: z.string(),
  /**
   * Source path of a rename or copy reported by porcelain status; null for
   * every other kind of change. Both paths belong to the entry: git actions
   * must receive the pair, or only half of the change is undone.
   */
  oldPath: z.string().nullable(),
  /** True when the entry is a detected copy (C) rather than a rename (R). */
  copied: z.boolean(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  /**
   * Unmerged entry (`DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`). A conflict is
   * its own state: it is neither staged nor unstaged, so a panel cannot offer
   * a stage action that would resolve it by accident.
   */
  conflict: z.boolean(),
  /**
   * The index side has changes. Not exclusive with `unstaged`: a partially
   * staged file reports both sides in one entry.
   */
  staged: z.boolean(),
  /** The worktree side has changes, or the file is untracked. */
  unstaged: z.boolean(),
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
  /** True when Git reported a binary diff; such files have no textual hunks. */
  binary: z.boolean().optional(),
  /** True when only the file mode changed (chmod), so there are no textual hunks. */
  modeChanged: z.boolean().optional(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

/** What the Diff panel compares. */
export const DiffModeSchema = z.enum(['both', 'unstaged', 'staged', 'base']);
export type DiffMode = z.infer<typeof DiffModeSchema>;

/** Staged and unstaged work both stay visible by default. */
export const DEFAULT_DIFF_MODE: DiffMode = 'both';

/**
 * Side that new-side line numbers and comment anchors point at: the working
 * tree, the index, or both (`both` mode reports it per file via `staged`).
 */
export const DiffAnchorSideSchema = z.enum(['worktree', 'index', 'mixed']);
export type DiffAnchorSide = z.infer<typeof DiffAnchorSideSchema>;

/**
 * Every diff response carries the comparison it was computed for, so the panel
 * can label the current mode and drop a response that arrives after the user
 * switched modes.
 */
export const DiffDescriptorSchema = z.object({
  mode: DiffModeSchema,
  /** Ref the workspace is compared against in `base` mode; null otherwise. */
  baseRef: z.string().nullable(),
  /**
   * True when the workspace side is the working tree with the index applied,
   * so staged work is part of the comparison (`base` mode).
   */
  workspaceIncludesIndex: z.boolean(),
  /** Which side new line numbers and comment anchors refer to. */
  anchorSide: DiffAnchorSideSchema,
});
export type DiffDescriptor = z.infer<typeof DiffDescriptorSchema>;

export const GitDiffSchema = z.object({
  descriptor: DiffDescriptorSchema,
  files: z.array(DiffFileSchema),
});
export type GitDiff = z.infer<typeof GitDiffSchema>;

/** Ref names shown next to a commit: branches, remote-tracking refs, `tag: v1`. */
export const GitCommitSchema = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  committedAt: z.string(),
  subject: z.string(),
  body: z.string(),
  refs: z.array(z.string()),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

export const GitLogSchema = z.object({
  commits: z.array(GitCommitSchema),
  /** More commits exist past the requested window. */
  hasMore: z.boolean(),
});
export type GitLog = z.infer<typeof GitLogSchema>;

export const GitCommitDetailSchema = z.object({
  commit: GitCommitSchema,
  files: z.array(DiffFileSchema),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetailSchema>;

export const GitBranchSchema = z.object({
  name: z.string(),
  remote: z.boolean(),
  current: z.boolean(),
  /** Short upstream name, e.g. `origin/main`; null when the branch has none. */
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  /** Upstream was configured but no longer exists on the remote. */
  gone: z.boolean(),
  tip: z.string(),
  subject: z.string(),
  committedAt: z.string(),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;

export const GitRemoteSchema = z.object({
  name: z.string(),
  fetchUrl: z.string(),
  pushUrl: z.string(),
});
export type GitRemote = z.infer<typeof GitRemoteSchema>;

export const GitBranchesSchema = z.object({
  /** Current branch, null in detached HEAD. */
  current: z.string().nullable(),
  detached: z.boolean(),
  /** Repository has no commits yet. */
  unborn: z.boolean(),
  /** Ref the current branch is compared against by default. */
  baseRef: z.string().nullable(),
  remotes: z.array(GitRemoteSchema),
  local: z.array(GitBranchSchema),
  remote: z.array(GitBranchSchema),
});
export type GitBranches = z.infer<typeof GitBranchesSchema>;

export const GitCompareFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: DiffFileStatusSchema,
  /** Lines added/deleted; null for binary files. */
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type GitCompareFile = z.infer<typeof GitCompareFileSchema>;

export const GitCompareSchema = z.object({
  base: z.string(),
  head: z.string(),
  mergeBase: z.string().nullable(),
  /** Commits in head that base does not have. */
  ahead: z.number().int().nonnegative(),
  /** Commits in base that head does not have. */
  behind: z.number().int().nonnegative(),
  commits: z.array(GitCommitSchema),
  /** Commits beyond the requested window; `commits` is truncated. */
  commitsTruncated: z.boolean(),
  files: z.array(GitCompareFileSchema),
});
export type GitCompare = z.infer<typeof GitCompareSchema>;
