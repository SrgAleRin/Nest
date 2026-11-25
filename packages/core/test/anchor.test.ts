import { describe, expect, it } from 'vitest';
import { anchorBlockText, findAnchorLine } from '../src/services/anchor.js';

describe('anchorBlockText', () => {
  it('captures one or more whole lines', () => {
    expect(anchorBlockText(['a', 'b', 'c'], 2, 3)).toBe('b\nc');
    expect(anchorBlockText(['a', 'b', 'c'], 1, 1)).toBe('a');
  });

  it('rejects ranges outside the file', () => {
    expect(anchorBlockText(['a'], 2, 2)).toBeNull();
    expect(anchorBlockText(['a', 'b'], 2, 1)).toBeNull();
  });
});

describe('findAnchorLine', () => {
  it('keeps the preferred line when it still matches', () => {
    expect(findAnchorLine(['a', 'b', 'c'], 'b', 2)).toBe(2);
  });

  it('follows a line that moved', () => {
    expect(findAnchorLine(['new', 'a', 'b', 'c'], 'b', 2)).toBe(3);
  });

  it('follows a moved multi-line block', () => {
    expect(findAnchorLine(['x', 'a', 'b', 'c'], 'a\nb', 1)).toBe(2);
  });

  it('prefers the match closest to the old position', () => {
    expect(findAnchorLine(['b', 'x', 'b', 'y'], 'b', 3)).toBe(3);
    expect(findAnchorLine(['b', 'x', 'b', 'y'], 'b', 2)).toBe(1);
  });

  it('returns null when the text is gone', () => {
    expect(findAnchorLine(['a', 'c'], 'b', 2)).toBeNull();
  });

  it('ignores trailing whitespace', () => {
    expect(findAnchorLine(['a  ', 'b'], 'a', 2)).toBe(1);
  });
});
