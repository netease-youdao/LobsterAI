import { describe, expect, test } from 'vitest';

import {
  computeInlineContextChipLayout,
  EMPTY_INLINE_CONTEXT_CHIP_LAYOUT,
  type InlineContextChipLayoutInput,
  isSameInlineContextChipLayout,
  resolveInlineContextChipHeight,
} from './inlineContextChipLayout';

describe('resolveInlineContextChipHeight', () => {
  test('scales with the prompt font size in whole pixels', () => {
    expect(resolveInlineContextChipHeight(15)).toBe(24);
    expect(resolveInlineContextChipHeight(16)).toBe(26);
    expect(resolveInlineContextChipHeight(13)).toBe(21);
  });
});

const baseInput: InlineContextChipLayoutInput = {
  lastChip: { top: 0, right: 120, height: 24 },
  contentWidth: 600,
  lineHeight: 24,
  columnGap: 6,
  rowGap: 4,
  minTextWidth: 64,
};

describe('computeInlineContextChipLayout', () => {
  test('returns the empty layout without chips', () => {
    expect(computeInlineContextChipLayout({ ...baseInput, lastChip: null }))
      .toEqual(EMPTY_INLINE_CONTEXT_CHIP_LAYOUT);
  });

  test('returns the empty layout before the textarea has a width', () => {
    expect(computeInlineContextChipLayout({ ...baseInput, contentWidth: 0 }))
      .toEqual(EMPTY_INLINE_CONTEXT_CHIP_LAYOUT);
  });

  test('continues the first text line right after a single chip row', () => {
    expect(computeInlineContextChipLayout(baseInput)).toEqual({
      layerOffsetTop: 0,
      textOffsetTop: 0,
      textIndent: 126,
    });
  });

  test('aligns the text line with the last of several chip rows', () => {
    expect(computeInlineContextChipLayout({
      ...baseInput,
      lastChip: { top: 56, right: 210.4, height: 24 },
    })).toEqual({
      layerOffsetTop: 0,
      textOffsetTop: 56,
      textIndent: 217,
    });
  });

  test('centers chip rows on text lines when the chip is taller than a line', () => {
    expect(computeInlineContextChipLayout({ ...baseInput, lineHeight: 20 }).layerOffsetTop).toBe(-2);
    expect(computeInlineContextChipLayout({ ...baseInput, lineHeight: 28 }).layerOffsetTop).toBe(2);
  });

  test('starts the text on a new row when the last chip leaves too little room', () => {
    expect(computeInlineContextChipLayout({
      ...baseInput,
      lastChip: { top: 28, right: 560, height: 24 },
    })).toEqual({
      layerOffsetTop: 0,
      textOffsetTop: 56,
      textIndent: 0,
    });
  });

  test('keeps the text beside the last chip when exactly the minimum room is left', () => {
    const layout = computeInlineContextChipLayout({
      ...baseInput,
      lastChip: { top: 0, right: 530, height: 24 },
    });
    expect(layout.textIndent).toBe(536);
    expect(layout.textOffsetTop).toBe(0);
  });
});

describe('isSameInlineContextChipLayout', () => {
  test('compares every field', () => {
    const layout = computeInlineContextChipLayout(baseInput);
    expect(isSameInlineContextChipLayout(layout, { ...layout })).toBe(true);
    expect(isSameInlineContextChipLayout(layout, { ...layout, textIndent: layout.textIndent + 1 })).toBe(false);
    expect(isSameInlineContextChipLayout(layout, { ...layout, textOffsetTop: 28 })).toBe(false);
    expect(isSameInlineContextChipLayout(layout, { ...layout, layerOffsetTop: 1 })).toBe(false);
  });
});
