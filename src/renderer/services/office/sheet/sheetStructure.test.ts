import { describe, expect, test } from 'vitest';

import {
  AxisMap, expandThisRowReferences, type FormulaScope, formulaSheetName, hasThreeDimensionalReference, IDENTITY_COLUMNS, IDENTITY_ROWS, offsetFormula,
  parseSqref, type SheetFate, type SheetMaps, sheetMaps, shortenThisRowReferences, StructureAction, StructureAxis, transformAnchoredFormula,
  transformFormula, transformSqref,
} from './sheetStructure';

const { Insert, Remove } = StructureAction;
const rowsOnly = (...ops: [StructureAction, number, number][]): SheetMaps => ({
  rows: new AxisMap(ops.map(([action, index, count]) => ({ action, index, count })), 1_048_576),
  columns: IDENTITY_COLUMNS,
});
const columnsOnly = (...ops: [StructureAction, number, number][]): SheetMaps => ({
  rows: IDENTITY_ROWS,
  columns: new AxisMap(ops.map(([action, index, count]) => ({ action, index, count })), 16_384),
});
const unchanged: SheetMaps = { rows: IDENTITY_ROWS, columns: IDENTITY_COLUMNS };

function scope(fates: Record<string, Partial<SheetFate>>, homeSheet?: string): FormulaScope {
  const byName = new Map(Object.entries(fates).map(([name, fate]) => [name.toLowerCase(), { name, renamed: false, maps: unchanged, ...fate }]));
  return { homeSheet, sheet: name => byName.get(name.toLowerCase()) };
}

describe('axis maps', () => {
  test('insertions shift later indexes and grow ranges that span them', () => {
    const map = new AxisMap([{ action: Insert, index: 5, count: 2 }], 100);
    expect([map.index(4), map.index(5), map.index(10)]).toEqual([4, 7, 12]);
    expect(map.range(5, 10)).toEqual([7, 12]);
    expect(map.range(3, 10)).toEqual([3, 12]);
    expect(map.range(0, 4)).toEqual([0, 4]);
    expect([map.inverse(4), map.inverse(5), map.inverse(6), map.inverse(7)]).toEqual([4, null, null, 5]);
    expect(map.index(99)).toBeNull();
    expect(map.range(90, 99)).toEqual([92, 99]);
  });

  test('deletions drop indexes, shrink ranges and settle anchors on the next row', () => {
    const map = new AxisMap([{ action: Remove, index: 5, count: 2 }], 100);
    expect([map.index(4), map.index(5), map.index(6), map.index(7)]).toEqual([4, null, null, 5]);
    expect(map.range(3, 10)).toEqual([3, 8]);
    expect(map.range(5, 6)).toBeNull();
    expect(map.range(6, 10)).toEqual([5, 8]);
    expect(map.range(0, 5)).toEqual([0, 4]);
    expect([map.settle(5), map.settle(6), map.settle(8)]).toEqual([5, 5, 6]);
    expect(map.inverse(5)).toBe(7);
  });

  test('sequences apply in order', () => {
    const map = new AxisMap([{ action: Insert, index: 2, count: 3 }, { action: Remove, index: 0, count: 2 }], 100);
    expect([map.index(0), map.index(1), map.index(2)]).toEqual([null, null, 3]);
    expect([map.inverse(0), map.inverse(3)]).toEqual([null, 2]);
    const undone = new AxisMap([{ action: Insert, index: 4, count: 2 }, { action: Remove, index: 4, count: 2 }], 100);
    expect([undone.index(3), undone.index(4), undone.index(9)]).toEqual([3, 4, 9]);
    expect(undone.range(2, 8)).toEqual([2, 8]);
  });

  test('ops are grouped per sheet and axis', () => {
    const maps = sheetMaps([
      { sheetId: 'a', axis: StructureAxis.Rows, action: Insert, index: 0, count: 1 },
      { sheetId: 'b', axis: StructureAxis.Rows, action: Insert, index: 0, count: 5 },
      { sheetId: 'a', axis: StructureAxis.Columns, action: Remove, index: 1, count: 1 },
    ], 'a');
    expect(maps.rows.index(0)).toBe(1);
    expect(maps.columns.index(1)).toBeNull();
    expect(maps.columns.index(2)).toBe(1);
  });
});

