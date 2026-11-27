import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Narrow window: the panel is a drawer over the terminal, not a column.
 *
 * Electron reports CSS pixels, so a `1100x700` window at 150% DPI only has
 * about `733` of them. The threshold covers that case and every window up to
 * `980` px: below it a column would eat the terminal that the panel exists to
 * serve.
 */
export const LEFT_PANEL_NARROW_WIDTH = 980;
export const LEFT_PANEL_MIN_WIDTH = 220;
export const LEFT_PANEL_DEFAULT_WIDTH = 272;
/** The sidebar holds names and badges; anything wider is a table pretending. */
export const LEFT_PANEL_MAX_WIDTH = 440;
/** A share of the window, so the terminal keeps a usable column on big screens. */
export const LEFT_PANEL_MAX_VIEWPORT_RATIO = 0.38;
/** One arrow-key step on the resize handle. */
export const LEFT_PANEL_WIDTH_STEP = 24;
/** Width of the collapsed rail: an expand button and nothing else. */
export const LEFT_PANEL_RAIL_WIDTH = 28;
export const LEFT_PANEL_STORAGE_KEY = 'nest.leftPanel';

/** Local UI preference; the layout is never stored in SQLite. */
export interface LeftPanelUi {
  width: number;
  collapsed: boolean;
}

export const DEFAULT_LEFT_PANEL_UI: LeftPanelUi = {
  width: LEFT_PANEL_DEFAULT_WIDTH,
  collapsed: false,
};

/** The subset of `Storage` the preference needs. */
export interface LeftPanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isNarrowLeftPanel(viewportWidth: number): boolean {
  return viewportWidth > 0 && viewportWidth <= LEFT_PANEL_NARROW_WIDTH;
}

/** Roughly 220 px … 38 vw, and never wider than a fixed cap. */
export function leftPanelMaxWidth(viewportWidth: number): number {
  const share = Math.round(viewportWidth * LEFT_PANEL_MAX_VIEWPORT_RATIO);
  return Math.max(LEFT_PANEL_MIN_WIDTH, Math.min(LEFT_PANEL_MAX_WIDTH, share));
}

/** Roughly 220 px … 38 vw; a non-finite value falls back to the default. */
export function clampLeftPanelWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return clampLeftPanelWidth(LEFT_PANEL_DEFAULT_WIDTH, viewportWidth);
  const max = leftPanelMaxWidth(viewportWidth);
  return Math.min(max, Math.max(LEFT_PANEL_MIN_WIDTH, Math.round(width)));
}

/** The width a pointer position at the panel's right edge means. */
export function leftPanelWidthFromPointer(pointerX: number, viewportWidth: number): number {
  return clampLeftPanelWidth(pointerX, viewportWidth);
}

/**
 * The width one key of the resize handle asks for; `null` for a key the handle
 * ignores. The divider is the right edge, so a right arrow grows the panel.
 */
export function leftPanelWidthForKey(
  width: number,
  key: string,
  viewportWidth: number,
): number | null {
  switch (key) {
    case 'ArrowRight':
      return clampLeftPanelWidth(width + LEFT_PANEL_WIDTH_STEP, viewportWidth);
    case 'ArrowLeft':
      return clampLeftPanelWidth(width - LEFT_PANEL_WIDTH_STEP, viewportWidth);
    case 'Home':
      return LEFT_PANEL_MIN_WIDTH;
    case 'End':
      return leftPanelMaxWidth(viewportWidth);
    default:
      return null;
  }
}

/** A stored preference, or `null` when the value is missing or malformed. */
export function parseLeftPanelUi(raw: string | null): LeftPanelUi | null {
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

export function serializeLeftPanelUi(ui: LeftPanelUi): string {
  return JSON.stringify({ width: Math.round(ui.width), collapsed: ui.collapsed });
}

/** Reads the stored preference; a narrow window always starts collapsed. */
export function readLeftPanelUi(
  storage: LeftPanelStorage | null,
  viewportWidth: number,
): LeftPanelUi {
  const stored = storage ? parseLeftPanelUi(safeGet(storage)) : null;
  const ui = stored ?? DEFAULT_LEFT_PANEL_UI;
  const width = clampLeftPanelWidth(ui.width, viewportWidth);
  if (isNarrowLeftPanel(viewportWidth)) return { width, collapsed: true };
  return { width, collapsed: ui.collapsed };
}

export function writeLeftPanelUi(storage: LeftPanelStorage | null, ui: LeftPanelUi): void {
  if (!storage) return;
  try {
    storage.setItem(LEFT_PANEL_STORAGE_KEY, serializeLeftPanelUi(ui));
  } catch {
    // A full or disabled storage is not a reason to break the layout.
  }
}

function safeGet(storage: LeftPanelStorage): string | null {
  try {
    return storage.getItem(LEFT_PANEL_STORAGE_KEY);
  } catch {
    return null;
  }
}

function browserStorage(): LeftPanelStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface LeftPanelLayout {
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
  /** Opens the drawer or the column. */
  openPanel(): void;
}

/**
 * Width and collapsed state of the left column, persisted in `localStorage`.
 * In a narrow window the panel is an overlay drawer that starts closed: the
 * terminal keeps its column and is never remounted by this layout.
 */
export function useLeftPanelLayout(): LeftPanelLayout {
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const [ui, setUi] = useState<LeftPanelUi>(() =>
    readLeftPanelUi(browserStorage(), typeof window === 'undefined' ? 1440 : window.innerWidth),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const narrow = isNarrowLeftPanel(viewportWidth);

  // Crossing into a narrow window folds the column away instead of squeezing
  // the terminal; the user opens it again on demand.
  useEffect(() => {
    if (narrow) setDrawerOpen(false);
  }, [narrow]);

  const width = clampLeftPanelWidth(ui.width, viewportWidth);

  const setWidth = useCallback((next: number) => {
    setUi((previous) => {
      const updated = {
        ...previous,
        width: clampLeftPanelWidth(next, window.innerWidth),
        collapsed: false,
      };
      writeLeftPanelUi(browserStorage(), updated);
      return updated;
    });
  }, []);

  const setCollapsed = useCallback((collapsed: boolean) => {
    setUi((previous) => {
      if (previous.collapsed === collapsed) return previous;
      const updated = { ...previous, collapsed };
      writeLeftPanelUi(browserStorage(), updated);
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
    }),
    [narrow, width, ui.collapsed, drawerOpen, setWidth, setCollapsed, toggle, close, openPanel],
  );
}
