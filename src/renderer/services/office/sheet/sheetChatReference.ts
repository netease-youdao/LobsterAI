import type { FWorkbook } from '@univerjs/sheets/facade';

import { formulaSheetName } from './sheetStructure';

/**
 * Selected cells as a chat excerpt ("Add to chat"): where they are, as a formula names them, and
 * what they show as tab-separated rows. The agent reads formulas and more with excel_read.
 */

/** Room for the rows: the chat takes 4,000 characters per excerpt, the note needs a little. */
const MAX_TEXT = 3600;
/** Longest text kept from one cell. */
const MAX_CELL = 200;
/** Rows read from the workbook at most; the text holds fewer anyway. */
const MAX_ROWS_READ = 500;

export interface SheetSelectionReference {
  /** Sheet1!B2:D8 */
  address: string;
  /** The cells as they show, one tab-separated line per row. */
  text: string;
}

export interface ReferenceLabels {
  /** The text for cells that show nothing. */
  empty: string;
  /** The line after rows left out; {count} is how many. */
  moreRows: string;
}

function cellText(value: string): string {
  const flat = value.replace(/[\t\r\n]+/g, ' ').trim();
  return flat.length > MAX_CELL ? `${flat.slice(0, MAX_CELL - 1)}…` : flat;
}

/**
 * Tab-separated rows of what cells show. Empty rows and columns after the last content are left
 * out (the excerpt still starts at the selection's first cell); long selections stop at a whole
 * row, followed by a line saying how many rows of `totalRows` were left out.
 */
export function cellsText(rows: readonly (readonly string[])[], labels: ReferenceLabels, totalRows = rows.length, maxChars = MAX_TEXT): string {
  const cells = rows.map(row => row.map(cellText));
  const width = Math.max(0, ...cells.map(row => {
    let end = row.length;
    while (end > 0 && !row[end - 1]) end--;
    return end;
  }));
  let height = cells.length;
  while (height > 0 && !cells[height - 1].some(Boolean)) height--;
  if (!width || !height) return labels.empty;
  const lines: string[] = [];
  let length = 0;
  for (let row = 0; row < height; row++) {
    let line = cells[row].slice(0, width).join('\t').replace(/\t+$/, '');
    if (lines.length && length + line.length + 1 > maxChars) {
      lines.push(labels.moreRows.replace('{count}', String(totalRows - row)));
      return lines.join('\n');
    }
    if (line.length > maxChars) line = `${line.slice(0, maxChars - 1)}…`;
    lines.push(line);
    length += line.length + 1;
  }
  if (rows.length < totalRows) lines.push(labels.moreRows.replace('{count}', String(totalRows - rows.length)));
  return lines.join('\n');
}

/** The active sheet's selected range as an excerpt; whole rows and columns are read up to their last content. */
export function selectionReference(workbook: FWorkbook, labels: ReferenceLabels): SheetSelectionReference | undefined {
  const sheet = workbook.getActiveSheet();
  const range = workbook.getActiveRange();
  if (!range) return undefined;
  const worksheet = sheet.getSheet();
  const { startRow, startColumn, endRow, endColumn } = range.getRange();
  const lastRow = Math.min(endRow, worksheet.getLastRowWithContent());
  const lastColumn = Math.min(endColumn, worksheet.getLastColumnWithContent());
  const totalRows = Math.max(0, lastRow - startRow + 1);
  const readRows = Math.min(totalRows, MAX_ROWS_READ);
  const rows = readRows > 0 && lastColumn >= startColumn
    ? sheet.getRange(startRow, startColumn, readRows, lastColumn - startColumn + 1).getDisplayValues()
    : [];
  return {
    address: `${formulaSheetName(sheet.getSheetName())}!${range.getA1Notation()}`,
    text: cellsText(rows, labels, totalRows),
  };
}
