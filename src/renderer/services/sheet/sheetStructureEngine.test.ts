import { CommandType, CustomCommandExecutionError, ICommandService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import { CopySheetCommand } from '@univerjs/sheets';
import { ConditionalFormattingRuleModel } from '@univerjs/sheets-conditional-formatting';
import { SheetDataValidationModel } from '@univerjs/sheets-data-validation';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../../tests/fixtures/sheet';
import { editorImport } from './sheetEditorImport';
import { sharedFormulaResolver, SheetExporter } from './sheetExporter';
import { StructureAction, StructureAxis } from './sheetStructure';
import { StructureRefusal } from './sheetStructureSupport';
import { StructureTracker } from './sheetStructureTracker';
import { createHeadlessSheetUniver, registerWorkbookTables } from './sheetUniverEngine';
import { exportXlsx } from './xlsxExport';
import { importXlsx } from './xlsxImport';

const OPTIONS = { name: 'fixture.xlsx', univerLocale: 'zhCN', formatLocale: 'zh' as const, maxCells: 100_000, digitWidth: 7 };
const unpack = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, value]) => [name, strFromU8(value)]));
const row = (xml: string, index: number) => xml.match(new RegExp(`<row r="${index}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`))?.[0];

/** The fixture with a bold formula rule of top priority on its data sheet, with a fixed reference below its cells. */
async function withFormulaRule(sqref: string): Promise<Partial<Record<string, string>>> {
  const parts = unpack(await makeSheetFixture());
  const data = parts[PARTS.data].replace('priority="1"', 'priority="2"');
  const rule = `<conditionalFormatting sqref="${sqref}"><cfRule type="expression" dxfId="0" priority="1"><formula>$B2&gt;$B$6/5</formula></cfRule></conditionalFormatting>`;
  return {
    [PARTS.data]: data.replace('<conditionalFormatting', `${rule}<conditionalFormatting`),
    [PARTS.styles]: parts[PARTS.styles].replace('<dxfs count="0"/>', '<dxfs count="1"><dxf><font><b/></font></dxf></dxfs>'),
  };
}

/** A headless editor: Univer with the same structure tracking and command guard the panel uses. */
async function open(overrides?: Partial<Record<string, string>>) {
  const bytes = await makeSheetFixture(overrides);
  const imported = importXlsx(bytes, OPTIONS);
  const { univer, api } = createHeadlessSheetUniver('zh');
  univer.createUnit(UniverInstanceType.UNIVER_SHEET, imported.data);
  const tracker = new StructureTracker(univer, editorImport(imported));
  tracker.install(api.getFormula());
  const refusals: string[] = [];
  univer.__getInjector().get(ICommandService).beforeCommandExecuted(command => {
    if (command.type !== CommandType.COMMAND) return;
    const reason = tracker.refusalFor(command);
    if (reason) {
      refusals.push(reason);
      throw new CustomCommandExecutionError(reason);
    }
  });
  registerWorkbookTables(univer, imported.data.id, imported.tables);
  // Undo acts on the focused unit, which a headless instance never focuses by itself.
  univer.__getInjector().get(IUniverInstanceService).focusUnit(imported.data.id);
  const workbook = api.getActiveWorkbook()!;
  const snapshotAtLoad = workbook.save();
  await api.getFormula().onCalculationResultApplied(5000);
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await tracker.settled();
    await api.getFormula().onCalculationResultApplied(5000).catch(() => undefined);
  };
  const save = () => exportXlsx({
    baseline: imported.baseline,
    current: workbook.save(),
    resolveFormula: (sheetId, rowIndex, column) => workbook.getSheetBySheetId(sheetId)?.getRange(rowIndex, column).getFormula() || undefined,
    structure: tracker.ops,
    tables: tracker.grownTables(),
    activeSheetId: workbook.getActiveSheet().getSheetId(),
  }, bytes);
  const data = () => workbook.getSheetByName('数据')!;
  const rules = (sheetId = 'sheet-0') => (univer.__getInjector().get(ConditionalFormattingRuleModel).getSubunitRules(imported.data.id, sheetId) ?? [])
    .map(rule => ({ ranges: rule.ranges.map(range => [range.startRow, range.startColumn, range.endRow, range.endColumn]), value: (rule.rule as { value?: unknown }).value }));
  return { univer, api, workbook, tracker, refusals, save, settle, data, rules, bytes, snapshotAtLoad };
}

