import { BorderStyleTypes, BorderType, type ICellData } from '@univerjs/core';
import type { FUniver } from '@univerjs/core/facade';
import type { FRange, FWorkbook, FWorksheet } from '@univerjs/sheets/facade';

import {
  SheetBorder, SheetClearTarget, SheetEditType, SheetHorizontalAlignment, SheetVerticalAlignment,
} from '../../../shared/artifactPreview/sheetAgent';
import {
  type CellRange, columnIndex, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, parseRangeReference, rangeCellCount, rangeReference,
} from './sheetAddress';

/**
 * The agent's reads and edits, expressed with Univer's facade so they run the same commands as
 * the toolbar. Every edit is validated before any is applied; the caller groups the applied
 * commands into one undo step and reverts it if applying still fails.
 */

export class SheetAgentError extends Error {}

const DEFAULT_READ_CELLS = 2000;
const MAX_READ_CELLS = 10_000;
const MAX_EDIT_CELLS = 50_000;
const MAX_TEXT = 32_767;
const PX_PER_POINT = 96 / 72;
const COLOR = /^#[\da-f]{6}$/i;
const SET_STYLE_COMMAND = 'sheet.command.set-style';
const ERROR_VALUE = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)$/;

export interface SheetAgentEdit {
  type: string;
  sheet?: string;
  range?: string;
  values?: unknown[][];
  formula?: string;
  what?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  fontColor?: string;
  fillColor?: string;
  fontFamily?: string;
  fontSize?: number;
  numberFormat?: string;
  horizontalAlignment?: string;
  verticalAlignment?: string;
  wrap?: boolean;
  border?: string;
  columns?: string | number;
  rows?: string | number;
  width?: number;
  height?: number;
  name?: string;
  position?: number;
  color?: string | null;
}

export interface SheetReadResult {
  sheets: { name: string; usedRange?: string; hidden?: true; frozen?: { rows: number; columns: number } }[];
  sheet: string;
  range?: string;
  cells: Record<string, unknown>;
  merged: string[];
  truncated?: { nextRange: string };
}

export interface SheetEditResult {
  applied: number;
  changed: string[];
  /** The first edited sheet and range, to bring into view. */
  focus?: { sheet: string; range: CellRange };
}

function usedRange(sheet: FWorksheet): CellRange | undefined {
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  return lastRow < 0 || lastColumn < 0 ? undefined : { startRow: 0, startColumn: 0, endRow: lastRow, endColumn: lastColumn };
}

function resolveSheet(workbook: FWorkbook, name: unknown): FWorksheet {
  if (name === undefined || name === null || name === '') return workbook.getActiveSheet();
  if (typeof name !== 'string') throw new SheetAgentError('"sheet" must be a sheet name.');
  const sheet = workbook.getSheetByName(name)
    ?? workbook.getSheets().find(candidate => candidate.getSheetName().toLowerCase() === name.trim().toLowerCase());
  if (!sheet) throw new SheetAgentError(`No sheet named "${name}". Sheets: ${workbook.getSheets().map(item => item.getSheetName()).join(', ')}.`);
  return sheet;
}

function parseRange(reference: unknown, field = 'range'): CellRange {
  if (typeof reference !== 'string' || !reference.trim()) throw new SheetAgentError(`"${field}" must be an A1 range such as "B2" or "A1:C10".`);
  const range = parseRangeReference(reference.replace(/^.*!/, ''));
  if (!range) throw new SheetAgentError(`"${reference}" is not an A1 range.`);
  return range;
}

function rangeOf(sheet: FWorksheet, range: CellRange): FRange {
  return sheet.getRange(range.startRow, range.startColumn, range.endRow - range.startRow + 1, range.endColumn - range.startColumn + 1);
}

