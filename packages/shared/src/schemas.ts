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
  /** Ref the task's branch was created from; null for main checkouts. */
  baseRef: z.string().nullable(),
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

export const TerminalThemeSchema = z.enum(['nest', 'solarized', 'paper']);
export type TerminalTheme = z.infer<typeof TerminalThemeSchema>;

export const TerminalCursorStyleSchema = z.enum(['block', 'underline', 'bar']);
export type TerminalCursorStyle = z.infer<typeof TerminalCursorStyleSchema>;

export const DEFAULT_TERMINAL_PREFERENCES = {
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
  fontSize: 13,
  lineHeight: 1.25,
  scrollback: 10000,
  cursorStyle: 'block' as TerminalCursorStyle,
  cursorBlink: true,
  theme: 'nest' as TerminalTheme,
};

export const TerminalPreferencesSchema = z.object({
  fontFamily: z.string().trim().min(1).max(300).default(DEFAULT_TERMINAL_PREFERENCES.fontFamily),
  fontSize: z.number().int().min(8).max(32).default(DEFAULT_TERMINAL_PREFERENCES.fontSize),
  lineHeight: z.number().min(0.8).max(2).default(DEFAULT_TERMINAL_PREFERENCES.lineHeight),
  scrollback: z
    .number()
    .int()
    .min(1000)
    .max(200_000)
    .default(DEFAULT_TERMINAL_PREFERENCES.scrollback),
  cursorStyle: TerminalCursorStyleSchema.default(DEFAULT_TERMINAL_PREFERENCES.cursorStyle),
  cursorBlink: z.boolean().default(DEFAULT_TERMINAL_PREFERENCES.cursorBlink),
  theme: TerminalThemeSchema.default(DEFAULT_TERMINAL_PREFERENCES.theme),
});
export type TerminalPreferences = z.infer<typeof TerminalPreferencesSchema>;

export const AppSettingsSchema = z.object({
  /** Harness ids hidden from the start pickers; existing sessions still resume. */
  disabledHarnesses: z.array(HarnessIdSchema),
  /** Executable on PATH or a full path, started without arguments. */
  customCommand: z.string().max(2000),
  /** Extra CLI arguments per harness id, parsed as words with optional quotes. */
  harnessArgs: z.partialRecord(HarnessIdSchema, z.string().max(2000)).default({}),
  /** Plain-terminal command; empty auto-detects pwsh, powershell or the login shell. */
  shellCommand: z.string().max(2000).default(''),
  /** Fonts, cursor and colours used by every xterm instance. */
  terminal: TerminalPreferencesSchema.default(DEFAULT_TERMINAL_PREFERENCES),
  /** Generic update feed (electron-updater latest.yml); empty uses the built-in feed. */
  updateFeedUrl: z.string().max(2000).default(''),
  /** What the new-tab plus button starts: ask every time or a specific profile. */
  newSessionDefault: NewSessionDefaultSchema.default('ask'),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const AppSettingsPatchSchema = z.object({
  disabledHarnesses: z.array(HarnessIdSchema).optional(),
  customCommand: z.string().max(2000).optional(),
  harnessArgs: z.partialRecord(HarnessIdSchema, z.string().max(2000)).optional(),
  shellCommand: z.string().max(2000).optional(),
  terminal: TerminalPreferencesSchema.optional(),
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

/**
 * `exact` — the conversation provably belongs to this session (the launched
 * process named it, or it was the only one that appeared after the launch).
 * `heuristic` — a best-effort guess: usable on request, never applied
 * automatically. `latest` — no id was found, the CLI continues its newest
 * conversation.
 */
export const ResumeModeSchema = z.enum(['exact', 'heuristic', 'latest']);
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
