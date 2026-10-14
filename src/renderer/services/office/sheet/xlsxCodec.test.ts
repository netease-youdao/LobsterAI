import { DataValidationErrorStyle, DataValidationRenderMode, type IStyleData, type IWorkbookData } from '@univerjs/core';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSheetFixture, SHEET_FIXTURE_PARTS as PARTS } from '../../../../../tests/fixtures/sheet';
import { SHEET_CHART_COMPONENT } from './sheetChartHost';
import { chartFromRange, ChartKind } from './sheetChartSpec';
import { sharedFormulaResolver } from './sheetExporter';
import { StructureAction, StructureAxis } from './sheetStructure';
import { parseChart } from './xlsxCharts';
import { CONDITIONAL_FORMATS_RESOURCE, conditionalFormatsOf } from './xlsxConditionalFormats';
import { DATA_VALIDATIONS_RESOURCE, dataValidationsOf } from './xlsxDataValidations';
import { DRAWINGS_RESOURCE } from './xlsxDrawings';
import { exportXlsx, formulaForExcel, SheetExportIssue, XlsxExportError } from './xlsxExport';
import { FILTERS_RESOURCE, filtersOf } from './xlsxFilters';
import { linkCell } from './xlsxHyperlinks';
import { type ImportedWorkbook, importXlsx } from './xlsxImport';
import { NOTES_RESOURCE, notesOf } from './xlsxNotes';
import { XlsxStyles } from './xlsxStyles';

const OPTIONS = { name: 'fixture.xlsx', univerLocale: 'zhCN', formatLocale: 'zh' as const, maxCells: 100_000, digitWidth: 7 };
const DATA = 'sheet-0';
const SUMMARY = 'sheet-1';

function unpack(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, value]) => [name, strFromU8(value)]));
}

async function fixture(overrides?: Partial<Record<string, string>>): Promise<{ bytes: Uint8Array; imported: ImportedWorkbook }> {
  const bytes = await makeSheetFixture(overrides);
  return { bytes, imported: importXlsx(bytes, OPTIONS) };
}

/** Simulate edits by changing a copy of the imported snapshot, as Univer's own save() would report them. */
function edited(imported: ImportedWorkbook, change: (data: IWorkbookData) => void, keepRuleModel = false): IWorkbookData {
  const current = structuredClone(imported.baseline.snapshot);
  // Row edits move rules through Univer's formatting plugin; these edits only touch cells.
  if (!keepRuleModel) current.resources = current.resources?.filter(item => item.name !== CONDITIONAL_FORMATS_RESOURCE);
  change(current);
  return current;
}

function withRules(data: IWorkbookData, rules: Record<string, unknown[]>): void {
  data.resources = [...(data.resources ?? []).filter(item => item.name !== CONDITIONAL_FORMATS_RESOURCE), { name: CONDITIONAL_FORMATS_RESOURCE, data: JSON.stringify(rules) }];
}

const noFormula = () => undefined;

type SheetData = IWorkbookData['sheets'][string];
/** Move rows the way Univer's insert and remove mutations do, so the snapshot matches the ops. */
function shiftRows(sheet: SheetData, map: (row: number) => number | null): void {
  const move = <T>(data: Record<number, T> | undefined) => {
    const result: Record<number, T> = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      const target = map(Number(key));
      if (target !== null) result[target] = value as T;
    }
    return result;
  };
  sheet.cellData = move(sheet.cellData as Record<number, NonNullable<SheetData['cellData']>[number]>) as SheetData['cellData'];
  sheet.rowData = move(sheet.rowData as Record<number, NonNullable<SheetData['rowData']>[number]>) as SheetData['rowData'];
  sheet.mergeData = (sheet.mergeData ?? []).flatMap(range => {
    const start = map(range.startRow);
    const end = map(range.endRow);
    return start === null || end === null ? [] : [{ ...range, startRow: start, endRow: end }];
  });
}
const insertRows = (sheet: SheetData, index: number, count: number) => shiftRows(sheet, row => (row >= index ? row + count : row));
const removeRows = (sheet: SheetData, index: number, count: number) => shiftRows(sheet, row => (row < index ? row : row < index + count ? null : row - count));
const row = (xml: string, index: number) => xml.match(new RegExp(`<row r="${index}"[^>]*?(?:/>|>[\\s\\S]*?</row>)`))?.[0];

describe('xlsx import', () => {
  test('maps sheets, values, formulas, styles and layout', async () => {
    const { imported } = await fixture();
    const { data, activeSheetId } = imported;
    expect(data.sheetOrder).toEqual([DATA, SUMMARY]);
    expect(activeSheetId).toBe(DATA);
    const sheet = data.sheets[DATA];
    const cells = sheet.cellData!;
    expect(sheet.name).toBe('数据');
    expect(cells[0][0]).toMatchObject({ v: '项目', t: 1, s: 'x1' });
    expect(cells[2][0].v).toBe('香蕉 ');
    expect(cells[3][0].v).toBe('line1\r\nline2');
    expect(cells[1][2]).toMatchObject({ f: '=B2*Rate', v: 15, s: 'x4' });
    expect(cells[2][2]).toMatchObject({ f: '=B3*Rate', si: '0:0', v: 20 });
    expect(cells[3][2]).toMatchObject({ si: '0:0', v: 25 });
    expect(cells[3][2].f).toBeUndefined();
    expect(cells[1][3]).toMatchObject({ v: true, t: 3 });
    expect(cells[5][2]).toMatchObject({ v: '备注 & note', t: 1 });
    expect(cells[0][4]).toEqual({ s: 'x3' });
    expect(sheet.rowData![0].h).toBe(28);
    expect(sheet.rowData![3].hd).toBe(1);
    expect(sheet.columnData![0].w).toBe(131);
    expect(sheet.columnData![4].hd).toBe(1);
    expect(sheet.freeze).toEqual({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 });
    expect(sheet.mergeData).toEqual([{ startRow: 5, startColumn: 3, endRow: 5, endColumn: 4 }]);
    expect(sheet.tabColor).toBe('#00B050');
    expect(sheet.zoomRatio).toBe(0.9);
    expect(data.sheets[SUMMARY].showGridlines).toBe(0);

    const header = data.styles.x1 as IStyleData;
    expect(header).toMatchObject({ ff: 'Calibri', fs: 12, bl: 1, cl: { rgb: '#C00000' }, ht: 2 });
    expect(header.bg?.rgb).toBe('#DAE3F3');
    expect(header.bd?.l).toEqual({ s: 1, cl: { rgb: '#000000' } });
    expect(data.styles.x2?.n?.pattern).toBe('yyyy/m/d');
    expect(data.styles.x3).toMatchObject({ n: { pattern: '0.0%' }, vt: 2, tb: 3 });
    expect(data.defaultStyle).toEqual({ ff: 'Calibri', fs: 11, cl: { rgb: '#000000' } });
    const names = JSON.parse(data.resources![0].data);
    expect(Object.values(names)).toEqual([{ id: 'name-0', name: 'Rate', formulaOrRefString: 'Summary!$B$1', localSheetId: 'AllDefaultWorkbook' }]);
  });

  test('refuses workbooks above the cell budget', async () => {
    const bytes = await makeSheetFixture();
    expect(() => importXlsx(bytes, { ...OPTIONS, maxCells: 5 })).toThrow(/Too many cells/);
  });
});

