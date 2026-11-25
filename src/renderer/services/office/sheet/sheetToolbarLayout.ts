/** Responsive breakpoints for the single-row Excel formatting toolbar so controls collapse cleanly into More. */
export const SHEET_TOOLBAR_FULL_WIDTH_PX = 860;
export const SHEET_TOOLBAR_COMPACT_WIDTH_PX = 560;
/** Below this width, Undo/Redo in the Excel header fold into the header More menu. */
export const SHEET_HEADER_COMPACT_WIDTH_PX = 400;
/** Below this width, the bottom SheetTabBar hides inline selection statistics to keep sheet tabs generous. */
export const SHEET_TAB_BAR_COMPACT_WIDTH_PX = 440;
/** Below this width, the bottom SheetTabBar also hides its zoom trigger (zoom remains in the header More menu). */
export const SHEET_TAB_BAR_MINIMAL_WIDTH_PX = 310;

export const SHEET_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const SHEET_TAB_NAME_MAX_LENGTH = 31;

/** Characters forbidden in Excel worksheet names. */
const INVALID_SHEET_NAME_CHARS = /[:\\/?*[\]]/;

export const SheetToolbarDensity = {
  Full: 'full',
  Compact: 'compact',
  Minimal: 'minimal',
} as const;
export type SheetToolbarDensity = typeof SheetToolbarDensity[keyof typeof SheetToolbarDensity];

export const SheetTabNameError = {
  Empty: 'empty',
  InvalidChars: 'invalidChars',
  TooLong: 'tooLong',
  Duplicate: 'duplicate',
} as const;
export type SheetTabNameError = typeof SheetTabNameError[keyof typeof SheetTabNameError];

export const SheetStatisticFunc = {
  Sum: 'SUM',
  Average: 'AVERAGE',
  Count: 'COUNT',
  CountA: 'COUNTA',
  Min: 'MIN',
  Max: 'MAX',
} as const;
export type SheetStatisticFunc = typeof SheetStatisticFunc[keyof typeof SheetStatisticFunc];

export function resolveSheetToolbarDensity(width: number): SheetToolbarDensity {
  if (width <= 0 || width >= SHEET_TOOLBAR_FULL_WIDTH_PX) {
    return SheetToolbarDensity.Full;
  }
  if (width >= SHEET_TOOLBAR_COMPACT_WIDTH_PX) {
    return SheetToolbarDensity.Compact;
  }
  return SheetToolbarDensity.Minimal;
}

export function resolveSheetHeaderCompact(width: number): boolean {
  return width > 0 && width < SHEET_HEADER_COMPACT_WIDTH_PX;
}

export function resolveSheetTabBarCompact(width: number): boolean {
  return width > 0 && width < SHEET_TAB_BAR_COMPACT_WIDTH_PX;
}

export function resolveSheetTabBarHideZoom(width: number): boolean {
  return width > 0 && width < SHEET_TAB_BAR_MINIMAL_WIDTH_PX;
}

/** Validate a proposed worksheet name against Excel's naming rules and existing workbook sheets. */
export function validateSheetTabName(
  rawName: string,
  existingNames: readonly string[],
  currentName: string,
): SheetTabNameError | null {
  const trimmed = rawName.trim();
  if (!trimmed) return SheetTabNameError.Empty;
  if (trimmed.length > SHEET_TAB_NAME_MAX_LENGTH) return SheetTabNameError.TooLong;
  if (INVALID_SHEET_NAME_CHARS.test(trimmed)) return SheetTabNameError.InvalidChars;
  const lower = trimmed.toLowerCase();
  const currentLower = currentName.trim().toLowerCase();
  if (lower !== currentLower && existingNames.some(name => name.trim().toLowerCase() === lower)) {
    return SheetTabNameError.Duplicate;
  }
  return null;
}

/**
 * Convert a drop target index among visible sheet tabs into the `order` index expected by
 * Univer's `SetWorksheetOrderCommand` (which splices `fromOrder` out, then inserts at `toOrder`).
 * Returns `null` when the sheet would stay in its current position or cannot be found.
 */
export function resolveSheetOrderIndex(
  allSheetIds: readonly string[],
  visibleSheetIds: readonly string[],
  draggedId: string,
  targetVisibleIndex: number,
): number | null {
  const fromOrder = allSheetIds.indexOf(draggedId);
  const currentVisibleIndex = visibleSheetIds.indexOf(draggedId);
  if (fromOrder < 0 || currentVisibleIndex < 0) return null;
  const remainingAll = allSheetIds.filter(id => id !== draggedId);
  const remainingVisible = visibleSheetIds.filter(id => id !== draggedId);
  const clamped = Math.max(0, Math.min(targetVisibleIndex, remainingVisible.length));
  if (clamped === currentVisibleIndex) return null;
  let toOrder: number;
  if (clamped === 0) {
    toOrder = remainingVisible.length > 0 ? remainingAll.indexOf(remainingVisible[0]) : 0;
  } else {
    const previousVisibleId = remainingVisible[clamped - 1];
    toOrder = remainingAll.indexOf(previousVisibleId) + 1;
  }
  if (toOrder < 0 || toOrder === fromOrder) return null;
  return toOrder;
}

/** Compact single-line formula preview for the header `fx` tooltip when the formula bar is collapsed. */
export function formatFormulaPreview(formula: string | undefined, maxLength = 60): string | undefined {
  if (!formula) return undefined;
  const normalized = formula.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const prefixed = normalized.startsWith('=') ? normalized : `=${normalized}`;
  if (prefixed.length <= maxLength) return prefixed;
  return `${prefixed.slice(0, Math.max(1, maxLength - 1))}…`;
}

export interface FormulaAutoExpandInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  readOnly: boolean;
  editing: boolean;
  editorText: string;
}

/**
 * Expand the collapsed formula bar when the user starts typing a formula (`=`) into a cell,
 * without triggering when `=` is typed in the middle of ordinary text.
 */
export function shouldAutoExpandFormulaBar(input: FormulaAutoExpandInput): boolean {
  if (input.readOnly || input.ctrlKey || input.metaKey || input.altKey || input.isComposing) {
    return false;
  }
  if (input.key !== '=') return false;
  return !input.editing || input.editorText.length === 0;
}