/** Cells of a sheet range, keyed by address; plain values stay plain, formulas and formatted text are spelled out. */
export function readSheet(workbook: FWorkbook, options: { sheet?: unknown; range?: unknown; maxCells?: unknown }): SheetReadResult {
  const sheet = resolveSheet(workbook, options.sheet);
  const limit = Math.min(MAX_READ_CELLS, Math.max(1, typeof options.maxCells === 'number' ? Math.floor(options.maxCells) : DEFAULT_READ_CELLS));
  const sheets = workbook.getSheets().map(item => {
    const used = usedRange(item);
    const freeze = item.getFreeze();
    const frozen = freeze && (freeze.xSplit > 0 || freeze.ySplit > 0) ? { frozen: { rows: freeze.ySplit, columns: freeze.xSplit } } : {};
    return { name: item.getSheetName(), ...(used ? { usedRange: rangeReference(used) } : {}), ...(item.isSheetHidden() ? { hidden: true as const } : {}), ...frozen };
  });
  const requested = options.range === undefined ? usedRange(sheet) : parseRange(options.range);
  const result: SheetReadResult = { sheets, sheet: sheet.getSheetName(), cells: {}, merged: [] };
  if (!requested) return result;
  const bounded: CellRange = {
    ...requested,
    endRow: Math.min(requested.endRow, Math.max(requested.startRow, sheet.getMaxRows() - 1)),
    endColumn: Math.min(requested.endColumn, Math.max(requested.startColumn, sheet.getMaxColumns() - 1)),
  };
  const width = bounded.endColumn - bounded.startColumn + 1;
  const rows = Math.max(1, Math.floor(limit / width));
  const range: CellRange = { ...bounded, endRow: Math.min(bounded.endRow, bounded.startRow + rows - 1) };
  if (range.endRow < bounded.endRow) {
    result.truncated = { nextRange: rangeReference({ ...bounded, startRow: range.endRow + 1, endRow: Math.min(bounded.endRow, range.endRow + rows) }) };
  }
  result.range = rangeReference(range);
  const target = rangeOf(sheet, range);
  // Raw values: with number formats loaded, getValues() returns formatted text.
  const values = target.getRawValues();
  const formulas = target.getFormulas();
  const display = target.getDisplayValues();
  for (let row = 0; row < values.length; row++) {
    for (let column = 0; column < values[row].length; column++) {
      const value = values[row][column];
      const formula = formulas[row]?.[column];
      if ((value === null || value === undefined || value === '') && !formula) continue;
      const text = display[row]?.[column] ?? '';
      const address = rangeReference({ startRow: range.startRow + row, startColumn: range.startColumn + column, endRow: range.startRow + row, endColumn: range.startColumn + column });
      const plain = value === null || value === undefined ? '' : String(value);
      result.cells[address] = formula || (text && text !== plain)
        ? { value: value ?? null, ...(formula ? { formula } : {}), ...(text && text !== plain ? { text } : {}) }
        : value;
    }
  }
  result.merged = sheet.getMergedRanges().map(merge => merge.getRange())
    .filter(merge => merge.startRow <= range.endRow && merge.endRow >= range.startRow && merge.startColumn <= range.endColumn && merge.endColumn >= range.startColumn)
    .map(merge => rangeReference(merge));
  return result;
}

/** A value the agent sends, typed like text typed into Excel: `=` starts a formula, numbers stay numbers. */
function cellInput(value: unknown, where: string): ICellData {
  if (value === null) return { v: null, f: null, si: null, p: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SheetAgentError(`${where}: numbers must be finite.`);
    return { v: value, f: null, si: null, p: null };
  }
  if (typeof value === 'boolean') return { v: value, f: null, si: null, p: null };
  if (typeof value !== 'string') throw new SheetAgentError(`${where}: values must be strings, numbers, booleans or null.`);
  if (value.length > MAX_TEXT) throw new SheetAgentError(`${where}: text is longer than Excel's ${MAX_TEXT} character limit.`);
  if (value.startsWith('=') && value.length > 1) return { f: value, si: null, p: null };
  return { v: value, f: null, si: null, p: null };
}

