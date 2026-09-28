import type { IWorkbookData } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { cellSlices, CellSliceStore, snapshotCellCount, withoutCells } from './sheetSnapshotSlices';

function workbook(rowsPerSheet: Record<string, number>, columns = 3): IWorkbookData {
  const sheets = Object.fromEntries(Object.entries(rowsPerSheet).map(([id, rows]) => [id, {
    id, name: id, rowData: { 0: { h: 30 } },
    cellData: Object.fromEntries(Array.from({ length: rows }, (_, row) => [row, Object.fromEntries(Array.from({ length: columns }, (_, column) => [column, { v: row * 10 + column }]))])),
  }]));
  return { id: 'book', name: 'book', appVersion: '1', locale: 'zhCN', styles: { s1: { bl: 1 } }, sheetOrder: Object.keys(rowsPerSheet), sheets } as unknown as IWorkbookData;
}

describe('snapshot slices', () => {
  test('slices whole rows of about the given number of cells, sheet by sheet', () => {
    const snapshot = workbook({ a: 10, b: 3 });
    const slices = [...cellSlices(snapshot, 9)];
    expect(slices.map(slice => [slice.sheetId, Object.keys(slice.rows).length])).toEqual([['a', 3], ['a', 3], ['a', 3], ['a', 1], ['b', 3]]);
    expect(snapshotCellCount(snapshot)).toBe(39);
  });

  test('the worker puts the slices back into the snapshot sent without cells', () => {
    const snapshot = workbook({ a: 25, b: 7 });
    const store = new CellSliceStore();
    for (const slice of cellSlices(snapshot, 10)) store.add(slice);
    const light = withoutCells(snapshot);
    expect(snapshotCellCount(light)).toBe(0);
    expect(light.sheets.a.rowData).toBe(snapshot.sheets.a.rowData);
    expect(store.assemble(light)).toEqual(snapshot);
  });

  test('the live snapshot is left untouched', () => {
    const snapshot = workbook({ a: 4 });
    const before = JSON.stringify(snapshot);
    withoutCells(snapshot);
    expect([...cellSlices(snapshot, 6)]).toHaveLength(2);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  test('sheets without cells travel with the snapshot', () => {
    const snapshot = workbook({ a: 2, empty: 0 });
    const store = new CellSliceStore();
    for (const slice of cellSlices(snapshot)) store.add(slice);
    expect(store.assemble(withoutCells(snapshot)).sheets.empty.cellData).toEqual({});
  });
});
