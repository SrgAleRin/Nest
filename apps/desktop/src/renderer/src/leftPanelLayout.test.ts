import { describe, expect, it } from 'vitest';
import {
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_STORAGE_KEY,
  clampLeftPanelWidth,
  isNarrowLeftPanel,
  leftPanelMaxWidth,
  leftPanelWidthForKey,
  leftPanelWidthFromPointer,
  parseLeftPanelUi,
  readLeftPanelUi,
  serializeLeftPanelUi,
  writeLeftPanelUi,
  type LeftPanelStorage,
} from './leftPanelLayout';

function memoryStorage(initial: Record<string, string> = {}): LeftPanelStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
}

describe('width clamping', () => {
  it('keeps a width between 220 px and min(440 px, 38 vw)', () => {
    expect(clampLeftPanelWidth(272, 1600)).toBe(272);
    expect(clampLeftPanelWidth(120, 1600)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampLeftPanelWidth(900, 1600)).toBe(leftPanelMaxWidth(1600));
    // 38% of 1000 is 380, which is under the fixed cap.
    expect(leftPanelMaxWidth(1000)).toBe(380);
    expect(clampLeftPanelWidth(370, 1000)).toBe(370);
    // 38% of 1600 is 608, so the cap wins.
    expect(leftPanelMaxWidth(1600)).toBe(440);
  });

  it('never goes below the minimum on a tiny window', () => {
    expect(leftPanelMaxWidth(400)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampLeftPanelWidth(272, 400)).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it('falls back to the default for a broken value', () => {
    expect(clampLeftPanelWidth(Number.NaN, 1600)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('reads the width from the pointer at the right edge', () => {
    expect(leftPanelWidthFromPointer(272, 1600)).toBe(272);
    expect(leftPanelWidthFromPointer(10, 1600)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(leftPanelWidthFromPointer(900, 1600)).toBe(leftPanelMaxWidth(1600));
  });

  it('resizes with arrows, Home and End', () => {
    expect(leftPanelWidthForKey(272, 'ArrowRight', 1600)).toBe(296);
    expect(leftPanelWidthForKey(272, 'ArrowLeft', 1600)).toBe(248);
    expect(leftPanelWidthForKey(272, 'Home', 1600)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(leftPanelWidthForKey(272, 'End', 1600)).toBe(leftPanelMaxWidth(1600));
    expect(leftPanelWidthForKey(272, 'PageDown', 1600)).toBeNull();
    expect(leftPanelWidthForKey(leftPanelMaxWidth(1600), 'ArrowRight', 1600)).toBe(
      leftPanelMaxWidth(1600),
    );
  });
});

describe('persisted preference', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    writeLeftPanelUi(storage, { width: 320, collapsed: true });
    expect(parseLeftPanelUi(storage.values[LEFT_PANEL_STORAGE_KEY] ?? null)).toEqual({
      width: 320,
      collapsed: true,
    });
  });

  it('ignores malformed values', () => {
    expect(parseLeftPanelUi(null)).toBeNull();
    expect(parseLeftPanelUi('{')).toBeNull();
    expect(parseLeftPanelUi('null')).toBeNull();
    expect(parseLeftPanelUi('{"width":"wide"}')).toBeNull();
    expect(parseLeftPanelUi('{"width":300}')).toEqual({ width: 300, collapsed: false });
  });

  it('restores width and collapsed state, clamped to the window', () => {
    const storage = memoryStorage({
      [LEFT_PANEL_STORAGE_KEY]: serializeLeftPanelUi({ width: 2000, collapsed: true }),
    });
    expect(readLeftPanelUi(storage, 1600)).toEqual({
      width: leftPanelMaxWidth(1600),
      collapsed: true,
    });
    expect(readLeftPanelUi(memoryStorage(), 1600)).toEqual({
      width: LEFT_PANEL_DEFAULT_WIDTH,
      collapsed: false,
    });
    expect(readLeftPanelUi(null, 1600).collapsed).toBe(false);
  });

  it('starts collapsed in a narrow window whatever was stored', () => {
    const storage = memoryStorage({
      [LEFT_PANEL_STORAGE_KEY]: serializeLeftPanelUi({ width: 320, collapsed: false }),
    });
    // `1100x700` at 150% DPI is about 733 CSS px; both are drawer windows.
    expect(isNarrowLeftPanel(733)).toBe(true);
    expect(isNarrowLeftPanel(980)).toBe(true);
    expect(isNarrowLeftPanel(981)).toBe(false);
    expect(isNarrowLeftPanel(0)).toBe(false);
    expect(readLeftPanelUi(storage, 733)).toEqual({
      width: clampLeftPanelWidth(320, 733),
      collapsed: true,
    });
  });
});
