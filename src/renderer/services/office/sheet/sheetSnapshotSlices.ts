import type { ICellData, IObjectMatrixPrimitiveType, IWorkbookData } from '@univerjs/core';

/**
 * A workbook snapshot sent to the file worker in pieces. Posting a message copies it on the
 * sending thread, and one large workbook's cells take tens of milliseconds to copy: sent in
 * slices of rows between frames, saving never holds up typing or scrolling.
 */

/** Cells per slice: copying one takes a few milliseconds. */
export const SLICE_CELLS = 16000;
/** Below this many cells a snapshot is sent whole: its copy is already quick. */
export const SLICED_EXPORT_CELLS = 20000;

type CellMatrix = IObjectMatrixPrimitiveType<ICellData>;

export interface CellSlice {
  sheetId: string;
  /** Whole rows of the sheet's cell data, keyed by row index. */
  rows: CellMatrix;
}

const cellsOf = (row: Record<number, ICellData> | undefined) => (row ? Object.keys(row).length : 0);

export function snapshotCellCount(snapshot: IWorkbookData): number {
  let count = 0;
  for (const sheet of Object.values(snapshot.sheets ?? {})) {
    for (const row of Object.values(sheet.cellData ?? {})) count += cellsOf(row);
  }
  return count;
}

/** The sheets' cell data in slices of whole rows, about `maxCells` cells each. */
export function* cellSlices(snapshot: IWorkbookData, maxCells = SLICE_CELLS): Generator<CellSlice> {
  for (const [sheetId, sheet] of Object.entries(snapshot.sheets ?? {})) {
    let rows: CellMatrix = {};
    let cells = 0;
    for (const [row, columns] of Object.entries(sheet.cellData ?? {})) {
      rows[Number(row)] = columns;
      cells += cellsOf(columns);
      if (cells >= maxCells) {
        yield { sheetId, rows };
        rows = {};
        cells = 0;
      }
    }
    if (cells > 0 || Object.keys(rows).length) yield { sheetId, rows };
  }
}

/** The snapshot without its cell data, which travels in slices; the sheets are shallow copies. */
export function withoutCells(snapshot: IWorkbookData): IWorkbookData {
  const sheets = Object.fromEntries(Object.entries(snapshot.sheets ?? {}).map(([id, sheet]) => [id, { ...sheet, cellData: {} }]));
  return { ...snapshot, sheets };
}

/** Collects slices on the worker's side. */
export class CellSliceStore {
  private readonly sheets = new Map<string, CellMatrix>();

  add(slice: CellSlice): void {
    const rows = this.sheets.get(slice.sheetId) ?? {};
    Object.assign(rows, slice.rows);
    this.sheets.set(slice.sheetId, rows);
  }

  /** The snapshot with the collected cell data put back. */
  assemble(snapshot: IWorkbookData): IWorkbookData {
    const sheets = Object.fromEntries(Object.entries(snapshot.sheets ?? {}).map(([id, sheet]) => [id, { ...sheet, cellData: this.sheets.get(id) ?? {} }]));
    return { ...snapshot, sheets };
  }
}
