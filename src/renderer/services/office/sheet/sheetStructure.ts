import { type CellRange, columnIndex, columnLabel, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS } from './sheetAddress';

/**
 * Row and column insertions and deletions, and what they do to references. Excel keeps every
 * reference pointing at the same cells when rows or columns move: cells below an insertion shift
 * down, ranges that span it grow, references into deleted cells become #REF!. The .xlsx writer
 * applies the same rules to every part of the file that names cells, so a workbook edited here
 * opens in Excel with its charts, conditional formats and names still aimed at the right data.
 */

export const StructureAxis = { Rows: 'rows', Columns: 'columns' } as const;
export type StructureAxis = typeof StructureAxis[keyof typeof StructureAxis];

export const StructureAction = { Insert: 'insert', Remove: 'remove' } as const;
export type StructureAction = typeof StructureAction[keyof typeof StructureAction];

/** One insertion or deletion of whole rows or columns, in the coordinates of the moment it ran. */
export interface StructureOp {
  sheetId: string;
  axis: StructureAxis;
  action: StructureAction;
  index: number;
  count: number;
}

export interface AxisOp {
  action: StructureAction;
  index: number;
  count: number;
}

/** Maps original row (or column) indexes to where they are after a sequence of insertions and deletions. */
export class AxisMap {
  constructor(readonly ops: readonly AxisOp[], readonly size: number) {}

  get identity(): boolean {
    return this.ops.length === 0;
  }

  /** Where one original index is now, or null when it was deleted or pushed off the sheet. */
  index(value: number): number | null {
    let current = value;
    for (const op of this.ops) {
      if (op.action === StructureAction.Insert) {
        if (current >= op.index) current += op.count;
      } else if (current >= op.index + op.count) {
        current -= op.count;
      } else if (current >= op.index) {
        return null;
      }
      if (current >= this.size) return null;
    }
    return current;
  }

  /**
   * Where an original index is now, or the first surviving position after it when it was
   * deleted: how a floating object anchored to a deleted row settles on the next one.
   */
  settle(value: number): number {
    let current = value;
    for (const op of this.ops) {
      if (op.action === StructureAction.Insert) {
        if (current >= op.index) current += op.count;
      } else if (current >= op.index + op.count) {
        current -= op.count;
      } else if (current >= op.index) {
        current = op.index;
      }
    }
    return Math.min(current, this.size - 1);
  }

  /** Excel's rule for a range: it grows around insertions inside it and shrinks around deletions. */
  range(start: number, end: number): [number, number] | null {
    let first = Math.min(start, end);
    let last = Math.max(start, end);
    for (const op of this.ops) {
      if (op.action === StructureAction.Insert) {
        if (op.index <= first) {
          first += op.count;
          last += op.count;
        } else if (op.index <= last) {
          last += op.count;
        }
      } else {
        const opEnd = op.index + op.count - 1;
        if (opEnd < first) {
          first -= op.count;
          last -= op.count;
        } else if (op.index <= last) {
          const nextFirst = first < op.index ? first : op.index;
          const nextLast = last > opEnd ? last - op.count : op.index - 1;
          if (nextFirst > nextLast) return null;
          first = nextFirst;
          last = nextLast;
        }
      }
      if (first >= this.size) return null;
      last = Math.min(last, this.size - 1);
    }
    return [first, last];
  }

  /** The original index now at `value`, or null for an inserted position. */
  inverse(value: number): number | null {
    let current = value;
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const op = this.ops[i];
      if (op.action === StructureAction.Insert) {
        if (current >= op.index + op.count) current -= op.count;
        else if (current >= op.index) return null;
      } else if (current >= op.index) {
        current += op.count;
      }
    }
    return current;
  }
}

export const IDENTITY_ROWS = new AxisMap([], EXCEL_MAX_ROWS);
export const IDENTITY_COLUMNS = new AxisMap([], EXCEL_MAX_COLUMNS);

export interface SheetMaps {
  rows: AxisMap;
  columns: AxisMap;
}

export function sheetMaps(ops: readonly StructureOp[], sheetId: string): SheetMaps {
  const rows: AxisOp[] = [];
  const columns: AxisOp[] = [];
  for (const op of ops) {
    if (op.sheetId !== sheetId) continue;
    (op.axis === StructureAxis.Rows ? rows : columns).push({ action: op.action, index: op.index, count: op.count });
  }
  return {
    rows: rows.length ? new AxisMap(rows, EXCEL_MAX_ROWS) : IDENTITY_ROWS,
    columns: columns.length ? new AxisMap(columns, EXCEL_MAX_COLUMNS) : IDENTITY_COLUMNS,
  };
}

