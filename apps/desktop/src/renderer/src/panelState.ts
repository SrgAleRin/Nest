/**
 * A panel can be loading, show stale data while refreshing, show an error or
 * have nothing to show yet. Error wins over data so a failed refresh is not
 * hidden behind content the user may believe is current.
 */
export type PanelPhase = 'loading' | 'error' | 'ready' | 'idle';

export function panelPhase(input: {
  loading: boolean;
  error: string | null;
  hasData: boolean;
}): PanelPhase {
  if (input.error) return 'error';
  if (input.hasData) return 'ready';
  return input.loading ? 'loading' : 'idle';
}
