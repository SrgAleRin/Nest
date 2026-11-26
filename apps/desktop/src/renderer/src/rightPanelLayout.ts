import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Narrow window: the panel is a drawer over the terminal, not a column.
 *
 * It sits above the window's own minimum width (`minWidth: 1040` in the main
 * process): a threshold below that would make the drawer unreachable, and the
 * panel would keep taking a column out of a window that is too small for it.
 */
export const RIGHT_PANEL_NARROW_WIDTH = 1180;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_DEFAULT_WIDTH = 390;
/** A share of the window, so the terminal keeps a usable column on big screens. */
export const RIGHT_PANEL_MAX_VIEWPORT_RATIO = 0.6;
/** One arrow-key step on the resize handle. */
export const RIGHT_PANEL_WIDTH_STEP = 24;
/** Width of the collapsed rail: an expand button and nothing else. */
export const RIGHT_PANEL_RAIL_WIDTH = 28;
export const RIGHT_PANEL_STORAGE_KEY = 'nest.rightPanel';

/** Local UI preference; the layout is never stored in SQLite. */
export interface RightPanelUi {
  width: number;
  collapsed: boolean;
}

export const DEFAULT_RIGHT_PANEL_UI: RightPanelUi = {
  width: RIGHT_PANEL_DEFAULT_WIDTH,
  collapsed: false,
};

/** The subset of `Storage` the preference needs. */
export interface RightPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isNarrowRightPanel(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth <= RIGHT_PANEL_NARROW_WIDTH;
}

export function rightPanelMaxWidth(viewportWidth: number): number {
  const max = Math.round(viewportWidth * RIGHT_PANEL_MAX_VIEWPORT_RATIO);
  return Math.max(RIGHT_PANEL_MIN_WIDTH, max);
}

/** Roughly 300 px … 60 vw; a non-finite value falls back to the default. */
export function clampRightPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width))
    return clampRightPanelWidth(RIGHT_PANEL_DEFAULT_WIDTH, viewportWidth);
  const max = rightPanelMaxWidth(viewportWidth);
  return Math.min(max, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

/** The width a pointer position at the panel's left edge means. */
export function rightPanelWidthFromPointer(pointerX: number, viewportWidth: number): number {
  return clampRightPanelWidth(viewportWidth - pointerX, viewportWidth);
}

/**
 * The width one key of the resize handle asks for; `null` for a key the handle
 * ignores. The divider is the left edge, so a left arrow grows the panel.
 */
export function rightPanelWidthForKey(
  width: number,
  key: string,
  viewportWidth: number,
): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampRightPanelWidth(width + RIGHT_PANEL_WIDTH_STEP, viewportWidth);
    case 'ArrowRight':
      return clampRightPanelWidth(width - RIGHT_PANEL_WIDTH_STEP, viewportWidth);
    case 'Home':
      return RIGHT_PANEL_MIN_WIDTH;
    case 'End':
      return rightPanelMaxWidth(viewportWidth);
    default:
      return null;
  }
}

/** A stored preference, or `null` when the value is missing or malformed. */
export function parseRightPanelUi(raw: string | null): RightPanelUi | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const width = record.width;
  const collapsed = record.collapsed;
  if (typeof width !== 'number' || !Number.isFinite(width)) return null;
  return { width, collapsed: collapsed === true };
}

export function serializeRightPanelUi(ui: RightPanelUi): string {
  return JSON.stringify({ width: Math.round(ui.width), collapsed: ui.collapsed });
}

/** Reads the stored preference; a narrow window always starts collapsed. */
export function readRightPanelUi(
  storage: RightPanelStorage | null,
  viewportWidth: number,
): RightPanelUi {
  const stored = storage ? parseRightPanelUi(safeGet(storage)) : null;
  const ui = stored ?? DEFAULT_RIGHT_PANEL_UI;
  const width = clampRightPanelWidth(ui.width, viewportWidth);
  if (isNarrowRightPanel(viewportWidth)) return { width, collapsed: true };
  return { width, collapsed: ui.collapsed };
}

