import type { FWorkbook } from '@univerjs/sheets/facade';

import { rangeReference } from './sheetAddress';
import { categoryLevels, type ResolvedData } from './sheetChartOption';
import type { SheetChartData } from './sheetChartSpec';
import { mapFormulaReferences } from './sheetStructure';
import type { ChartDataRef } from './xlsxCharts';

/**
 * What a chart drawn over the grid needs from its workbook: the cells behind its series and a
 * way to move the chart's original references through the edits made since the file opened.
 */
export interface ChartHost {
  workbook: FWorkbook;
  /**
   * A chart reference moved through the row and column edits since the file opened, or, for a
   * chart made in the editor, through those made after it (`origin` edits into the log).
   */
  resolve: (reference: string, origin?: number) => string;
  /** A chart's latest data: settings change it after the chart was first drawn. */
  data?: (drawingId: string) => SheetChartData | undefined;
  /** The chart's own title text, for editing it on the chart (undefined for the placeholder). */
  title?: (drawingId: string) => string | undefined;
  /** Retitle a chart as one undoable step (an empty text deletes the title); absent when read-only. */
  setTitle?: (drawingId: string, text: string) => void;
}

/** Univer's float DOM component key for charts drawn over the grid. */
export const SHEET_CHART_COMPONENT = 'lobster-sheet-chart';
const MAX_POINTS = 10_000;
const hosts = new Map<string, ChartHost>();

export function registerChartHost(unitId: string, host: ChartHost): () => void {
  hosts.set(unitId, host);
  return () => { if (hosts.get(unitId) === host) hosts.delete(unitId); };
}

export const chartHost = (unitId: string): ChartHost | undefined => hosts.get(unitId);

const fromCache = (source: ChartDataRef): ResolvedData => ({
  values: source.cache,
  text: source.cache.map(value => (value === null || value === undefined ? '' : String(value))),
  ...(source.formatCode ? { formatCode: source.formatCode } : {}),
  ...(source.levels?.length ? { levels: source.levels.map(level => level.map(label => label ?? '')) } : {}),
});

/** A series source read from the workbook's cells, or from the chart's cache when they cannot be read. */
export function readChartData(host: ChartHost, source: ChartDataRef | undefined, origin?: number): ResolvedData {
  if (!source) return { values: [], text: [] };
  if (!source.ref) return fromCache(source);
  const reference = host.resolve(source.ref, origin);
  if (reference.includes('#REF!')) return fromCache(source);
  const areas: { sheet: string; range: string }[] = [];
  let readable = true;
  mapFormulaReferences(reference, token => {
    const sheet = token.sheets[0];
    const area = token.reference;
    if (!sheet || token.sheets.length > 1 || token.external || !area) readable = false;
    else if (area.kind === 'cell') areas.push({ sheet, range: rangeReference({ startRow: area.cell.row, endRow: area.cell.row, startColumn: area.cell.column, endColumn: area.cell.column }) });
    else if (area.kind === 'area') areas.push({ sheet, range: rangeReference({ startRow: area.start.row, endRow: area.end.row, startColumn: area.start.column, endColumn: area.end.column }) });
    else readable = false;
    return token.text;
  });
  if (!readable || !areas.length) return fromCache(source);
  // Multi-level categories: a block of labels, split into the levels Excel draws.
  if (source.levels && areas.length === 1) {
    const sheet = host.workbook.getSheetByName(areas[0].sheet);
    if (!sheet) return fromCache(source);
    const { text, levels } = categoryLevels(sheet.getRange(areas[0].range).getDisplayValues().map(row => row.map(cell => cell ?? '')));
    return { values: text, text, ...(levels.length ? { levels } : {}) };
  }
  const values: (string | number | null)[] = [];
  const text: string[] = [];
  let formatCode = source.formatCode;
  for (const area of areas) {
    const sheet = host.workbook.getSheetByName(area.sheet);
    if (!sheet) return fromCache(source);
    const range = sheet.getRange(area.range);
    const raw = range.getRawValues();
    const display = range.getDisplayValues();
    for (let row = 0; row < raw.length && values.length < MAX_POINTS; row++) {
      for (let column = 0; column < (raw[row]?.length ?? 0) && values.length < MAX_POINTS; column++) {
        const value = raw[row][column];
        values.push(value === undefined || value === '' ? null : (value as string | number | null));
        text.push(display[row]?.[column] ?? '');
      }
    }
    if (!formatCode) {
      const code = range.getNumberFormat();
      if (code && code !== 'General') formatCode = code;
    }
  }
  return { values, text, ...(formatCode ? { formatCode } : {}) };
}