describe('structural edits through the engine', () => {
  test('inserted rows move formulas, rules, tables and names, and undo restores the file', async () => {
    const editor = await open();
    try {
      editor.data().insertRows(2, 1);
      await editor.settle();
      expect(editor.tracker.ops).toEqual([{ sheetId: 'sheet-0', axis: StructureAxis.Rows, action: StructureAction.Insert, index: 2, count: 1 }]);
      const parts = unpack(editor.save().bytes);
      const data = parts[PARTS.data];
      expect(row(data, 4)).toContain('<c r="A4" t="s"><v>4</v></c>');
      expect(data).toMatch(/<c r="B7"><f>SUM\(B2:B5\)<\/f><v>12<\/v><\/c>/);
      expect(data).toMatch(/<c r="C4" s="4"><f>B4\*Rate<\/f><v>20<\/v><\/c>/);
      expect(data).toMatch(/<c r="C5" s="4"><f>B5\*Rate<\/f><v>25<\/v><\/c>/);
      expect(data).not.toContain('t="shared"');
      expect(data).toContain('<conditionalFormatting sqref="B2:B5">');
      expect(data).toContain('<mergeCell ref="D7:E7"/>');
      expect(parts[PARTS.table]).toContain('ref="A1:C5"');
      expect(parts[PARTS.workbook]).toContain('数据!$A$1:$E$7');
      expect(parts[PARTS.summary]).toMatch(/<c r="A2"><f>数据!B7\*2<\/f><v>24<\/v><\/c>/);

      await editor.api.undo();
      await editor.settle();
      expect(editor.tracker.ops).toEqual([]);
      const undone = unpack(editor.save().bytes);
      expect(undone[PARTS.data]).toContain('<conditionalFormatting sqref="B2:B4">');
      expect(undone[PARTS.table]).toContain('ref="A1:C4"');
      expect(undone[PARTS.summary]).toContain('<f>数据!B6*2</f>');
    } finally {
      editor.univer.dispose();
    }
  });

  test('deleting rows shrinks references and undo brings them back intact', async () => {
    const editor = await open();
    try {
      editor.data().deleteRows(1, 1);
      await editor.settle();
      expect(editor.tracker.ops).toEqual([{ sheetId: 'sheet-0', axis: StructureAxis.Rows, action: StructureAction.Remove, index: 1, count: 1 }]);
      let parts = unpack(editor.save().bytes);
      expect(parts[PARTS.data]).toContain('<conditionalFormatting sqref="B2:B3">');
      expect(parts[PARTS.data]).toMatch(/<c r="B5"><f>SUM\(B2:B3\)<\/f>/);
      expect(parts[PARTS.table]).toContain('ref="A1:C3"');

      await editor.api.undo();
      await editor.settle();
      expect(editor.tracker.ops).toEqual([]);
      parts = unpack(editor.save().bytes);
      expect(parts[PARTS.data]).toContain('<conditionalFormatting sqref="B2:B4">');
      expect(parts[PARTS.data]).toMatch(/<c r="B6"><f>SUM\(B2:B4\)<\/f>/);
      expect(parts[PARTS.table]).toContain('ref="A1:C4"');
    } finally {
      editor.univer.dispose();
    }
  });

  test('rules grow with inserted rows and keep their anchor, as in Excel', async () => {
    const editor = await open(await withFormulaRule('A2:C4'));
    try {
      editor.data().insertRows(2, 1);
      await editor.settle();
      // One rule per range, not split at the new row; the fixed reference moved with its cell.
      expect(editor.rules()).toEqual([
        { ranges: [[1, 0, 4, 2]], value: '=$B2>$B$7/5' },
        { ranges: [[1, 1, 4, 1]], value: 3 },
      ]);
      const data = unpack(editor.save().bytes)[PARTS.data];
      // The new row takes the row above's own formats, not the bold its rules show.
      expect(row(data, 3)).toMatch(/^<row r="3"[^>]*><c r="C3" s="4"\/><\/row>$/);
      expect(data).toContain('<conditionalFormatting sqref="A2:C5"><cfRule type="expression" dxfId="0" priority="1"><formula>$B2&gt;$B$7/5</formula></cfRule></conditionalFormatting>'
        + '<conditionalFormatting sqref="B2:B5"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>3</formula></cfRule></conditionalFormatting>');

      // Deleting the rule's first row rebases its formula on the new top-left cell.
      editor.data().deleteRows(1, 1);
      await editor.settle();
      expect(editor.rules()[0]).toEqual({ ranges: [[1, 0, 3, 2]], value: '=$B2>$B$6/5' });
      // Formulas on other sheets are recalculated too (Univer alone leaves 0 after two edits).
      expect(editor.workbook.getSheetByName('Summary')!.getRange('A2').getValue()).toBe(18);

      await editor.api.undo();
      await editor.api.undo();
      await editor.settle();
      expect(editor.rules()).toEqual([
        { ranges: [[1, 0, 3, 2]], value: '=$B2>$B$6/5' },
        { ranges: [[1, 1, 3, 1]], value: 3 },
      ]);
      expect(editor.save().changed).toBe(false);
    } finally {
      editor.univer.dispose();
    }
  });

  test('a rule whose cells are all deleted goes, and undo puts it back in its place', async () => {
    const editor = await open(await withFormulaRule('E2:E4'));
    try {
      editor.data().deleteColumns(4, 1);
      await editor.settle();
      expect(editor.rules()).toEqual([{ ranges: [[1, 1, 3, 1]], value: 3 }]);
      expect(unpack(editor.save().bytes)[PARTS.data]).not.toContain('type="expression"');

      await editor.api.undo();
      await editor.settle();
      expect(editor.rules()).toEqual([
        { ranges: [[1, 4, 3, 4]], value: '=$B2>$B$6/5' },
        { ranges: [[1, 1, 3, 1]], value: 3 },
      ]);
      expect(editor.save().changed).toBe(false);
    } finally {
      editor.univer.dispose();
    }
  });

  test('validation rules follow row and column edits, as in Excel', async () => {
    const data = unpack(await makeSheetFixture())[PARTS.data];
    const checks = '<dataValidations count="2"><dataValidation type="list" allowBlank="1" sqref="D2:D4"><formula1>$A$2:$A$4</formula1></dataValidation>'
      + '<dataValidation type="whole" operator="greaterThan" sqref="E2:E4"><formula1>0</formula1></dataValidation></dataValidations>';
    const editor = await open({ [PARTS.data]: data.replace('<pageMargins', `${checks}<pageMargins`) });
    const validations = () => (editor.univer.__getInjector().get(SheetDataValidationModel).getRules(editor.workbook.getId(), 'sheet-0'))
      .map(rule => ({ type: rule.type, formula1: rule.formula1, ranges: rule.ranges.map(range => [range.startRow, range.startColumn, range.endRow, range.endColumn]) }));
    try {
      editor.data().insertRows(2, 1);
      await editor.settle();
      // The list's own source grows with it; Univer alone would only move references.
      expect(validations()).toEqual([
        { type: 'list', formula1: '=$A$2:$A$5', ranges: [[1, 3, 4, 3]] },
        { type: 'whole', formula1: '0', ranges: [[1, 4, 4, 4]] },
      ]);
      let written = unpack(editor.save().bytes)[PARTS.data];
      expect(written).toContain('<dataValidation type="list" allowBlank="1" sqref="D2:D5"><formula1>$A$2:$A$5</formula1></dataValidation>');
      expect(written).toContain('<dataValidation type="whole" operator="greaterThan" sqref="E2:E5"><formula1>0</formula1></dataValidation>');

      editor.data().deleteColumns(4, 1);
      await editor.settle();
      expect(validations().map(rule => rule.type)).toEqual(['list']);
      written = unpack(editor.save().bytes)[PARTS.data];
      expect(written).toContain('<dataValidations count="1">');
      expect(written).not.toContain('type="whole"');

      await editor.api.undo();
      await editor.api.undo();
      await editor.settle();
      expect(validations()).toEqual([
        { type: 'list', formula1: '=$A$2:$A$4', ranges: [[1, 3, 3, 3]] },
        { type: 'whole', formula1: '0', ranges: [[1, 4, 3, 4]] },
      ]);
      expect(editor.save().changed).toBe(false);
    } finally {
      editor.univer.dispose();
    }
  });

  test('the worker-side exporter writes what the editor would, formulas resolved without the engine', async () => {
    const editor = await open();
    try {
      const sheet = editor.data();
      sheet.insertRows(2, 1);
      sheet.getRange('B8').setValue(9);
      await editor.settle();
      // Every formula the engine reports, including shared-formula members, resolves the same way.
      const snapshot = editor.workbook.save();
      const resolve = sharedFormulaResolver(snapshot);
      for (const [sheetId, data] of Object.entries(snapshot.sheets)) {
        for (const [row, columns] of Object.entries(data.cellData ?? {})) {
          for (const [column, cell] of Object.entries(columns as Record<string, { f?: string; si?: string }>)) {
            if (!cell?.f && !cell?.si) continue;
            const engine = editor.workbook.getSheetBySheetId(sheetId)!.getRange(Number(row), Number(column)).getFormula();
            expect(resolve(sheetId, Number(row), Number(column))).toBe(engine);
          }
        }
      }
      const inEditor = unpack(editor.save().bytes);
      const loaded = { resources: editor.snapshotAtLoad.resources };
      const exporter = new SheetExporter(editor.bytes, importXlsx(editor.bytes, OPTIONS).baseline);
      exporter.adopt(loaded);
      const inWorker = unpack(exporter.export(snapshot, { structure: editor.tracker.ops, activeSheetId: editor.workbook.getActiveSheet().getSheetId() }));
      expect(Object.keys(inWorker).sort()).toEqual(Object.keys(inEditor).sort());
      for (const name of Object.keys(inEditor)) expect(inWorker[name], name).toBe(inEditor[name]);
    } finally {
      editor.univer.dispose();
    }
  });

  test('deleting the anchor row of a shared formula keeps the rest of the group', async () => {
    const editor = await open();
    try {
      editor.data().deleteRows(2, 1);
      await editor.settle();
      const data = unpack(editor.save().bytes)[PARTS.data];
      expect(data).toMatch(/<c r="C3" s="4"><f>B3\*Rate<\/f>/);
      expect(data).not.toContain('t="shared"');
    } finally {
      editor.univer.dispose();
    }
  });

  test('columns: before a table it moves, inside it they become table columns', async () => {
    const editor = await open();
    try {
      editor.data().insertColumns(0, 1);
      await editor.settle();
      let parts = unpack(editor.save().bytes);
      expect(parts[PARTS.table]).toContain('ref="B1:D4"');
      expect(parts[PARTS.data]).toContain('<conditionalFormatting sqref="C2:C4">');
      expect(parts[PARTS.data]).toMatch(/<c r="D2" s="4"><f>C2\*Rate<\/f>/);
      expect(parts[PARTS.data]).toContain('<col min="2" max="2" width="18.7109375" customWidth="1"/>');
      // Inside the table (now B:D): a new table column named in its header cell, as Excel does.
      editor.data().insertColumns(2, 1);
      await editor.settle();
      expect(editor.refusals).toEqual([]);
      expect(editor.data().getRange('C1').getValue()).toBe('Column1');
      parts = unpack(editor.save().bytes);
      expect(parts[PARTS.table]).toContain('ref="B1:E4"');
      expect(parts[PARTS.table]).toContain('<tableColumns count="4"><tableColumn id="1" name="项目"/><tableColumn id="4" name="Column1"/><tableColumn id="2" name="数量"/>');
      expect(parts[PARTS.data]).toMatch(/<c r="C1"[^>]*t="(?:s|str|inlineStr)"/);
      // Renaming the new column's header renames the table column.
      editor.data().getRange('C1').setValue('单价');
      await editor.settle();
      expect(unpack(editor.save().bytes)[PARTS.table]).toContain('<tableColumn id="4" name="单价"/>');
      // Deleting it drops the table column again; undo brings it back.
      editor.data().deleteColumns(2, 1);
      await editor.settle();
      expect(unpack(editor.save().bytes)[PARTS.table]).toContain('<tableColumns count="3"><tableColumn id="1" name="项目"/><tableColumn id="2" name="数量"/>');
      await editor.api.undo();
      await editor.settle();
      expect(unpack(editor.save().bytes)[PARTS.table]).toContain('<tableColumn id="4" name="单价"/>');
    } finally {
      editor.univer.dispose();
    }
  });

  test('table columns: formulas that use a column by name keep it; a table keeps one column', async () => {
    const editor = await open();
    try {
      editor.data().getRange('F2').setValue('=SUM(Fruit[数量])');
      await editor.settle();
      const total = editor.data().getRange('F2').getValue();
      expect(typeof total).toBe('number');
      editor.data().deleteColumns(1, 1);
      editor.data().deleteColumns(0, 3);
      expect(editor.refusals).toEqual([StructureRefusal.TableColumnInUse, StructureRefusal.TableColumns]);
      expect(editor.tracker.ops).toEqual([]);
      // A column no formula names can go.
      editor.data().deleteColumns(0, 1);
      await editor.settle();
      expect(editor.refusals).toHaveLength(2);
      expect(unpack(editor.save().bytes)[PARTS.table]).toContain('ref="A1:B4"');
      // The structured reference follows its column.
      expect(editor.data().getRange('E2').getFormula()).toBe('=SUM(Fruit[数量])');
      expect(editor.data().getRange('E2').getValue()).toBe(total);
    } finally {
      editor.univer.dispose();
    }
  });

  test('typing next to a table grows it, as Excel\'s AutoExpansion does', async () => {
    // 金额 is a calculated column.
    const table = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Fruit" displayName="Fruit" ref="A1:C4" totalsRowShown="0">'
      + '<autoFilter ref="A1:C4"/><tableColumns count="3"><tableColumn id="1" name="项目"/><tableColumn id="2" name="数量"/><tableColumn id="3" name="金额"><calculatedColumnFormula>Fruit[[#This Row],[数量]]*Rate</calculatedColumnFormula></tableColumn></tableColumns>'
      + '<tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>';
    const editor = await open({ [PARTS.table]: table });
    try {
      editor.data().getRange('A5').setValue('橙子');
      await editor.settle();
      // The new row joins the table and takes the calculated column's formula.
      expect(editor.tracker.tableRanges().get('Fruit')).toEqual({ startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 });
      expect(editor.data().getRange('C5').getFormula()).toBe('=B5*Rate');
      let parts = unpack(editor.save().bytes);
      expect(parts[PARTS.table]).toContain('ref="A1:C5"');
      expect(parts[PARTS.table]).toContain('<autoFilter ref="A1:C5"/>');
      expect(parts[PARTS.data]).toMatch(/<c r="C5"[^>]*><f>B5\*Rate<\/f>/);
      // A header typed beside the table adds a column named by it.
      editor.data().getRange('D1').setValue('备注');
      await editor.settle();
      parts = unpack(editor.save().bytes);
      expect(parts[PARTS.table]).toContain('ref="A1:D5"');
      expect(parts[PARTS.table]).toContain('<tableColumn id="4" name="备注"/></tableColumns>');
      // Undo takes the column and then the row back out, formula and all.
      await editor.api.undo();
      await editor.api.undo();
      await editor.settle();
      expect(editor.tracker.tableRanges().get('Fruit')).toEqual({ startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 });
      expect(editor.data().getRange('C5').getFormula()).toBe('');
      parts = unpack(editor.save().bytes);
      expect(parts[PARTS.table]).toContain('ref="A1:C4"');
      // Changing a cell that already had a value does not grow a table.
      editor.data().getRange('D2').setValue(false);
      await editor.settle();
      expect(editor.tracker.tableRanges().get('Fruit')?.endColumn).toBe(2);
    } finally {
      editor.univer.dispose();
    }
  });

  test('a sheet is copied with its content unless a copy would lose some (a table)', async () => {
    const editor = await open();
    try {
      const unitId = editor.workbook.getId();
      await editor.api.executeCommand(CopySheetCommand.id, { unitId, subUnitId: 'sheet-0' }).catch(() => false);
      expect(editor.refusals).toEqual([StructureRefusal.CopyWithContent]);
      await editor.api.executeCommand(CopySheetCommand.id, { unitId, subUnitId: 'sheet-1' });
      await editor.settle();
      expect(editor.workbook.getSheets().map(sheet => sheet.getSheetName())).toHaveLength(3);
      const parts = unpack(editor.save().bytes);
      expect(Object.keys(parts).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))).toHaveLength(3);
    } finally {
      editor.univer.dispose();
    }
  });

  test('a table keeps its header row and at least one data row', async () => {
    const editor = await open();
    try {
      editor.data().deleteRows(0, 1);
      editor.data().deleteRows(1, 3);
      expect(editor.refusals).toEqual([StructureRefusal.TableRows, StructureRefusal.TableRows]);
      expect(editor.tracker.ops).toEqual([]);
      editor.data().deleteRows(1, 2);
      await editor.settle();
      expect(unpack(editor.save().bytes)[PARTS.table]).toContain('ref="A1:C2"');
    } finally {
      editor.univer.dispose();
    }
  });

  test('sheets can be renamed, added and deleted', async () => {
    const editor = await open();
    try {
      editor.workbook.getSheetByName('Summary')!.setName('Totals');
      const added = editor.workbook.insertSheet('New');
      added.getRange('A1').setValue('hello');
      await editor.settle();
      let parts = unpack(editor.save().bytes);
      expect(parts[PARTS.workbook]).toContain('<sheet name="Totals" sheetId="2" r:id="rId2"/>');
      expect(parts[PARTS.workbook]).toContain('<definedName name="Rate">Totals!$B$1</definedName>');
      expect(parts[PARTS.workbook]).toMatch(/<sheet name="New" sheetId="3" r:id="rId\d+"\/>/);
      expect(parts['xl/worksheets/sheet3.xml']).toContain('<t>hello</t>');

      editor.workbook.deleteSheet(editor.workbook.getSheetByName('Totals')!);
      await editor.settle();
      parts = unpack(editor.save().bytes);
      expect(parts[PARTS.summary]).toBeUndefined();
      expect(parts[PARTS.workbook]).not.toContain('name="Totals"');
      expect(parts[PARTS.workbook]).toContain('<definedName name="Rate">#REF!</definedName>');
    } finally {
      editor.univer.dispose();
    }
  });
});
