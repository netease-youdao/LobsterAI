import type { ICellData, IRange, IStyleData, IWorkbookData, IWorksheetData, Nullable } from '@univerjs/core';

import { type CellRange, cellReference, parseCellReference, parseRangeReference, rangeReference } from './sheetAddress';
import { SHEET_CHART_COMPONENT } from './sheetChartHost';
import { mapChartReferences } from './sheetChartSpec';
import { isIdentity, laterEditsScope, type StructureOp, transformFormula } from './sheetStructure';
import { chartPartXml, snapshotChartReader } from './xlsxChartWriter';
import { conditionalFormatsUnchanged, rewriteConditionalFormats } from './xlsxConditionalFormatExport';
import { CONDITIONAL_FORMATS_RESOURCE, conditionalFormatsOf } from './xlsxConditionalFormats';
import { dataValidationsUnchanged, rewriteDataValidations } from './xlsxDataValidationExport';
import { dataValidationsOf } from './xlsxDataValidations';
import {
  addSheetDrawings, chartChanges, chartPartOf, drawingsOf, drawingsUnchanged, imageChanges, type NewSheetChart, rewriteSheetDrawings,
} from './xlsxDrawings';
import { filtersOf, moveFilter, rewriteAutoFilter, sameFilter, syncFilterDatabases, withFilteredRows } from './xlsxFilters';
import { hyperlinkChanges, rewriteHyperlinks } from './xlsxHyperlinks';
import { CellType, pixelsToColumnWidth, pixelsToPoints, STYLE_ID_PREFIX, type WorkbookBaseline } from './xlsxImport';
import { noteChanges, notesOf, rewriteNotes } from './xlsxNotes';
import { relationshipsPath, RelationshipType, removeContentType, writePackage, XlsxPackage } from './xlsxPackage';
import {
  alignSheetSnapshot, allocateSheetParts, AxisGeometry, blankWorksheet, dropStaleTitles, type NewSheetPart, patchSheetView, relatedParts,
  RelationshipTypes, resizeTable, rewriteWorkbookSheets, setTabSelected, sheetViewState, StructurePlan, transformChart, transformCommentRefs,
  transformDrawing, transformHyperlinkTargets, transformTable, transformVml, transformWorksheet, updateWorkbookRelationships, viewChanged,
  type WorkbookSheetState,
} from './xlsxStructureExport';
import { effectiveStyle, XlsxStyleWriter } from './xlsxStyles';
import {
  addElementPrefix, decodeXml, elementPrefix, encodeExcelString, encodeXmlText, firstXmlElement, setXmlAttributes,
  xmlAttribute, xmlElements,
} from './xlsxXml';

/**
 * Writes an edited workbook back into its ORIGINAL package. Only cells, rows, columns and
 * merges that differ from the imported snapshot are rewritten; every other part and every
 * untouched element keeps its bytes. Changes the writer cannot represent are refused rather
 * than written lossily.
 */

export const SheetExportIssue = {
  /** A change to rows, columns or sheets the writer cannot carry into the file. */
  Structure: 'structure',
  /** A table header changed in a way the table definition cannot follow. */
  TableHeader: 'table-header',
  /** A shared formula could not be rewritten as a plain formula. */
  Formula: 'formula',
} as const;
export type SheetExportIssue = typeof SheetExportIssue[keyof typeof SheetExportIssue];

export class XlsxExportError extends Error {
  constructor(readonly issue: SheetExportIssue, message: string) {
    super(message);
  }
}

export interface ExportRequest {
  baseline: WorkbookBaseline;
  /** Univer's current snapshot of the same workbook. */
  current: IWorkbookData;
  /** Formula text (`=…`) of a cell that only references a shared formula id, resolved by the engine. */
  resolveFormula: (sheetId: string, row: number, column: number) => string | undefined;
  /** Whole-row and whole-column insertions and deletions since the baseline, oldest first. */
  structure?: readonly StructureOp[];
  /** The sheet on screen; it becomes the file's active tab when the original one is gone or hidden. */
  activeSheetId?: string;
  /** The current ranges of tables that grew by typing next to them (Excel's AutoExpansion), by name. */
  tables?: ReadonlyMap<string, CellRange>;
}

export interface ExportResult {
  bytes: Uint8Array;
  changed: boolean;
}

const ERROR_VALUES = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!', '#CONNECT!', '#BLOCKED!', '#UNKNOWN!', '#FIELD!', '#BUSY!']);

/** Functions Excel stores with the `_xlfn.` prefix (MS-XLSX 2.2.2 future functions). */
const FUTURE_FUNCTIONS = new Set(`ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE
BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT
CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH
COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ECMA.CEILING ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST
F.DIST.RT F.INV F.INV.RT F.TEST FIELDVALUE FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT
FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE
GAUSS HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOMITTED
ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST
NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC
PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC QUERYSTRING RANDARRAY RANK.AVG
RANK.EQ REDUCE RRI SCAN SEC SECH SEQUENCE SHEET SHEETS SKEW.P SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT
T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P
VAR.S VSTACK WEBSERVICE WEIBULL.DIST WORKDAY.INTL WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST`.split(/\s+/));
/** Dynamic-array functions Excel additionally marks with `_xlws.`. */
const WORKSHEET_FUNCTIONS = new Set(['FILTER', 'SORT']);

/** Restore Excel's storage prefixes for functions Univer parses by their bare names. */
export function formulaForExcel(formula: string): string {
  const text = formula.replace(/^=/, '');
  let result = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === '\'') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === char) {
          if (text[end + 1] === char) { end += 2; continue; }
          break;
        }
        end++;
      }
      result += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    const match = /^[A-Za-z_][\w.]*(?=\()/.exec(text.slice(index));
    if (match && !/[\w.]$/.test(result)) {
      const name = match[0].toUpperCase();
      if (WORKSHEET_FUNCTIONS.has(name)) result += `_xlfn._xlws.${match[0]}`;
      else if (FUTURE_FUNCTIONS.has(name)) result += `_xlfn.${match[0]}`;
      else result += match[0];
      index += match[0].length;
      continue;
    }
    result += char;
    index++;
  }
  return result;
}

type ValueState =
  | { kind: 'none' }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean };

interface CellState {
  formula?: string;
  shared?: string;
  value: ValueState;
  styleId?: string;
  style?: IStyleData;
}

function richText(cell: ICellData): string | undefined {
  const stream = cell.p?.body?.dataStream;
  return typeof stream === 'string' ? stream.replace(/\r?\n$/, '').replace(/\r\n?/g, '\n') : undefined;
}

