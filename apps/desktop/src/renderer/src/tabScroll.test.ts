import { describe, expect, it } from 'vitest';
import { hasOverflow, revealTab, scrollTabsBy } from './tabScroll';

const strip = (scrollLeft: number, scrollWidth = 900, clientWidth = 400) => ({
  scrollLeft,
  scrollWidth,
  clientWidth,
});

describe('tab strip scrolling', () => {
  it('detects a strip that is wider than its viewport', () => {
    expect(hasOverflow(strip(0))).toBe(true);
    expect(hasOverflow(strip(0, 400, 400))).toBe(false);
  });

  it('clamps a wheel delta to the content', () => {
    expect(scrollTabsBy(strip(0), 120)).toBe(120);
    expect(scrollTabsBy(strip(480), 120)).toBe(500);
    expect(scrollTabsBy(strip(0), -120)).toBe(0);
    expect(scrollTabsBy(strip(100, 400, 400), 120)).toBe(100);
  });

  it('reveals a tab past the right edge by the smallest step', () => {
    // Viewport shows 0..400; the tab sits at 380..500.
    expect(revealTab(strip(0), { left: 380, width: 120 })).toBe(100);
  });

  it('reveals a tab hidden on the left', () => {
    expect(revealTab(strip(300), { left: 120, width: 100 })).toBe(120);
  });

  it('leaves a fully visible tab alone', () => {
    expect(revealTab(strip(100), { left: 150, width: 100 })).toBe(100);
  });

  it('left-aligns a tab wider than the viewport', () => {
    expect(revealTab(strip(200), { left: 300, width: 600 })).toBe(300);
  });
});
