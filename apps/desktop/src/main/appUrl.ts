import path from 'node:path';
import { app } from 'electron';
import { appUrlFrom } from './boundaries';

/**
 * The URL Nest loads into its window and the only one the IPC router and the
 * navigation guards accept. Dev runs use the Vite server URL; a built app uses
 * the emitted renderer entry next to `out/main`.
 */
export function currentAppUrl(): URL {
  return appUrlFrom({
    devUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    rendererFile: path.join(__dirname, '../renderer/index.html'),
  });
}
