import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  setupScript: z.string().nullable(),
  createdAt: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskKindSchema = z.enum(['checkout', 'worktree']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = z.enum(['active', 'archived']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const MAIN_CHECKOUT_SLUG = '@main';
export const MAIN_CHECKOUT_TITLE = 'main checkout';

export const TaskSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: TaskKindSchema,
  slug: z.string().min(1),
  title: z.string().min(1),
  branch: z.string().min(1),
  workspacePath: z.string().min(1),
  status: TaskStatusSchema,
  setupError: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Task = z.infer<typeof TaskSchema>;

export const HarnessIdSchema = z.enum([
  'claude',
  'codex',
  'dsh',
  'opencode',
  'pi',
  'copilot',
  'zcode',
  'qwen',
  'shell',
  'fake',
  'custom',
]);
export type HarnessId = z.infer<typeof HarnessIdSchema>;

export const HarnessProfileSchema = z.object({
  id: HarnessIdSchema,
  label: z.string().min(1),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  resumeArgs: z.array(z.string()),
  available: z.boolean(),
  source: z.enum(['builtin', 'custom']),
});
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

/** Profile started by the plus button without opening the picker. */
export const NewSessionDefaultSchema = z.union([HarnessIdSchema, z.literal('ask')]);
export type NewSessionDefault = z.infer<typeof NewSessionDefaultSchema>;

export const AppSettingsSchema = z.object({
  /** Harness ids hidden from the start pickers; existing sessions still resume. */
  disabledHarnesses: z.array(HarnessIdSchema),
  /** Executable on PATH or a full path, started without arguments. */
  customCommand: z.string().max(2000),
  /** Generic update feed (electron-updater latest.yml); empty uses the built-in feed. */
  updateFeedUrl: z.string().max(2000).default(''),
  /** What the new-tab plus button starts: ask every time or a specific profile. */
  newSessionDefault: NewSessionDefaultSchema.default('ask'),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const AppSettingsPatchSchema = z.object({
  disabledHarnesses: z.array(HarnessIdSchema).optional(),
  customCommand: z.string().max(2000).optional(),
  updateFeedUrl: z.string().max(2000).optional(),
  newSessionDefault: NewSessionDefaultSchema.optional(),
});
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

export const UpdateStateSchema = z.enum([
  'idle',
  'disabled',
  'checking',
  'available',
  'not-available',
  'downloading',
  'downloaded',
  'error',
]);
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UpdateStatusSchema = z.object({
  state: UpdateStateSchema,
  currentVersion: z.string(),
  /** False in development or when NEST_DISABLE_UPDATES=1. */
  enabled: z.boolean(),
  feedUrl: z.string().nullable(),
  availableVersion: z.string().nullable(),
  /** Download progress, 0..100, only while downloading. */
  percent: z.number().min(0).max(100).nullable(),
  message: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const SessionStatusSchema = z.enum(['starting', 'running', 'idle', 'exited', 'failed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ResumeModeSchema = z.enum(['exact', 'latest']);
export type ResumeMode = z.infer<typeof ResumeModeSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  harnessId: HarnessIdSchema,
  title: z.string().min(1),
  status: SessionStatusSchema,
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
  harnessSessionId: z.string().min(1).nullable(),
  resumeMode: ResumeModeSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Session = z.infer<typeof SessionSchema>;

export const CommentSideSchema = z.enum(['old', 'new']);
export type CommentSide = z.infer<typeof CommentSideSchema>;

export const CommentStatusSchema = z.enum(['open', 'resolved']);
export type CommentStatus = z.infer<typeof CommentStatusSchema>;

export const ReviewCommentSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  /** Last line of a multi-line comment; equals `line` for single-line notes. */
  endLine: z.number().int().positive(),
  side: CommentSideSchema,
  body: z.string(),
  status: CommentStatusSchema,
  /** The anchored text was removed or replaced; stored line numbers are a hint. */
  stale: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