function valueState(cell: Nullable<ICellData>): ValueState {
  if (!cell) return { kind: 'none' };
  const text = richText(cell);
  if (text !== undefined) return text ? { kind: 'string', value: text } : { kind: 'none' };
  const { v, t } = cell;
  if (v === undefined || v === null || v === '') return { kind: 'none' };
  if (t === CellType.Boolean || typeof v === 'boolean') return { kind: 'boolean', value: v === true || v === 1 || String(v).toUpperCase() === 'TRUE' || v === '1' };
  if (t === CellType.String || t === CellType.ForceString) return { kind: 'string', value: String(v) };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', value: v } : { kind: 'string', value: String(v) };
  if (t === CellType.Number && v.trim() !== '' && Number.isFinite(Number(v))) return { kind: 'number', value: Number(v) };
  return { kind: 'string', value: v };
}

function cellState(cell: Nullable<ICellData>, styles: IWorkbookData['styles']): CellState {
  const state: CellState = { value: valueState(cell) };
  if (!cell) return state;
  const formula = typeof cell.f === 'string' ? cell.f.trim().replace(/^=/, '') : '';
  if (formula) state.formula = formula;
  if (cell.si) state.shared = String(cell.si);
  if (typeof cell.s === 'string') {
    state.styleId = cell.s;
    state.style = styles[cell.s] ?? undefined;
  } else if (cell.s) {
    state.style = cell.s;
  }
  return state;
}

const sameValue = (a: ValueState, b: ValueState): boolean => a.kind === b.kind && (a.kind === 'none' || (a as { value: unknown }).value === (b as { value: unknown }).value);
const isFormula = (state: CellState): boolean => Boolean(state.formula || state.shared);
const isError = (value: ValueState): boolean => value.kind === 'string' && ERROR_VALUES.has(value.value);

interface SheetChanges {
  cells: Map<number, Map<number, CellPatch>>;
  rows: Map<number, { height?: number | null; hidden?: boolean }>;
  columns: Map<number, { width?: number | null; hidden?: boolean }>;
  merges?: IRange[];
}

/** What changed in a cell; the writer keeps as much of the original element as possible. */
interface CellPatch {
  current: CellState;
  /** Formula or value changed, or the cell is new or cleared. */
  content: boolean;
  /** Only the computed result of an unchanged formula changed. */
  cached: boolean;
  style: boolean;
  /** An unchanged cell whose shared formula must be written out because its group anchor changed. */
  materialize?: boolean;
  baseline: CellState;
}

function cells(data: Partial<IWorksheetData> | undefined): IWorksheetData['cellData'] {
  return data?.cellData ?? {};
}

function styleChanged(before: CellState, after: CellState, defaults: IStyleData | undefined): boolean {
  if (before.styleId === after.styleId && before.styleId !== undefined) return false;
  if (!before.style && !after.style) return false;
  return JSON.stringify(effectiveStyle(defaults, before.style)) !== JSON.stringify(effectiveStyle(defaults, after.style));
}

function diffSheet(baseline: Partial<IWorksheetData>, current: Partial<IWorksheetData>, baselineStyles: IWorkbookData['styles'], currentStyles: IWorkbookData['styles'], defaults: IStyleData | undefined): SheetChanges {
  const changes: SheetChanges = { cells: new Map(), rows: new Map(), columns: new Map() };
  const before = cells(baseline);
  const after = cells(current);
  const rows = new Set([...Object.keys(before), ...Object.keys(after)].map(Number));
  for (const row of rows) {
    const beforeRow = before[row] ?? {};
    const afterRow = after[row] ?? {};
    const columns = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)].map(Number));
    for (const column of columns) {
      const was = cellState(beforeRow[column], baselineStyles);
      const now = cellState(afterRow[column], currentStyles);
      const formulaChanged = was.formula !== now.formula || was.shared !== now.shared;
      const valueChanged = !sameValue(was.value, now.value);
      const content = formulaChanged || (!isFormula(now) && valueChanged);
      // An error for a formula nobody changed usually means the engine lacks a feature Excel has;
      // keep the file's own result (or none) and let Excel recalculate on open.
      const cached = !formulaChanged && isFormula(now) && valueChanged && !isError(now.value);
      const style = styleChanged(was, now, defaults);
      if (!content && !cached && !style) continue;
      let rowPatches = changes.cells.get(row);
      if (!rowPatches) changes.cells.set(row, rowPatches = new Map());
      rowPatches.set(column, { current: now, content, cached, style, baseline: was });
    }
  }
  const beforeRows = baseline.rowData ?? {};
  const afterRows = current.rowData ?? {};
  for (const row of new Set([...Object.keys(beforeRows), ...Object.keys(afterRows)].map(Number))) {
    const was = beforeRows[row] ?? {};
    const now = afterRows[row] ?? {};
    const patch: { height?: number | null; hidden?: boolean } = {};
    if ((was.h ?? null) !== (now.h ?? null)) patch.height = now.h ?? null;
    if (Boolean(was.hd) !== Boolean(now.hd)) patch.hidden = Boolean(now.hd);
    if (Object.keys(patch).length) changes.rows.set(row, patch);
  }
  const beforeColumns = baseline.columnData ?? {};
  const afterColumns = current.columnData ?? {};
  for (const column of new Set([...Object.keys(beforeColumns), ...Object.keys(afterColumns)].map(Number))) {
    const was = beforeColumns[column] ?? {};
    const now = afterColumns[column] ?? {};
    const patch: { width?: number | null; hidden?: boolean } = {};
    if ((was.w ?? null) !== (now.w ?? null)) patch.width = now.w ?? null;
    if (Boolean(was.hd) !== Boolean(now.hd)) patch.hidden = Boolean(now.hd);
    if (Object.keys(patch).length) changes.columns.set(column, patch);
  }
  const mergeKey = (ranges: IRange[] | undefined) => (ranges ?? []).map(range => rangeReference(range)).sort().join(',');
  if (mergeKey(baseline.mergeData) !== mergeKey(current.mergeData)) changes.merges = current.mergeData ?? [];
  return changes;
}

