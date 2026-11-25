import { contextBridge, ipcRenderer } from 'electron';
import type {
  NestBridge,
  NestEvent,
  RpcMethod,
  RpcParams,
  RpcResponse,
  RpcResult,
} from '@nest/shared';

async function invoke<M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
): Promise<RpcResponse<RpcResult<M>>> {
  return (await ipcRenderer.invoke('nest:rpc', method, params)) as RpcResponse<RpcResult<M>>;
}

const bridge: NestBridge = {
  invoke,
  on(handler: (event: NestEvent) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: NestEvent) => handler(payload);
    ipcRenderer.on('nest:event', listener);
    return () => {
      ipcRenderer.removeListener('nest:event', listener);
    };
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('nest', bridge);
