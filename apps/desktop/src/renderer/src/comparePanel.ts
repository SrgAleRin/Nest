/** The pair of revisions the `Compare` panel shows. */
export interface CompareSelection {
  base: string;
  head: string;
}

/** The pair a freshly loaded branch list suggests. */
export type CompareSeed = CompareSelection;

/**
 * The pair a late branch seed may write, or `null` when the seed must do
 * nothing. A pair the user picked by hand is never overwritten and never
 * reloaded, so a seed that arrives after a pick (or after a comparison opened
 * from the graph or the inspector) cannot jump the pickers back. While nothing
 * was picked the seed keeps its old behaviour: it fills an empty base once and
 * keeps a head that is already set.
 */
export function applyCompareSeed(
  current: CompareSelection,
  seed: CompareSeed,
  touched: boolean,
): CompareSelection | null {
  if (touched) return null;
  // The base was seeded (or chosen) before: a refreshed branch list must not
  // restart the comparison on its own.
  if (current.base) return null;
  if (!seed.base) return null;
  return { base: seed.base, head: current.head || seed.head };
}
