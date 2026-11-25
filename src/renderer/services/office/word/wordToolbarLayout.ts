/** Breakpoints for the single-row Word formatting bar so controls collapse into More instead of wrapping. */
export const WORD_TOOLBAR_COMPACT_WIDTH_PX = 540;
export const WORD_TOOLBAR_MINIMAL_WIDTH_PX = 445;
/** Below this width, Undo/Redo in the Word top header fold into the formatting More menu. */
export const WORD_HEADER_COMPACT_WIDTH_PX = 420;

export const WordToolbarDensity = {
  Full: 'full',
  Compact: 'compact',
  Minimal: 'minimal',
} as const;

export type WordToolbarDensity = typeof WordToolbarDensity[keyof typeof WordToolbarDensity];

export function resolveWordToolbarDensity(width: number): WordToolbarDensity {
  if (width <= 0 || width >= WORD_TOOLBAR_COMPACT_WIDTH_PX) {
    return WordToolbarDensity.Full;
  }
  if (width >= WORD_TOOLBAR_MINIMAL_WIDTH_PX) {
    return WordToolbarDensity.Compact;
  }
  return WordToolbarDensity.Minimal;
}

export function resolveWordHeaderCompact(width: number): boolean {
  return width > 0 && width < WORD_HEADER_COMPACT_WIDTH_PX;
}

export function cycleFindMatchIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) {
    return delta > 0 ? 0 : total - 1;
  }
  return (current + delta + total) % total;
}