function hasChanges(changes: SheetChanges): boolean {
  return changes.cells.size > 0 || changes.rows.size > 0 || changes.columns.size > 0 || changes.merges !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Cell markup

function numberText(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function textElement(value: string): string {
  const escaped = encodeXmlText(encodeExcelString(value));
  return /^\s|\s$|\n/.test(value) ? `<t xml:space="preserve">${escaped}</t>` : `<t>${escaped}</t>`;
}

function cachedValue(value: ValueState): { type?: string; markup: string } | undefined {
  switch (value.kind) {
    case 'number': return { markup: `<v>${numberText(value.value)}</v>` };
    case 'boolean': return { type: 'b', markup: `<v>${value.value ? 1 : 0}</v>` };
    case 'string': return { type: ERROR_VALUES.has(value.value) ? 'e' : 'str', markup: `<v>${encodeXmlText(encodeExcelString(value.value))}</v>` };
    default: return undefined;
  }
}

function freshCell(reference: string, style: number, state: CellState, formula: string | undefined): string | null {
  const s = style ? ` s="${style}"` : '';
  if (formula !== undefined) {
    const cached = cachedValue(state.value);
    const type = cached?.type ? ` t="${cached.type}"` : '';
    return `<c r="${reference}"${s}${type}><f>${encodeXmlText(formulaForExcel(formula))}</f>${cached?.markup ?? ''}</c>`;
  }
  switch (state.value.kind) {
    case 'number': return `<c r="${reference}"${s}><v>${numberText(state.value.value)}</v></c>`;
    case 'boolean': return `<c r="${reference}"${s} t="b"><v>${state.value.value ? 1 : 0}</v></c>`;
    case 'string': return `<c r="${reference}"${s} t="inlineStr"><is>${textElement(state.value.value)}</is></c>`;
    default: return style ? `<c r="${reference}"${s}/>` : null;
  }
}

/** Replace the result of an unchanged formula, keeping its `<f>` element (and shared-formula metadata). */
function withCachedValue(original: { open: string; inner: string }, value: ValueState, prefix: string): { open: string; inner: string } {
  const cached = cachedValue(value);
  const valueElement = firstXmlElement(original.inner, 'v');
  let inner = valueElement ? original.inner.slice(0, valueElement.start) + original.inner.slice(valueElement.end) : original.inner;
  if (cached) {
    const formula = firstXmlElement(inner, 'f');
    const at = formula ? formula.end : 0;
    inner = inner.slice(0, at) + addElementPrefix(cached.markup, prefix) + inner.slice(at);
  }
  return { open: xmlAttribute(original.open, 't') === cached?.type ? original.open : setXmlAttributes(original.open, { t: cached?.type }), inner };
}

// ---------------------------------------------------------------------------------------------
// Worksheet patching

interface ParsedCell {
  column: number;
  open: string;
  inner?: string;
  markup: string;
  /** The cell names its position (`r`); cells may leave it implied by their order. */
  explicit: boolean;
}

interface ParsedRow {
  index: number;
  start: number;
  end: number;
  open: string;
  inner?: string;
  name: string;
  explicit: boolean;
}

const REFERENCE_ATTRIBUTE = /\sr\s*=\s*["']([^"']*)["']/;
/** The `r` attribute of a row or cell tag: read for every cell of a large sheet, so without a full attribute parse. */
const referenceOf = (open: string): string | undefined => REFERENCE_ATTRIBUTE.exec(open)?.[1];

function parseRowCells(row: ParsedRow): ParsedCell[] {
  const result: ParsedCell[] = [];
  let previous = -1;
  for (const cell of row.inner ? xmlElements(row.inner, 'c') : []) {
    const reference = referenceOf(cell.open);
    const column = reference ? parseCellReference(reference)?.column ?? previous + 1 : previous + 1;
    previous = column;
    result.push({ column, open: cell.open, inner: cell.inner, markup: row.inner!.slice(cell.start, cell.end), explicit: Boolean(reference) });
  }
  return result;
}

interface SharedGroup {
  anchor?: { row: number; column: number };
  members: { row: number; column: number }[];
}

function sharedGroups(rows: ParsedRow[]): Map<string, SharedGroup> {
  const groups = new Map<string, SharedGroup>();
  for (const row of rows) {
    if (!row.inner?.includes('shared')) continue;
    for (const cell of parseRowCells(row)) {
      const formula = cell.inner && firstXmlElement(cell.inner, 'f');
      if (!formula || xmlAttribute(formula.open, 't') !== 'shared') continue;
      const id = xmlAttribute(formula.open, 'si');
      if (id === undefined) continue;
      let group = groups.get(id);
      if (!group) groups.set(id, group = { members: [] });
      const position = { row: row.index, column: cell.column };
      group.members.push(position);
      if (xmlAttribute(formula.open, 'ref') && formula.inner?.trim()) group.anchor = position;
    }
  }
  return groups;
}

interface PatchContext {
  sheetId: string;
  styles: XlsxStyleWriter;
  resolveFormula: ExportRequest['resolveFormula'];
  mdw: number;
  defaultColumnWidth: number;
}

function styleIndex(patch: CellPatch, context: PatchContext, originalOpen: string | undefined): number {
  const original = Number(originalOpen ? xmlAttribute(originalOpen, 's') ?? 0 : 0);
  if (!patch.style) return original;
  const id = patch.current.styleId;
  if (id?.startsWith(STYLE_ID_PREFIX) && /^\d+$/.test(id.slice(STYLE_ID_PREFIX.length))) return Number(id.slice(STYLE_ID_PREFIX.length));
  if (!patch.current.style || !Object.keys(patch.current.style).length) return 0;
  const baseId = patch.baseline.styleId;
  const base = baseId?.startsWith(STYLE_ID_PREFIX) ? Number(baseId.slice(STYLE_ID_PREFIX.length)) : original;
  return context.styles.xfFor(Number.isInteger(base) ? base : 0, patch.current.style);
}

function formulaText(patch: CellPatch, row: number, column: number, context: PatchContext): string | undefined {
  if (patch.current.formula) return patch.current.formula;
  if (!patch.current.shared) return undefined;
  const resolved = context.resolveFormula(context.sheetId, row, column)?.trim().replace(/^=/, '');
  if (!resolved) throw new XlsxExportError(SheetExportIssue.Formula, `Cannot resolve the formula of ${cellReference(row, column)}`);
  return resolved;
}

function patchedCell(original: ParsedCell | undefined, row: number, column: number, patch: CellPatch, context: PatchContext, prefix: string): string | null {
  const reference = cellReference(row, column);
  const style = styleIndex(patch, context, original?.open);
  if (patch.content || patch.materialize || !original) {
    const formula = isFormula(patch.current) ? formulaText(patch, row, column, context) : undefined;
    const markup = freshCell(reference, style, patch.current, formula);
    return markup && addElementPrefix(markup, prefix);
  }
  const styleText = style ? String(style) : undefined;
  const base = original.open.replace(/\/>$/, '>');
  // Most kept cells (a new cached result, say) keep their tag as it is.
  let open = referenceOf(base) === reference && xmlAttribute(base, 's') === styleText ? base : setXmlAttributes(base, { r: reference, s: styleText });
  let inner = original.inner ?? '';
  if (patch.cached) ({ open, inner } = withCachedValue({ open, inner }, patch.current.value, prefix));
  return inner ? `${open}${inner}</${original.open.match(/^<([^\s/>]+)/)![1]}>` : open.replace(/>$/, '/>');
}

function rowOpenTag(open: string | undefined, index: number, prefix: string, patch: { height?: number | null; hidden?: boolean } | undefined): string {
  const base = open ? open.replace(/\/>$/, '>') : `<${prefix}row r="${index + 1}">`;
  const changes: Record<string, string | undefined> = { r: String(index + 1), spans: undefined };
  if (patch?.height !== undefined) {
    changes.ht = patch.height === null ? undefined : String(pixelsToPoints(patch.height));
    changes.customHeight = patch.height === null ? undefined : '1';
  }
  if (patch?.hidden !== undefined) changes.hidden = patch.hidden ? '1' : undefined;
  return setXmlAttributes(base, changes);
}

function rowHasAttributes(open: string): boolean {
  const attributes = [...open.matchAll(/\s([^\s=/>]+)\s*=/g)].map(match => match[1]).filter(name => name !== 'r' && name !== 'spans' && !name.startsWith('x14ac:'));
  return attributes.length > 0;
}

function patchSheetData(xml: string, changes: SheetChanges, context: PatchContext, groups: Map<string, SharedGroup>, rows: ParsedRow[], sheetData: { start: number; end: number; innerStart: number; inner?: string; name: string; open: string }, materializeAll = false): { xml: string; bounds?: CellRange } {
  const prefix = elementPrefix(sheetData.name);
  const touchedRows = new Set([...changes.cells.keys(), ...changes.rows.keys()]);
  const byIndex = new Map(rows.map(row => [row.index, row]));
  const implicitRows = rows.some(row => !row.explicit);
  let bounds: CellRange | undefined;
  const extend = (row: number, column: number) => {
    bounds = bounds
      ? { startRow: Math.min(bounds.startRow, row), startColumn: Math.min(bounds.startColumn, column), endRow: Math.max(bounds.endRow, row), endColumn: Math.max(bounds.endColumn, column) }
      : { startRow: row, startColumn: column, endRow: row, endColumn: column };
  };

  // Group anchors that are rewritten break every other member of their shared formula. When rows
  // or columns moved, every group's range is stale: all of them are written out as plain formulas.
  for (const group of groups.values()) {
    if (!materializeAll) {
      if (!group.anchor) continue;
      const anchorPatch = changes.cells.get(group.anchor.row)?.get(group.anchor.column);
      if (!anchorPatch?.content) continue;
    }
    for (const member of group.members) {
      if (!materializeAll && member.row === group.anchor!.row && member.column === group.anchor!.column) continue;
      let rowPatches = changes.cells.get(member.row);
      if (!rowPatches) changes.cells.set(member.row, rowPatches = new Map());
      const existing = rowPatches.get(member.column);
      if (existing?.content) continue;
      rowPatches.set(member.column, existing ? { ...existing, materialize: true } : {
        current: { value: { kind: 'none' }, shared: 'pending' }, baseline: { value: { kind: 'none' } }, content: false, cached: false, style: false, materialize: true,
      });
      touchedRows.add(member.row);
    }
  }

  const renderRow = (index: number, row: ParsedRow | undefined): string => {
    const patches = changes.cells.get(index);
    const original = row ? parseRowCells(row) : [];
    const cellsByColumn = new Map(original.map(cell => [cell.column, cell]));
    const columns = [...new Set([...cellsByColumn.keys(), ...(patches?.keys() ?? [])])].sort((a, b) => a - b);
    let body = '';
    for (const column of columns) {
      const patch = patches?.get(column);
      const cell = cellsByColumn.get(column);
      if (!patch) {
        body += cell!.explicit ? cell!.markup : cell!.markup.replace(/^<([^\s/>]+)/, `<$1 r="${cellReference(index, column)}"`);
        continue;
      }
      if (patch.current.shared === 'pending') patch.current = pendingState(cell, index, column, context);
      const markup = patchedCell(cell, index, column, patch, context, prefix);
      if (markup) {
        body += markup;
        extend(index, column);
      }
    }
    const open = rowOpenTag(row?.open, index, prefix, changes.rows.get(index));
    if (!body && !rowHasAttributes(open)) return '';
    const name = row?.name ?? `${prefix}row`;
    return body ? `${open}${body}</${name}>` : open.replace(/>$/, '/>');
  };

  const inner = sheetData.inner ?? '';
  // Rebuild the sheetData content in one pass: new rows go before the first later row.
  const pending = [...touchedRows].filter(index => !byIndex.has(index)).sort((a, b) => a - b);
  const parts: string[] = [];
  let cursor = 0;
  let offset = 0;
  for (const row of rows) {
    parts.push(inner.slice(offset, row.start));
    while (cursor < pending.length && pending[cursor] < row.index) parts.push(renderRow(pending[cursor++], undefined));
    if (touchedRows.has(row.index)) parts.push(renderRow(row.index, row));
    else if (implicitRows && !row.explicit) parts.push(setXmlAttributes(row.open, { r: String(row.index + 1) }) + inner.slice(row.start + row.open.length, row.end));
    else parts.push(inner.slice(row.start, row.end));
    offset = row.end;
  }
  parts.push(inner.slice(offset));
  while (cursor < pending.length) parts.push(renderRow(pending[cursor++], undefined));
  const body = parts.join('');
  const open = sheetData.open.replace(/\/>$/, '>');
  return { xml: xml.slice(0, sheetData.start) + `${open}${body}</${sheetData.name}>` + xml.slice(sheetData.end), bounds };
}

/** A shared-formula member that must be written out: its current value and style, the formula from the engine. */
function pendingState(cell: ParsedCell | undefined, row: number, column: number, context: PatchContext): CellState {
  const formula = context.resolveFormula(context.sheetId, row, column)?.trim().replace(/^=/, '');
  if (!formula) throw new XlsxExportError(SheetExportIssue.Formula, `Cannot resolve the shared formula of ${cellReference(row, column)}`);
  const value = cell?.inner ? cachedFromMarkup(cell) : { kind: 'none' as const };
  return { formula, value };
}

function cachedFromMarkup(cell: ParsedCell): ValueState {
  const value = firstXmlElement(cell.inner!, 'v');
  if (value?.inner === undefined) return { kind: 'none' };
  const text = decodeXml(value.inner);
  const type = xmlAttribute(cell.open, 't');
  if (type === 'b') return { kind: 'boolean', value: text === '1' };
  if (type === 'str' || type === 'e' || type === 's') return { kind: 'string', value: text };
  const number = Number(text);
  return Number.isFinite(number) ? { kind: 'number', value: number } : { kind: 'string', value: text };
}

const WORKSHEET_AFTER_MERGES = ['phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins',
  'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing',
  'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

function patchMerges(xml: string, merges: IRange[], prefix: string): string {
  const existing = firstXmlElement(xml, 'mergeCells');
  const markup = merges.length
    ? addElementPrefix(`<mergeCells count="${merges.length}">${merges.map(range => `<mergeCell ref="${rangeReference(range)}"/>`).join('')}</mergeCells>`, prefix)
    : '';
  if (existing) return xml.slice(0, existing.start) + markup + xml.slice(existing.end);
  if (!markup) return xml;
  const next = WORKSHEET_AFTER_MERGES.map(name => firstXmlElement(xml, name)).filter(Boolean).sort((a, b) => a!.start - b!.start)[0];
  const at = next ? next.start : xml.lastIndexOf('</');
  return xml.slice(0, at) + markup + xml.slice(at);
}

function patchColumns(xml: string, changes: SheetChanges['columns'], context: PatchContext, prefix: string): string {
  if (!changes.size) return xml;
  const cols = firstXmlElement(xml, 'cols');
  interface ColumnRange { min: number; max: number; open: string }
  const ranges: ColumnRange[] = [];
  for (const col of cols?.inner ? xmlElements(cols.inner, 'col') : []) {
    const min = Number(xmlAttribute(col.open, 'min'));
    const max = Number(xmlAttribute(col.open, 'max'));
    if (Number.isInteger(min) && Number.isInteger(max) && min <= max) ranges.push({ min, max, open: col.open.replace(/>$/, '/>').replace(/\/\/>$/, '/>') });
  }
  for (const [index, patch] of [...changes].sort((a, b) => a[0] - b[0])) {
    const column = index + 1;
    const position = ranges.findIndex(range => range.min <= column && column <= range.max);
    let target: ColumnRange;
    if (position >= 0) {
      const range = ranges[position];
      const pieces: ColumnRange[] = [];
      if (range.min < column) pieces.push({ ...range, max: column - 1, open: setXmlAttributes(range.open, { max: String(column - 1) }) });
      target = { min: column, max: column, open: setXmlAttributes(range.open, { min: String(column), max: String(column) }) };
      pieces.push(target);
      if (range.max > column) pieces.push({ ...range, min: column + 1, open: setXmlAttributes(range.open, { min: String(column + 1) }) });
      ranges.splice(position, 1, ...pieces);
    } else {
      target = { min: column, max: column, open: `<col min="${column}" max="${column}"/>` };
      const at = ranges.findIndex(range => range.min > column);
      ranges.splice(at < 0 ? ranges.length : at, 0, target);
    }
    const attributes: Record<string, string | undefined> = {};
    if (patch.width !== undefined) {
      if (patch.width === null) {
        attributes.width = pixelsToColumnWidth(context.defaultColumnWidth, context.mdw).toString();
        attributes.customWidth = undefined;
      } else {
        attributes.width = pixelsToColumnWidth(patch.width, context.mdw).toString();
        attributes.customWidth = '1';
      }
    }
    if (patch.hidden !== undefined) attributes.hidden = patch.hidden ? '1' : undefined;
    if (!xmlAttribute(target.open, 'width') && attributes.width === undefined) attributes.width = pixelsToColumnWidth(context.defaultColumnWidth, context.mdw).toString();
    target.open = setXmlAttributes(target.open, attributes);
  }
  const markup = addElementPrefix(`<cols>${ranges.map(range => range.open.replace(/^<[\w.-]+:/, '<')).join('')}</cols>`, prefix);
  if (cols) return xml.slice(0, cols.start) + markup + xml.slice(cols.end);
  const sheetData = firstXmlElement(xml, 'sheetData')!;
  return xml.slice(0, sheetData.start) + markup + xml.slice(sheetData.start);
}

function patchDimension(xml: string, bounds: CellRange | undefined): string {
  if (!bounds) return xml;
  const dimension = firstXmlElement(xml, 'dimension');
  if (!dimension) return xml;
  const current = parseRangeReference(xmlAttribute(dimension.open, 'ref') ?? '');
  const merged = current
    ? { startRow: Math.min(current.startRow, bounds.startRow), startColumn: Math.min(current.startColumn, bounds.startColumn), endRow: Math.max(current.endRow, bounds.endRow), endColumn: Math.max(current.endColumn, bounds.endColumn) }
    : bounds;
  return xml.slice(0, dimension.start) + setXmlAttributes(dimension.open, { ref: rangeReference(merged) }) + xml.slice(dimension.end);
}

// ---------------------------------------------------------------------------------------------
// Tables, calculation chain and workbook

function syncTableHeaders(files: Map<string, Uint8Array>, baseline: WorkbookBaseline, sheetPart: string, changes: SheetChanges, formulasText: () => string): void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  for (const relation of baseline.pkg.relationships(sheetPart)) {
    if (relation.type !== RelationshipType.Table || relation.external) continue;
    const bytes = files.get(relation.target);
    const xml = bytes && decoder.decode(bytes);
    const table = xml && firstXmlElement(xml, 'table');
    if (!xml || !table) continue;
    const range = parseRangeReference(xmlAttribute(table.open, 'ref') ?? '');
    const headerRows = Number(xmlAttribute(table.open, 'headerRowCount') ?? 1);
    if (!range || headerRows < 1) continue;
    const patches = changes.cells.get(range.startRow);
    if (!patches) continue;
    const columnsElement = firstXmlElement(xml, 'tableColumns');
    if (!columnsElement?.inner) continue;
    const columns = [...xmlElements(columnsElement.inner, 'tableColumn')];
    const renames = new Map<number, string>();
    for (const [column, patch] of patches) {
      if (column < range.startColumn || column > range.endColumn || !patch.content) continue;
      const value = patch.current.value;
      const name = value.kind === 'string' ? value.value : value.kind === 'number' ? numberText(value.value) : value.kind === 'boolean' ? (value.value ? 'TRUE' : 'FALSE') : '';
      if (!name.trim() || isFormula(patch.current)) {
        throw new XlsxExportError(SheetExportIssue.TableHeader, 'Table headers must be non-empty text');
      }
      // A column inserted inside the table already carries its header's name.
      if (name !== xmlAttribute(columns[column - range.startColumn]?.open ?? '<x>', 'name')) renames.set(column - range.startColumn, name);
    }
    if (!renames.size) continue;
    const names = columns.map((element, index) => renames.get(index) ?? xmlAttribute(element.open, 'name') ?? '');
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
      throw new XlsxExportError(SheetExportIssue.TableHeader, 'Table headers must be unique');
    }
    const tableName = xmlAttribute(table.open, 'displayName') ?? xmlAttribute(table.open, 'name') ?? '';
    if (tableName && formulasText().toLowerCase().includes(`${tableName.toLowerCase()}[`)) {
      throw new XlsxExportError(SheetExportIssue.TableHeader, `Formulas reference table ${tableName} by column name`);
    }
    let inner = columnsElement.inner;
    for (const [index, element] of [...columns.entries()].reverse()) {
      if (!renames.has(index)) continue;
      inner = inner.slice(0, element.start) + setXmlAttributes(element.open, { name: renames.get(index) }) + inner.slice(element.start + element.open.length);
    }
    const updated = xml.slice(0, columnsElement.innerStart) + inner + xml.slice(columnsElement.innerStart + columnsElement.inner.length);
    files.set(relation.target, encoder.encode(updated));
  }
}

function removeCalcChain(files: Map<string, Uint8Array>, baseline: WorkbookBaseline): void {
  const encoder = new TextEncoder();
  const relation = baseline.pkg.relationships(baseline.workbookPart).find(item => item.type === RelationshipType.CalcChain && !item.external);
  if (!relation) return;
  files.delete(relation.target);
  // The package as this save has it so far: earlier steps may have added parts and content types.
  const current = new XlsxPackage(files);
  const relsPath = relationshipsPath(baseline.workbookPart);
  const rels = current.text(relsPath);
  if (rels) {
    let updated = rels;
    for (const element of [...xmlElements(rels, 'Relationship')].reverse()) {
      if (xmlAttribute(element.open, 'Id') === relation.id) updated = updated.slice(0, element.start) + updated.slice(element.end);
    }
    files.set(relsPath, encoder.encode(updated));
  }
  removeContentType(files, `/${relation.target}`);
}

const WORKBOOK_BEFORE_CALC = ['definedNames', 'externalReferences', 'functionGroups', 'sheets'];

/** Ask Excel to recalculate on open: cached results the editor could not compute stay honest. */
function requestFullCalculation(xml: string): string {
  const calc = firstXmlElement(xml, 'calcPr');
  if (calc) return xml.slice(0, calc.start) + setXmlAttributes(calc.open, { fullCalcOnLoad: '1' }) + xml.slice(calc.start + calc.open.length);
  const anchor = WORKBOOK_BEFORE_CALC.map(name => firstXmlElement(xml, name)).find(Boolean);
  if (!anchor) return xml;
  return xml.slice(0, anchor.end) + addElementPrefix('<calcPr fullCalcOnLoad="1"/>', elementPrefix(anchor.name)) + xml.slice(anchor.end);
}

const FORMULA_ELEMENT = /<(?:[\w.-]+:)?f[\s>/]/;
const CHART_PART = /^xl\/charts\/chart(?:Ex)?\d*\.xml$/i;

function sheetState(sheet: Partial<IWorksheetData> | undefined): WorkbookSheetState['state'] {
  const hidden = Number(sheet?.hidden ?? 0);
  return hidden === 2 ? 'veryHidden' : hidden ? 'hidden' : undefined;
}

function parseRows(sheetData: { inner?: string }): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let previous = -1;
  for (const row of sheetData.inner ? xmlElements(sheetData.inner, 'row') : []) {
    const explicit = referenceOf(row.open);
    const index = explicit ? Number(explicit) - 1 : previous + 1;
    previous = index;
    rows.push({ index, start: row.start, end: row.end, open: row.open, inner: row.inner, name: row.name, explicit: Boolean(explicit) });
  }
  return rows;
}