describe('formula references', () => {
  const inserted = scope({ Sheet1: { maps: rowsOnly([Insert, 1, 1]) }, Data: { name: 'My Data', renamed: true }, Old: { name: null }, 数据: { maps: rowsOnly([Insert, 0, 1]) } }, 'Sheet1');

  test('follow inserted rows the way Excel does', () => {
    expect(transformFormula('SUM(A1:A10)', inserted)).toBe('SUM(A1:A11)');
    expect(transformFormula('A2*2', inserted)).toBe('A3*2');
    expect(transformFormula('$B$2+B$3', inserted)).toBe('$B$3+B$4');
    expect(transformFormula('SUM(Sheet1!2:3)', inserted)).toBe('SUM(Sheet1!3:4)');
    expect(transformFormula('SUM(B:B)', inserted)).toBe('SUM(B:B)');
    expect(transformFormula('LOG10(A2)', inserted)).toBe('LOG10(A3)');
    expect(transformFormula('_xlfn.XLOOKUP(A2,B:B,C:C)', inserted)).toBe('_xlfn.XLOOKUP(A3,B:B,C:C)');
    expect(transformFormula('SUM(A2#)', inserted)).toBe('SUM(A3#)');
    expect(transformFormula('A1:A3 A2:C2', inserted)).toBe('A1:A4 A3:C3');
    expect(transformFormula('数据!B6*2', inserted)).toBe('数据!B7*2');
  });

  test('leave strings, structured, external and error references alone', () => {
    const formula = '"A2"&A1';
    expect(transformFormula(formula, inserted)).toBe(formula);
    expect(transformFormula('Table1[[#This Row],[Amount]]*A2', inserted)).toBe('Table1[[#This Row],[Amount]]*A3');
    expect(transformFormula('[1]Sheet1!A2+[1]!Rate', inserted)).toBe('[1]Sheet1!A2+[1]!Rate');
    expect(transformFormula('\'[Book.xlsx]Sheet1\'!A2', inserted)).toBe('\'[Book.xlsx]Sheet1\'!A2');
    expect(transformFormula('#REF!A1+A2', inserted)).toBe('#REF!A1+A3');
    expect(transformFormula('A1+1.5E3+{1,2;"A2",4}', inserted)).toBe('A1+1.5E3+{1,2;"A2",4}');
  });

  test('follow renamed and deleted sheets', () => {
    expect(transformFormula('Data!A1', inserted)).toBe('\'My Data\'!A1');
    expect(transformFormula('SUM(\'Data\'!$A$1:$A$5)', inserted)).toBe('SUM(\'My Data\'!$A$1:$A$5)');
    expect(transformFormula('Data!Rate*2', inserted)).toBe('\'My Data\'!Rate*2');
    expect(transformFormula('Old!A1+1', inserted)).toBe('#REF!+1');
    expect(transformFormula('SUM(Sheet1:Data!A1)', inserted)).toBe('SUM(\'Sheet1:My Data\'!A1)');
    expect(hasThreeDimensionalReference('SUM(Sheet1:Data!A1)')).toBe(true);
    expect(hasThreeDimensionalReference('SUM(Data!A1:B2)')).toBe(false);
  });

  test('deleted cells become #REF! and ranges shrink', () => {
    const removed = scope({ Sheet1: { maps: rowsOnly([Remove, 1, 1]) } }, 'Sheet1');
    expect(transformFormula('A2', removed)).toBe('#REF!');
    expect(transformFormula('SUM(A1:A3)', removed)).toBe('SUM(A1:A2)');
    expect(transformFormula('Sheet1!A2+Sheet1!A3', removed)).toBe('Sheet1!#REF!+Sheet1!A2');
  });

  test('columns move like rows', () => {
    const columns = scope({ Sheet1: { maps: columnsOnly([Insert, 1, 2]) } }, 'Sheet1');
    expect(transformFormula('B1+A1', columns)).toBe('D1+A1');
    expect(transformFormula('SUM(A1:C1)', columns)).toBe('SUM(A1:E1)');
    expect(transformFormula('SUM(B:C)', columns)).toBe('SUM(D:E)');
    expect(transformFormula('SUM(1:1)', columns)).toBe('SUM(1:1)');
  });

  test('unqualified references stay put without a home sheet', () => {
    const noHome = scope({ Sheet1: { maps: rowsOnly([Insert, 0, 1]) } });
    expect(transformFormula('A1+Sheet1!A1', noHome)).toBe('A1+Sheet1!A2');
  });

  test('offsets relative parts only', () => {
    expect(offsetFormula('A1+$B$2+B$3+$C4', 1, 1)).toBe('B2+$B$2+C$3+$C5');
    expect(offsetFormula('Sheet2!A1', 1, 0)).toBe('Sheet2!A2');
    expect(offsetFormula('A1', -1, 0)).toBe('#REF!');
  });

  test('rule formulas are rebased when their anchor cell is deleted', () => {
    const maps = rowsOnly([Remove, 0, 1]);
    const scoped = scope({ Sheet1: { maps } }, 'Sheet1');
    const before = parseSqref('A1:A10');
    const after = parseSqref('A1:A9');
    expect(transformAnchoredFormula('A1>5', scoped, maps, before, after)).toBe('A1>5');
    expect(transformAnchoredFormula('$B1>$C$1', scoped, maps, before, after)).toBe('$B1>#REF!');
    const later = rowsOnly([Remove, 2, 1]);
    expect(transformAnchoredFormula('A1>5', scope({ Sheet1: { maps: later } }, 'Sheet1'), later, before, parseSqref('A1:A9'))).toBe('A1>5');
  });
});

