import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
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
import { currentAppUrl } from './appUrl';
import { decideExternalLink, isTrustedSenderFrame } from './boundaries';
import type { NotificationInput } from './notifications';
import type { UpdateService } from './updates';

export interface IpcContext {
  core: Core;
  info: () => AppInfo;
  updates: UpdateService;
  getWindow: () => BrowserWindow | null;
  /** Called after a project/task mutation so filesystem watches can be reconciled. */
  onTasksChanged?: () => void;
  showNotification?: (input: NotificationInput) => boolean;
  setBadge?: (count: number) => void;
}

export function registerIpc(context: IpcContext): void {
  const { core } = context;
  const tasksChanged = (): void => context.onTasksChanged?.();

  const handlers: RpcHandlers = {
    'app.info': () => context.info(),

    'app.openExternal': async ({ url }) => {
      // Same policy the window open handler uses: one allowlist for links that
      // leave the app, whether the main process or the renderer asked.
      const decision = decideExternalLink(url);
      if (!decision.allowed) throw new NestError(decision.code, decision.message);
      await shell.openExternal(decision.url);
    },
    'clipboard.read': async () => ({ text: await clipboard.readText() }),

    'clipboard.write': async ({ text }) => {
      await clipboard.writeText(text);
    },

    'dialog.pickDirectory': async () => {
      const window = context.getWindow();
      const result = window
        ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    'projects.list': () => core.projects.list(),

    'projects.add': async ({ path }) => {
      const result = await core.projects.add(path);
      tasksChanged();
      return result;
    },

    'projects.remove': async ({ projectId }) => {
      // Live PTYs are stopped and confirmed before rows disappear; a failure
      // throws and the renderer keeps the project visible.
      await core.projects.remove(projectId);
      tasksChanged();
    },

    'projects.reveal': async ({ projectId }) => {
      const project = core.projects.get(projectId);
      await shell.openPath(project.path);
    },

    'tasks.list': ({ projectId }) => core.tasks.list(projectId),

    'tasks.create': async (input) => {
      const task = await core.tasks.create(input);
      tasksChanged();
      return task;
    },

    'tasks.remove': async ({ taskId, force }) => {
      await core.tasks.remove(taskId, { force });
      tasksChanged();
    },

    'tasks.openCheckout': ({ projectId }) => core.tasks.ensureCheckout(projectId),

    'tasks.reveal': async ({ taskId }) => {
      const task = core.tasks.get(taskId);
      await shell.openPath(task.workspacePath);
    },

    'git.status': async ({ taskId }) => core.git.status(taskId),

    'git.diff': async ({ taskId, path, mode }) => core.git.diff(taskId, { path, mode }),

    'git.stage': async ({ taskId, paths }) => core.git.stage(taskId, paths),

    'git.unstage': async ({ taskId, paths }) => core.git.unstage(taskId, paths),

    'git.commit': async ({ taskId, message, stageAll, amend }) =>
      core.git.commit(taskId, message, stageAll, amend),

    'git.push': async ({ taskId, force, publish }) => core.git.push(taskId, { force, publish }),

    'git.log': async ({ taskId, ref, limit, skip }) => core.git.log(taskId, { ref, limit, skip }),

    'git.commitDetail': async ({ taskId, hash }) => core.git.commitDetail(taskId, hash),

    'git.branches': async ({ taskId }) => core.git.branches(taskId),

    'git.compare': async ({ taskId, base, head }) => core.git.compare(taskId, base, head),

    'git.fetch': async ({ taskId }) => core.git.fetch(taskId),

    'git.pull': async ({ taskId }) => core.git.pull(taskId),

    'git.checkout': async ({ taskId, branch, create, from }) =>
      core.git.checkout(taskId, branch, { create, from }),

    'git.discard': async ({ taskId, paths }) => core.git.discard(taskId, paths),

    'files.list': ({ taskId }) => core.files.list(taskId),

    'files.read': ({ taskId, path }) => core.files.read(taskId, path),

    'comments.list': ({ taskId, mode }) => core.comments.list(taskId, { mode }),

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

    'sessions.close': ({ sessionId }) => {
      core.sessions.close(sessionId);
    },

    'sessions.resume': async ({ sessionId }) => core.sessions.resume(sessionId),

    'sessions.resize': ({ sessionId, cols, rows }) => {
      core.sessions.resize(sessionId, cols, rows);
    },

    'sessions.scrollback': ({ sessionId }) => core.sessions.snapshot(sessionId),

    'harness.list': ({ includeDisabled }) =>
      core.harnesses.list({ includeDisabled: includeDisabled ?? false }),

    'settings.get': () => core.settings.get(),

    'settings.update': (patch) => {
      const settings = core.settings.update(patch);
      // The custom command may have changed, so cached PATH lookups are stale.
      core.harnesses.invalidate();
      // Saving a new feed applies immediately; the status arrives as an event.
      if (patch.updateFeedUrl !== undefined) void context.updates.check();
      return settings;
    },

    'updates.status': () => context.updates.getStatus(),
    'updates.check': () => context.updates.check(),
    'updates.install': () => context.updates.install(),

    'notifications.show': (input) => ({ shown: context.showNotification?.(input) ?? false }),

    'notifications.badge': ({ count }) => {
      context.setBadge?.(count);
    },
  };

  ipcMain.handle(
    'nest:rpc',
    async (event, method: unknown, params: unknown): Promise<RpcResponse<unknown>> => {
      // Only Nest's own window, and only its top frame, may call the router:
      // `senderFrame` is null for a frame that has already gone, and a frame
      // loaded from another origin never gets to the handlers below.
      const frame = event.senderFrame;
      const window = context.getWindow();
      const trusted =
        frame !== null &&
        window !== null &&
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        isTrustedSenderFrame(
          { url: frame.url, origin: frame.origin, isTopFrame: frame.parent === null },
          currentAppUrl(),
        );
      if (!trusted) {
        return {
          ok: false,
          error: {
            code: 'untrusted_sender',
            message: 'Refusing an RPC call from a window or frame Nest does not own',
            details: frame ? `frame ${frame.url || '(empty)'}` : 'no sender frame',
          },
        };
      }

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
