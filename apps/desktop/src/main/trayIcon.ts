/**
 * Tray icon: the 32x32 PNG stored inside `build/icon.ico`, kept inline so the
 * tray works in dev and in a packaged build without shipping a second asset.
 *
 * The first version of this constant carried a two-character typo in the
 * middle of the base64. It still looked like a PNG, but the data did not
 * decode, so Electron handed the tray a 0x0 image and the tray icon was
 * simply blank. `trayIcon.test.ts` now verifies every chunk CRC, so a
 * corrupted paste cannot come back silently.
 */
const TRAY_ICON_PNG_BASE64 = [
  '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',
].join('');

export function trayIconDataUrl(): string {
  return `data:image/png;base64,${TRAY_ICON_PNG_BASE64}`;
}

export { TRAY_ICON_PNG_BASE64 };
