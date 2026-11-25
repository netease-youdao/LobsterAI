import { describe, expect, test } from 'vitest';

import {
  formatFormulaPreview,
  resolveSheetHeaderCompact,
  resolveSheetOrderIndex,
  resolveSheetTabBarCompact,
  resolveSheetTabBarHideZoom,
  resolveSheetToolbarDensity,
  SHEET_HEADER_COMPACT_WIDTH_PX,
  SHEET_TAB_BAR_COMPACT_WIDTH_PX,
  SHEET_TAB_BAR_MINIMAL_WIDTH_PX,
  SHEET_TOOLBAR_COMPACT_WIDTH_PX,
  SHEET_TOOLBAR_FULL_WIDTH_PX,
  SheetTabNameError,
  SheetToolbarDensity,
  shouldAutoExpandFormulaBar,
  validateSheetTabName,
} from './sheetToolbarLayout';

describe('sheetToolbarLayout', () => {
  test('resolves formatting toolbar density by container width', () => {
    expect(resolveSheetToolbarDensity(0)).toBe(SheetToolbarDensity.Full);
    expect(resolveSheetToolbarDensity(SHEET_TOOLBAR_FULL_WIDTH_PX)).toBe(SheetToolbarDensity.Full);
    expect(resolveSheetToolbarDensity(SHEET_TOOLBAR_FULL_WIDTH_PX - 1)).toBe(SheetToolbarDensity.Compact);
    expect(resolveSheetToolbarDensity(SHEET_TOOLBAR_COMPACT_WIDTH_PX)).toBe(SheetToolbarDensity.Compact);
    expect(resolveSheetToolbarDensity(SHEET_TOOLBAR_COMPACT_WIDTH_PX - 1)).toBe(SheetToolbarDensity.Minimal);
  });

  test('resolves compact header and tab bar breakpoints', () => {
    expect(resolveSheetHeaderCompact(0)).toBe(false);
    expect(resolveSheetHeaderCompact(SHEET_HEADER_COMPACT_WIDTH_PX)).toBe(false);
    expect(resolveSheetHeaderCompact(SHEET_HEADER_COMPACT_WIDTH_PX - 1)).toBe(true);

    expect(resolveSheetTabBarCompact(0)).toBe(false);
    expect(resolveSheetTabBarCompact(SHEET_TAB_BAR_COMPACT_WIDTH_PX)).toBe(false);
    expect(resolveSheetTabBarCompact(SHEET_TAB_BAR_COMPACT_WIDTH_PX - 1)).toBe(true);

    expect(resolveSheetTabBarHideZoom(0)).toBe(false);
    expect(resolveSheetTabBarHideZoom(SHEET_TAB_BAR_MINIMAL_WIDTH_PX)).toBe(false);
    expect(resolveSheetTabBarHideZoom(SHEET_TAB_BAR_MINIMAL_WIDTH_PX - 1)).toBe(true);
  });

  test('validates worksheet names against Excel limits and case-insensitive duplicates', () => {
    const existing = ['月度支出', 'Summary', 'Data'];
    expect(validateSheetTabName('  ', existing, 'Data')).toBe(SheetTabNameError.Empty);
    expect(validateSheetTabName('Q1/Q2', existing, 'Data')).toBe(SheetTabNameError.InvalidChars);
    expect(validateSheetTabName('a'.repeat(32), existing, 'Data')).toBe(SheetTabNameError.TooLong);
    expect(validateSheetTabName('summary', existing, 'Data')).toBe(SheetTabNameError.Duplicate);
    // Changing case of the sheet's own name is allowed.
    expect(validateSheetTabName('DATA', existing, 'Data')).toBeNull();
    expect(validateSheetTabName('预算对比', existing, 'Data')).toBeNull();
  });

  test('maps visible tab drag targets onto full sheet order including hidden sheets', () => {
    const all = ['a', 'h1', 'b', 'c'];
    const visible = ['a', 'b', 'c'];

    // Move 'a' (all 0) after 'c' (visible index 2 -> after 'c' at remaining index 2 -> toOrder 3)
    expect(resolveSheetOrderIndex(all, visible, 'a', 2)).toBe(3);
    // Move 'a' after 'b' (visible index 1 -> toOrder 2)
    expect(resolveSheetOrderIndex(all, visible, 'a', 1)).toBe(2);
    // Move 'c' (all 3) before 'a' (visible index 0 -> toOrder 0)
    expect(resolveSheetOrderIndex(all, visible, 'c', 0)).toBe(0);
    // Moving to current visible position is a no-op
    expect(resolveSheetOrderIndex(all, visible, 'b', 1)).toBeNull();

    // Leading hidden sheet stays before visible index 0
    expect(resolveSheetOrderIndex(['h0', 'a', 'b'], ['a', 'b'], 'b', 0)).toBe(1);
    expect(resolveSheetOrderIndex(all, visible, 'missing', 0)).toBeNull();
  });

  test('formats single-line formula previews and truncates long formulas', () => {
    expect(formatFormulaPreview(undefined)).toBeUndefined();
    expect(formatFormulaPreview('   ')).toBeUndefined();
    expect(formatFormulaPreview('SUM(D3:D11)')).toBe('=SUM(D3:D11)');
    expect(formatFormulaPreview('=SUM(\n  D3:D11\n)')).toBe('=SUM( D3:D11 )');
    const longFormula = `=SUM(${'A1:A100,'.repeat(12)})`;
    const preview = formatFormulaPreview(longFormula, 24);
    expect(preview).toHaveLength(24);
    expect(preview?.endsWith('…')).toBe(true);
  });

  test('auto-expands formula bar only when typing = to start a formula', () => {
    const base = {
      key: '=',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      readOnly: false,
      editing: false,
      editorText: '',
    };
    expect(shouldAutoExpandFormulaBar(base)).toBe(true);
    expect(shouldAutoExpandFormulaBar({ ...base, editing: true, editorText: '' })).toBe(true);
    expect(shouldAutoExpandFormulaBar({ ...base, editing: true, editorText: 'a ' })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, key: 'a' })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, readOnly: true })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, ctrlKey: true })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, metaKey: true })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, altKey: true })).toBe(false);
    expect(shouldAutoExpandFormulaBar({ ...base, isComposing: true })).toBe(false);
  });
});
