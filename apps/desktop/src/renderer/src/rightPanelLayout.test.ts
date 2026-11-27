import { describe, expect, it } from 'vitest';
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_STORAGE_KEY,
  clampRightPanelWidth,
  isNarrowRightPanel,
  parseRightPanelUi,
  readRightPanelUi,
  rightPanelMaxWidth,
  rightPanelWidthForKey,
  rightPanelWidthFromPointer,
  revealCenterForTool,
  serializeRightPanelUi,
  writeRightPanelUi,
  type RightPanelStorage,
} from './rightPanelLayout';

function memoryStorage(initial: Record<string, string> = {}): RightPanelStorage & {
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
  it('keeps a width between 300 px and 60 vw', () => {
    expect(clampRightPanelWidth(390, 1600)).toBe(390);
    expect(clampRightPanelWidth(120, 1600)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(1400, 1600)).toBe(rightPanelMaxWidth(1600));
    expect(rightPanelMaxWidth(1600)).toBe(960);
  });

  it('never goes below the minimum on a tiny window', () => {
    expect(rightPanelMaxWidth(400)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(390, 400)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('falls back to the default for a broken value', () => {
    expect(clampRightPanelWidth(Number.NaN, 1600)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('reads the width from the pointer at the left edge', () => {
    expect(rightPanelWidthFromPointer(1000, 1600)).toBe(600);
    expect(rightPanelWidthFromPointer(1590, 1600)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(rightPanelWidthFromPointer(-200, 1600)).toBe(rightPanelMaxWidth(1600));
  });

  it('resizes with arrows, Home and End', () => {
    expect(rightPanelWidthForKey(400, 'ArrowLeft', 1600)).toBe(424);
    expect(rightPanelWidthForKey(400, 'ArrowRight', 1600)).toBe(376);
    expect(rightPanelWidthForKey(400, 'Home', 1600)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(rightPanelWidthForKey(400, 'End', 1600)).toBe(rightPanelMaxWidth(1600));
    expect(rightPanelWidthForKey(400, 'PageDown', 1600)).toBeNull();
    expect(rightPanelWidthForKey(RIGHT_PANEL_MIN_WIDTH, 'ArrowRight', 1600)).toBe(
      RIGHT_PANEL_MIN_WIDTH,
    );
  });
});

describe('persisted preference', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    writeRightPanelUi(storage, { width: 520, collapsed: true });
    expect(parseRightPanelUi(storage.values[RIGHT_PANEL_STORAGE_KEY] ?? null)).toEqual({
      width: 520,
      collapsed: true,
    });
  });

  it('ignores malformed values', () => {
    expect(parseRightPanelUi(null)).toBeNull();
    expect(parseRightPanelUi('{')).toBeNull();
    expect(parseRightPanelUi('null')).toBeNull();
    expect(parseRightPanelUi('{"width":"wide"}')).toBeNull();
    expect(parseRightPanelUi('{"width":420}')).toEqual({ width: 420, collapsed: false });
  });

  it('restores width and collapsed state, clamped to the window', () => {
    const storage = memoryStorage({
      [RIGHT_PANEL_STORAGE_KEY]: serializeRightPanelUi({ width: 2000, collapsed: true }),
    });
    expect(readRightPanelUi(storage, 1600)).toEqual({ width: 960, collapsed: true });
    expect(readRightPanelUi(memoryStorage(), 1600)).toEqual({
      width: RIGHT_PANEL_DEFAULT_WIDTH,
      collapsed: false,
    });
    expect(readRightPanelUi(null, 1600).collapsed).toBe(false);
  });

  it('starts collapsed in a narrow window whatever was stored', () => {
    const storage = memoryStorage({
      [RIGHT_PANEL_STORAGE_KEY]: serializeRightPanelUi({ width: 420, collapsed: false }),
    });
    expect(isNarrowRightPanel(1040)).toBe(true);
    expect(isNarrowRightPanel(1181)).toBe(false);
    expect(readRightPanelUi(storage, 1100)).toEqual({ width: 420, collapsed: true });
  });

  /**
   * A center tool is never a reason to resize the column. A narrow window is
   * the one case that moves anything: the drawer covers the center, so it closes
   * and the tool is visible at once.
   */
  describe('opening a center tool', () => {
    it('closes the drawer of a narrow window', () => {
      let closes = 0;
      const closed = revealCenterForTool({
        drawer: true,
        close: () => {
          closes += 1;
        },
      });

      expect(closed).toBe(true);
      expect(closes).toBe(1);
    });

    it('leaves a wide column and its tab alone', () => {
      let closes = 0;
      const closed = revealCenterForTool({
        drawer: false,
        close: () => {
          closes += 1;
        },
      });

      expect(closed).toBe(false);
      expect(closes).toBe(0);
    });
  });
});