export const isIdentity = (maps: SheetMaps): boolean => maps.rows.identity && maps.columns.identity;

export function mapCell(maps: SheetMaps, row: number, column: number): { row: number; column: number } | null {
  const r = maps.rows.index(row);
  const c = maps.columns.index(column);
  return r === null || c === null ? null : { row: r, column: c };
}

export function mapRange(maps: SheetMaps, range: CellRange): CellRange | null {
  const rows = range.startRow === 0 && range.endRow === EXCEL_MAX_ROWS - 1 ? [0, EXCEL_MAX_ROWS - 1] as const : maps.rows.range(range.startRow, range.endRow);
  const columns = range.startColumn === 0 && range.endColumn === EXCEL_MAX_COLUMNS - 1 ? [0, EXCEL_MAX_COLUMNS - 1] as const : maps.columns.range(range.startColumn, range.endColumn);
  if (!rows || !columns) return null;
  return { startRow: rows[0], endRow: rows[1], startColumn: columns[0], endColumn: columns[1] };
}

// ---------------------------------------------------------------------------------------------
// Sheet names in formulas

const PLAIN_SHEET_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u;
const LOOKS_LIKE_REFERENCE = /^(?:[A-Za-z]{1,3}\d+|[Rr]\d*(?:[Cc]\d*)?|[Cc]\d*|true|false)$/i;

/** A sheet name as a formula prefix: quoted unless Excel would read it bare. */
export function formulaSheetName(name: string): string {
  return PLAIN_SHEET_NAME.test(name) && !LOOKS_LIKE_REFERENCE.test(name) ? name : `'${name.replace(/'/g, '\'\'')}'`;
}

// ---------------------------------------------------------------------------------------------
// Formula references

/** What became of a sheet a formula names. */
export interface SheetFate {
  /** Its current name, or null when it was deleted. */
  name: string | null;
  renamed: boolean;
  maps: SheetMaps;
}

export interface FormulaScope {
  /** Original name of the sheet unqualified references belong to; undefined leaves them alone. */
  homeSheet?: string;
  /** The fate of a sheet by its original name, or undefined for a name the workbook does not know. */
  sheet(name: string): SheetFate | undefined;
}

interface ParsedCellPart {
  columnAbsolute: boolean;
  column: number;
  rowAbsolute: boolean;
  row: number;
}

/** A reference found in formula text, before any sheet qualification is applied. */
export type FormulaReference =
  | { kind: 'cell'; cell: ParsedCellPart }
  | { kind: 'area'; start: ParsedCellPart; end: ParsedCellPart }
  | { kind: 'columns'; start: { absolute: boolean; index: number }; end: { absolute: boolean; index: number } }
  | { kind: 'rows'; start: { absolute: boolean; index: number }; end: { absolute: boolean; index: number } };

export interface ReferenceToken {
  /** Sheet names from the prefix (two for a 3-D reference); none for an unqualified reference. */
  sheets: string[];
  /** The prefix exactly as written, including `!`, or ''. */
  prefix: string;
  external: boolean;
  /** Undefined for a sheet-qualified defined name such as `Sheet1!Rate`. */
  reference?: FormulaReference;
  text: string;
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_.\\?]/u;
const PREFIX = /(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*)(?::([\p{L}_][\p{L}\p{N}_.]*))?)!/uy;
const AFTER = '(?![\\p{L}\\p{N}_.\\\\(\\[!$])';
const CELL_PART = '(\\$?)([A-Za-z]{1,3})(\\$?)(\\d{1,7})';
const AREA = new RegExp(`${CELL_PART}(?::${CELL_PART})?${AFTER}`, 'uy');
const COLUMNS = new RegExp(`(\\$?)([A-Za-z]{1,3}):(\\$?)([A-Za-z]{1,3})${AFTER}`, 'uy');
const ROWS = new RegExp(`(\\$?)(\\d{1,7}):(\\$?)(\\d{1,7})(?![\\p{L}\\p{N}_.\\\\(\\[!$:])`, 'uy');