describe('xlsx export', () => {
  test('returns the original bytes when nothing changed', async () => {
    const { bytes, imported } = await fixture();
    const result = exportXlsx({ baseline: imported.baseline, current: structuredClone(imported.data), resolveFormula: noFormula }, bytes);
    expect(result.changed).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  test('patches only changed cells and keeps every other part verbatim', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      const cells = data.sheets[DATA].cellData!;
      cells[1][1] = { v: 7, t: 2 };
      cells[1][0] = { v: '青苹果', t: 1 };
      cells[4] = { 1: { v: 'new <row>', t: 1 } };
      delete cells[5][2];
    });
    const before = unpack(bytes);
    const after = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    const sheet = after[PARTS.data];
    expect(row(sheet, 2)).toBe('<row r="2"><c r="A2" t="inlineStr"><is><t>青苹果</t></is></c><c r="B2"><v>7</v></c><c r="C2" s="4"><f>B2*Rate</f><v>15</v></c><c r="D2" t="b"><v>1</v></c></row>');
    expect(row(sheet, 5)).toBe('<row r="5"><c r="B5" t="inlineStr"><is><t>new &lt;row&gt;</t></is></c></row>');
    expect(sheet.indexOf('<row r="5"')).toBeLessThan(sheet.indexOf('<row r="6"'));
    expect(row(sheet, 6)).toBe('<row r="6"><c r="A6" t="s"><v>6</v></c><c r="B6"><f>SUM(B2:B4)</f><v>12</v></c></row>');
    for (const index of [1, 3, 4]) expect(row(sheet, index)).toBe(row(before[PARTS.data], index));
    expect(sheet.replace(/<sheetData>[\s\S]*<\/sheetData>/, '')).toBe(before[PARTS.data].replace(/<sheetData>[\s\S]*<\/sheetData>/, ''));
    for (const part of [PARTS.summary, PARTS.strings, PARTS.styles, PARTS.table, PARTS.custom, 'xl/theme/theme1.xml']) {
      expect(after[part], part).toBe(before[part]);
    }
    // Formulas changed around them: the chain goes, and Excel recalculates on open.
    expect(after[PARTS.calcChain]).toBeUndefined();
    expect(after['[Content_Types].xml']).not.toContain('calcChain');
    expect(after['xl/_rels/workbook.xml.rels']).not.toContain('calcChain');
    expect(after[PARTS.workbook]).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>');
  });

  test('derives new style records from the original ones', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      data.styles.bold = { bl: 1 };
      data.styles.headerItalic = { ...(data.styles.x1 as IStyleData), it: 1 };
      data.styles.percent2 = { ...(data.styles.x3 as IStyleData), n: { pattern: '0.00' } };
      data.styles.custom = { n: { pattern: '#,##0.000' } };
      const cells = data.sheets[DATA].cellData!;
      cells[1][1] = { ...cells[1][1], s: 'bold' };
      cells[0][0] = { ...cells[0][0], s: 'headerItalic' };
      cells[3][3] = { ...cells[3][3], s: 'percent2' };
      cells[2][1] = { ...cells[2][1], s: 'custom' };
    });
    const after = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    const styles = after[PARTS.styles];
    const xfs = [...styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)![1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(match => match[0]);
    expect(styles).toContain('<cellXfs count="9">');
    expect(styles).toContain('<fonts count="4">');
    expect(styles).toContain('<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.000"/></numFmts>');
    const sheet = after[PARTS.data];
    const recordOf = (reference: string) => xfs[Number(sheet.match(new RegExp(`<c r="${reference}" s="(\\d+)"`))![1])];
    const fonts = [...styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/)![1].matchAll(/<font>[\s\S]*?<\/font>/g)].map(match => match[0]);
    // B2 had no record: bold derives from the default font, keeping its name, size and theme color.
    expect(recordOf('B2')).toMatch(/^<xf numFmtId="0" fontId="(\d+)" fillId="0" borderId="0" xfId="0" applyFont="1"\/>$/);
    expect(fonts[Number(recordOf('B2').match(/fontId="(\d+)"/)![1])]).toBe('<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>');
    // The header keeps its fill, border and alignment; only the font changes.
    expect(recordOf('A1')).toMatch(/^<xf numFmtId="0" fontId="\d+" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"\/><\/xf>$/);
    expect(fonts[Number(recordOf('A1').match(/fontId="(\d+)"/)![1])]).toBe('<font><b/><i/><sz val="12"/><color rgb="FFC00000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>');
    // A built-in format is reused; protection and alignment survive.
    expect(recordOf('D4')).toBe('<xf numFmtId="2" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment vertical="center" wrapText="1"/><protection locked="0"/></xf>');
    expect(recordOf('B3')).toBe('<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>');
    expect(sheet).toMatch(/<c r="A1" s="\d+" t="s"><v>0<\/v><\/c>/);
    expect(sheet).toMatch(/<c r="B2" s="\d+"><v>3<\/v><\/c>/);
  });

  test('writes column widths, row heights, visibility and merges', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      const sheet = data.sheets[DATA];
      sheet.columnData![1] = { w: 150 };
      sheet.columnData![6] = { w: 40 };
      sheet.rowData![1] = { h: 40 };
      sheet.rowData![3] = {};
      sheet.mergeData = [...sheet.mergeData!, { startRow: 7, startColumn: 0, endRow: 7, endColumn: 1 }];
    });
    const sheet = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes)[PARTS.data];
    expect(sheet).toContain('<cols><col min="1" max="1" width="18.7109375" customWidth="1"/><col min="2" max="2" width="21.42578125" customWidth="1"/><col min="3" max="3" width="12.7109375" customWidth="1"/><col min="5" max="5" width="9.140625" hidden="1"/><col min="7" max="7" width="5.7109375" customWidth="1"/></cols>');
    expect(row(sheet, 2)).toMatch(/^<row r="2" ht="30" customHeight="1">/);
    expect(row(sheet, 4)).toMatch(/^<row r="4">/);
    expect(sheet).toContain('<mergeCells count="2"><mergeCell ref="D6:E6"/><mergeCell ref="A8:B8"/></mergeCells><conditionalFormatting');

    const unmerged = edited(imported, data => { data.sheets[DATA].mergeData = []; });
    expect(unpack(exportXlsx({ baseline: imported.baseline, current: unmerged, resolveFormula: noFormula }, bytes).bytes)[PARTS.data]).not.toContain('mergeCell');
  });

  test('writes out a shared formula group whose anchor was replaced', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => { data.sheets[DATA].cellData![2][2] = { v: 99, t: 2, s: 'x4' }; });
    const resolve = (sheetId: string, rowIndex: number, column: number) => (sheetId === DATA && rowIndex === 3 && column === 2 ? '=B4*Rate' : undefined);
    const sheet = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: resolve }, bytes).bytes)[PARTS.data];
    expect(sheet).toContain('<c r="C3" s="4"><v>99</v></c>');
    expect(sheet).toContain('<c r="C4" s="4"><f>B4*Rate</f><v>25</v></c>');
    expect(sheet).not.toContain('t="shared"');
    expect(() => exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes)).toThrow(XlsxExportError);
  });

  test('writes renamed, frozen, hidden and recolored sheets', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      data.sheets[SUMMARY].name = 'Totals';
      data.sheets[SUMMARY].hidden = 1;
      data.sheets[SUMMARY].showGridlines = 1;
      data.sheets[SUMMARY].freeze = { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 };
      data.sheets[DATA].freeze = { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 };
      data.sheets[DATA].tabColor = '#FF0000';
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    expect(parts[PARTS.workbook]).toContain('<sheet name="Totals" sheetId="2" r:id="rId2" state="hidden"/>');
    expect(parts[PARTS.workbook]).toContain('<definedName name="Rate">Totals!$B$1</definedName>');
    expect(parts[PARTS.data]).toContain('<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>');
    expect(parts[PARTS.data]).toContain('<sheetView tabSelected="1" zoomScale="90" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView>');
    expect(parts[PARTS.summary]).toContain('<sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/>');
    expect(parts[PARTS.summary]).toContain('<selection pane="bottomRight" activeCell="B3" sqref="B3"/>');
    expect(parts[PARTS.calcChain]).toBeUndefined();
  });

  test('writes the zoom of a sheet with its next save, as Excel does', async () => {
    const { bytes, imported } = await fixture();
    expect(imported.data.sheets[DATA].zoomRatio).toBe(0.9);
    // Opening and saving without zooming changes nothing.
    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);
    const current = edited(imported, data => {
      data.sheets[DATA].zoomRatio = 1;
      data.sheets[SUMMARY].zoomRatio = 1.25;
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    expect(parts[PARTS.data]).toContain('<sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1"');
    expect(parts[PARTS.summary]).toContain('<sheetView showGridLines="0" workbookViewId="0" zoomScale="125" zoomScaleNormal="125"/>');
  });

  test('moves every reference when rows are inserted', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      insertRows(data.sheets[DATA], 2, 1);
      data.sheets[DATA].cellData![6][1] = { f: '=SUM(B2:B5)', v: 12, t: 2 };
      data.sheets[SUMMARY].cellData![1][0] = { f: '=数据!B7*2', v: 24, t: 2 };
    });
    const resolve = (sheetId: string, rowIndex: number, column: number) => (sheetId === DATA && column === 2 && (rowIndex === 3 || rowIndex === 4) ? `=B${rowIndex + 1}*Rate` : undefined);
    const structure = [{ sheetId: DATA, axis: StructureAxis.Rows, action: StructureAction.Insert, index: 2, count: 1 }];
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: resolve, structure }, bytes).bytes);
    const data = parts[PARTS.data];
    expect(row(data, 3)).toBeUndefined();
    expect(row(data, 4)).toContain('<c r="A4" t="s"><v>4</v></c>');
    expect(row(data, 5)).toContain('hidden="1"');
    expect(data).toContain('<c r="C4" s="4"><f>B4*Rate</f><v>20</v></c>');
    expect(data).toContain('<c r="C5" s="4"><f>B5*Rate</f><v>25</v></c>');
    expect(data).not.toContain('t="shared"');
    expect(data).toContain('<c r="B7"><f>SUM(B2:B5)</f><v>12</v></c>');
    expect(data).toContain('<mergeCell ref="D7:E7"/>');
    expect(data).toContain('<conditionalFormatting sqref="B2:B5">');
    expect(data).toContain('<dimension ref="A1:E7"/>');
    expect(data).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(parts[PARTS.table]).toContain('ref="A1:C5"');
    expect(parts[PARTS.table]).toContain('<autoFilter ref="A1:C5"/>');
    expect(parts[PARTS.workbook]).toContain('localSheetId="0">数据!$A$1:$E$7</definedName>');
    expect(parts[PARTS.workbook]).toContain('fullCalcOnLoad="1"');
    expect(parts[PARTS.summary]).toContain('<c r="A2"><f>数据!B7*2</f><v>24</v></c>');
    expect(parts[PARTS.calcChain]).toBeUndefined();
    expect(parts[PARTS.custom]).toBe('<custom xmlns="urn:lobster:test">preserve me verbatim</custom>');
  });

  test('shrinks ranges and drops references when rows are deleted', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      removeRows(data.sheets[DATA], 1, 1);
      data.sheets[DATA].cellData![4][1] = { f: '=SUM(B2:B3)', v: 9, t: 2 };
    });
    const resolve = (sheetId: string, rowIndex: number, column: number) => (sheetId === DATA && column === 2 && (rowIndex === 1 || rowIndex === 2) ? `=B${rowIndex + 1}*Rate` : undefined);
    const structure = [{ sheetId: DATA, axis: StructureAxis.Rows, action: StructureAction.Remove, index: 1, count: 1 }];
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: resolve, structure }, bytes).bytes);
    const data = parts[PARTS.data];
    expect(row(data, 2)).toContain('<c r="A2" t="s"><v>4</v></c>');
    expect(data).toContain('<conditionalFormatting sqref="B2:B3">');
    expect(data).toContain('<mergeCell ref="D5:E5"/>');
    expect(data).toContain('<c r="B5"><f>SUM(B2:B3)</f>');
    expect(parts[PARTS.table]).toContain('ref="A1:C3"');
  });

  test('adds, deletes and reorders sheets with their relationships', async () => {
    const { bytes, imported } = await fixture();
    const added = edited(imported, data => {
      data.sheets['sheet-new'] = { id: 'sheet-new', name: 'New', cellData: { 0: { 0: { v: 'hi', t: 1 }, 1: { f: '=数据!B2*2', v: 6, t: 2 } } } } as IWorkbookData['sheets'][string];
      data.sheetOrder = [SUMMARY, DATA, 'sheet-new'];
    });
    let parts = unpack(exportXlsx({ baseline: imported.baseline, current: added, resolveFormula: noFormula }, bytes).bytes);
    expect(parts[PARTS.workbook]).toMatch(/<sheets><sheet name="Summary" sheetId="2" r:id="rId2"\/><sheet name="数据" sheetId="1" r:id="rId1"\/><sheet name="New" sheetId="3" r:id="rId7"\/><\/sheets>/);
    expect(parts[PARTS.workbook]).toContain('<definedName name="_xlnm.Print_Area" localSheetId="1">');
    expect(parts[PARTS.workbook]).toContain('activeTab="1"');
    expect(parts['xl/_rels/workbook.xml.rels']).toContain('<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>');
    expect(parts['[Content_Types].xml']).toContain('<Override PartName="/xl/worksheets/sheet3.xml"');
    expect(parts['xl/worksheets/sheet3.xml']).toContain('<c r="A1" t="inlineStr"><is><t>hi</t></is></c><c r="B1"><f>数据!B2*2</f><v>6</v></c>');

    const deleted = edited(imported, data => {
      delete data.sheets[SUMMARY];
      data.sheetOrder = [DATA];
    });
    parts = unpack(exportXlsx({ baseline: imported.baseline, current: deleted, resolveFormula: noFormula }, bytes).bytes);
    expect(parts[PARTS.summary]).toBeUndefined();
    expect(parts[PARTS.workbook]).toContain('<sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets>');
    expect(parts[PARTS.workbook]).toContain('<definedName name="Rate">#REF!</definedName>');
    expect(parts['xl/_rels/workbook.xml.rels']).not.toContain('sheet2.xml');
    expect(parts['[Content_Types].xml']).not.toContain('sheet2.xml');
    expect(parts[PARTS.table]).toBeDefined();
  });

  test('imports conditional formats and writes them back from the rule model', async () => {
    const { bytes, imported } = await fixture();
    const loaded = conditionalFormatsOf(imported.data)[DATA];
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ ranges: [{ startRow: 1, endRow: 3, startColumn: 1, endColumn: 1 }], rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 3 } });

    // The model as loaded writes nothing.
    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined, true), resolveFormula: noFormula }, bytes).changed).toBe(false);

    // A rule extended by fill keeps its markup under the new range; a new rule gets its own style.
    const extended = edited(imported, data => {
      withRules(data, { [DATA]: [
        { ...loaded[0], ranges: [{ startRow: 1, endRow: 5, startColumn: 1, endColumn: 1 }] },
        { cfId: 'new-1', ranges: [{ startRow: 1, endRow: 3, startColumn: 2, endColumn: 2 }], stopIfTrue: false, rule: { type: 'highlightCell', subType: 'text', operator: 'containsText', value: 'x"y', style: { bl: 1, bg: { rgb: '#FFEB9C' } } } },
        { cfId: 'new-2', ranges: [{ startRow: 1, endRow: 3, startColumn: 3, endColumn: 3 }], stopIfTrue: false, rule: { type: 'dataBar', isShowValue: true, config: { min: { type: 'min' }, max: { type: 'max' }, isGradient: false, positiveColor: '#638EC6', nativeColor: '#FF0000' } } },
      ] });
    }, true);
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current: extended, resolveFormula: noFormula }, bytes).bytes);
    const data = parts[PARTS.data];
    expect(data).toContain('<conditionalFormatting sqref="B2:B6"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>3</formula></cfRule></conditionalFormatting>');
    expect(data).toContain('<conditionalFormatting sqref="C2:C4"><cfRule type="containsText" dxfId="0" priority="2" operator="containsText" text="x&quot;y"><formula>NOT(ISERROR(SEARCH("x""y",C2)))</formula></cfRule></conditionalFormatting>');
    expect(data).toMatch(/<cfRule type="dataBar" priority="3"><dataBar><cfvo type="min"\/><cfvo type="max"\/><color rgb="FF638EC6"\/><\/dataBar><extLst><ext uri="\{B025F937-C7B1-47D3-B67F-A62EFF666E3E\}"/);
    expect(data).toMatch(/<extLst><ext uri="\{78C0D931-6437-407d-A8EE-F0AAD7539E65\}" xmlns:x14="[^"]+"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="[^"]+"><x14:cfRule type="dataBar" id="\{[^}]+\}"><x14:dataBar minLength="0" maxLength="100" gradient="0">/);
    expect(data.indexOf('<conditionalFormatting')).toBeLessThan(data.indexOf('<pageMargins'));
    // The fixture's rule names a dxf its (empty) list lacks, so the first new record is 0.
    expect(parts[PARTS.styles]).toContain('<dxfs count="1"><dxf><font><b/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf></dxfs>');

    // Clearing every rule removes the markup.
    const cleared = edited(imported, current => withRules(current, { [DATA]: [] }), true);
    expect(unpack(exportXlsx({ baseline: imported.baseline, current: cleared, resolveFormula: noFormula }, bytes).bytes)[PARTS.data]).not.toContain('conditionalFormatting');
  });

  test('imports pictures and charts and writes moved or deleted ones back', async () => {
    const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const point = (col: number, row: number) => `<xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff>`;
    const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${officeRel}" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">`
      + `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${point(3, 1)}</xdr:from><xdr:to>${point(5, 4)}</xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="571500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`
      + `<xdr:twoCellAnchor><xdr:from>${point(6, 1)}</xdr:from><xdr:to>${point(12, 15)}</xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 2"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      + '</xdr:wsDr>';
    const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>Summary!$B$1:$B$1</c:f><c:numCache><c:ptCount val="1"/><c:pt idx="0"><c:v>5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
    const { bytes, imported } = await fixture({
      'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${officeRel}"><sheetData><row r="1"><c r="B1"><v>5</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>`,
      'xl/worksheets/_rels/sheet2.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeRel}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`,
      'xl/drawings/drawing1.xml': drawing,
      'xl/drawings/_rels/drawing1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${officeRel}/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="${officeRel}/chart" Target="../charts/chart1.xml"/></Relationships>`,
      'xl/media/image1.png': 'not really a png',
      'xl/charts/chart1.xml': chart,
    });
    const resource = imported.data.resources?.find(item => item.name === 'SHEET_DRAWING_PLUGIN');
    const loaded = JSON.parse(resource!.data)[SUMMARY] as { data: Record<string, Record<string, any>>; order: string[] };
    expect(loaded.order).toEqual(['lobster-image-sheet-1-2', 'lobster-chart-sheet-1-3']);
    expect(loaded.data['lobster-image-sheet-1-2']).toMatchObject({ drawingType: 0, anchorType: '0', sheetTransform: { from: { column: 3, row: 1 }, to: { column: 5, row: 4 } } });
    expect(loaded.data['lobster-chart-sheet-1-3']).toMatchObject({ drawingType: 8, componentKey: 'lobster-sheet-chart', anchorType: '1', sheetTransform: { from: { column: 6, row: 1 }, to: { column: 12, row: 15 } } });
    expect(loaded.data['lobster-chart-sheet-1-3'].data.spec.plots[0].series[0].values).toEqual({ ref: 'Summary!$B$1:$B$1', cache: [5] });

    // Nothing moved: nothing is written.
    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);

    // The chart moved down two rows and the picture was deleted.
    const current = edited(imported, data => {
      const item = data.resources!.find(entry => entry.name === 'SHEET_DRAWING_PLUGIN')!;
      const drawings = JSON.parse(item.data);
      const sheet = drawings[SUMMARY];
      delete sheet.data['lobster-image-sheet-1-2'];
      sheet.order = ['lobster-chart-sheet-1-3'];
      const moved = sheet.data['lobster-chart-sheet-1-3'];
      moved.sheetTransform.from.row = 3;
      moved.sheetTransform.to.row = 17;
      item.data = JSON.stringify(drawings);
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    const written = parts['xl/drawings/drawing1.xml'];
    expect(written).not.toContain('<xdr:pic>');
    expect(written).toContain(`<xdr:twoCellAnchor><xdr:from>${point(6, 3)}</xdr:from><xdr:to>${point(12, 17)}</xdr:to><xdr:graphicFrame macro="">`);
    // The chart frame's own transform and the chart part stay as Excel wrote them.
    expect(written).toContain('<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>');
    expect(parts['xl/charts/chart1.xml']).toBe(chart);
  });

  test('imports data validation and writes it back from the rule model', async () => {
    const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
    const xm = 'http://schemas.microsoft.com/office/excel/2006/main';
    const listItems = '"是,否,""未知"""';
    const summary = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1"><v>5</v></c></row></sheetData>'
      + '<dataValidations count="3">'
      + `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="C1:C5"><formula1>${listItems}</formula1></dataValidation>`
      + '<dataValidation type="whole" operator="between" showErrorMessage="1" errorTitle="Oops" error="1-10" sqref="D1:D5"><formula1>1</formula1><formula2>10</formula2></dataValidation>'
      + '<dataValidation type="list" showDropDown="1" sqref="E:E"><formula1>$G$1:$G$3</formula1></dataValidation>'
      + '</dataValidations><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="${x14}"><x14:dataValidations count="1" xmlns:xm="${xm}"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>数据!$A$2:$A$4</xm:f></x14:formula1><xm:sqref>F1:F5</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>`;
    const { bytes, imported } = await fixture({ [PARTS.summary]: summary });
    const rules = dataValidationsOf(imported.data)![SUMMARY];
    const rowCount = imported.data.sheets[SUMMARY].rowCount!;
    expect(rules.map(rule => [rule.type, rule.formula1, rule.formula2, rule.ranges.map(range => [range.startRow, range.startColumn, range.endRow, range.endColumn])])).toEqual([
      ['list', '是,否,"未知"', undefined, [[0, 2, 4, 2]]],
      ['whole', '1', '10', [[0, 3, 4, 3]]],
      ['list', '=$G$1:$G$3', undefined, [[0, 4, rowCount - 1, 4]]],
      ['list', '=数据!$A$2:$A$4', undefined, [[0, 5, 4, 5]]],
    ]);
    expect(rules[0]).toMatchObject({ allowBlank: true, showErrorMessage: true, showDropDown: true, renderMode: DataValidationRenderMode.ARROW });
    expect(rules[1]).toMatchObject({ operator: 'between', errorTitle: 'Oops', error: '1-10', errorStyle: DataValidationErrorStyle.STOP });
    expect(rules[2]).toMatchObject({ showDropDown: false, renderMode: DataValidationRenderMode.TEXT });

    // The model as loaded writes nothing.
    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);

    // One rule removed, one extended and one added: kept rules keep their markup and ranges.
    const changed = edited(imported, data => {
      const next = [
        { ...rules[0], ranges: [{ startRow: 0, endRow: 7, startColumn: 2, endColumn: 2 }] },
        rules[2],
        rules[3],
        { uid: 'new', type: 'decimal', operator: 'greaterThan', formula1: '0', ranges: [{ startRow: 0, endRow: 2, startColumn: 7, endColumn: 7 }], showErrorMessage: true, errorStyle: DataValidationErrorStyle.WARNING },
      ];
      data.resources = [...(data.resources ?? []).filter(item => item.name !== DATA_VALIDATIONS_RESOURCE), { name: DATA_VALIDATIONS_RESOURCE, data: JSON.stringify({ [SUMMARY]: next }) }];
    });
    const written = unpack(exportXlsx({ baseline: imported.baseline, current: changed, resolveFormula: noFormula }, bytes).bytes)[PARTS.summary];
    expect(written).toContain('<dataValidations count="3">'
      + `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="C1:C8"><formula1>${listItems}</formula1></dataValidation>`
      + '<dataValidation type="list" showDropDown="1" sqref="E:E"><formula1>$G$1:$G$3</formula1></dataValidation>'
      + '<dataValidation type="decimal" errorStyle="warning" operator="greaterThan" showErrorMessage="1" sqref="H1:H3"><formula1>0</formula1></dataValidation>'
      + '</dataValidations><pageMargins');
    expect(written).toContain(`<ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="${x14}"><x14:dataValidations count="1" xmlns:xm="${xm}"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>数据!$A$2:$A$4</xm:f></x14:formula1><xm:sqref>F1:F5</xm:sqref></x14:dataValidation></x14:dataValidations></ext>`);
    expect(written).not.toContain('type="whole"');

    // A renamed source sheet: the editor renames the rule formula (see StructureTracker), the file follows.
    const renamed = edited(imported, data => {
      data.sheets[DATA].name = 'Data';
      const next = rules.map(rule => (rule.formula1?.startsWith('=数据!') ? { ...rule, formula1: rule.formula1.replace('数据!', 'Data!') } : rule));
      data.resources = [...(data.resources ?? []).filter(item => item.name !== DATA_VALIDATIONS_RESOURCE), { name: DATA_VALIDATIONS_RESOURCE, data: JSON.stringify({ [SUMMARY]: next }) }];
    });
    const afterRename = unpack(exportXlsx({ baseline: imported.baseline, current: renamed, resolveFormula: noFormula }, bytes).bytes)[PARTS.summary];
    expect(afterRename).toContain('<xm:f>Data!$A$2:$A$4</xm:f>');
  });

  test('new validation goes after the conditional formats, not into a data bar\'s extension list', async () => {
    const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
    const xm = 'http://schemas.microsoft.com/office/excel/2006/main';
    // Excel writes a data bar with an extension list inside its rule, and the bar's settings at the end.
    const summary = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="B1"><v>5</v></c></row></sheetData>'
      + '<conditionalFormatting sqref="B1:B5"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar>'
      + `<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}" xmlns:x14="${x14}"><x14:id>{00000000-0000-4000-8000-000000000001}</x14:id></ext></extLst></cfRule></conditionalFormatting>`
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${x14}"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="${xm}">`
      + '<x14:cfRule type="dataBar" id="{00000000-0000-4000-8000-000000000001}"><x14:dataBar minLength="0" maxLength="100"><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/></x14:dataBar></x14:cfRule>'
      + '<xm:sqref>B1:B5</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst></worksheet>';
    const { bytes, imported } = await fixture({ [PARTS.summary]: summary });
    const current = edited(imported, data => {
      const rule = { uid: 'new', type: 'list', formula1: '是,否', ranges: [{ startRow: 0, endRow: 4, startColumn: 3, endColumn: 3 }], showDropDown: true };
      data.resources = [...(data.resources ?? []).filter(item => item.name !== DATA_VALIDATIONS_RESOURCE), { name: DATA_VALIDATIONS_RESOURCE, data: JSON.stringify({ [SUMMARY]: [rule] }) }];
    }, true);
    const saved = exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes;
    const written = unpack(saved)[PARTS.summary];
    expect(written).toContain('</cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" sqref="D1:D5"><formula1>"是,否"</formula1></dataValidation></dataValidations><pageMargins');
    // Read back: the data bar and the new list are both there.
    const reopened = importXlsx(saved, OPTIONS);
    expect(conditionalFormatsOf(reopened.data)[SUMMARY]).toHaveLength(1);
    expect(dataValidationsOf(reopened.data)![SUMMARY].map(rule => rule.formula1)).toEqual(['是,否']);
  });

  test('shows hyperlinks as links and writes back only the ones edited', async () => {
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const summary = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheetData>`
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Rate</t></is></c><c r="B1"><v>5</v></c></row>'
      + '<row r="2"><c r="C2" t="inlineStr"><is><t>x</t></is></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Go</t></is></c></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>Named</t></is></c></row></sheetData>'
      + '<hyperlinks><hyperlink ref="A1" r:id="rId1" tooltip="Open rate"/><hyperlink ref="B1" r:id="rId2"/><hyperlink ref="C2" r:id="rId3"/>'
      + '<hyperlink ref="A3" location="数据!B2" display="Go"/><hyperlink ref="A4" location="Rate"/></hyperlinks>'
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
    const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${rel}/hyperlink" Target="https://example.com/rate" TargetMode="External"/>`
      + `<Relationship Id="rId2" Type="${rel}/hyperlink" Target="https://example.com/five" TargetMode="External"/>`
      + `<Relationship Id="rId3" Type="${rel}/hyperlink" Target="https://old.example" TargetMode="External"/></Relationships>`;
    const { bytes, imported } = await fixture({ [PARTS.summary]: summary, 'xl/worksheets/_rels/sheet2.xml.rels': relationships });
    const cells = imported.data.sheets[SUMMARY].cellData!;
    const url = (row: number, column: number) => cells[row]?.[column]?.p?.body?.customRanges?.[0]?.properties?.url;
    expect(url(0, 0)).toBe('https://example.com/rate');
    expect(url(1, 2)).toBe('https://old.example');
    expect(url(2, 0)).toBe('#gid=sheet-0&range=B2');
    expect(cells[0][0].p?.body?.dataStream).toBe('Rate\r\n');
    // A link on a number and one to a defined name stay in the file without showing.
    expect(cells[0][1].p).toBeUndefined();
    expect(imported.hiddenHyperlinks).toBe(2);

    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);

    const current = edited(imported, data => {
      const sheet = data.sheets[SUMMARY].cellData!;
      sheet[0][0].p!.body!.customRanges = [];
      sheet[1][2].p!.body!.customRanges![0].properties!.url = 'https://changed.example';
      sheet[2][0] = { v: 'Went', t: 1 };
      const added = { v: 'New', t: 1 };
      linkCell(added, 'https://new.example', 'added', {});
      sheet[4] = { 0: added };
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    // Removed from A1, replaced on C2, kept where the text was typed over (A3) or not shown (B1, A4), added on A5.
    expect(parts[PARTS.summary]).toContain('<hyperlinks><hyperlink ref="B1" r:id="rId2"/><hyperlink ref="A3" location="数据!B2" display="Go"/><hyperlink ref="A4" location="Rate"/>'
      + '<hyperlink ref="C2" r:id="rId1"/><hyperlink ref="A5" r:id="rId3"/></hyperlinks>');
    const rels = parts['xl/worksheets/_rels/sheet2.xml.rels'];
    expect(rels).toContain('Target="https://example.com/five"');
    expect(rels).toContain(`<Relationship Id="rId1" Type="${rel}/hyperlink" Target="https://changed.example" TargetMode="External"/>`);
    expect(rels).toContain(`<Relationship Id="rId3" Type="${rel}/hyperlink" Target="https://new.example" TargetMode="External"/>`);
    expect(rels).not.toContain('example.com/rate');
    expect(rels).not.toContain('old.example');
    expect(row(parts[PARTS.summary], 3)).toContain('Went');
  });

  test('loads AutoFilters as filters and writes filtered rows back as hidden rows', async () => {
    const summary = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Fruit</t></is></c><c r="B1" t="inlineStr"><is><t>Qty</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>Apple</t></is></c><c r="B2"><v>3</v></c></row>'
      + '<row r="3" hidden="1"><c r="A3" t="inlineStr"><is><t>Banana</t></is></c><c r="B3"><v>5</v></c></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>Pear</t></is></c><c r="B4"><v>7</v></c></row>'
      + '<row r="5" hidden="1"><c r="A5" t="inlineStr"><is><t>Plum</t></is></c><c r="B5"><v>9</v></c></row></sheetData>'
      + '<autoFilter ref="A1:B5"><filterColumn colId="0"><filters><filter val="Apple"/><filter val="Pear"/></filters></filterColumn></autoFilter>'
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
    const workbook = unpack(await makeSheetFixture())[PARTS.workbook]
      .replace('</definedNames>', '<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Summary!$A$1:$B$5</definedName></definedNames>');
    const { bytes, imported } = await fixture({ [PARTS.summary]: summary, [PARTS.workbook]: workbook });
    const filter = filtersOf(imported.data)![SUMMARY];
    expect(filter).toEqual({ ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 }, filterColumns: [{ colId: 0, filters: { filters: ['Apple', 'Pear'] } }], cachedFilteredOut: [2, 4] });
    // Filtered rows are not hidden by hand: clearing the filter shows them.
    expect(imported.data.sheets[SUMMARY].rowData?.[2]?.hd).toBeUndefined();

    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);

    const withFilter = (next: object | null) => edited(imported, data => {
      data.resources = [...(data.resources ?? []).filter(item => item.name !== FILTERS_RESOURCE), { name: FILTERS_RESOURCE, data: JSON.stringify(next ? { [SUMMARY]: next } : {}) }];
    });
    // Quantities above 4, now on B: Apple's row hides, Banana's shows again.
    let parts = unpack(exportXlsx({
      baseline: imported.baseline,
      current: withFilter({ ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 1 }, filterColumns: [{ colId: 1, customFilters: { customFilters: [{ val: 4, operator: 'greaterThan' }] } }], cachedFilteredOut: [1] }),
      resolveFormula: noFormula,
    }, bytes).bytes);
    expect(parts[PARTS.summary]).toContain('<autoFilter ref="A1:B5"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="4"/></customFilters></filterColumn></autoFilter>');
    expect(row(parts[PARTS.summary], 2)).toContain('hidden="1"');
    expect(row(parts[PARTS.summary], 3)).not.toContain('hidden');
    expect(row(parts[PARTS.summary], 5)).not.toContain('hidden');
    expect(parts[PARTS.workbook]).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">Summary!$A$1:$B$5</definedName>');

    // Removing the filter shows every row and drops its name.
    parts = unpack(exportXlsx({ baseline: imported.baseline, current: withFilter(null), resolveFormula: noFormula }, bytes).bytes);
    expect(parts[PARTS.summary]).not.toContain('autoFilter');
    expect(parts[PARTS.summary]).not.toContain('hidden="1"');
    expect(parts[PARTS.workbook]).not.toContain('_FilterDatabase');
  });

  test('a filter turned on in the editor writes an AutoFilter and its hidden name', async () => {
    const { bytes, imported } = await fixture();
    expect(filtersOf(imported.data)?.[DATA]).toBeUndefined();
    const current = edited(imported, data => {
      const filter = { ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 }, filterColumns: [{ colId: 1, customFilters: { customFilters: [{ val: 2, operator: 'greaterThan' }] } }], cachedFilteredOut: [1] };
      data.resources = [...(data.resources ?? []).filter(item => item.name !== FILTERS_RESOURCE), { name: FILTERS_RESOURCE, data: JSON.stringify({ [DATA]: filter }) }];
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes).bytes);
    const sheet = parts[PARTS.data];
    expect(sheet).toContain('<autoFilter ref="A1:C5"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="2"/></customFilters></filterColumn></autoFilter>');
    // Schema order: the AutoFilter comes before the conditional formats and the page margins.
    expect(sheet.indexOf('<autoFilter')).toBeLessThan(sheet.indexOf('<conditionalFormatting'));
    expect(row(sheet, 2)).toContain('hidden="1"');
    expect(parts[PARTS.workbook]).toContain('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">数据!$A$1:$C$5</definedName>');

    // A workbook with an empty `<definedNames/>` (openpyxl writes one) keeps a single list.
    const empty = unpack(await makeSheetFixture())[PARTS.workbook].replace(/<definedNames>[\s\S]*?<\/definedNames>/, '<definedNames />');
    const bare = await fixture({ [PARTS.workbook]: empty });
    const withFilter = edited(bare.imported, data => {
      const filter = { ref: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 }, filterColumns: [], cachedFilteredOut: [] };
      data.resources = [...(data.resources ?? []).filter(item => item.name !== FILTERS_RESOURCE), { name: FILTERS_RESOURCE, data: JSON.stringify({ [DATA]: filter }) }];
    });
    const workbook = unpack(exportXlsx({ baseline: bare.imported.baseline, current: withFilter, resolveFormula: noFormula }, bare.bytes).bytes)[PARTS.workbook];
    expect(workbook.match(/<definedNames/g)).toHaveLength(1);
    expect(workbook).toContain('<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">数据!$A$1:$C$5</definedName></definedNames>');
  });

  test('loads comments as notes and writes back only the notes edited', async () => {
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const summary = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${rel}"><sheetData><row r="1"><c r="B1"><v>5</v></c></row></sheetData>`
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><legacyDrawing r:id="rId2"/></worksheet>';
    const comments = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Ann</author></authors><commentList>'
      + '<comment ref="B1" authorId="0"><text><r><rPr><b/></rPr><t>Ann:</t></r><r><t xml:space="preserve">\nCheck the rate</t></r></text></comment>'
      + '<comment ref="C3" authorId="0"><text><t>Old note</t></text></comment></commentList></comments>';
    const shape = (row: number, column: number, visible: boolean) => `<v:shape id="_x0000_s${1025 + row}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:120pt;height:60pt;z-index:1;visibility:${visible ? 'visible' : 'hidden'}" fillcolor="#ffffe1"><x:ClientData ObjectType="Note"><x:Row>${row}</x:Row><x:Column>${column}</x:Column>${visible ? '<x:Visible/>' : ''}</x:ClientData></v:shape>`;
    const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">${shape(0, 1, true)}${shape(2, 2, false)}</xml>`;
    const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${rel}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="${rel}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>`;
    const { bytes, imported } = await fixture({
      [PARTS.summary]: summary, 'xl/worksheets/_rels/sheet2.xml.rels': relationships, 'xl/comments1.xml': comments, 'xl/drawings/vmlDrawing1.vml': vml,
    });
    const loaded = notesOf(imported.data)![SUMMARY];
    expect(loaded[0][1]).toMatchObject({ row: 0, col: 1, note: 'Ann:\nCheck the rate', width: 160, height: 80, show: true });
    expect(loaded[2][2]).toMatchObject({ note: 'Old note' });
    expect(loaded[2][2].show).toBeUndefined();

    expect(exportXlsx({ baseline: imported.baseline, current: edited(imported, () => undefined), resolveFormula: noFormula }, bytes).changed).toBe(false);

    const withNotes = (change: (sheet: Record<number, Record<number, Record<string, unknown>>>) => void, target = SUMMARY) => edited(imported, data => {
      const model = structuredClone(notesOf(data) ?? {}) as unknown as Record<string, Record<number, Record<number, Record<string, unknown>>>>;
      model[target] ??= {};
      change(model[target]);
      data.resources = [...(data.resources ?? []).filter(item => item.name !== NOTES_RESOURCE), { name: NOTES_RESOURCE, data: JSON.stringify(model) }];
    });
    // B1 edited and hidden, C3 deleted, D5 added.
    let parts = unpack(exportXlsx({
      baseline: imported.baseline,
      current: withNotes(sheet => {
        sheet[0][1] = { ...sheet[0][1], note: 'Rate checked', show: false };
        delete sheet[2];
        sheet[4] = { 3: { id: 'n', row: 4, col: 3, width: 144, height: 79, note: 'New & shiny' } };
      }),
      resolveFormula: noFormula,
    }, bytes).bytes);
    expect(parts['xl/comments1.xml']).toContain('<authors><author>Ann</author><author>LobsterAI</author></authors>');
    // Rewritten whole, the text keeps the body's formatting rather than the bold author name.
    expect(parts['xl/comments1.xml']).toContain('<comment ref="B1" authorId="0"><text><r><t xml:space="preserve">Rate checked</t></r></text></comment>');
    expect(parts['xl/comments1.xml']).not.toContain('C3');
    expect(parts['xl/comments1.xml']).toContain('<comment ref="D5" authorId="1"><text><t xml:space="preserve">New &amp; shiny</t></text></comment>');
    const drawing = parts['xl/drawings/vmlDrawing1.vml'];
    expect(drawing).toContain('visibility:hidden');
    expect(drawing).not.toContain('<x:Visible/>');
    expect(drawing).not.toContain('<x:Row>2</x:Row>');
    expect(drawing).toMatch(/<x:Row>4<\/x:Row><x:Column>3<\/x:Column><\/x:ClientData><\/v:shape><\/xml>$/);

    // A sheet's first note brings its comment and drawing parts.
    parts = unpack(exportXlsx({
      baseline: imported.baseline,
      current: withNotes(sheet => { sheet[1] = { 0: { id: 'm', row: 1, col: 0, width: 144, height: 79, note: '首条批注' } }; }, DATA),
      resolveFormula: noFormula,
    }, bytes).bytes);
    const dataRels = parts['xl/worksheets/_rels/sheet1.xml.rels'];
    expect(dataRels).toContain(`Type="${rel}/comments" Target="../comments2.xml"`);
    expect(dataRels).toMatch(new RegExp(`Id="(rId\\d+)" Type="${rel}/vmlDrawing" Target="../drawings/vmlDrawing2.vml"`));
    expect(parts['xl/comments2.xml']).toContain('<comment ref="A2" authorId="0"><text><t xml:space="preserve">首条批注</t></text></comment>');
    expect(parts['xl/drawings/vmlDrawing2.vml']).toContain('<x:Row>1</x:Row><x:Column>0</x:Column>');
    expect(parts[PARTS.data]).toMatch(/<legacyDrawing r:id="rId\d+"\/><tableParts/);
    expect(parts['[Content_Types].xml']).toContain('<Override PartName="/xl/comments2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>');
    expect(parts['[Content_Types].xml']).toContain('Extension="vml"');
  });

  test('keeps table headers and their table definition in step', async () => {
    const { bytes, imported } = await fixture();
    const renamed = edited(imported, data => { data.sheets[DATA].cellData![0][1] = { v: '件数', t: 1, s: 'x1' }; });
    const table = unpack(exportXlsx({ baseline: imported.baseline, current: renamed, resolveFormula: noFormula }, bytes).bytes)[PARTS.table];
    expect(table).toContain('<tableColumn id="2" name="件数"/>');
    const issueOf = (current: IWorkbookData) => {
      try { exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes); } catch (error) { return (error as XlsxExportError).issue; }
      return undefined;
    };
    expect(issueOf(edited(imported, data => { delete data.sheets[DATA].cellData![0][0].v; }))).toBe(SheetExportIssue.TableHeader);
    expect(issueOf(edited(imported, data => { data.sheets[DATA].cellData![0][1] = { v: '项目', t: 1 }; }))).toBe(SheetExportIssue.TableHeader);
    expect(issueOf(edited(imported, data => {
      data.sheets[DATA].cellData![0][1] = { v: '件数', t: 1 };
      data.sheets[SUMMARY].cellData![3] = { 0: { f: '=SUM(Fruit[数量])' } };
    }))).toBe(SheetExportIssue.TableHeader);
  });

  test('restores Excel storage prefixes for newer functions', () => {
    expect(formulaForExcel('=XLOOKUP(A1,B:B,C:C)')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)');
    expect(formulaForExcel('=IFERROR(xlookup(1,A:A,B:B),0)+FILTER(A1:A3,B1:B3>1)')).toBe('IFERROR(_xlfn.xlookup(1,A:A,B:B),0)+_xlfn._xlws.FILTER(A1:A3,B1:B3>1)');
    expect(formulaForExcel('="XLOOKUP(" & \'IFS(x\'!A1 & SUM(A1)')).toBe('"XLOOKUP(" & \'IFS(x\'!A1 & SUM(A1)');
    expect(formulaForExcel('=_xlfn.CONCAT(A1)')).toBe('_xlfn.CONCAT(A1)');
  });
});

