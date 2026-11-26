import { z } from 'zod';
import type { Session, Task, UpdateStatus } from './schemas.js';
import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  HarnessProfileSchema,
  ProjectSchema,
  ReviewCommentSchema,
  SessionSchema,
  TaskSchema,
  UpdateStatusSchema,
} from './schemas.js';
import {
  DiffModeSchema,
  GitBranchesSchema,
  GitCommitDetailSchema,
  GitCompareSchema,
  GitDiffSchema,
  GitLogSchema,
  GitStatusSchema,
} from './git.js';
import { FileContentSchema, WorkspaceFilesSchema } from './files.js';

export const AppInfoSchema = z.object({
  version: z.string(),
  electron: z.string(),
  platform: z.string(),
  profile: z.string().nullable(),
  userData: z.string(),
  dbPath: z.string(),
  worktreesRoot: z.string(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

const id = z.string().min(1);
const empty = z.object({});

export const rpcMethods = {
  'app.info': { params: empty, result: AppInfoSchema },

  'app.openExternal': {
    params: z.object({ url: z.string().min(1).max(2048) }),
    result: z.void(),
  },

  'clipboard.read': { params: empty, result: z.object({ text: z.string() }) },
  'clipboard.write': { params: z.object({ text: z.string() }), result: z.void() },

  'dialog.pickDirectory': { params: empty, result: z.string().nullable() },

  'projects.list': { params: empty, result: z.array(ProjectSchema) },
  'projects.add': {
    params: z.object({ path: z.string().min(1) }),
    result: z.object({ project: ProjectSchema, checkout: TaskSchema }),
  },
  'projects.remove': { params: z.object({ projectId: id }), result: z.void() },
  'projects.reveal': { params: z.object({ projectId: id }), result: z.void() },

  'tasks.list': {
    params: z.object({ projectId: id.optional() }),
    result: z.array(TaskSchema),
  },
  'tasks.create': {
    params: z.object({
      projectId: id,
      title: z.string().trim().min(1).max(200),
      baseBranch: z.string().min(1).optional(),
      setupScript: z.string().max(2000).nullable().optional(),
    }),
    result: TaskSchema,
  },
  'tasks.remove': {
    params: z.object({ taskId: id, force: z.boolean().optional() }),
    result: z.void(),
  },
  'tasks.openCheckout': { params: z.object({ projectId: id }), result: TaskSchema },
  'tasks.reveal': { params: z.object({ taskId: id }), result: z.void() },

  'git.status': { params: z.object({ taskId: id }), result: GitStatusSchema },
  'git.diff': {
    params: z.object({
      taskId: id,
      path: z.string().min(1).optional(),
      /** Which comparison to run; core defaults to `both`. */
      mode: DiffModeSchema.optional(),
    }),
    result: GitDiffSchema,
  },
  'git.stage': {
    params: z.object({ taskId: id, paths: z.array(z.string().min(1)).min(1) }),
    result: GitStatusSchema,
  },
  'git.unstage': {
    params: z.object({ taskId: id, paths: z.array(z.string().min(1)).min(1) }),
    result: GitStatusSchema,
  },
  'git.commit': {
    params: z.object({
      taskId: id,
      message: z.string().trim().min(1).max(5000),
      stageAll: z.boolean().optional(),
      amend: z.boolean().optional(),
    }),
    result: z.object({ hash: z.string(), summary: z.string() }),
  },
  'git.push': {
    params: z.object({ taskId: id, force: z.boolean().optional() }),
    result: z.object({ output: z.string() }),
  },
  'git.log': {
    params: z.object({
      taskId: id,
      /** Start from this ref instead of HEAD. */
      ref: z.string().min(1).max(250).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      skip: z.number().int().min(0).max(100_000).optional(),
    }),
    result: GitLogSchema,
  },
  'git.commitDetail': {
    params: z.object({ taskId: id, hash: z.string().min(1).max(250) }),
    result: GitCommitDetailSchema,
  },
  'git.branches': { params: z.object({ taskId: id }), result: GitBranchesSchema },
  'git.compare': {
    params: z.object({
      taskId: id,
      base: z.string().min(1).max(250),
      head: z.string().min(1).max(250).optional(),
    }),
    result: GitCompareSchema,
  },
  'git.fetch': { params: z.object({ taskId: id }), result: z.object({ output: z.string() }) },
  'git.pull': { params: z.object({ taskId: id }), result: z.object({ output: z.string() }) },
  'git.checkout': {
    params: z.object({
      taskId: id,
      branch: z.string().min(1).max(250),
      /** Create the branch instead of switching to an existing one. */
      create: z.boolean().optional(),
      /** Start point for a created branch; defaults to the current HEAD. */
      from: z.string().min(1).max(250).optional(),
    }),
    result: GitStatusSchema,
  },
  'git.discard': {
    params: z.object({ taskId: id, paths: z.array(z.string().min(1)).min(1) }),
    result: GitStatusSchema,
  },

  'files.list': { params: z.object({ taskId: id }), result: WorkspaceFilesSchema },
  'files.read': {
    params: z.object({ taskId: id, path: z.string().min(1).max(4096) }),
    result: FileContentSchema,
  },

  'comments.list': {
    params: z.object({ taskId: id }),
    result: z.array(ReviewCommentSchema),
  },
  'comments.create': {
    params: z.object({
      taskId: id,
      filePath: z.string().min(1),
      line: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
      side: z.enum(['old', 'new']),
      body: z.string().trim().min(1).max(10000),
    }),
    result: ReviewCommentSchema,
  },
  'comments.update': {
    params: z.object({
      commentId: id,
      body: z.string().trim().min(1).max(10000).optional(),
      status: z.enum(['open', 'resolved']).optional(),
    }),
    result: ReviewCommentSchema,
  },
  'comments.remove': { params: z.object({ commentId: id }), result: z.void() },
  'comments.send': {
    params: z.object({ commentId: id, sessionId: id.optional() }),
    result: z.object({ sent: z.boolean(), reason: z.string().optional() }),
  },

  'sessions.list': {
    params: z.object({ taskId: id.optional() }),
    result: z.array(SessionSchema),
  },
  'sessions.start': {
    params: z.object({
      taskId: id,
      harnessId: z.string().min(1),
      cols: z.number().int().positive().max(1000).optional(),
      rows: z.number().int().positive().max(1000).optional(),
    }),
    result: SessionSchema,
  },
  'sessions.write': {
    params: z.object({ sessionId: id, data: z.string() }),
    result: z.void(),
  },
  'sessions.stop': { params: z.object({ sessionId: id }), result: z.void() },
  'sessions.close': { params: z.object({ sessionId: id }), result: z.void() },
  'sessions.resume': { params: z.object({ sessionId: id }), result: SessionSchema },
  'sessions.resize': {
    params: z.object({
      sessionId: id,
      cols: z.number().int().positive().max(1000),
      rows: z.number().int().positive().max(1000),
    }),
    result: z.void(),
  },
  'sessions.scrollback': {
    params: z.object({ sessionId: id }),
    /**
     * `data` is the stored output snapshot and `position` is the stream
     * position it covers: every `session:data` chunk that ends at or before
     * `position` is already inside `data`. The renderer writes the snapshot
     * first and then only the buffered chunks that end after `position`.
     */
    result: z.object({ data: z.string(), position: z.number().int().min(0) }),
  },

  'harness.list': {
    params: z.object({ includeDisabled: z.boolean().optional() }),
    result: z.array(HarnessProfileSchema),
  },

  'settings.get': { params: empty, result: AppSettingsSchema },
  'settings.update': { params: AppSettingsPatchSchema, result: AppSettingsSchema },

  'updates.status': { params: empty, result: UpdateStatusSchema },
  'updates.check': { params: empty, result: UpdateStatusSchema },
  'updates.install': { params: empty, result: z.void() },

  'notifications.show': {
    params: z.object({
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(500),
      sessionId: id.optional(),
      urgent: z.boolean().optional(),
    }),
    result: z.object({ shown: z.boolean() }),
  },
  'notifications.badge': {
    params: z.object({ count: z.number().int().min(0).max(999) }),
    result: z.void(),
  },
} as const;

export type RpcMethod = keyof typeof rpcMethods;
export type RpcParams<M extends RpcMethod> = z.infer<(typeof rpcMethods)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof rpcMethods)[M]['result']>;

export type RpcHandlers = {
  [M in RpcMethod]: (params: RpcParams<M>) => RpcResult<M> | Promise<RpcResult<M>>;
};

export interface RpcErrorShape {
  code: string;
  message: string;
  details?: string;
}

export type RpcResponse<T> = { ok: true; data: T } | { ok: false; error: RpcErrorShape };

export type TaskProgressStep = 'fetch' | 'worktree' | 'setup';

export type NestEvent =
  | {
      type: 'session:data';
      sessionId: string;
      data: string;
      /**
       * Stream position of the first unit in `data`; `end` is the position just
       * after the last one. Positions count UTF-16 units from the first unit
       * Nest ever received for the session, so they keep increasing across
       * scrollback truncation and across resume. `end - start` always equals
       * `data.length`.
       */
      start: number;
      end: number;
    }
  | { type: 'session:status'; session: Session }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:progress'; projectId: string; step: TaskProgressStep }
  | { type: 'git:changed'; taskId: string }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'notification:activated'; sessionId?: string }
  | { type: 'updates:status'; status: UpdateStatus };

export interface NestClient {
  invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  on(handler: (event: NestEvent) => void): () => void;
}

export interface NestBridge {
  invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResponse<RpcResult<M>>>;
  on(handler: (event: NestEvent) => void): () => void;
  platform: string;
}