function cellPart(dollarColumn: string, label: string, dollarRow: string, digits: string): ParsedCellPart | undefined {
  const column = columnIndex(label);
  const row = Number(digits) - 1;
  if (column < 0 || row < 0 || row >= EXCEL_MAX_ROWS) return undefined;
  return { columnAbsolute: dollarColumn === '$', column, rowAbsolute: dollarRow === '$', row };
}

function matchReferenceBody(text: string, at: number): { reference: FormulaReference; end: number } | undefined {
  AREA.lastIndex = at;
  const area = AREA.exec(text);
  if (area) {
    const start = cellPart(area[1], area[2], area[3], area[4]);
    if (start) {
      if (area[6] === undefined) return { reference: { kind: 'cell', cell: start }, end: AREA.lastIndex };
      const end = cellPart(area[5], area[6], area[7], area[8]);
      if (end) return { reference: { kind: 'area', start, end }, end: AREA.lastIndex };
    }
  }
  COLUMNS.lastIndex = at;
  const columns = COLUMNS.exec(text);
  if (columns) {
    const first = columnIndex(columns[2]);
    const last = columnIndex(columns[4]);
    if (first >= 0 && last >= 0) {
      return {
        reference: { kind: 'columns', start: { absolute: columns[1] === '$', index: first }, end: { absolute: columns[3] === '$', index: last } },
        end: COLUMNS.lastIndex,
      };
    }
  }
  ROWS.lastIndex = at;
  const rows = ROWS.exec(text);
  if (rows) {
    const first = Number(rows[2]) - 1;
    const last = Number(rows[4]) - 1;
    if (first >= 0 && last >= 0 && first < EXCEL_MAX_ROWS && last < EXCEL_MAX_ROWS) {
      return {
        reference: { kind: 'rows', start: { absolute: rows[1] === '$', index: first }, end: { absolute: rows[3] === '$', index: last } },
        end: ROWS.lastIndex,
      };
    }
  }
  return undefined;
}

/** A reference, or a sheet-qualified name, starting at `at`. */
function matchReference(text: string, at: number): (ReferenceToken & { end: number }) | undefined {
  PREFIX.lastIndex = at;
  const prefix = PREFIX.exec(text);
  let sheets: string[] = [];
  let external = false;
  let bodyStart = at;
  if (prefix) {
    bodyStart = PREFIX.lastIndex;
    if (prefix[1] !== undefined) {
      const name = prefix[1].replace(/''/g, '\'');
      if (name.includes('[')) external = true;
      else sheets = name.includes(':') ? name.split(':') : [name];
    } else {
      sheets = prefix[3] !== undefined ? [prefix[2], prefix[3]] : [prefix[2]];
    }
  }
  const body = matchReferenceBody(text, bodyStart);
  if (!body) {
    if (!prefix) return undefined;
    return { sheets, prefix: prefix[0], external, text: prefix[0], end: bodyStart };
  }
  return { sheets, prefix: prefix?.[0] ?? '', external, reference: body.reference, text: text.slice(at, body.end), end: body.end };
}

function skipQuoted(text: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) { index += 2; continue; }
      return index + 1;
    }
    index++;
  }
  return text.length;
}

/** Past a structured reference's brackets, which nest and escape with `'`. */
function skipBrackets(text: string, at: number): number {
  let depth = 0;
  for (let index = at; index < text.length; index++) {
    const char = text[index];
    if (char === '\'') { index++; continue; }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return index + 1;
  }
  return text.length;
}

function skipArray(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === '"') index = skipQuoted(text, index, '"') - 1;
    else if (text[index] === '}') return index + 1;
  }
  return text.length;
}

const ERROR_LITERAL = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER = /[\p{L}\p{N}_.\\?$]+/uy;

/**
 * Walk formula text and let `replace` rewrite each cell reference (and each sheet-qualified
 * name's prefix). Strings, structured references, external references and array constants
 * are copied untouched. Returns the input string itself when nothing changed.
 */
