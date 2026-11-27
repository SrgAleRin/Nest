import { describe, expect, it } from 'vitest';
import { applyCompareSeed, type CompareSelection } from './comparePanel';

const empty: CompareSelection = { base: '', head: '' };
const seed: CompareSelection = { base: 'main', head: 'feature' };

describe('compare branch seed', () => {
  it('fills an empty pair while nothing was picked by hand', () => {
    expect(applyCompareSeed(empty, seed, false)).toEqual({ base: 'main', head: 'feature' });
  });

  it('keeps a head that is already set and only fills the base', () => {
    expect(applyCompareSeed({ base: '', head: 'release/1.2' }, seed, false)).toEqual({
      base: 'main',
      head: 'release/1.2',
    });
  });

  it('does not re-seed a pair that already has a base', () => {
    expect(applyCompareSeed({ base: 'origin/main', head: 'HEAD' }, seed, false)).toBeNull();
  });

  it('never overwrites a pair the user picked by hand', () => {
    expect(applyCompareSeed(empty, seed, true)).toBeNull();
    expect(applyCompareSeed({ base: 'origin/main', head: 'feature' }, seed, true)).toBeNull();
  });

  it('does nothing without a base to seed', () => {
    expect(applyCompareSeed(empty, { base: '', head: 'HEAD' }, false)).toBeNull();
  });
});