export function writeRightPanelUi(storage: RightPanelStorage | null, ui: RightPanelUi): void {
  if (!storage) return;
  try {
    storage.setItem(RIGHT_PANEL_STORAGE_KEY, serializeRightPanelUi(ui));
  } catch {
    // A full or disabled storage is not a reason to break the layout.
  }
}

function safeGet(storage: RightPanelStorage): string | null {
  try {
    return storage.getItem(RIGHT_PANEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserStorage(): RightPanelStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface RightPanelLayout {
  narrow: boolean;
  /** Effective width in px; the collapsed rail is narrower than this. */
  width: number;
  /** Wide-window preference: the panel is folded into the rail. */
  collapsed: boolean;
  /** The panel is on screen (as a column, or as the narrow-window drawer). */
  open: boolean;
  /** A narrow window is showing the panel as an overlay. */
  drawer: boolean;
  setWidth(width: number): void;
  setCollapsed(collapsed: boolean): void;
  toggle(): void;
  close(): void;
  /** Opens the drawer or the column, for `Open diff`. */
  openPanel(): void;
  /** Opens the panel wider, so a patch has room next to the terminal. */
  widen(): void;
}

/**
 * Width and collapsed state of the right column, persisted in `localStorage`.
 * In a narrow window the panel is an overlay drawer that starts closed: the
 * terminal keeps its column and is never remounted by this layout.
 */
export function useRightPanelLayout(): RightPanelLayout {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const [ui, setUi] = useState<RightPanelUi>(() =>
    readRightPanelUi(browserStorage(), typeof window === 'undefined' ? 1440 : window.innerWidth),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const narrow = isNarrowRightPanel(viewportWidth);

  // Crossing into a narrow window folds the column away instead of squeezing
  // the terminal; the user opens it again on demand.
  useEffect(() => {
    if (narrow) setDrawerOpen(false);
  }, [narrow]);

  const width = clampRightPanelWidth(ui.width, viewportWidth);

  const setWidth = useCallback((next: number) => {
    setUi((previous) => {
      const updated = {
        ...previous,
        width: clampRightPanelWidth(next, window.innerWidth),
        collapsed: false,
      };
      writeRightPanelUi(browserStorage(), updated);
      return updated;
    });
  }, []);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setUi((previous) => {
      if (previous.collapsed === collapsed) return previous;
      const updated = { ...previous, collapsed };
      writeRightPanelUi(browserStorage(), updated);
      return updated;
    });
  }, []);

  const openPanel = useCallback(() => {
    setDrawerOpen(true);
    setCollapsed(false);
  }, [setCollapsed]);

  // Closing the narrow drawer is not a preference about the wide column.
  const close = useCallback(() => {
    setDrawerOpen(false);
    if (!narrow) setCollapsed(true);
  }, [narrow, setCollapsed]);

  const toggle = useCallback(() => {
    if (narrow) setDrawerOpen((previous) => !previous);
    else setCollapsed(!ui.collapsed);
  }, [narrow, setCollapsed, ui.collapsed]);

  const widen = useCallback(() => {
    setDrawerOpen(true);
    setUi((previous) => {
      const nextWidth = Math.min(
        rightPanelMaxWidth(window.innerWidth),
        Math.max(clampRightPanelWidth(previous.width, window.innerWidth), 620),
      );
      const updated = { width: nextWidth, collapsed: false };
      writeRightPanelUi(browserStorage(), updated);
      return updated;
    });
  }, []);

  return useMemo(
    () => ({
      narrow,
      width,
      collapsed: ui.collapsed,
      open: narrow ? drawerOpen : !ui.collapsed,
      drawer: narrow && drawerOpen,
      setWidth,
      setCollapsed,
      toggle,
      close,
      openPanel,
      widen,
    }),
    [
      narrow,
      width,
      ui.collapsed,
      drawerOpen,
      setWidth,
      setCollapsed,
      toggle,
      close,
      openPanel,
      widen,
    ],
  );
}
