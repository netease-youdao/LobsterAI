import { describe, expect, test } from 'vitest';

import {
  cycleFindMatchIndex,
  resolveWordHeaderCompact,
  resolveWordToolbarDensity,
  WORD_HEADER_COMPACT_WIDTH_PX,
  WORD_TOOLBAR_COMPACT_WIDTH_PX,
  WORD_TOOLBAR_MINIMAL_WIDTH_PX,
  WordToolbarDensity,
} from './wordToolbarLayout';

describe('resolveWordToolbarDensity', () => {
  test('uses Full before width is measured or when wide enough', () => {
    expect(resolveWordToolbarDensity(0)).toBe(WordToolbarDensity.Full);
    expect(resolveWordToolbarDensity(WORD_TOOLBAR_COMPACT_WIDTH_PX)).toBe(WordToolbarDensity.Full);
    expect(resolveWordToolbarDensity(720)).toBe(WordToolbarDensity.Full);
  });

  test('switches to Compact at medium side-panel widths', () => {
    expect(resolveWordToolbarDensity(WORD_TOOLBAR_COMPACT_WIDTH_PX - 1)).toBe(WordToolbarDensity.Compact);
    expect(resolveWordToolbarDensity(WORD_TOOLBAR_MINIMAL_WIDTH_PX)).toBe(WordToolbarDensity.Compact);
  });

  test('switches to Minimal at narrow widths', () => {
    expect(resolveWordToolbarDensity(WORD_TOOLBAR_MINIMAL_WIDTH_PX - 1)).toBe(WordToolbarDensity.Minimal);
    expect(resolveWordToolbarDensity(320)).toBe(WordToolbarDensity.Minimal);
  });
});

describe('resolveWordHeaderCompact', () => {
  test('collapses secondary header buttons only on measured narrow widths', () => {
    expect(resolveWordHeaderCompact(0)).toBe(false);
    expect(resolveWordHeaderCompact(WORD_HEADER_COMPACT_WIDTH_PX)).toBe(false);
    expect(resolveWordHeaderCompact(WORD_HEADER_COMPACT_WIDTH_PX - 1)).toBe(true);
  });
});

describe('cycleFindMatchIndex', () => {
  test('returns -1 when there are no matches', () => {
    expect(cycleFindMatchIndex(0, 0, 1)).toBe(-1);
    expect(cycleFindMatchIndex(-1, 0, -1)).toBe(-1);
  });

  test('wraps forward and backward cleanly', () => {
    expect(cycleFindMatchIndex(0, 3, 1)).toBe(1);
    expect(cycleFindMatchIndex(2, 3, 1)).toBe(0);
    expect(cycleFindMatchIndex(0, 3, -1)).toBe(2);
    expect(cycleFindMatchIndex(-1, 3, 1)).toBe(0);
    expect(cycleFindMatchIndex(-1, 3, -1)).toBe(2);
  });
});
