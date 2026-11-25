import { z } from 'zod';
import type { Session, Task } from './schemas.js';
import {
  HarnessProfileSchema,
  ProjectSchema,
  ReviewCommentSchema,
  SessionSchema,
  TaskSchema,
} from './schemas.js';
import { GitDiffSchema, GitStatusSchema } from './git.js';

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
  'tasks.remove': { params: z.object({ taskId: id }), result: z.void() },
  'tasks.reveal': { params: z.object({ taskId: id }), result: z.void() },

  'git.status': { params: z.object({ taskId: id }), result: GitStatusSchema },
  'git.diff': {
    params: z.object({
      taskId: id,
      path: z.string().min(1).optional(),
      staged: z.boolean().optional(),
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
    }),
    result: z.object({ hash: z.string(), summary: z.string() }),
  },
  'git.push': { params: z.object({ taskId: id }), result: z.object({ output: z.string() }) },

  'comments.list': {
    params: z.object({ taskId: id }),
    result: z.array(ReviewCommentSchema),
  },
  'comments.create': {
    params: z.object({
      taskId: id,
      filePath: z.string().min(1),
      line: z.number().int().positive(),
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
    result: z.object({ data: z.string() }),
  },

  'harness.list': { params: empty, result: z.array(HarnessProfileSchema) },
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

export type NestEvent =
  | { type: 'session:data'; sessionId: string; data: string }
  | { type: 'session:status'; session: Session }
  | { type: 'task:updated'; task: Task }
  | { type: 'git:changed'; taskId: string }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; message: string };

export interface NestClient {
  invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>;
  on(handler: (event: NestEvent) => void): () => void;
}

export interface NestBridge {
  invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResponse<RpcResult<M>>>;
  on(handler: (event: NestEvent) => void): () => void;
  platform: string;
}
