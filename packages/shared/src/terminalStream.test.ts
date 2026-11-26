import { describe, expect, it } from 'vitest';
import { TerminalReplay, type SessionDataChunk } from './terminalStream.js';

function recorder(): { write: (data: string) => void; written: string[]; all: () => string } {
  const written: string[] = [];
  return {
    write: (data: string) => written.push(data),
    written,
    all: () => written.join(''),
  };
}

function chunk(start: number, data: string): SessionDataChunk {
  return { data, start, end: start + data.length };
}

/** `zero|one|two|three|four` — chunk boundaries line up with the `|` separators. */
const stream = 'zero|one|two|three|four';

describe('terminal replay', () => {
  it('writes the snapshot first and then only the part of buffered chunks it does not cover', () => {
    const sink = recorder();
    const replay = new TerminalReplay(sink.write);

    // Live chunks that arrive while the history request is in flight.
    replay.push(chunk(0, 'zero|'));
    replay.push(chunk(5, 'one|'));

    // The snapshot already contains everything up to position 9.
    replay.attach({ data: stream.slice(0, 9), position: 9 });

    // Nothing old was written twice: only the snapshot reached xterm.
    expect(sink.written).toHaveLength(1);
    expect(sink.all()).toBe('zero|one|');

    replay.push(chunk(9, 'two|'));
    expect(sink.all()).toBe('zero|one|two|');
  });

  it('trims a chunk that partially overlaps the snapshot', () => {
    const sink = recorder();
    const replay = new TerminalReplay(sink.write);

    // Covers `|two|` but the snapshot already consumed its first three units.
    replay.push(chunk(8, stream.slice(8, 13)));
    replay.attach({ data: stream.slice(0, 11), position: 11 });
    // `zero|one|tw` from the snapshot plus the uncovered `o|` of the chunk.
    expect(sink.all()).toBe('zero|one|two|');

    replay.push(chunk(13, 'three'));
    expect(sink.all()).toBe('zero|one|two|three');
  });

  it('keeps exact content and order when a remount replays a numbered stream', () => {
    const parts = Array.from({ length: 12 }, (_, index) => `[${index}]`);
    const payload = parts.join('');
    const live: SessionDataChunk[] = [];
    let position = 0;
    for (const part of parts) {
      live.push(chunk(position, part));
      position += part.length;
    }
    const covered = live[8]!.end!;

    const first = recorder();
    const mount = new TerminalReplay(first.write);
    // Seven chunks arrive before the snapshot request resolves; two more are
    // inside the snapshot; the rest arrive live.
    for (const part of live.slice(0, 7)) mount.push(part);
    mount.attach({ data: payload.slice(0, covered), position: covered });
    for (const part of live.slice(9)) mount.push(part);
    expect(first.all()).toBe(payload);

    // LRU eviction and remount: the snapshot alone rebuilds the same screen.
    const second = recorder();
    const remount = new TerminalReplay(second.write);
    remount.attach({ data: payload, position: payload.length });
    expect(second.all()).toBe(payload);
  });

  it('never writes to a disposed terminal', () => {
    const sink = recorder();
    const replay = new TerminalReplay(sink.write);
    replay.push(chunk(0, 'late'));
    replay.dispose();

    replay.attach({ data: 'snapshot', position: 8 });
    replay.push(chunk(8, 'more'));
    expect(sink.written).toHaveLength(0);
    expect(replay.disposed).toBe(true);
    expect(replay.pendingBytes).toBe(0);
  });

  it('keeps arrival order for chunks without positions', () => {
    const sink = recorder();
    const replay = new TerminalReplay(sink.write);
    replay.push({ data: 'a', start: null, end: null });
    replay.attach({ data: 'snapshot', position: 8 });
    replay.push({ data: 'b', start: null, end: null });
    expect(sink.all()).toBe('snapshotab');
  });
});