interface SheetPatchResult {
  xml: string;
  cellsChanged: boolean;
  formulas: boolean;
}

/** Cells, rows, columns, merges and view settings of one worksheet part. */
function patchWorksheet(xml: string, changes: SheetChanges, context: PatchContext, materializeAll: boolean): SheetPatchResult {
  let result = xml;
  let formulas = false;
  const sheetData = firstXmlElement(result, 'sheetData');
  if (!sheetData) throw new XlsxExportError(SheetExportIssue.Structure, `Worksheet ${context.sheetId} has no sheetData`);
  const rows = parseRows(sheetData);
  const groups = sharedGroups(rows);
  const prefix = elementPrefix(sheetData.name);
  if (changes.cells.size || changes.rows.size || (materializeAll && groups.size)) {
    for (const rowPatches of changes.cells.values()) for (const patch of rowPatches.values()) if (isFormula(patch.current)) formulas = true;
    if (materializeAll && groups.size) formulas = true;
    const patched = patchSheetData(result, changes, context, groups, rows, sheetData, materializeAll);
    result = patchDimension(patched.xml, patched.bounds);
  }
  if (changes.columns.size) result = patchColumns(result, changes.columns, context, prefix);
  if (changes.merges) result = patchMerges(result, changes.merges, prefix);
  return { xml: result, cellsChanged: changes.cells.size > 0 || (materializeAll && groups.size > 0), formulas };
}

