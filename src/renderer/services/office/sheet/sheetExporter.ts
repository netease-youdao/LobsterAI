import type { ICellData, IWorkbookData } from '@univerjs/core';

import { offsetFormula } from './sheetStructure';
import { adoptLoadedConditionalFormats } from './xlsxConditionalFormats';
import { adoptLoadedDataValidations } from './xlsxDataValidations';
import { adoptLoadedDrawings } from './xlsxDrawings';
import { type ExportRequest, exportXlsx } from './xlsxExport';
import { adoptLoadedFilters } from './xlsxFilters';
import type { WorkbookBaseline } from './xlsxImport';
import { adoptLoadedNotes } from './xlsxNotes';

/** What the editor tracked besides the snapshot: row and column edits, grown tables, the sheet on screen. */
export type SheetEdits = Pick<ExportRequest, 'structure' | 'tables' | 'activeSheetId'>;

/**
 * Everything a save needs, without the Univer instance: the file as opened, its import, and the
 * model's state right after loading. It runs in the file worker so saving large workbooks never
 * blocks the grid; the editor sends it the current snapshot.
 */

/** Compare later saves against the model as it stood right after loading (see the adopt functions). */
export function adoptLoaded(baseline: WorkbookBaseline, loaded: Pick<IWorkbookData, 'resources'>): void {
  const snapshot = loaded as IWorkbookData;
  adoptLoadedConditionalFormats(baseline.conditionalFormats, snapshot);
  adoptLoadedDrawings(baseline.drawings, snapshot);
  adoptLoadedDataValidations(baseline.dataValidations, snapshot);
  adoptLoadedNotes(baseline.notes, snapshot);
  adoptLoadedFilters(baseline.filters, snapshot);
}

/**
 * A cell's formula as the engine reports it: its own, or its shared-formula group's (cells with
 * the same `si`) moved from the group's anchor, the cell that holds the text.
 */
export function sharedFormulaResolver(snapshot: IWorkbookData): (sheetId: string, row: number, column: number) => string | undefined {
  const anchors = new Map<string, Map<string, { row: number; column: number; formula: string }>>();
  const anchorsOf = (sheetId: string) => {
    let sheet = anchors.get(sheetId);
    if (sheet) return sheet;
    sheet = new Map();
    anchors.set(sheetId, sheet);
    for (const [row, columns] of Object.entries(snapshot.sheets[sheetId]?.cellData ?? {})) {
      for (const [column, cell] of Object.entries(columns as Record<string, ICellData | null>)) {
        if (cell?.si && typeof cell.f === 'string' && cell.f && !sheet.has(cell.si)) sheet.set(cell.si, { row: Number(row), column: Number(column), formula: cell.f });
      }
    }
    return sheet;
  };
  return (sheetId, row, column) => {
    const cell = (snapshot.sheets[sheetId]?.cellData as Record<number, Record<number, ICellData | null>> | undefined)?.[row]?.[column];
    if (typeof cell?.f === 'string' && cell.f) return cell.f;
    const anchor = cell?.si ? anchorsOf(sheetId).get(cell.si) : undefined;
    if (!anchor) return undefined;
    return `=${offsetFormula(anchor.formula.replace(/^=/, ''), row - anchor.row, column - anchor.column)}`;
  };
}

export class SheetExporter {
  constructor(private readonly bytes: Uint8Array, private readonly baseline: WorkbookBaseline) {}

  /** The model's resources right after loading; call once before the first save. */
  adopt(loaded: Pick<IWorkbookData, 'resources'>): void {
    adoptLoaded(this.baseline, loaded);
  }

  /** The workbook's bytes for the current snapshot; a copy of the original when nothing changed. */
  export(current: IWorkbookData, edits: SheetEdits): Uint8Array {
    const result = exportXlsx({ baseline: this.baseline, current, resolveFormula: sharedFormulaResolver(current), ...edits }, this.bytes);
    return result.changed ? result.bytes : this.bytes.slice();
  }
}
