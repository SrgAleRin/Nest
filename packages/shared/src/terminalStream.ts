/**
 * Rejoining history with live output.
 *
 * Every PTY chunk carries a position in the session output stream: `start` is
 * the number of UTF-16 units Nest had already produced before the chunk and
 * `end` is that number after it. `sessions.scrollback` returns the stored
 * snapshot together with the position it covers, so a remounted terminal can
 * tell which live chunks are already inside the snapshot and which ones still
 * have to be written.
 *
 * The renderer subscribes first, buffers live chunks, fetches the snapshot,
 * writes it, and only then writes the buffered chunks that end after the
 * snapshot position — in arrival order, with the part before the position
 * trimmed. That keeps content and order exact after a reload or an LRU
 * remount, including chunks that overlap the snapshot, and never lets old
 * data overwrite newer data or leave xterm in a half-applied ANSI state.
 */

export interface SessionDataChunk {
  data: string;
  /** Position of the first unit, or `null` when the sender predates positions. */
  start: number | null;
  /** Position right after the last unit, or `null` for an unpositioned chunk. */
  end: number | null;
}

export interface SessionSnapshot {
  /** Stored output. May be a truncated tail of the stream. */
  data: string;
  /** Stream position covered by `data`; nothing before it has to be replayed. */
  position: number;
}

type Phase = 'buffering' | 'live' | 'disposed';

/**
 * Writes one terminal output stream into xterm in the right order. Owned by a
 * single mounted terminal: after `dispose()` every later call is a no-op, so a
 * chunk that arrives while the terminal is being unmounted never reaches a
 * disposed xterm.
 */
export class TerminalReplay {
  private phase: Phase = 'buffering';
  private buffered: SessionDataChunk[] = [];
  private bufferedBytes = 0;
  private position = 0;

  constructor(private readonly write: (data: string) => void) {}

  /** Live chunk from the event bus; held back until the snapshot arrives. */
  push(chunk: SessionDataChunk): void {
    if (this.phase === 'disposed') return;
    if (this.phase === 'live') {
      this.write(chunk.data);
      return;
    }
    if (chunk.data.length === 0) return;
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.data.length;
  }

  /**
   * Applies the snapshot, then the buffered chunks that are not covered by it.
   * Safe to call once; later calls and calls after `dispose()` are ignored.
   */
  attach(snapshot: SessionSnapshot): void {
    if (this.phase !== 'buffering') return;
    this.position = snapshot.position;
    this.phase = 'live';
    const pending = this.buffered;
    this.buffered = [];
    this.bufferedBytes = 0;
    if (snapshot.data.length > 0) this.write(snapshot.data);
    for (const chunk of pending) this.writeAfterSnapshot(chunk);
  }

  /** Detaches from the terminal; no further writes are possible. */
  dispose(): void {
    this.phase = 'disposed';
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  get disposed(): boolean {
    return this.phase === 'disposed';
  }

  /** True while live chunks are queued for a snapshot that has not arrived yet. */
  get buffering(): boolean {
    return this.phase === 'buffering';
  }

  /** Bytes waiting for the snapshot; bounded by one scrollback round-trip. */
  get pendingBytes(): number {
    return this.bufferedBytes;
  }

  private writeAfterSnapshot(chunk: SessionDataChunk): void {
    const { start, end } = chunk;
    if (start === null || end === null || end !== start + chunk.data.length) {
      // An unpositioned sender keeps arrival order, which is the best we can do.
      this.write(chunk.data);
      return;
    }
    if (end <= this.position) return;
    const skip = this.position > start ? this.position - start : 0;
    if (skip <= 0) {
      this.write(chunk.data);
      return;
    }
    if (skip >= chunk.data.length) return;
    this.write(chunk.data.slice(skip));
  }
}