/** Write the current snapshot into the original package; returns the original bytes when nothing changed. */
export function exportXlsx(request: ExportRequest, originalBytes: Uint8Array): ExportResult {
  const { baseline, current } = request;
  const currentNames = new Map(current.sheetOrder.filter(id => current.sheets[id]).map(id => [id, current.sheets[id].name ?? id]));
  const plan = new StructurePlan(baseline, current.sheetOrder.filter(id => current.sheets[id]), currentNames, request.structure ?? []);
  const defaults = typeof baseline.snapshot.defaultStyle === 'object' && baseline.snapshot.defaultStyle ? baseline.snapshot.defaultStyle : undefined;

  // Without the plugin's resource the model is unknown: leave the file's rules as they are.
  const hasFormatModel = Boolean(current.resources?.some(item => item.name === CONDITIONAL_FORMATS_RESOURCE));
  const conditionalFormats = conditionalFormatsOf(current);
  // Likewise pictures: only a snapshot with the drawing plugin's resource can have moved them.
  const drawings = drawingsOf(current);
  const validations = dataValidationsOf(current);
  // Filters too; rows a filter hides are stored as hidden rows, so both sides compare them that way.
  const filters = filtersOf(current);
  const notes = notesOf(current);
  const work = baseline.sheets.filter(sheet => current.sheets[sheet.id]).map(sheet => {
    const maps = plan.maps(sheet.id);
    const loadedFilter = baseline.filters.get(sheet.id);
    const movedFilter = loadedFilter ? moveFilter(loadedFilter, maps) : null;
    const filter = filters ? filters[sheet.id] ?? null : movedFilter;
    const aligned = withFilteredRows(alignSheetSnapshot(baseline.snapshot.sheets[sheet.id], maps), movedFilter?.cachedFilteredOut);
    const now = withFilteredRows(current.sheets[sheet.id], filter?.cachedFilteredOut);
    const formats = {
      imported: baseline.conditionalFormats.get(sheet.id) ?? [],
      current: conditionalFormats[sheet.id] ?? [],
      maps,
      scope: plan.scope(sheet.name),
    };
    const rules = {
      imported: baseline.dataValidations.get(sheet.id) ?? [],
      current: validations?.[sheet.id] ?? [],
      maps,
      scope: plan.scope(sheet.name),
    };
    return {
      sheet, maps, aligned, now, formats, rules,
      formatsChanged: hasFormatModel && !conditionalFormatsUnchanged({ ...formats, dxf: () => 0 }),
      rulesChanged: Boolean(validations) && !dataValidationsUnchanged(rules),
      links: hyperlinkChanges(aligned, now),
      filter,
      movedFilter,
      filterChanged: Boolean(filters) && !sameFilter(movedFilter, filter),
      noteEdits: notes ? noteChanges(baseline.notes.get(sheet.id) ?? [], notes[sheet.id], maps) : undefined,
      drawingsChanged: Boolean(drawings) && !drawingsUnchanged(baseline.drawings.get(sheet.id) ?? [], drawings?.[sheet.id]?.data),
      charts: drawings ? chartChanges(baseline.drawings.get(sheet.id) ?? [], drawings[sheet.id], SHEET_CHART_COMPONENT) : undefined,
      images: drawings ? imageChanges(baseline.drawings.get(sheet.id) ?? [], drawings[sheet.id]) : [],
      changes: diffSheet(aligned, now, baseline.snapshot.styles, current.styles, defaults),
      view: { before: sheetViewState(aligned), after: sheetViewState(now) },
    };
  });
  const statesChanged = work.some(item => sheetState(item.aligned) !== sheetState(item.now));
  const anything = plan.sheetsChanged || plan.referencesMoved || statesChanged
    || work.some(item => hasChanges(item.changes) || item.formatsChanged || item.rulesChanged || item.links || item.filterChanged || item.noteEdits || item.drawingsChanged || item.charts || item.images.length || viewChanged(item.view.before, item.view.after));
  if (!anything) return { bytes: originalBytes, changed: false };

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const files = new Map(baseline.pkg.files);
  const read = (part: string) => { const bytes = files.get(part); return bytes ? decoder.decode(bytes).replace(/^\uFEFF/, '') : undefined; };
  const styles = new XlsxStyleWriter(baseline.styles, defaults ?? {});
  let cellsChanged = false;
  let formulas = false;
  const sheetTexts = new Map<string, string>();
  const allFormulas = () => [
    ...baseline.sheets.map(sheet => sheetTexts.get(sheet.part) ?? baseline.pkg.text(sheet.part) ?? ''),
    ...Object.values(current.sheets).flatMap(sheet => Object.values(sheet.cellData ?? {}).flatMap(row => Object.values(row as Record<string, ICellData>).map(cell => cell?.f ?? ''))),
  ].join('\n');

  const sheetName = (sheetId: string) => currentNames.get(sheetId);
  // Charts written from the model carry current references; the other chart parts move below.
  const modelCharts = new Set<string>();
  let chartRead: ReturnType<typeof snapshotChartReader> | undefined;
  const chartXml = (spec: Parameters<typeof chartPartXml>[0]) => chartPartXml(spec, chartRead ??= snapshotChartReader(current));
  const sheetsNow = plan.currentOrder.map(id => ({ id, name: String(current.sheets[id]?.name ?? id) }));
  const currentChart = (chart: NewSheetChart): NewSheetChart => ({
    ...chart,
    spec: mapChartReferences(chart.spec, reference => transformFormula(reference, chart.origin === undefined ? plan.scope() : laterEditsScope(request.structure ?? [], chart.origin, sheetsNow))),
  });
  const writeDrawings = (part: string, xml: string, charts: ReturnType<typeof chartChanges>, images: ReturnType<typeof imageChanges>): string => {
    for (const { item, spec } of charts?.edited ?? []) {
      const chartPart = chartPartOf(files, item);
      if (!chartPart) continue;
      files.set(chartPart, encoder.encode(chartXml(mapChartReferences(spec, reference => transformFormula(reference, plan.scope())))));
      modelCharts.add(chartPart);
    }
    if (!charts?.added.length && !images.length) return xml;
    const existing = new Set(files.keys());
    const next = addSheetDrawings(files, part, xml, { images, charts: (charts?.added ?? []).map(currentChart) }, chartXml);
    for (const name of files.keys()) if (!existing.has(name) && CHART_PART.test(name)) modelCharts.add(name);
    return next;
  };
  const writeLinks = (part: string, xml: string, links: NonNullable<ReturnType<typeof hyperlinkChanges>>): string => {
    const path = relationshipsPath(part);
    const before = read(path);
    const next = rewriteHyperlinks(xml, before, links, sheetName);
    if (next.relationships !== undefined && next.relationships !== before) files.set(path, encoder.encode(next.relationships));
    return next.xml;
  };
  // Sheets whose filter range must be named again (`_xlnm._FilterDatabase`), by current name.
  const filterDatabases = new Map<string, IRange | null>();
  for (const { sheet, maps, now, changes, view, formats, formatsChanged, rules, rulesChanged, links, filter, movedFilter, filterChanged, noteEdits, drawingsChanged, charts, images } of work) {
    const original = baseline.pkg.text(sheet.part)!;
    if (FORMULA_ELEMENT.test(original)) formulas = true;
    const identity = isIdentity(maps);
    const scope = plan.scope(sheet.name);
    let xml = plan.referencesMoved ? transformWorksheet(original, { maps, scope }) : original;
    const context: PatchContext = {
      sheetId: sheet.id,
      styles,
      resolveFormula: request.resolveFormula,
      mdw: baseline.maxDigitWidth,
      defaultColumnWidth: baseline.snapshot.sheets[sheet.id].defaultColumnWidth ?? Math.round(8.43 * baseline.maxDigitWidth + 5),
    };
    if (hasChanges(changes) || !identity) {
      const patched = patchWorksheet(xml, changes, context, !identity);
      xml = patched.xml;
      if (patched.cellsChanged) cellsChanged = true;
      if (patched.formulas) formulas = true;
    }
    if (viewChanged(view.before, view.after)) xml = patchSheetView(xml, view.before, view.after);
    if (formatsChanged) xml = rewriteConditionalFormats(xml, { ...formats, dxf: style => styles.dxfFor(style) });
    if (rulesChanged) xml = rewriteDataValidations(xml, rules);
    if (links) xml = writeLinks(sheet.part, xml, links);
    if (filterChanged) {
      xml = rewriteAutoFilter(xml, filter, style => styles.dxfFor(style), movedFilter);
      filterDatabases.set(currentNames.get(sheet.id) ?? sheet.name, filter?.ref ?? null);
    }
    sheetTexts.set(sheet.part, xml);
    if (xml !== original) files.set(sheet.part, encoder.encode(xml));

    const rewrite = (part: string, transform: (text: string) => string) => {
      const text = read(part);
      if (text === undefined) return;
      const next = transform(text);
      if (next !== text) files.set(part, encoder.encode(next));
    };
    // A column added to a table (inserted inside it or typed beside it) is named by its header cell, as Excel names it.
    const headerText = (row: number, column: number) => {
      const value = valueState((now.cellData as Record<number, Record<number, ICellData | null>> | undefined)?.[row]?.[column]);
      return value.kind === 'string' ? value.value : value.kind === 'number' ? numberText(value.value) : undefined;
    };
    if (plan.referencesMoved) {
      const geometry = {
        before: { rows: AxisGeometry.rows(baseline.snapshot.sheets[sheet.id]), columns: AxisGeometry.columns(baseline.snapshot.sheets[sheet.id]) },
        after: { rows: AxisGeometry.rows(now), columns: AxisGeometry.columns(now) },
      };
      for (const part of relatedParts(files, sheet.part, RelationshipTypes.Drawing)) rewrite(part, text => transformDrawing(text, maps, geometry, scope));
      for (const part of relatedParts(files, sheet.part, RelationshipTypes.VmlDrawing)) rewrite(part, text => transformVml(text, maps));
      for (const part of relatedParts(files, sheet.part, RelationshipTypes.Comments)) rewrite(part, text => transformCommentRefs(text, 'comment', maps));
      for (const part of relatedParts(files, sheet.part, RelationshipTypes.ThreadedComments)) rewrite(part, text => transformCommentRefs(text, 'threadedComment', maps));
      for (const part of relatedParts(files, sheet.part, RelationshipType.Table)) rewrite(part, text => transformTable(text, maps, scope, headerText));
      rewrite(relationshipsPath(sheet.part), text => transformHyperlinkTargets(text, scope));
    }
    if (request.tables?.size) {
      for (const part of relatedParts(files, sheet.part, RelationshipType.Table)) rewrite(part, text => resizeTable(text, request.tables!, headerText));
    }
    if (drawingsChanged) {
      const imported = baseline.drawings.get(sheet.id) ?? [];
      for (const part of new Set(imported.map(item => item.part))) {
        const text = read(part);
        if (text === undefined) continue;
        const next = rewriteSheetDrawings(text, imported.filter(item => item.part === part), drawings?.[sheet.id]?.data);
        if (next !== text) files.set(part, encoder.encode(next));
      }
    }
    // After the comment and VML parts followed the row and column edits.
    if (noteEdits) {
      const text = sheetTexts.get(sheet.part)!;
      const next = rewriteNotes(files, sheet.part, text, noteEdits);
      if (next !== text) {
        sheetTexts.set(sheet.part, next);
        files.set(sheet.part, encoder.encode(next));
      }
    }
    if (charts || images.length) {
      const text = sheetTexts.get(sheet.part)!;
      const next = writeDrawings(sheet.part, text, charts, images);
      if (next !== text) {
        sheetTexts.set(sheet.part, next);
        files.set(sheet.part, encoder.encode(next));
      }
    }
    if (changes.cells.size) syncTableHeaders(files, baseline, sheet.part, changes, allFormulas);
  }

  // Sheets added in the editor start from an empty worksheet part.
  const newParts: NewSheetPart[] = plan.added.length ? allocateSheetParts(files, baseline, plan.added) : [];
  for (const part of newParts) {
    const sheetFilter = filters?.[part.id];
    const now = withFilteredRows(current.sheets[part.id], sheetFilter?.cachedFilteredOut);
    const empty: Partial<IWorksheetData> = { cellData: {}, rowData: {}, columnData: {}, mergeData: [] };
    const changes = diffSheet(empty, now, baseline.snapshot.styles, current.styles, defaults);
    let xml = blankWorksheet(baseline.pkg.text(baseline.sheets[0].part), pixelsToPoints(now.defaultRowHeight ?? 20));
    const context: PatchContext = {
      sheetId: part.id, styles, resolveFormula: request.resolveFormula, mdw: baseline.maxDigitWidth,
      defaultColumnWidth: now.defaultColumnWidth ?? Math.round(8.43 * baseline.maxDigitWidth + 5),
    };
    const patched = patchWorksheet(xml, changes, context, false);
    xml = patched.xml;
    if (patched.cellsChanged) cellsChanged = true;
    if (patched.formulas) formulas = true;
    xml = patchSheetView(xml, sheetViewState(empty), sheetViewState(now));
    const rules = conditionalFormats[part.id] ?? [];
    if (rules.length) {
      xml = rewriteConditionalFormats(xml, { imported: [], current: rules, maps: plan.maps(part.id), scope: plan.scope(), dxf: style => styles.dxfFor(style) });
    }
    const checks = validations?.[part.id] ?? [];
    if (checks.length) xml = rewriteDataValidations(xml, { imported: [], current: checks, maps: plan.maps(part.id), scope: plan.scope() });
    const links = hyperlinkChanges(empty, now);
    if (links) xml = writeLinks(part.part, xml, links);
    if (sheetFilter) {
      xml = rewriteAutoFilter(xml, sheetFilter, style => styles.dxfFor(style));
      filterDatabases.set(currentNames.get(part.id) ?? part.id, sheetFilter.ref);
    }
    const sheetNotes = notes ? noteChanges([], notes[part.id], plan.maps(part.id)) : undefined;
    if (sheetNotes) xml = rewriteNotes(files, part.part, xml, sheetNotes);
    xml = writeDrawings(part.part, xml, drawings ? chartChanges([], drawings[part.id], SHEET_CHART_COMPONENT) : undefined, drawings ? imageChanges([], drawings[part.id]) : []);
    sheetTexts.set(part.part, xml);
    files.set(part.part, encoder.encode(xml));
  }

  if (plan.referencesMoved) {
    const scope = plan.scope();
    for (const [name] of files) {
      if (!CHART_PART.test(name) || modelCharts.has(name)) continue;
      const text = read(name)!;
      const next = transformChart(text, scope);
      if (next !== text) files.set(name, encoder.encode(next));
    }
  }

  const stylesXml = styles.toXml();
  if (stylesXml) {
    const stylesPart = baseline.pkg.relationships(baseline.workbookPart).find(item => item.type === RelationshipType.Styles && !item.external)!.target;
    files.set(stylesPart, encoder.encode(stylesXml));
  }

  let workbookXml = baseline.pkg.text(baseline.workbookPart)!;
  const namedFilters = () => { workbookXml = syncFilterDatabases(workbookXml, filterDatabases); };
  if (plan.sheetsChanged || plan.referencesMoved || statesChanged) {
    const states = new Map<string, WorkbookSheetState>(plan.currentOrder.map(id => [id, { name: current.sheets[id].name ?? id, state: sheetState(current.sheets[id]) }]));
    const rewritten = rewriteWorkbookSheets(workbookXml, {
      baseline, plan, order: plan.currentOrder, states, newParts: new Map(newParts.map(part => [part.id, part])), preferredActive: request.activeSheetId,
    });
    workbookXml = rewritten.xml;
    if (rewritten.activeChanged && rewritten.activeSheetId) {
      const parts = [
        ...work.map(item => ({ id: item.sheet.id, part: item.sheet.part })),
        ...newParts.map(part => ({ id: part.id, part: part.part })),
      ];
      for (const { id, part } of parts) {
        const text = sheetTexts.get(part) ?? read(part);
        if (text === undefined) continue;
        const next = setTabSelected(text, id === rewritten.activeSheetId);
        if (next !== text) {
          sheetTexts.set(part, next);
          files.set(part, encoder.encode(next));
        }
      }
    }
  }
  namedFilters();
  const structural = plan.sheetsChanged || plan.referencesMoved;
  if (cellsChanged || structural) {
    removeCalcChain(files, baseline);
    if (formulas) workbookXml = requestFullCalculation(workbookXml);
  }
  if (workbookXml !== baseline.pkg.text(baseline.workbookPart)) files.set(baseline.workbookPart, encoder.encode(workbookXml));
  if (newParts.length || plan.deleted.length) updateWorkbookRelationships(files, baseline, newParts, plan.deleted);
  if (plan.sheetsChanged) dropStaleTitles(files);
  return { bytes: writePackage(files), changed: true };
}
