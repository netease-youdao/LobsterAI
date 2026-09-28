import type { IWorkbookData } from '@univerjs/core';

import type { CellRange } from './sheetAddress';
import { analyzeWorkbookStructure, type WorkbookStructureInfo } from './sheetStructureSupport';
import { type ResolvedTableStyle, resolveTableStyle } from './sheetTableStyles';
import { chartPalette } from './xlsxCharts';
import type { SheetFilter } from './xlsxFilters';
import type { ImportedSheet, ImportedTable, ImportedWorkbook } from './xlsxImport';
import { RelationshipType } from './xlsxPackage';

/**
 * What the grid's thread keeps of an import: the snapshot for Univer and what the editor reads
 * of the file, worked out where the file was imported. The file's parts, formats and the export
 * baseline stay with whoever saves it (the file worker), so this is plain, copyable data.
 */
export interface EditorImport {
  data: IWorkbookData;
  activeSheetId?: string;
  cellCount: number;
  tables: ImportedTable[];
  autoFitRows: Record<string, number[]>;
  hiddenDrawings: number;
  hiddenHyperlinks: number;
  unshownLinks: Map<string, CellRange[]>;
  sheets: ImportedSheet[];
  maxDigitWidth: number;
  filters: Map<string, SheetFilter>;
  structure: WorkbookStructureInfo;
  /** The table styles the tables use, by name, with the workbook's theme colors. */
  tableStyles: Map<string, ResolvedTableStyle>;
  /** The theme's accent colors, for new charts. */
  palette: string[];
}

export function editorImport(imported: ImportedWorkbook): EditorImport {
  const { baseline } = imported;
  const stylesPart = baseline.pkg.relationships(baseline.workbookPart).find(item => item.type === RelationshipType.Styles && !item.external)?.target;
  const stylesXml = stylesPart ? baseline.pkg.text(stylesPart) : undefined;
  const tableStyles = new Map<string, ResolvedTableStyle>();
  for (const table of imported.tables) {
    const name = table.style?.name;
    if (!name || tableStyles.has(name)) continue;
    const style = resolveTableStyle(name, baseline.styles, stylesXml);
    if (style) tableStyles.set(name, style);
  }
  return {
    data: imported.data,
    activeSheetId: imported.activeSheetId,
    cellCount: imported.cellCount,
    tables: imported.tables,
    autoFitRows: imported.autoFitRows,
    hiddenDrawings: imported.hiddenDrawings,
    hiddenHyperlinks: imported.hiddenHyperlinks,
    unshownLinks: imported.unshownLinks,
    sheets: baseline.sheets,
    maxDigitWidth: baseline.maxDigitWidth,
    filters: baseline.filters,
    structure: analyzeWorkbookStructure(baseline, imported.unshownLinks),
    tableStyles,
    palette: chartPalette(baseline.styles),
  };
}
