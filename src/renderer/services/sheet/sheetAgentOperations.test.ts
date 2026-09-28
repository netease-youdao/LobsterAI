import { CommandType, CustomCommandExecutionError, ICommandService, IUndoRedoService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { afterEach, describe, expect, test } from 'vitest';

import { makeSheetFixture } from '../../../../tests/fixtures/sheet';
import { SheetEditType } from '../../../shared/artifactPreview/sheetAgent';
import { applySheetEdits, formulaErrors, readSheet, SheetAgentError } from './sheetAgentOperations';
import { editorImport } from './sheetEditorImport';
import { StructureTracker } from './sheetStructureTracker';
import { createHeadlessSheetUniver, registerWorkbookTables } from './sheetUniverEngine';
import { importXlsx } from './xlsxImport';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

async function open() {
  const imported = importXlsx(await makeSheetFixture(), { name: 'fixture.xlsx', univerLocale: 'zhCN', formatLocale: 'zh', maxCells: 100_000 });
  const { univer, api } = createHeadlessSheetUniver('zh');
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, imported.data);
  registerWorkbookTables(univer, imported.data.id, imported.tables);
  univer.__getInjector().get(IUniverInstanceService).focusUnit(imported.data.id);
  disposers.push(() => univer.dispose());
  const tracker = new StructureTracker(univer, editorImport(imported));
  tracker.install();
  const refusals: string[] = [];
  univer.__getInjector().get(ICommandService).beforeCommandExecuted(command => {
    const reason = command.type === CommandType.COMMAND ? tracker.refusalFor(command) : undefined;
    if (reason) {
      refusals.push(reason);
      throw new CustomCommandExecutionError(reason);
    }
  });
  const workbook = api.getActiveWorkbook()!;
  await api.getFormula().onCalculationResultApplied(5000);
  return { univer, api, workbook, mdw: imported.baseline.maxDigitWidth, refusals };
}

describe('agent reads', () => {
  test('returns sheets, sparse cells with formulas and formatted text, and merges', async () => {
    const { workbook } = await open();
    const result = readSheet(workbook, {});
    expect(result.sheets).toEqual([{ name: '数据', usedRange: 'A1:E6', frozen: { rows: 1, columns: 0 } }, { name: 'Summary', usedRange: 'A1:B2' }]);
    expect(result.sheet).toBe('数据');
    expect(result.range).toBe('A1:E6');
    expect(result.cells.A1).toBe('项目');
    expect(result.cells.B2).toBe(3);
    expect(result.cells.C2).toMatchObject({ value: 15, formula: '=B2*Rate' });
    expect(result.cells.C4).toMatchObject({ value: 25, formula: '=B4*Rate' });
    expect(result.cells.D3).toMatchObject({ value: 46293, text: '2026/9/28' });
    expect(result.cells.E1).toBeUndefined();
    expect(result.merged).toEqual(['D6:E6']);
    const summary = readSheet(workbook, { sheet: 'summary', range: 'A1:B1' });
    expect(summary.cells).toEqual({ A1: { value: 'Rate', formula: '="Rate"' }, B1: 5 });
  });

  test('truncates large ranges and says where to continue', async () => {
    const { workbook } = await open();
    const result = readSheet(workbook, { range: 'A1:E6', maxCells: 10 });
    expect(result.range).toBe('A1:E2');
    expect(result.truncated).toEqual({ nextRange: 'A3:E4' });
    expect(() => readSheet(workbook, { sheet: 'Missing' })).toThrow(SheetAgentError);
  });
});