function parseSpan(reference: unknown, field: 'columns' | 'rows'): { start: number; count: number } {
  if (typeof reference === 'number' && field === 'rows' && Number.isInteger(reference) && reference > 0) return { start: reference - 1, count: 1 };
  if (typeof reference !== 'string' || !reference.trim()) throw new SheetAgentError(`"${field}" must be like ${field === 'columns' ? '"B" or "B:D"' : '"3" or "3:5"'}.`);
  const [first, second = first] = reference.trim().split(':');
  const index = (part: string) => (field === 'columns' ? columnIndex(part.replace(/\$/g, '')) : /^\$?\d+$/.test(part) ? Number(part.replace('$', '')) - 1 : -1);
  const [a, b] = [index(first), index(second)];
  const max = field === 'columns' ? EXCEL_MAX_COLUMNS : EXCEL_MAX_ROWS;
  if (a < 0 || b < 0 || a >= max || b >= max) throw new SheetAgentError(`"${reference}" is not a valid ${field === 'columns' ? 'column' : 'row'} span.`);
  return { start: Math.min(a, b), count: Math.abs(b - a) + 1 };
}

const FORMAT_KEYS = ['bold', 'italic', 'underline', 'strikethrough', 'fontColor', 'fillColor', 'fontFamily', 'fontSize', 'numberFormat', 'horizontalAlignment', 'verticalAlignment', 'wrap', 'border'] as const;

interface PreparedEdit {
  label: string;
  sheet: FWorksheet;
  range?: CellRange;
  apply: () => void;
}

export interface ApplyOptions {
  mdw: number;
  /** Why the editor refused the last command, when a structural edit had no effect. */
  refusal?: () => string | undefined;
}

const INVALID_SHEET_NAME = /[:\\/?*[\]]/;
const MAX_STRUCTURE_COUNT = 10_000;

function sheetName(value: unknown, where: string, workbook: FWorkbook, except?: FWorksheet): string {
  if (typeof value !== 'string' || !value.trim()) throw new SheetAgentError(`${where}: "name" is required.`);
  const name = value.trim();
  if (name.length > 31 || INVALID_SHEET_NAME.test(name) || name.startsWith('\'') || name.endsWith('\'')) {
    throw new SheetAgentError(`${where}: sheet names have at most 31 characters, no : \\ / ? * [ ] and no leading or trailing apostrophe.`);
  }
  if (workbook.getSheets().some(sheet => sheet !== except && sheet.getSheetName().toLowerCase() === name.toLowerCase())) {
    throw new SheetAgentError(`${where}: a sheet named "${name}" already exists.`);
  }
  return name;
}

function checkEffect(done: boolean, where: string, options: ApplyOptions): void {
  if (done) return;
  const reason = options.refusal?.();
  throw new SheetAgentError(`${where} was refused${reason ? `: ${reason}` : ''}.`);
}