export function mapFormulaReferences(formula: string, replace: (token: ReferenceToken) => string): string {
  let result = '';
  let changed = false;
  let index = 0;
  const copyTo = (end: number) => {
    result += formula.slice(index, end);
    index = end;
  };
  while (index < formula.length) {
    const char = formula[index];
    const previous = index > 0 ? formula[index - 1] : '';
    if (char === '"') { copyTo(skipQuoted(formula, index, '"')); continue; }
    if (char === '{') { copyTo(skipArray(formula, index)); continue; }
    if (char === '#') {
      ERROR_LITERAL.lastIndex = index;
      if (ERROR_LITERAL.exec(formula)) {
        let end = ERROR_LITERAL.lastIndex;
        // `#REF!A1`: a reference into a deleted sheet stays with its error.
        if (formula.slice(index, end) === '#REF!') {
          const body = matchReferenceBody(formula, end);
          if (body) end = body.end;
        }
        copyTo(end);
      } else {
        copyTo(index + 1);
      }
      continue;
    }
    if (char === '[') {
      let end = skipBrackets(formula, index);
      // `[1]Sheet1!A1` and `[1]!Name` point into another workbook.
      if (/^\[\d+\]$/.test(formula.slice(index, end))) {
        PREFIX.lastIndex = end;
        if (PREFIX.exec(formula)) end = PREFIX.lastIndex;
        else if (formula[end] === '!') end++;
        const body = matchReferenceBody(formula, end);
        if (body) end = body.end;
        else {
          IDENTIFIER.lastIndex = end;
          if (IDENTIFIER.exec(formula)) end = IDENTIFIER.lastIndex;
        }
      }
      copyTo(end);
      continue;
    }
    const startsToken = char === '\'' || char === '$' || IDENTIFIER_CHAR.test(char);
    if (startsToken && !(previous && (IDENTIFIER_CHAR.test(previous) || previous === '$' || previous === ']'))) {
      const token = matchReference(formula, index);
      if (token) {
        const replacement = replace(token);
        if (replacement !== token.text) changed = true;
        result += replacement;
        index = token.end;
        continue;
      }
      if (char === '\'') { copyTo(skipQuoted(formula, index, '\'')); continue; }
      NUMBER.lastIndex = index;
      if (/[\d.]/.test(char) && NUMBER.exec(formula)) { copyTo(NUMBER.lastIndex); continue; }
      IDENTIFIER.lastIndex = index;
      if (IDENTIFIER.exec(formula)) {
        let end = IDENTIFIER.lastIndex;
        if (formula[end] === '[') end = skipBrackets(formula, end);
        copyTo(end);
        continue;
      }
    }
    copyTo(index + 1);
  }
  return changed ? result : formula;
}

const cellText = (part: ParsedCellPart): string => `${part.columnAbsolute ? '$' : ''}${columnLabel(part.column)}${part.rowAbsolute ? '$' : ''}${part.row + 1}`;

export function referenceText(reference: FormulaReference): string {
  switch (reference.kind) {
    case 'cell': return cellText(reference.cell);
    case 'area': return `${cellText(reference.start)}:${cellText(reference.end)}`;
    case 'columns': return `${reference.start.absolute ? '$' : ''}${columnLabel(reference.start.index)}:${reference.end.absolute ? '$' : ''}${columnLabel(reference.end.index)}`;
    case 'rows': return `${reference.start.absolute ? '$' : ''}${reference.start.index + 1}:${reference.end.absolute ? '$' : ''}${reference.end.index + 1}`;
  }
}

/** A reference moved through row and column insertions and deletions, or null when it now points nowhere. */
export function mapReference(reference: FormulaReference, maps: SheetMaps): FormulaReference | null {
  switch (reference.kind) {
    case 'cell': {
      const cell = mapCell(maps, reference.cell.row, reference.cell.column);
      return cell && { kind: 'cell', cell: { ...reference.cell, row: cell.row, column: cell.column } };
    }
    case 'area': {
      const rows = maps.rows.range(reference.start.row, reference.end.row);
      const columns = maps.columns.range(reference.start.column, reference.end.column);
      if (!rows || !columns) return null;
      const [start, end] = reference.start.row <= reference.end.row ? [reference.start, reference.end] : [reference.end, reference.start];
      const [left, right] = reference.start.column <= reference.end.column ? [reference.start, reference.end] : [reference.end, reference.start];
      return {
        kind: 'area',
        start: { rowAbsolute: start.rowAbsolute, row: rows[0], columnAbsolute: left.columnAbsolute, column: columns[0] },
        end: { rowAbsolute: end.rowAbsolute, row: rows[1], columnAbsolute: right.columnAbsolute, column: columns[1] },
      };
    }
    case 'columns': {
      const full = Math.min(reference.start.index, reference.end.index) === 0 && Math.max(reference.start.index, reference.end.index) === EXCEL_MAX_COLUMNS - 1;
      const columns = full ? [0, EXCEL_MAX_COLUMNS - 1] : maps.columns.range(reference.start.index, reference.end.index);
      return columns && { kind: 'columns', start: { ...reference.start, index: columns[0] }, end: { ...reference.end, index: columns[1] } };
    }
    case 'rows': {
      const full = Math.min(reference.start.index, reference.end.index) === 0 && Math.max(reference.start.index, reference.end.index) === EXCEL_MAX_ROWS - 1;
      const rows = full ? [0, EXCEL_MAX_ROWS - 1] : maps.rows.range(reference.start.index, reference.end.index);
      return rows && { kind: 'rows', start: { ...reference.start, index: rows[0] }, end: { ...reference.end, index: rows[1] } };
    }
  }
}

