import { describe, expect, it } from 'vitest';
import { emitSessionData, eventSessionData, onSessionData } from './terminalBus';
import type { SessionDataChunk } from '@nest/shared';

describe('terminal bus', () => {
  it('delivers a wire event as a positioned chunk', () => {
    const chunks: SessionDataChunk[] = [];
    const off = onSessionData('session-1', (chunk) => chunks.push(chunk));
    eventSessionData({
      type: 'session:data',
      sessionId: 'session-1',
      data: 'hello',
      start: 3,
      end: 8,
    });
    off();
    eventSessionData({
      type: 'session:data',
      sessionId: 'session-1',
      data: 'late',
      start: 8,
      end: 12,
    });
    expect(chunks).toEqual([{ data: 'hello', start: 3, end: 8 }]);
  });

  it('keeps arrival order when the sender has no positions', () => {
    const chunks: SessionDataChunk[] = [];
    const off = onSessionData('session-2', (chunk) => chunks.push(chunk));
    emitSessionData('session-2', { data: 'a', start: null, end: null });
    off();
    expect(chunks).toEqual([{ data: 'a', start: null, end: null }]);
  });

  it('unsubscribes per session', () => {
    const seen: string[] = [];
    const off = onSessionData('session-3', (chunk) => seen.push(chunk.data));
    emitSessionData('session-4', { data: 'other', start: 0, end: 5 });
    emitSessionData('session-3', { data: 'own', start: 0, end: 3 });
    off();
    emitSessionData('session-3', { data: 'after', start: 3, end: 8 });
    expect(seen).toEqual(['own']);
  });
});
