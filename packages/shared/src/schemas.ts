import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
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
  available: z.boolean(),
  source: z.enum(['builtin', 'custom']),
});
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

export const SessionStatusSchema = z.enum(['starting', 'running', 'idle', 'exited', 'failed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  harnessId: HarnessIdSchema,
  title: z.string().min(1),
  status: SessionStatusSchema,
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
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
  side: CommentSideSchema,
  body: z.string(),
  status: CommentStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
