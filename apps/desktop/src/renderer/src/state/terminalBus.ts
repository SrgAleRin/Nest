import type { NestEvent, RpcMethod, RpcParams, RpcResult } from '@nest/shared';

type DataListener = (data: string) => void;

const listeners = new Map<string, Set<DataListener>>();

export function onSessionData(sessionId: string, listener: DataListener): () => void {
  const set = listeners.get(sessionId) ?? new Set<DataListener>();
  set.add(listener);
  listeners.set(sessionId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export function emitSessionData(sessionId: string, data: string): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(data);
}

export function eventSessionData(event: NestEvent): void {
  if (event.type === 'session:data') emitSessionData(event.sessionId, event.data);
}

export type Invoke = <M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;
