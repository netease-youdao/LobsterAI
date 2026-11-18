// Geometry for context chips (skills, kits, modes) that flow inline in front
// of the prompt text. The chips live in an overlay above the textarea; the
// textarea makes room for them with an extra top offset (rows of chips above
// the last one) and a first-line text-indent (the last chip row), so the caret
// continues on the same line right after the last chip.

export interface InlineContextChipBox {
  /** Top edge of the chip, relative to the chip layer. */
  top: number;
  /** Right edge of the chip, relative to the chip layer. */
  right: number;
  height: number;
}

export interface InlineContextChipLayoutInput {
  /** The last chip in the layer, or null when there are no chips. */
  lastChip: InlineContextChipBox | null;
  /** Width available for text inside the textarea's content box. */
  contentWidth: number;
  lineHeight: number;
  /** Horizontal space between the last chip and the first character. */
  columnGap: number;
  /** Vertical space between chip rows. */
  rowGap: number;
  /** Below this much room after the last chip, text starts on a new row. */
  minTextWidth: number;
}

export interface InlineContextChipLayout {
  /** Offset of the chip layer from the textarea's text origin; centers chip rows on text lines. */
  layerOffsetTop: number;
  /** Extra space above the first text line, taken by chip rows. */
  textOffsetTop: number;
  /** First-line indent that keeps the caret clear of the last chip. */
  textIndent: number;
}

// Chips read as words in the sentence: they take the prompt's font size and a
// height proportional to it (24px at 15px, 26px at 16px).
const INLINE_CONTEXT_CHIP_HEIGHT_EM = 1.6;

export function resolveInlineContextChipHeight(fontSize: number): number {
  return Math.round(fontSize * INLINE_CONTEXT_CHIP_HEIGHT_EM);
}

export const EMPTY_INLINE_CONTEXT_CHIP_LAYOUT: InlineContextChipLayout = {
  layerOffsetTop: 0,
  textOffsetTop: 0,
  textIndent: 0,
};

export function computeInlineContextChipLayout(
  input: InlineContextChipLayoutInput,
): InlineContextChipLayout {
  const { lastChip, contentWidth, lineHeight, columnGap, rowGap, minTextWidth } = input;
  if (!lastChip || contentWidth <= 0) return EMPTY_INLINE_CONTEXT_CHIP_LAYOUT;

  // A chip row starting at layer offset T is centered on a text line starting
  // at T when the whole layer is shifted by half the height difference.
  const layerOffsetTop = Math.round((lineHeight - lastChip.height) / 2);
  const indent = Math.ceil(lastChip.right + columnGap);

  if (contentWidth - indent >= minTextWidth) {
    return {
      layerOffsetTop,
      textOffsetTop: Math.round(lastChip.top),
      textIndent: indent,
    };
  }

  // Not enough room beside the last chip: start the text on the next row.
  return {
    layerOffsetTop,
    textOffsetTop: Math.round(lastChip.top + lastChip.height + rowGap),
    textIndent: 0,
  };
}

export function isSameInlineContextChipLayout(
  a: InlineContextChipLayout,
  b: InlineContextChipLayout,
): boolean {
  return a.layerOffsetTop === b.layerOffsetTop
    && a.textOffsetTop === b.textOffsetTop
    && a.textIndent === b.textIndent;
}
