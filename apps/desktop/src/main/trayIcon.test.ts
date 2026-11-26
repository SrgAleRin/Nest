import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TRAY_ICON_PNG_BASE64, trayIconDataUrl } from './trayIcon';

/**
 * The tray icon is a base64 PNG inlined in the source, so a typo in that blob
 * is invisible in review and only shows up as "there is no icon in the tray".
 * Validate it the way a decoder would: signature, header, every chunk CRC and
 * an inflatable image stream. A two-character corruption slipped through once.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 255] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): Chunk[] {
  const chunks: Chunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = png.readUInt32BE(offset + 8 + length);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length)), `CRC of ${type}`).toBe(stored);
    chunks.push({ type, data });
    offset += length + 12;
  }
  return chunks;
}

describe('tray icon', () => {
  it('is a well formed PNG that decodes', () => {
    const png = Buffer.from(TRAY_ICON_PNG_BASE64, 'base64');
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    const chunks = readChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);

    const header = chunks[0]?.data;
    expect(header).toBeDefined();
    expect(header?.readUInt32BE(0)).toBe(32);
    expect(header?.readUInt32BE(4)).toBe(32);
    expect(header?.[8]).toBe(8); // bit depth
    expect(header?.[9]).toBe(6); // RGBA

    // One filter byte plus four channels per pixel, for every row.
    const idat = chunks.find((chunk) => chunk.type === 'IDAT');
    expect(idat).toBeDefined();
    expect(inflateSync(idat!.data).length).toBe(32 * (32 * 4 + 1));
  });

  it('is exposed as a data URL Electron can read', () => {
    expect(trayIconDataUrl()).toBe(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  });
});