const REF_ERROR = '#REF!';

/** Rewrite a formula for renamed or deleted sheets and moved rows and columns, following Excel's rules. */
const TABLE_NAME_BEFORE = /([\p{L}_\\][\p{L}\p{N}_.]*)$/u;

/**
 * Excel's `@` shorthand in structured references (`Sales[@Qty]`, `[@[Unit Price]]`, `Sales[@]`)
 * written out as files store it (`Sales[[#This Row],[Qty]]`): the formula engine reads only the
 * long form. `tableAt` names the table an unqualified reference (`[@Qty]`) belongs to.
 */
export function expandThisRowReferences(formula: string, tableAt?: () => string | undefined): string {
  if (!formula.includes('[@')) return formula;
  let result = '';
  let index = 0;
  while (index < formula.length) {
    const char = formula[index];
    if (char === '"' || char === '\'') {
      const end = skipQuoted(formula, index, char);
      result += formula.slice(index, end);
      index = end;
      continue;
    }
    if (char !== '[' || formula[index + 1] !== '@') {
      result += char;
      index++;
      continue;
    }
    let depth = 0;
    let end = index;
    for (; end < formula.length; end++) {
      if (formula[end] === '[') depth++;
      else if (formula[end] === ']' && --depth === 0) break;
    }
    if (end >= formula.length) return result + formula.slice(index);
    const inner = formula.slice(index + 2, end);
    const table = TABLE_NAME_BEFORE.test(result) ? '' : tableAt?.();
    if (table === undefined) {
      result += formula.slice(index, end + 1);
    } else {
      const columns = !inner ? '' : inner.startsWith('[') ? `,${inner}` : `,[${inner}]`;
      result += `${table}[[#This Row]${columns}]`;
    }
    index = end + 1;
  }
  return result;
}