describe('reference lists', () => {
  test('move, shrink and drop', () => {
    expect(transformSqref('A1:B2 D4', rowsOnly([Insert, 0, 1]))).toBe('A2:B3 D5');
    expect(transformSqref('A1:B2 D4', rowsOnly([Remove, 3, 1]))).toBe('A1:B2');
    expect(transformSqref('D4', rowsOnly([Remove, 3, 1]))).toBeNull();
    const text = '$A$1:$B$2';
    expect(transformSqref(text, rowsOnly([Insert, 5, 1]))).toBe(text);
    expect(transformSqref('A:A 3:3', rowsOnly([Insert, 0, 2]))).toBe('A1:A1048576 A5:XFD5');
  });

  test('sheet names are quoted when Excel needs quotes', () => {
    expect(['Sheet1', 'My Data', 'A1', '2024', 'It\'s', '数据', 'R1C1', 'Q1.a'].map(formulaSheetName))
      .toEqual(['Sheet1', '\'My Data\'', '\'A1\'', '\'2024\'', '\'It\'\'s\'', '数据', '\'R1C1\'', 'Q1.a']);
  });
});

describe('this-row references', () => {
  test('the @ shorthand is written out as files store it', () => {
    expect(expandThisRowReferences('=Sales[@Qty]*Sales[@[Unit Price]]')).toBe('=Sales[[#This Row],[Qty]]*Sales[[#This Row],[Unit Price]]');
    expect(expandThisRowReferences('=SUM(Sales[@[Q1]:[Q4]])+COUNTA(Sales[@])')).toBe('=SUM(Sales[[#This Row],[Q1]:[Q4]])+COUNTA(Sales[[#This Row]])');
    // Unqualified references take the table the cell is in; text is left alone.
    expect(expandThisRowReferences('=[@Qty]&"[@Qty]"', () => 'Sales')).toBe('=Sales[[#This Row],[Qty]]&"[@Qty]"');
    expect(expandThisRowReferences('=[@Qty]*2')).toBe('=[@Qty]*2');
    expect(expandThisRowReferences('=Sales[Qty]')).toBe('=Sales[Qty]');
  });

  test('the long form shows as Excel shows it, and entering what shows writes it back', () => {
    const cases: [string, string | undefined, string][] = [
      ['=Sales[[#This Row],[Qty]]*2', 'Sales', '=[@Qty]*2'],
      ['=Sales[[#This Row],[Qty]]*2', 'Other', '=Sales[@Qty]*2'],
      ['=Sales[[#This Row],[Unit Price]]', 'Sales', '=[@[Unit Price]]'],
      ['=SUM(Sales[[#This Row],[Q1]:[Q4]])', 'Sales', '=SUM([@[Q1]:[Q4]])'],
      ['=COUNTA(Sales[[#This Row]])', 'Sales', '=COUNTA(Sales[@])'],
      ['=Sales[[#This Row],[Qty]]&"Sales[[#This Row],[Qty]]"', 'Sales', '=[@Qty]&"Sales[[#This Row],[Qty]]"'],
      ['=SUM(Sales[Qty])', 'Sales', '=SUM(Sales[Qty])'],
    ];
    for (const [long, table, short] of cases) {
      expect(shortenThisRowReferences(long, table)).toBe(short);
      expect(expandThisRowReferences(short, () => table)).toBe(long);
    }
  });
});
