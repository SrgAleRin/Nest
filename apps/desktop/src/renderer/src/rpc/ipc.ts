import type { NestBridge, NestClient, NestEvent, RpcMethod, RpcParams, RpcResult } from '@nest/shared';

export function createIpcClient(bridge: NestBridge): NestClient {
  return {
    async invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      const response = await bridge.invoke(method, params);
      if (response.ok) return response.data;
      const error = new Error(response.error.message);
      error.name = response.error.code;
      if (response.error.details) {
        error.message = `${response.error.message}\n${response.error.details}`;
      }
      throw error;
    },
    on(handler: (event: NestEvent) => void) {
      return bridge.on(handler);
    },
  };
}