function prepare(workbook: FWorkbook, api: FUniver, edit: SheetAgentEdit, index: number, options: ApplyOptions): PreparedEdit {
  const where = `Edit ${index + 1} (${String(edit?.type)})`;
  if (!edit || typeof edit !== 'object') throw new SheetAgentError(`Edit ${index + 1} must be an object.`);
  const mdw = options.mdw;
  if (edit.type === SheetEditType.AddSheet) {
    const name = sheetName(edit.name, where, workbook);
    const count = workbook.getSheets().length;
    if (edit.position !== undefined && (!Number.isInteger(edit.position) || edit.position < 1 || edit.position > count + 1)) {
      throw new SheetAgentError(`${where}: "position" must be 1–${count + 1}.`);
    }
    return {
      label: name, sheet: workbook.getActiveSheet(),
      apply: () => {
        const added = workbook.insertSheet(name);
        checkEffect(Boolean(added) && added.getSheetName() === name, where, options);
        if (edit.position !== undefined) workbook.moveSheet(added, edit.position - 1);
      },
    };
  }
  const sheet = resolveSheet(workbook, edit.sheet);
  const name = sheet.getSheetName();
  const label = (range: CellRange) => `${name}!${rangeReference(range)}`;
  switch (edit.type) {
    case SheetEditType.SetValues: {
      const start = parseRange(edit.range);
      if (!Array.isArray(edit.values) || !edit.values.length || edit.values.some(row => !Array.isArray(row) || !row.length)) {
        throw new SheetAgentError(`${where}: "values" must be a non-empty 2D array.`);
      }
      const width = Math.max(...edit.values.map(row => row.length));
      if (edit.values.some(row => row.length !== width)) throw new SheetAgentError(`${where}: every row of "values" needs the same number of cells.`);
      const single = start.startRow === start.endRow && start.startColumn === start.endColumn;
      if (!single && (start.endRow - start.startRow + 1 !== edit.values.length || start.endColumn - start.startColumn + 1 !== width)) {
        throw new SheetAgentError(`${where}: "values" is ${edit.values.length}×${width} but ${rangeReference(start)} is ${start.endRow - start.startRow + 1}×${start.endColumn - start.startColumn + 1}. Pass the first cell only, or a range of the same size.`);
      }
      const range = { ...start, endRow: start.startRow + edit.values.length - 1, endColumn: start.startColumn + width - 1 };
      if (range.endRow >= EXCEL_MAX_ROWS || range.endColumn >= EXCEL_MAX_COLUMNS) throw new SheetAgentError(`${where}: the values run past the sheet's last row or column.`);
      if (rangeCellCount(range) > MAX_EDIT_CELLS) throw new SheetAgentError(`${where}: at most ${MAX_EDIT_CELLS} cells per edit.`);
      const cells = edit.values.map((row, r) => row.map((value, c) => cellInput(value, `${where} ${rangeReference({ startRow: range.startRow + r, startColumn: range.startColumn + c, endRow: range.startRow + r, endColumn: range.startColumn + c })}`)));
      return { label: label(range), sheet, range, apply: () => { rangeOf(sheet, range).setValues(cells); } };
    }
    case SheetEditType.SetFormula: {
      const range = parseRange(edit.range);
      if (typeof edit.formula !== 'string' || !edit.formula.trim()) throw new SheetAgentError(`${where}: "formula" is required.`);
      if (rangeCellCount(range) > MAX_EDIT_CELLS) throw new SheetAgentError(`${where}: at most ${MAX_EDIT_CELLS} cells per edit.`);
      const formula = edit.formula.trim().startsWith('=') ? edit.formula.trim() : `=${edit.formula.trim()}`;
      const engine = api.getFormula();
      const formulas: string[][] = [];
      for (let row = range.startRow; row <= range.endRow; row++) {
        const line: string[] = [];
        for (let column = range.startColumn; column <= range.endColumn; column++) {
          line.push(row === range.startRow && column === range.startColumn ? formula : engine.moveFormulaRefOffset(formula, column - range.startColumn, row - range.startRow));
        }
        formulas.push(line);
      }
      return { label: label(range), sheet, range, apply: () => { rangeOf(sheet, range).setFormulas(formulas); } };
    }
    case SheetEditType.Clear: {
      const range = parseRange(edit.range);
      const what = edit.what ?? SheetClearTarget.Contents;
      if (!(Object.values(SheetClearTarget) as string[]).includes(what)) throw new SheetAgentError(`${where}: "what" must be contents, formats or all.`);
      return {
        label: label(range), sheet, range,
        apply: () => {
          const target = rangeOf(sheet, range);
          if (what === SheetClearTarget.Contents) target.clearContent();
          else if (what === SheetClearTarget.Formats) target.clearFormat();
          else target.clear();
        },
      };
    }
    case SheetEditType.Format: {
      const range = parseRange(edit.range);
      if (!FORMAT_KEYS.some(key => edit[key] !== undefined)) throw new SheetAgentError(`${where}: name at least one property to format.`);
      for (const key of ['fontColor', 'fillColor'] as const) {
        if (edit[key] !== undefined && (typeof edit[key] !== 'string' || !COLOR.test(edit[key]!))) throw new SheetAgentError(`${where}: "${key}" must be a #RRGGBB color.`);
      }
      if (edit.fontSize !== undefined && (typeof edit.fontSize !== 'number' || edit.fontSize < 1 || edit.fontSize > 409)) throw new SheetAgentError(`${where}: "fontSize" must be 1–409 points.`);
      if (edit.fontFamily !== undefined && (typeof edit.fontFamily !== 'string' || !edit.fontFamily.trim() || edit.fontFamily.length > 64)) throw new SheetAgentError(`${where}: "fontFamily" must be a font name.`);
      if (edit.numberFormat !== undefined && (typeof edit.numberFormat !== 'string' || !edit.numberFormat || edit.numberFormat.length > 255)) throw new SheetAgentError(`${where}: "numberFormat" must be an Excel format code.`);
      if (edit.horizontalAlignment !== undefined && !(Object.values(SheetHorizontalAlignment) as string[]).includes(edit.horizontalAlignment)) throw new SheetAgentError(`${where}: "horizontalAlignment" must be left, center or right.`);
      if (edit.verticalAlignment !== undefined && !(Object.values(SheetVerticalAlignment) as string[]).includes(edit.verticalAlignment)) throw new SheetAgentError(`${where}: "verticalAlignment" must be top, middle or bottom.`);
      if (edit.border !== undefined && !(Object.values(SheetBorder) as string[]).includes(edit.border)) throw new SheetAgentError(`${where}: "border" must be all, outside or none.`);
      for (const key of ['bold', 'italic', 'underline', 'strikethrough', 'wrap'] as const) {
        if (edit[key] !== undefined && typeof edit[key] !== 'boolean') throw new SheetAgentError(`${where}: "${key}" must be true or false.`);
      }
      return {
        label: label(range), sheet, range,
        apply: () => {
          const target = rangeOf(sheet, range);
          if (edit.bold !== undefined) target.setFontWeight(edit.bold ? 'bold' : 'normal');
          if (edit.italic !== undefined) target.setFontStyle(edit.italic ? 'italic' : 'normal');
          // Underline and strikethrough are independent, unlike the facade's single font line.
          const decorate = (type: 'ul' | 'st', on: boolean) => api.syncExecuteCommand(SET_STYLE_COMMAND, {
            unitId: workbook.getId(), subUnitId: sheet.getSheetId(), range: target.getRange(), style: { type, value: { s: on ? 1 : 0 } },
          });
          if (edit.underline !== undefined) decorate('ul', edit.underline);
          if (edit.strikethrough !== undefined) decorate('st', edit.strikethrough);
          if (edit.fontColor) target.setFontColor(edit.fontColor);
          if (edit.fillColor) target.setBackgroundColor(edit.fillColor);
          if (edit.fontFamily) target.setFontFamily(edit.fontFamily.trim());
          if (edit.fontSize) target.setFontSize(edit.fontSize);
          if (edit.numberFormat) target.setNumberFormat(edit.numberFormat);
          // Univer's facade names right alignment 'normal'.
          if (edit.horizontalAlignment) target.setHorizontalAlignment(edit.horizontalAlignment === SheetHorizontalAlignment.Right ? 'normal' : edit.horizontalAlignment as 'left' | 'center');
          if (edit.verticalAlignment) target.setVerticalAlignment(edit.verticalAlignment as 'top' | 'middle' | 'bottom');
          if (edit.wrap !== undefined) target.setWrap(edit.wrap);
          if (edit.border === SheetBorder.All) target.setBorder(BorderType.ALL, BorderStyleTypes.THIN, '#000000');
          if (edit.border === SheetBorder.Outside) target.setBorder(BorderType.OUTSIDE, BorderStyleTypes.THIN, '#000000');
          if (edit.border === SheetBorder.None) target.setBorder(BorderType.NONE, BorderStyleTypes.THIN);
        },
      };
    }
    case SheetEditType.SetColumnWidth: {
      const span = parseSpan(edit.columns, 'columns');
      if (typeof edit.width !== 'number' || !(edit.width > 0) || edit.width > 255) throw new SheetAgentError(`${where}: "width" must be 0–255 characters.`);
      // Excel's column width counts characters of the default font plus 5 pixels of padding.
      const pixels = Math.round(edit.width * mdw + 5);
      const range = { startRow: 0, startColumn: span.start, endRow: 0, endColumn: span.start + span.count - 1 };
      return { label: `${name}!${rangeReference(range).replace(/\d+/g, '')}`, sheet, apply: () => { sheet.setColumnWidths(span.start, span.count, pixels); } };
    }
    case SheetEditType.SetRowHeight: {
      const span = parseSpan(edit.rows, 'rows');
      if (typeof edit.height !== 'number' || !(edit.height > 0) || edit.height > 409) throw new SheetAgentError(`${where}: "height" must be 0–409 points.`);
      const pixels = Math.round(edit.height * PX_PER_POINT);
      return { label: `${name}!${span.start + 1}:${span.start + span.count}`, sheet, apply: () => { sheet.setRowHeights(span.start, span.count, pixels); } };
    }
    case SheetEditType.Merge:
    case SheetEditType.Unmerge: {
      const range = parseRange(edit.range);
      if (edit.type === SheetEditType.Merge && rangeCellCount(range) < 2) throw new SheetAgentError(`${where}: merge needs at least two cells.`);
      return {
        label: label(range), sheet, range,
        apply: () => {
          const target = rangeOf(sheet, range);
          if (edit.type === SheetEditType.Merge) target.merge();
          else target.breakApart();
        },
      };
    }
    case SheetEditType.InsertRows:
    case SheetEditType.DeleteRows: {
      const span = parseSpan(edit.rows, 'rows');
      if (span.count > MAX_STRUCTURE_COUNT) throw new SheetAgentError(`${where}: at most ${MAX_STRUCTURE_COUNT} rows per edit.`);
      const insert = edit.type === SheetEditType.InsertRows;
      const range = { startRow: span.start, endRow: span.start + span.count - 1, startColumn: 0, endColumn: 0 };
      return {
        label: `${name}!${span.start + 1}:${span.start + span.count}`, sheet, range,
        apply: () => {
          const before = sheet.getMaxRows();
          if (insert) sheet.insertRowsBefore(span.start, span.count);
          else sheet.deleteRows(span.start, span.count);
          checkEffect(sheet.getMaxRows() !== before, where, options);
        },
      };
    }
    case SheetEditType.InsertColumns:
    case SheetEditType.DeleteColumns: {
      const span = parseSpan(edit.columns, 'columns');
      if (span.count > MAX_STRUCTURE_COUNT) throw new SheetAgentError(`${where}: at most ${MAX_STRUCTURE_COUNT} columns per edit.`);
      const insert = edit.type === SheetEditType.InsertColumns;
      const range = { startRow: 0, endRow: 0, startColumn: span.start, endColumn: span.start + span.count - 1 };
      return {
        label: `${name}!${rangeReference(range).replace(/\d+/g, '')}`, sheet, range,
        apply: () => {
          const before = sheet.getMaxColumns();
          if (insert) sheet.insertColumnsBefore(span.start, span.count);
          else sheet.deleteColumns(span.start, span.count);
          checkEffect(sheet.getMaxColumns() !== before, where, options);
        },
      };
    }
    case SheetEditType.RenameSheet: {
      const next = sheetName(edit.name, where, workbook, sheet);
      return { label: next, sheet, apply: () => { sheet.setName(next); checkEffect(sheet.getSheetName() === next, where, options); } };
    }
    case SheetEditType.DeleteSheet: {
      if (workbook.getSheets().filter(item => !item.isSheetHidden() && item.getSheetId() !== sheet.getSheetId()).length === 0) {
        throw new SheetAgentError(`${where}: a workbook keeps at least one visible sheet.`);
      }
      return { label: name, sheet, apply: () => { checkEffect(workbook.deleteSheet(sheet), where, options); } };
    }
    case SheetEditType.MoveSheet: {
      const count = workbook.getSheets().length;
      if (!Number.isInteger(edit.position) || edit.position! < 1 || edit.position! > count) throw new SheetAgentError(`${where}: "position" must be 1–${count}.`);
      return {
        label: name, sheet,
        apply: () => {
          workbook.moveSheet(sheet, edit.position! - 1);
          checkEffect(workbook.getSheets().findIndex(item => item.getSheetId() === sheet.getSheetId()) === edit.position! - 1, where, options);
        },
      };
    }
    case SheetEditType.HideSheet:
    case SheetEditType.ShowSheet: {
      const hide = edit.type === SheetEditType.HideSheet;
      if (hide && workbook.getSheets().filter(item => !item.isSheetHidden() && item.getSheetId() !== sheet.getSheetId()).length === 0) {
        throw new SheetAgentError(`${where}: a workbook keeps at least one visible sheet.`);
      }
      return {
        label: name, sheet,
        apply: () => {
          if (hide) sheet.hideSheet();
          else sheet.showSheet();
          checkEffect(sheet.isSheetHidden() === hide, where, options);
        },
      };
    }
    case SheetEditType.Freeze: {
      const count = (value: unknown, field: string) => {
        if (value === undefined) return undefined;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) throw new SheetAgentError(`${where}: "${field}" must be a whole number of ${field} (0 unfreezes).`);
        return value;
      };
      const rows = count(edit.rows, 'rows');
      const columns = count(edit.columns, 'columns');
      if (rows === undefined && columns === undefined) throw new SheetAgentError(`${where}: name "rows", "columns" or both.`);
      return {
        label: name, sheet,
        apply: () => {
          const current = sheet.getFreeze();
          const ySplit = rows ?? current?.ySplit ?? 0;
          const xSplit = columns ?? current?.xSplit ?? 0;
          if (!ySplit && !xSplit) sheet.cancelFreeze();
          else sheet.setFreeze({ xSplit, ySplit, startRow: ySplit, startColumn: xSplit });
          const after = sheet.getFreeze();
          checkEffect((after?.ySplit ?? 0) === ySplit && (after?.xSplit ?? 0) === xSplit, where, options);
        },
      };
    }
    case SheetEditType.SetTabColor: {
      if (edit.color !== null && (typeof edit.color !== 'string' || !COLOR.test(edit.color))) throw new SheetAgentError(`${where}: "color" must be #RRGGBB or null.`);
      return { label: name, sheet, apply: () => { sheet.setTabColor(edit.color ?? ''); } };
    }
    default:
      throw new SheetAgentError(`Edit ${index + 1}: unknown type "${String(edit.type)}". Use one of ${Object.values(SheetEditType).join(', ')}.`);
  }
}

