/**
 * Horizontal tab strip scrolling.
 *
 * The tab bar hides its scrollbar so the strip stays flat, which also removes
 * the only way to reach a tab that overflows on the right: a vertical wheel
 * does nothing in a horizontally scrolling box and `Shift`+wheel is not
 * something users try. These helpers keep the arithmetic out of the component
 * and testable: a wheel ticks through the strip and the selected tab is always
 * scrolled back into view.
 */
export interface TabStripMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export function hasOverflow(metrics: TabStripMetrics): boolean {
  return metrics.scrollWidth > metrics.clientWidth + 1;
}

/** New `scrollLeft` after a wheel delta (pixels), clamped to the content. */
export function scrollTabsBy(metrics: TabStripMetrics, delta: number): number {
  if (!hasOverflow(metrics) || delta === 0) return metrics.scrollLeft;
  const limit = metrics.scrollWidth - metrics.clientWidth;
  return Math.min(Math.max(metrics.scrollLeft + delta, 0), limit);
}

/**
 * Offset that brings one tab fully into view with the least movement. `left`
 * and `width` are relative to the strip's content box.
 */
export function revealTab(
  metrics: TabStripMetrics,
  tab: { left: number; width: number },
): number {
  const viewLeft = metrics.scrollLeft;
  const viewRight = viewLeft + metrics.clientWidth;
  if (tab.width >= metrics.clientWidth) return Math.max(tab.left, 0);
  if (tab.left < viewLeft) return Math.max(tab.left, 0);
  if (tab.left + tab.width > viewRight) return tab.left + tab.width - metrics.clientWidth;
  return viewLeft;
}