/** Column names Excel brackets in `[@[Unit Price]]` because they hold spaces or special characters. */
const BRACKETED_COLUMN = /[\s,:.[\]#'"{}$^&*+=\-<>/\\~!@%()|;?`]/;

/**
 * The long form of same-row table references shown as Excel shows it (`Sales[[#This Row],[Qty]]`
 * → `[@Qty]` inside the Sales table, `Sales[@Qty]` elsewhere), for the formula bar and the cell
 * editor; entering the short form writes the long form again (`expandThisRowReferences`).
 */
export function shortenThisRowReferences(formula: string, table?: string): string {
  if (!/#this row/i.test(formula)) return formula;
  let result = '';
  let index = 0;
  while (index < formula.length) {
    const char = formula[index];
    if (char === '"' || char === '\'') {
      const end = skipQuoted(formula, index, char);
      result += formula.slice(index, end);
      index = end;
      continue;
    }
    if (char !== '[') {
      result += char;
      index++;
      continue;
    }
    let depth = 0;
    let end = index;
    for (; end < formula.length; end++) {
      if (formula[end] === '[') depth++;
      else if (formula[end] === ']' && --depth === 0) break;
    }
    if (end >= formula.length) return result + formula.slice(index);
    const inner = formula.slice(index + 1, end);
    const row = /^\[#this row\](?:,(.+))?$/i.exec(inner) ?? (/^#this row$/i.test(inner) ? [inner] : null);
    const name = TABLE_NAME_BEFORE.exec(result)?.[1];
    if (!row || !name) {
      result += formula.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const columns = row[1];
    const single = columns && /^\[([^\]]*)\]$/.exec(columns);
    const at = !columns ? '@' : single && !BRACKETED_COLUMN.test(single[1]) ? `@${single[1]}` : `@${columns}`;
    // Inside its own table Excel leaves the table name out, except for the whole row.
    if (columns && table && name.toLowerCase() === table.toLowerCase()) result = result.slice(0, result.length - name.length);
    result += `[${at}]`;
    index = end + 1;
  }
  return result;
}

/**
 * How references written after some edits move through the edits made since (`ops` from index
 * `from`): sheet names are the current ones, so a later rename is not followed.
 */
export function laterEditsScope(ops: readonly StructureOp[], from: number, sheets: { id: string; name: string }[]): FormulaScope {
  const later = ops.slice(Math.max(0, from));
  const byName = new Map(sheets.map(sheet => [sheet.name.toLowerCase(), { name: sheet.name, renamed: false, maps: sheetMaps(later, sheet.id) }]));
  return { sheet: name => byName.get(name.toLowerCase()) };
}

export function transformFormula(formula: string, scope: FormulaScope): string {
  return mapFormulaReferences(formula, token => {
    if (token.external) return token.text;
    if (token.sheets.length === 2) {
      // 3-D references span sheets by position; only follow renames of their end sheets.
      const fates = token.sheets.map(name => scope.sheet(name));
      if (!fates.some(fate => fate?.renamed && fate.name !== null)) return token.text;
      const names = token.sheets.map((name, i) => (fates[i]?.renamed && fates[i]!.name !== null ? fates[i]!.name! : name));
      const joined = names.join(':');
      const prefix = names.some(name => formulaSheetName(name) !== name) ? `'${joined.replace(/'/g, '\'\'')}'!` : `${joined}!`;
      return `${prefix}${token.text.slice(token.prefix.length)}`;
    }
    const sheetName = token.sheets[0] ?? scope.homeSheet;
    if (sheetName === undefined) return token.text;
    const fate = scope.sheet(sheetName);
    if (!fate) return token.text;
    if (fate.name === null) return REF_ERROR;
    const prefix = token.prefix && fate.renamed ? `${formulaSheetName(fate.name)}!` : token.prefix;
    if (!token.reference) return prefix;
    const mapped = mapReference(token.reference, fate.maps);
    if (!mapped) return `${prefix}${REF_ERROR}`;
    const body = token.text.slice(token.prefix.length);
    const text = referenceText(mapped);
    return `${prefix}${text === referenceText(token.reference) ? body : text}`;
  });
}

/** Shift the relative parts of every reference by a row and column offset, as copying a formula does. */
export function offsetFormula(formula: string, rowOffset: number, columnOffset: number): string {
  if (!rowOffset && !columnOffset) return formula;
  return mapFormulaReferences(formula, token => {
    if (token.external || !token.reference) return token.text;
    const reference = token.reference;
    const shiftCell = (part: ParsedCellPart): ParsedCellPart | null => {
      const row = part.rowAbsolute ? part.row : part.row + rowOffset;
      const column = part.columnAbsolute ? part.column : part.column + columnOffset;
      return row < 0 || column < 0 || row >= EXCEL_MAX_ROWS || column >= EXCEL_MAX_COLUMNS ? null : { ...part, row, column };
    };
    let shifted: FormulaReference | null;
    switch (reference.kind) {
      case 'cell': { const cell = shiftCell(reference.cell); shifted = cell && { kind: 'cell', cell }; break; }
      case 'area': {
        const start = shiftCell(reference.start);
        const end = shiftCell(reference.end);
        shifted = start && end && { kind: 'area', start, end };
        break;
      }
      case 'columns': {
        const start = reference.start.absolute ? reference.start.index : reference.start.index + columnOffset;
        const end = reference.end.absolute ? reference.end.index : reference.end.index + columnOffset;
        shifted = start < 0 || end < 0 || start >= EXCEL_MAX_COLUMNS || end >= EXCEL_MAX_COLUMNS ? null
          : { kind: 'columns', start: { ...reference.start, index: start }, end: { ...reference.end, index: end } };
        break;
      }
      case 'rows': {
        const start = reference.start.absolute ? reference.start.index : reference.start.index + rowOffset;
        const end = reference.end.absolute ? reference.end.index : reference.end.index + rowOffset;
        shifted = start < 0 || end < 0 || start >= EXCEL_MAX_ROWS || end >= EXCEL_MAX_ROWS ? null
          : { kind: 'rows', start: { ...reference.start, index: start }, end: { ...reference.end, index: end } };
        break;
      }
    }
    return `${token.prefix}${shifted ? referenceText(shifted) : REF_ERROR}`;
  });
}

/** Whether any reference in the formula spans sheets (`Sheet1:Sheet3!A1`). */
export function hasThreeDimensionalReference(formula: string): boolean {
  let found = false;
  mapFormulaReferences(formula, token => {
    if (token.sheets.length === 2) found = true;
    return token.text;
  });
  return found;
}

/** Sheet names (as written) that a formula references explicitly. */
export function referencedSheets(formula: string): string[] {
  const names = new Set<string>();
  mapFormulaReferences(formula, token => {
    for (const name of token.sheets) names.add(name);
    return token.text;
  });
  return [...names];
}

// ---------------------------------------------------------------------------------------------
// Anchored formulas and reference lists

/** Top-left corner of a list of ranges, the cell relative references in CF and DV rules are written for. */
export function topLeft(ranges: CellRange[]): { row: number; column: number } | undefined {
  if (!ranges.length) return undefined;
  return { row: Math.min(...ranges.map(range => range.startRow)), column: Math.min(...ranges.map(range => range.startColumn)) };
}

/**
 * A rule formula that Excel evaluates relative to the top-left cell of its ranges. When that
 * corner moves because the rows or columns under it were deleted, the formula is rebased on the
 * new corner before its references follow the edit.
 */
export function transformAnchoredFormula(formula: string, scope: FormulaScope, maps: SheetMaps, before: CellRange[], after: CellRange[]): string {
  const oldAnchor = topLeft(before);
  const newAnchor = topLeft(after);
  let text = formula;
  if (oldAnchor && newAnchor) {
    const row = maps.rows.inverse(newAnchor.row);
    const column = maps.columns.inverse(newAnchor.column);
    if (row !== null && column !== null && (row !== oldAnchor.row || column !== oldAnchor.column)) {
      text = offsetFormula(text, row - oldAnchor.row, column - oldAnchor.column);
    }
  }
  return transformFormula(text, scope);
}

/** Parse a space-separated list of A1 ranges (`sqref`). */
export function parseSqref(text: string): CellRange[] {
  const ranges: CellRange[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (!part) continue;
    const token = matchReferenceBody(part.replace(/\$/g, ''), 0);
    if (!token || token.end !== part.replace(/\$/g, '').length) continue;
    const reference = token.reference;
    if (reference.kind === 'cell') ranges.push({ startRow: reference.cell.row, endRow: reference.cell.row, startColumn: reference.cell.column, endColumn: reference.cell.column });
    else if (reference.kind === 'area') ranges.push({
      startRow: Math.min(reference.start.row, reference.end.row), endRow: Math.max(reference.start.row, reference.end.row),
      startColumn: Math.min(reference.start.column, reference.end.column), endColumn: Math.max(reference.start.column, reference.end.column),
    });
    else if (reference.kind === 'columns') ranges.push({ startRow: 0, endRow: EXCEL_MAX_ROWS - 1, startColumn: Math.min(reference.start.index, reference.end.index), endColumn: Math.max(reference.start.index, reference.end.index) });
    else ranges.push({ startRow: Math.min(reference.start.index, reference.end.index), endRow: Math.max(reference.start.index, reference.end.index), startColumn: 0, endColumn: EXCEL_MAX_COLUMNS - 1 });
  }
  return ranges;
}

export function sqrefText(ranges: CellRange[]): string {
  return ranges.map(range => {
    const start = `${columnLabel(range.startColumn)}${range.startRow + 1}`;
    const end = `${columnLabel(range.endColumn)}${range.endRow + 1}`;
    return start === end ? start : `${start}:${end}`;
  }).join(' ');
}

/** Move every range of a list; ranges that were entirely deleted drop out. */
export function mapRanges(ranges: CellRange[], maps: SheetMaps): CellRange[] {
  return ranges.map(range => mapRange(maps, range)).filter((range): range is CellRange => range !== null);
}

/** Rewrite an sqref attribute value, or null when none of its ranges survived. Unchanged text stays as written. */
export function transformSqref(text: string, maps: SheetMaps): string | null {
  if (isIdentity(maps)) return text;
  const ranges = parseSqref(text);
  if (!ranges.length) return text;
  const mapped = mapRanges(ranges, maps);
  if (!mapped.length) return null;
  const result = sqrefText(mapped);
  return result === sqrefText(ranges) ? text : result;
}
