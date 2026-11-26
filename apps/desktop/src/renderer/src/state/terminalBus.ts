import type { NestEvent, RpcMethod, RpcParams, RpcResult, SessionDataChunk } from '@nest/shared';

type DataListener = (chunk: SessionDataChunk) => void;

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

export function emitSessionData(sessionId: string, chunk: SessionDataChunk): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(chunk);
}

/** Converts the wire event into a chunk; older senders may omit positions. */
export function eventSessionData(event: NestEvent): void {
  if (event.type !== 'session:data') return;
  const data = event.data;
  const end = typeof event.end === 'number' && Number.isFinite(event.end) ? event.end : null;
  emitSessionData(event.sessionId, {
    data,
    start: end === null ? null : end - data.length,
    end,
  });
}

export type Invoke = <M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;
