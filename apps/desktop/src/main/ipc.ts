import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  rpcMethods,
  type AppInfo,
  type NestEvent,
  type RpcErrorShape,
  type RpcHandlers,
  type RpcMethod,
  type RpcResponse,
} from '@nest/shared';
import { NestError, type Core } from '@nest/core';

export interface IpcContext {
  core: Core;
  info: () => AppInfo;
  getWindow: () => BrowserWindow | null;
}

export function registerIpc(context: IpcContext): void {
  const { core } = context;

  const handlers: RpcHandlers = {
    'app.info': () => context.info(),

    'app.openExternal': async ({ url }) => {
      let protocol = '';
      try {
        protocol = new URL(url).protocol;
      } catch {
        throw new NestError('invalid_url', 'Not a valid URL');
      }
      if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') {
        throw new NestError('unsupported_url', `Refusing to open ${protocol} links`);
      }
      await shell.openExternal(url);
    },

    'dialog.pickDirectory': async () => {
      const window = context.getWindow();
      const result = window
        ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    'projects.list': () => core.projects.list(),

    'projects.add': async ({ path }) => core.projects.add(path),

    'projects.remove': ({ projectId }) => {
      core.projects.remove(projectId);
    },

    'projects.reveal': async ({ projectId }) => {
      const project = core.projects.get(projectId);
      await shell.openPath(project.path);
    },

    'tasks.list': ({ projectId }) => core.tasks.list(projectId),

    'tasks.create': async (input) => core.tasks.create(input),

    'tasks.remove': async ({ taskId, force }) => {
      await core.tasks.remove(taskId, { force });
    },

    'tasks.openCheckout': ({ projectId }) => core.tasks.ensureCheckout(projectId),

    'tasks.reveal': async ({ taskId }) => {
      const task = core.tasks.get(taskId);
      await shell.openPath(task.workspacePath);
    },

    'git.status': async ({ taskId }) => core.git.status(taskId),

    'git.diff': async ({ taskId, path, staged }) => core.git.diff(taskId, path, staged),

    'git.stage': async ({ taskId, paths }) => core.git.stage(taskId, paths),

    'git.unstage': async ({ taskId, paths }) => core.git.unstage(taskId, paths),

    'git.commit': async ({ taskId, message, stageAll }) =>
      core.git.commit(taskId, message, stageAll),

    'git.push': async ({ taskId }) => core.git.push(taskId),

    'comments.list': ({ taskId }) => core.comments.list(taskId),

    'comments.create': (input) => core.comments.create(input),

    'comments.update': ({ commentId, body, status }) =>
      core.comments.update(commentId, { body, status }),

    'comments.remove': ({ commentId }) => {
      core.comments.remove(commentId);
    },

    'comments.send': ({ commentId, sessionId }) => core.comments.send(commentId, sessionId),

    'sessions.list': ({ taskId }) => core.sessions.list(taskId),

    'sessions.start': async ({ taskId, harnessId, cols, rows }) =>
      core.sessions.start({ taskId, harnessId, cols, rows }),

    'sessions.write': ({ sessionId, data }) => {
      core.sessions.write(sessionId, data);
    },

    'sessions.stop': ({ sessionId }) => {
      core.sessions.stop(sessionId);
    },

    'sessions.resume': async ({ sessionId }) => core.sessions.resume(sessionId),

    'sessions.resize': ({ sessionId, cols, rows }) => {
      core.sessions.resize(sessionId, cols, rows);
    },

    'sessions.scrollback': ({ sessionId }) => ({ data: core.sessions.scrollback(sessionId) }),

    'harness.list': () => core.harnesses.list(),
  };

  ipcMain.handle(
    'nest:rpc',
    async (_event, method: unknown, params: unknown): Promise<RpcResponse<unknown>> => {
      if (typeof method !== 'string' || !(method in rpcMethods)) {
        return {
          ok: false,
          error: { code: 'method_not_found', message: `Unknown RPC method: ${String(method)}` },
        };
      }

      const key = method as RpcMethod;
      const definition = rpcMethods[key];
      const parsed = definition.params.safeParse(params ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'invalid_params',
            message: `Invalid parameters for ${key}`,
            details: parsed.error.message,
          },
        };
      }

      try {
        const handler = handlers[key] as (value: unknown) => unknown;
        const data = await handler(parsed.data);
        const result = definition.result.safeParse(data);
        if (!result.success) {
          return {
            ok: false,
            error: {
              code: 'invalid_result',
              message: `Handler for ${key} returned an invalid result`,
              details: result.error.message,
            },
          };
        }
        return { ok: true, data: result.data };
      } catch (error) {
        return { ok: false, error: toRpcError(key, error) };
      }
    },
  );
}

export function broadcastEvent(event: NestEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('nest:event', event);
  }
}

function toRpcError(method: string, error: unknown): RpcErrorShape {
  if (error instanceof NestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'internal_error', message: `${method}: ${message}` };
}