describe('charts made in the editor', () => {
  test('a new chart gets its chart part, a drawing part and the relationships to reach them', async () => {
    const { bytes, imported } = await fixture();
    const spec = chartFromRange(ChartKind.Column, '数据', { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }, (row, column) => {
      const value = imported.data.sheets[DATA].cellData?.[row]?.[column]?.v;
      return { value: value ?? null, text: value === undefined || value === null ? '' : String(value) };
    })!;
    const chart = {
      drawingId: 'new-chart', drawingType: 8, componentKey: SHEET_CHART_COMPONENT, unitId: imported.data.id, subUnitId: DATA,
      // Made after one row edit; the row inserted later moves its references.
      data: { spec, origin: { edits: 1 } },
      sheetTransform: { from: { column: 5, columnOffset: 0, row: 1, rowOffset: 0 }, to: { column: 10, columnOffset: 0, row: 15, rowOffset: 0 } },
      transform: { left: 400, top: 20, width: 480, height: 288 },
    };
    const structure = [
      { sheetId: SUMMARY, axis: StructureAxis.Rows, action: StructureAction.Insert, index: 5, count: 1 },
      { sheetId: DATA, axis: StructureAxis.Rows, action: StructureAction.Insert, index: 2, count: 1 },
    ];
    const current = edited(imported, data => {
      const sheet = data.sheets[DATA];
      shiftRows(sheet, row => (row >= 2 ? row + 1 : row));
      const summary = data.sheets[SUMMARY];
      shiftRows(summary, row => (row >= 5 ? row + 1 : row));
      data.resources = [...(data.resources ?? []), { name: DRAWINGS_RESOURCE, data: JSON.stringify({ [DATA]: { data: { [chart.drawingId]: chart }, order: [chart.drawingId] } }) }];
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: sharedFormulaResolver(current), structure }, bytes).bytes);
    expect(parts[PARTS.data]).toMatch(/<drawing r:id="rId2"\/><tableParts/);
    expect(parts['xl/worksheets/_rels/sheet1.xml.rels']).toContain('<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>');
    expect(parts['xl/drawings/_rels/drawing1.xml.rels']).toContain('Target="../charts/chart1.xml"');
    expect(parts['[Content_Types].xml']).toContain('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>');
    expect(parts['[Content_Types].xml']).toContain('<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>');
    expect(parts['xl/drawings/drawing1.xml']).toContain('<xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row>');
    const written = parseChart(parts['xl/charts/chart1.xml'], new XlsxStyles(undefined, undefined, 'en'));
    // Rows 2–4 of the data grew by the row inserted after the chart was made; caches hold current values.
    expect(written.plots[0].series[0].values).toMatchObject({ ref: '数据!$B$2:$B$5', cache: [3, null, 4, 5] });
    expect(written.plots[0].series[0].categories?.ref).toBe('数据!$A$2:$A$5');
    // Without the chart the file stays as it was.
    const removed = edited(imported, () => undefined);
    expect(exportXlsx({ baseline: imported.baseline, current: removed, resolveFormula: noFormula }, bytes).changed).toBe(false);
  });
});

