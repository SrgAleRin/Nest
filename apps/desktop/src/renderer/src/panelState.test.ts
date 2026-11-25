import { describe, expect, it } from 'vitest';
import { panelPhase } from './panelState';

describe('panelPhase', () => {
  it('is loading before the first result', () => {
    expect(panelPhase({ loading: true, error: null, hasData: false })).toBe('loading');
  });

  it('is idle before the request starts', () => {
    expect(panelPhase({ loading: false, error: null, hasData: false })).toBe('idle');
  });

  it('keeps showing data while refreshing', () => {
    expect(panelPhase({ loading: true, error: null, hasData: true })).toBe('ready');
  });

  it('reports readiness once data arrived', () => {
    expect(panelPhase({ loading: false, error: null, hasData: true })).toBe('ready');
  });

  it('shows an error instead of stale or loading content', () => {
    expect(panelPhase({ loading: false, error: 'boom', hasData: false })).toBe('error');
    expect(panelPhase({ loading: true, error: 'boom', hasData: true })).toBe('error');
  });
});
