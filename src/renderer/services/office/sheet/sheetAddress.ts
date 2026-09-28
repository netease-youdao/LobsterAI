/** A1-style cell and range references, zero-based internally. */

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLUMNS = 16_384;

export interface CellAddress {
  row: number;
  column: number;
}

export interface CellRange {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export function columnLabel(column: number): string {
  let label = '';
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

/** Zero-based column of a label such as `AB`, or -1. */
export function columnIndex(label: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(label)) return -1;
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1 < EXCEL_MAX_COLUMNS ? value - 1 : -1;
}

export function cellReference(row: number, column: number): string {
  return `${columnLabel(column)}${row + 1}`;
}

/** Parse `B7` or `$B$7`. */
export function parseCellReference(reference: string): CellAddress | undefined {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(reference.trim());
  if (!match) return undefined;
  const column = columnIndex(match[1]);
  const row = Number(match[2]) - 1;
  if (column < 0 || row < 0 || row >= EXCEL_MAX_ROWS) return undefined;
  return { row, column };
}

/** Parse `A1`, `A1:C3`, whole columns `B:D` or whole rows `2:5`. */
export function parseRangeReference(reference: string): CellRange | undefined {
  const [first, second = first, ...rest] = reference.trim().split(':');
  if (rest.length || !first) return undefined;
  const start = parseCellReference(first);
  const end = parseCellReference(second);
  if (start && end) return normalizeRange({ startRow: start.row, startColumn: start.column, endRow: end.row, endColumn: end.column });
  const columns = [first, second].map(part => columnIndex(part.replace(/\$/g, '')));
  if (columns.every(column => column >= 0) && reference.includes(':')) {
    return normalizeRange({ startRow: 0, startColumn: columns[0], endRow: EXCEL_MAX_ROWS - 1, endColumn: columns[1] });
  }
  const rows = [first, second].map(part => (/^\$?\d{1,7}$/.test(part) ? Number(part.replace('$', '')) - 1 : -1));
  if (rows.every(row => row >= 0 && row < EXCEL_MAX_ROWS) && reference.includes(':')) {
    return normalizeRange({ startRow: rows[0], startColumn: 0, endRow: rows[1], endColumn: EXCEL_MAX_COLUMNS - 1 });
  }
  return undefined;
}

export function normalizeRange(range: CellRange): CellRange {
  return {
    startRow: Math.min(range.startRow, range.endRow),
    startColumn: Math.min(range.startColumn, range.endColumn),
    endRow: Math.max(range.startRow, range.endRow),
    endColumn: Math.max(range.startColumn, range.endColumn),
  };
}

export function rangeReference(range: CellRange): string {
  const start = cellReference(range.startRow, range.startColumn);
  const end = cellReference(range.endRow, range.endColumn);
  return start === end ? start : `${start}:${end}`;
}

export function rangeCellCount(range: CellRange): number {
  return (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1);
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startColumn <= b.endColumn && b.startColumn <= a.endColumn;
}

export function rangeContains(range: CellRange, row: number, column: number): boolean {
  return row >= range.startRow && row <= range.endRow && column >= range.startColumn && column <= range.endColumn;
}