describe('content types', () => {
  test('parts added in the same save as a cell edit keep their content types', async () => {
    const { bytes, imported } = await fixture();
    const current = edited(imported, data => {
      data.sheets[DATA].cellData![1][1] = { ...data.sheets[DATA].cellData![1][1], v: 9 };
      data.resources = [...(data.resources ?? []).filter(item => item.name !== NOTES_RESOURCE),
        { name: NOTES_RESOURCE, data: JSON.stringify({ [DATA]: { 1: { 1: { id: 'n1', row: 1, col: 1, width: 144, height: 79, note: 'Checked' } } } }) }];
    });
    const parts = unpack(exportXlsx({ baseline: imported.baseline, current, resolveFormula: sharedFormulaResolver(current) }, bytes).bytes);
    // The calculation chain goes (a cell changed); the new comments part keeps its content type.
    expect(parts['xl/calcChain.xml']).toBeUndefined();
    expect(parts['[Content_Types].xml']).not.toContain('calcChain');
    expect(parts['[Content_Types].xml']).toContain('<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>');
    expect(parts['[Content_Types].xml']).toContain('Extension="vml"');
  });
});

describe('pictures added in the editor', () => {
  // A 1×1 transparent PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  test('a new picture is embedded with its media part, relationship and content type', async () => {
    const { bytes, imported } = await fixture();
    const picture = {
      drawingId: 'new-picture', drawingType: 0, imageSourceType: 'BASE64', source: `data:image/png;base64,${PNG}`, unitId: imported.data.id, subUnitId: SUMMARY,
      sheetTransform: { from: { column: 3, columnOffset: 0, row: 1, rowOffset: 0 }, to: { column: 5, columnOffset: 10, row: 6, rowOffset: 0 } },
      transform: { left: 200, top: 20, width: 150, height: 100 },
    };
    const current = edited(imported, data => {
      data.resources = [...(data.resources ?? []), { name: DRAWINGS_RESOURCE, data: JSON.stringify({ [SUMMARY]: { data: { [picture.drawingId]: picture }, order: [picture.drawingId] } }) }];
    });
    const result = exportXlsx({ baseline: imported.baseline, current, resolveFormula: noFormula }, bytes);
    const parts = unpack(result.bytes);
    expect(Buffer.from(unzipSync(result.bytes)['xl/media/image1.png']).toString('base64')).toBe(PNG);
    expect(parts['[Content_Types].xml']).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(parts['xl/drawings/_rels/drawing1.xml.rels']).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"');
    const drawing = parts['xl/drawings/drawing1.xml'];
    expect(drawing).toContain('<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>3</xdr:col>');
    expect(drawing).toMatch(/<a:blip xmlns:r="[^"]+" r:embed="rId1"\/>/);
    // The summary sheet had no drawing part: it gets one and the element that points to it.
    expect(parts[PARTS.summary]).toMatch(/<drawing r:id="rId1"\/><\/worksheet>$/);
  });
});