describe('agent edits', () => {
  test('apply values, formulas, fills and formats as one undoable step', async () => {
    const { univer, api, workbook, mdw } = await open();
    const undo = univer.__getInjector().get(IUndoRedoService);
    const before = undo.getUndoRedoStatus(workbook.getId()).undos;
    const group = undo.beginUndoRedoGroup(workbook.getId(), 'agent-test', 'append');
    const result = applySheetEdits(workbook, api, [
      { type: SheetEditType.SetValues, range: 'B2', values: [[10], [20]] },
      { type: SheetEditType.SetValues, sheet: 'Summary', range: 'A4:B5', values: [['合计', '=SUM(数据!B2:B4)'], [null, true]] },
      { type: SheetEditType.SetFormula, range: 'D2:D4', formula: '=B2*2' },
      { type: SheetEditType.Format, range: 'A2:A4', bold: true, fillColor: '#FFFF00', horizontalAlignment: 'right', underline: true, strikethrough: true },
      { type: SheetEditType.Format, range: 'B2:B4', numberFormat: '#,##0.00', border: 'all' },
      { type: SheetEditType.SetColumnWidth, columns: 'B:C', width: 20 },
      { type: SheetEditType.SetRowHeight, rows: '2', height: 30 },
      { type: SheetEditType.Merge, range: 'A8:B8' },
    ], { mdw });
    group.dispose();
    await api.getFormula().onCalculationResultApplied(5000);
    expect(result.applied).toBe(8);
    expect(result.changed).toEqual(['数据!B2:B3', 'Summary!A4:B5', '数据!D2:D4', '数据!A2:A4', '数据!B2:B4', '数据!B:C', '数据!2:2', '数据!A8:B8']);
    expect(result.focus).toEqual({ sheet: '数据', range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 } });
    const data = workbook.getSheetByName('数据')!;
    const summary = workbook.getSheetByName('Summary')!;
    expect(data.getRange('B2:B3').getRawValues()).toEqual([[10], [20]]);
    expect(summary.getRange('B4').getRawValue()).toBe(35);
    expect(summary.getRange('B5').getRawValue()).toBe(1);
    expect(data.getRange('D2:D4').getFormulas()).toEqual([['=B2*2'], ['=B3*2'], ['=B4*2']]);
    expect(data.getRange('D4').getRawValue()).toBe(10);
    const style = data.getRange('A2').getCellStyleData()!;
    expect(style).toMatchObject({ bl: 1, bg: { rgb: '#FFFF00' }, ht: 3, ul: { s: 1 }, st: { s: 1 } });
    expect(data.getRange('B2').getNumberFormat()).toBe('#,##0.00');
    expect(data.getRange('B2').getCellStyleData()?.bd?.t?.s).toBe(1);
    expect(data.getColumnWidth(1)).toBe(Math.round(20 * mdw + 5));
    expect(data.getRowHeight(1)).toBe(40);
    expect(data.getMergedRanges().map(range => range.getA1Notation())).toContain('A8:B8');
    // One undo reverts the whole call.
    expect(undo.getUndoRedoStatus(workbook.getId()).undos).toBe(before + 1);
    await api.undo();
    await api.getFormula().onCalculationResultApplied(5000);
    expect(data.getRange('B2').getRawValue()).toBe(3);
    expect(summary.getRange('A4').getRawValue() ?? null).toBeNull();
    expect(data.getRange('A2').getCellStyleData()?.bl).not.toBe(1);
  });

  test('refuse invalid edits before changing anything', async () => {
    const { api, workbook, mdw } = await open();
    const invalid = [
      [{ type: SheetEditType.SetValues, range: 'A1:B1', values: [[1]] }],
      [{ type: SheetEditType.SetValues, range: 'A1', values: [[1, 2], [3]] }],
      [{ type: SheetEditType.Format, range: 'A1', fontColor: 'red' }],
      [{ type: SheetEditType.Format, range: 'A1' }],
      [{ type: 'insert_rows', range: 'A1' }],
      [{ type: SheetEditType.SetColumnWidth, columns: 'B', width: 0 }],
      [{ type: SheetEditType.Merge, range: 'A1' }],
      [{ type: SheetEditType.SetValues, range: 'A1', values: [['ok']] }, { type: SheetEditType.Clear, range: 'nowhere' }],
    ];
    for (const edits of invalid) {
      expect(() => applySheetEdits(workbook, api, edits, { mdw }), JSON.stringify(edits)).toThrow(SheetAgentError);
    }
    expect(workbook.getSheetByName('数据')!.getRange('A1').getRawValue()).toBe('项目');
  });

  test('insert rows, add, rename and move sheets and freeze panes in order', async () => {
    const { api, workbook, mdw } = await open();
    applySheetEdits(workbook, api, [
      { type: SheetEditType.InsertRows, sheet: '数据', rows: '3:4' },
      { type: SheetEditType.SetValues, sheet: '数据', range: 'A3', values: [['新行']] },
      { type: SheetEditType.AddSheet, name: '汇总2', position: 1 },
      { type: SheetEditType.SetValues, sheet: '汇总2', range: 'A1', values: [['=SUM(数据!B2:B8)']] },
      { type: SheetEditType.RenameSheet, sheet: 'Summary', name: 'Totals' },
      { type: SheetEditType.Freeze, sheet: '数据', rows: 2, columns: 1 },
      { type: SheetEditType.SetTabColor, sheet: 'Totals', color: '#FF0000' },
    ], { mdw });
    await api.getFormula().onCalculationResultApplied(5000);
    expect(workbook.getSheets().map(sheet => sheet.getSheetName())).toEqual(['汇总2', '数据', 'Totals']);
    const data = workbook.getSheetByName('数据')!;
    expect(data.getRange('A3').getRawValue()).toBe('新行');
    expect(data.getRange('B8').getFormula()).toBe('=SUM(B2:B6)');
    expect(data.getFreeze()).toMatchObject({ xSplit: 1, ySplit: 2 });
    expect(workbook.getSheetByName('汇总2')!.getRange('A1').getRawValue()).toBe(24);
    expect(readSheet(workbook, { sheet: '数据' }).sheets[1]).toMatchObject({ name: '数据', frozen: { rows: 2, columns: 1 } });
  });

  test('refused structural edits fail with the reason', async () => {
    const { api, workbook, mdw, refusals } = await open();
    expect(() => applySheetEdits(workbook, api, [{ type: SheetEditType.DeleteColumns, sheet: '数据', columns: 'A:C' }], {
      mdw, refusal: () => refusals[refusals.length - 1],
    })).toThrow(/refused: table-columns/);
    expect(() => applySheetEdits(workbook, api, [{ type: SheetEditType.RenameSheet, sheet: '数据', name: 'Summary' }], { mdw })).toThrow(/already exists/);
    expect(() => applySheetEdits(workbook, api, [{ type: SheetEditType.AddSheet, name: 'a/b' }], { mdw })).toThrow(SheetAgentError);
  });

  test('report formula errors in edited ranges', async () => {
    const { api, workbook, mdw } = await open();
    const result = applySheetEdits(workbook, api, [{ type: SheetEditType.SetValues, range: 'F2', values: [['=1/0'], ['=B2+1']] }], { mdw });
    await api.getFormula().onCalculationResultApplied(5000);
    expect(formulaErrors(workbook, result.changed)).toEqual({ '数据!F2': '#DIV/0!' });
  });
});