/** Validate every edit, then apply them in order. Throws before changing anything when an edit is invalid. */
export function applySheetEdits(workbook: FWorkbook, api: FUniver, edits: unknown, options: ApplyOptions): SheetEditResult {
  if (!Array.isArray(edits) || !edits.length) throw new SheetAgentError('"edits" must be a non-empty list.');
  if (edits.length > 200) throw new SheetAgentError('At most 200 edits per call.');
  // Structural edits change the addresses and sheets later edits name, so those are validated
  // when they run; everything else is validated before anything changes.
  const structural = new Set<string>([
    SheetEditType.InsertRows, SheetEditType.DeleteRows, SheetEditType.InsertColumns, SheetEditType.DeleteColumns, SheetEditType.AddSheet,
    SheetEditType.RenameSheet, SheetEditType.DeleteSheet, SheetEditType.MoveSheet,
  ]);
  const list = edits as SheetAgentEdit[];
  const firstStructural = list.findIndex(edit => structural.has(edit?.type));
  const upfront = (firstStructural < 0 ? list : list.slice(0, firstStructural + 1)).map((edit, index) => prepare(workbook, api, edit, index, options));
  const prepared: PreparedEdit[] = [];
  list.forEach((edit, index) => {
    const ready = index < upfront.length ? upfront[index] : prepare(workbook, api, edit, index, options);
    ready.apply();
    prepared.push(ready);
  });
  const first = prepared.find(edit => edit.range);
  return {
    applied: prepared.length,
    changed: prepared.map(edit => edit.label),
    ...(first?.range ? { focus: { sheet: first.sheet.getSheetName(), range: first.range } } : {}),
  };
}

/** Formula cells in the edited ranges whose result is an error, so the agent can fix them. */
export function formulaErrors(workbook: FWorkbook, changed: string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const label of changed) {
    const separator = label.lastIndexOf('!');
    const sheet = workbook.getSheetByName(label.slice(0, separator));
    const range = parseRangeReference(label.slice(separator + 1));
    if (!sheet || !range || rangeCellCount(range) > MAX_READ_CELLS) continue;
    const target = rangeOf(sheet, range);
    const values = target.getRawValues();
    const formulas = target.getFormulas();
    values.forEach((row, r) => row.forEach((value, c) => {
      if (formulas[r]?.[c] && typeof value === 'string' && ERROR_VALUE.test(value)) {
        errors[`${sheet.getSheetName()}!${rangeReference({ startRow: range.startRow + r, startColumn: range.startColumn + c, endRow: range.startRow + r, endColumn: range.startColumn + c })}`] = value;
      }
    }));
  }
  return errors;
}
