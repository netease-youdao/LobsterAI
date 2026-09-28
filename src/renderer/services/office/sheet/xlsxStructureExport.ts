import type { ICellData, IRange, IWorksheetData } from '@univerjs/core';

import { type CellRange, cellReference, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, parseCellReference, parseRangeReference, rangeReference } from './sheetAddress';
import {
  type FormulaScope, isIdentity, mapCell, mapRange, mapRanges, parseSqref, type SheetFate, type SheetMaps, sheetMaps,
  type StructureOp, transformAnchoredFormula, transformFormula, transformSqref,
} from './sheetStructure';
import type { ImportedSheet, WorkbookBaseline } from './xlsxImport';
import { relationshipsPath, RelationshipType } from './xlsxPackage';
import {
  addElementPrefix, appendChildren, decodeXml, elementPrefix, encodeXmlAttribute, encodeXmlText, firstXmlElement, setXmlAttributes, xmlAttribute,
  type XmlElement, xmlElements,
} from './xlsxXml';

/**
 * The structural half of the .xlsx writer: rows and columns inserted or deleted, sheets added,
 * deleted, renamed, reordered or hidden, panes frozen. Parts are rewritten as text; an element
 * whose references did not move keeps its bytes.
 */

const EMU_PER_PIXEL = 9525;
const SHEET_MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKSHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

export const RelationshipTypes = {
  Drawing: `${OFFICE_REL_NS}/drawing`,
  VmlDrawing: `${OFFICE_REL_NS}/vmlDrawing`,
  Comments: `${OFFICE_REL_NS}/comments`,
  ThreadedComments: 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment',
  Chart: `${OFFICE_REL_NS}/chart`,
  ChartEx: 'http://schemas.microsoft.com/office/2014/relationships/chartEx',
} as const;

// ---------------------------------------------------------------------------------------------
// Plan

/** What happened to the workbook's sheets since it was opened. */
export class StructurePlan {
  readonly fates = new Map<string, SheetFate>();
  private readonly byName = new Map<string, SheetFate>();
  readonly deleted: ImportedSheet[] = [];
  readonly added: string[];
  readonly renamed: boolean;
  readonly reordered: boolean;
  /** Anything that can move a reference: row/column edits, renamed or deleted sheets. */
  readonly referencesMoved: boolean;
  /** Anything that changes the workbook's list of sheets. */
  readonly sheetsChanged: boolean;

  constructor(readonly baseline: Pick<WorkbookBaseline, 'sheets'>, readonly currentOrder: string[], currentNames: Map<string, string>, readonly ops: readonly StructureOp[]) {
    const original = new Set(baseline.sheets.map(sheet => sheet.id));
    let renamed = false;
    for (const sheet of baseline.sheets) {
      const name = currentNames.get(sheet.id) ?? null;
      const fate: SheetFate = { name, renamed: name !== null && name !== sheet.name, maps: sheetMaps(ops, sheet.id) };
      if (fate.renamed) renamed = true;
      if (name === null) this.deleted.push(sheet);
      this.fates.set(sheet.id, fate);
      this.byName.set(sheet.name.toLowerCase(), fate);
    }
    this.added = currentOrder.filter(id => !original.has(id));
    const surviving = baseline.sheets.map(sheet => sheet.id).filter(id => currentNames.has(id));
    this.reordered = surviving.join('\u0000') !== currentOrder.filter(id => original.has(id)).join('\u0000');
    this.renamed = renamed;
    const opsOnSurvivors = ops.some(op => original.has(op.sheetId) && currentNames.has(op.sheetId));
    this.referencesMoved = opsOnSurvivors || renamed || this.deleted.length > 0;
    this.sheetsChanged = renamed || this.deleted.length > 0 || this.added.length > 0 || this.reordered;
  }

  maps(sheetId: string): SheetMaps {
    return this.fates.get(sheetId)?.maps ?? sheetMaps([], sheetId);
  }

  /** How formulas of one sheet (by original name), or of the workbook when omitted, resolve sheet names. */
  scope(homeSheet?: string): FormulaScope {
    return { homeSheet, sheet: name => this.byName.get(name.toLowerCase()) };
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot alignment

/** The imported snapshot of a sheet with its rows and columns moved as the edits moved them. */
export function alignSheetSnapshot(sheet: Partial<IWorksheetData>, maps: SheetMaps): Partial<IWorksheetData> {
  if (isIdentity(maps)) return sheet;
  const cellData: IWorksheetData['cellData'] = {};
  for (const [rowKey, row] of Object.entries(sheet.cellData ?? {})) {
    const targetRow = maps.rows.index(Number(rowKey));
    if (targetRow === null || !row) continue;
    for (const [columnKey, cell] of Object.entries(row as Record<string, ICellData>)) {
      const targetColumn = maps.columns.index(Number(columnKey));
      if (targetColumn === null) continue;
      (cellData[targetRow] ??= {})[targetColumn] = cell;
    }
  }
  const moveKeys = <T>(data: Record<string, T> | undefined, map: SheetMaps['rows']): Record<number, T> => {
    const result: Record<number, T> = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      const target = map.index(Number(key));
      if (target !== null) result[target] = value;
    }
    return result;
  };
  return {
    ...sheet,
    cellData,
    rowData: moveKeys(sheet.rowData as Record<string, NonNullable<IWorksheetData['rowData'][number]>>, maps.rows),
    columnData: moveKeys(sheet.columnData as Record<string, NonNullable<IWorksheetData['columnData'][number]>>, maps.columns),
    mergeData: mapRanges(sheet.mergeData ?? [], maps) as IRange[],
  };
}

// ---------------------------------------------------------------------------------------------
// Element helpers

/** Replace (string), drop (null) or keep (undefined) every `<local>` element in `[from, to)`. */
function mapElements(xml: string, local: string, fn: (element: XmlElement) => string | null | undefined, from = 0, to = xml.length): string {
  let result = '';
  let offset = 0;
  let changed = false;
  for (const element of xmlElements(xml, local, from, to)) {
    const replacement = fn(element);
    if (replacement === undefined) continue;
    result += xml.slice(offset, element.start) + (replacement ?? '');
    offset = element.end;
    changed = true;
  }
  return changed ? result + xml.slice(offset) : xml;
}

function replaceInner(xml: string, element: XmlElement, inner: string): string {
  const close = `</${element.name}>`;
  const open = element.inner === undefined ? element.open.replace(/\/>$/, '>') : element.open;
  return xml.slice(0, element.start) + open + inner + close + xml.slice(element.end);
}

function elementMarkup(element: XmlElement, open: string, inner: string | undefined): string {
  return inner === undefined ? open : `${open.replace(/\/>$/, '>')}${inner}</${element.name}>`;
}

/** Rewrite the text of every `<local>` element holding a formula; unchanged text keeps its bytes. */
function mapFormulaElements(xml: string, local: string, transform: (formula: string) => string): string {
  return mapElements(xml, local, element => {
    // A wrapper such as x14's <x14:formula1><xm:f>…</xm:f></x14:formula1>: its <f> is mapped on its own.
    if (element.inner === undefined || element.inner.includes('<')) return undefined;
    const formula = decodeXml(element.inner);
    const next = transform(formula);
    return next === formula ? undefined : `${element.open}${encodeXmlText(next)}</${element.name}>`;
  });
}

/** Rewrite an sqref-like attribute; null drops the element. */
function mapRefAttribute(open: string, name: string, maps: SheetMaps): string | null | undefined {
  const value = xmlAttribute(open, name);
  if (value === undefined) return undefined;
  const next = transformSqref(value, maps);
  if (next === null) return null;
  return next === value ? undefined : setXmlAttributes(open, { [name]: next });
}

// ---------------------------------------------------------------------------------------------
// Worksheet parts

export interface WorksheetTransform {
  maps: SheetMaps;
  scope: FormulaScope;
}

function alignSheetData(xml: string, maps: SheetMaps): string {
  const sheetData = firstXmlElement(xml, 'sheetData');
  if (!sheetData?.inner) return xml;
  const inner = sheetData.inner;
  let result = '';
  let offset = 0;
  let previousRow = -1;
  for (const row of xmlElements(inner, 'row')) {
    result += inner.slice(offset, row.start);
    offset = row.end;
    const explicit = xmlAttribute(row.open, 'r');
    const index = explicit ? Number(explicit) - 1 : previousRow + 1;
    previousRow = index;
    const target = maps.rows.index(index);
    if (target === null) continue;
    const open = setXmlAttributes(row.open, { r: String(target + 1), spans: undefined });
    if (row.inner === undefined) { result += open; continue; }
    let cells = '';
    let cellOffset = 0;
    let previousColumn = -1;
    for (const cell of xmlElements(row.inner, 'c')) {
      cells += row.inner.slice(cellOffset, cell.start);
      cellOffset = cell.end;
      const reference = xmlAttribute(cell.open, 'r');
      const column = reference ? parseCellReference(reference)?.column ?? previousColumn + 1 : previousColumn + 1;
      previousColumn = column;
      const targetColumn = maps.columns.index(column);
      if (targetColumn === null) continue;
      cells += elementMarkup(cell, setXmlAttributes(cell.open, { r: cellReference(target, targetColumn) }), cell.inner);
    }
    cells += row.inner.slice(cellOffset);
    result += `${open}${cells}</${row.name}>`;
  }
  result += inner.slice(offset);
  return replaceInner(xml, sheetData, result);
}

/** Split `<col>` ranges around inserted columns and drop deleted ones; an inserted column starts with default properties. */
function alignColumns(xml: string, maps: SheetMaps): string {
  if (maps.columns.identity) return xml;
  const cols = firstXmlElement(xml, 'cols');
  if (!cols?.inner) return xml;
  let markup = '';
  for (const col of xmlElements(cols.inner, 'col')) {
    const min = Number(xmlAttribute(col.open, 'min'));
    const max = Math.min(Number(xmlAttribute(col.open, 'max')), EXCEL_MAX_COLUMNS);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) continue;
    let runStart = -1;
    let runEnd = -1;
    const flush = () => {
      if (runStart >= 0) markup += setXmlAttributes(col.open.replace(/>$/, '/>').replace(/\/\/>$/, '/>'), { min: String(runStart + 1), max: String(runEnd + 1) });
      runStart = runEnd = -1;
    };
    for (let column = min - 1; column < max; column++) {
      const target = maps.columns.index(column);
      if (target === null) { flush(); continue; }
      if (runStart >= 0 && target === runEnd + 1) runEnd = target;
      else { flush(); runStart = runEnd = target; }
    }
    flush();
  }
  const prefix = elementPrefix(cols.name);
  if (!markup) return xml.slice(0, cols.start) + xml.slice(cols.end);
  return xml.slice(0, cols.start) + `${cols.open}${markup.replace(/<(\/?)(?:[\w.-]+:)?col(?=[\s/>])/g, `<$1${prefix}col`)}</${cols.name}>` + xml.slice(cols.end);
}

function transformMergeCells(xml: string, maps: SheetMaps): string {
  const merges = firstXmlElement(xml, 'mergeCells');
  if (!merges?.inner) return xml;
  let count = 0;
  const inner = mapElements(merges.inner, 'mergeCell', element => {
    const ref = xmlAttribute(element.open, 'ref');
    const range = ref ? parseRangeReference(ref) : undefined;
    if (!range) { count++; return undefined; }
    const mapped = mapRange(maps, range);
    if (!mapped) return null;
    count++;
    const text = rangeReference(mapped);
    return text === ref ? undefined : setXmlAttributes(element.open, { ref: text });
  });
  if (!count) return xml.slice(0, merges.start) + xml.slice(merges.end);
  if (inner === merges.inner) return xml;
  return xml.slice(0, merges.start) + setXmlAttributes(merges.open, { count: String(count) }) + inner + `</${merges.name}>` + xml.slice(merges.end);
}

function transformDimension(xml: string, maps: SheetMaps): string {
  const dimension = firstXmlElement(xml, 'dimension');
  const ref = dimension && xmlAttribute(dimension.open, 'ref');
  const range = ref ? parseRangeReference(ref) : undefined;
  if (!dimension || !range) return xml;
  const mapped = mapRange(maps, range) ?? { startRow: 0, startColumn: 0, endRow: 0, endColumn: 0 };
  const text = rangeReference(mapped);
  return text === ref ? xml : xml.slice(0, dimension.start) + setXmlAttributes(dimension.open, { ref: text }) + xml.slice(dimension.end);
}

function transformCellAttribute(open: string, name: string, maps: SheetMaps): string {
  const value = xmlAttribute(open, name);
  if (value === undefined) return open;
  const next = transformSqref(value, maps) ?? 'A1';
  return next === value ? open : setXmlAttributes(open, { [name]: next });
}

function transformSheetViews(xml: string, maps: SheetMaps): string {
  const views = firstXmlElement(xml, 'sheetViews');
  if (!views?.inner) return xml;
  let inner = mapElements(views.inner, 'sheetView', element => {
    const open = transformCellAttribute(element.open, 'topLeftCell', maps);
    return open === element.open ? undefined : elementMarkup(element, open, element.inner);
  });
  inner = mapElements(inner, 'pane', element => {
    const open = transformCellAttribute(element.open, 'topLeftCell', maps);
    return open === element.open ? undefined : open;
  });
  inner = mapElements(inner, 'selection', element => {
    const open = transformCellAttribute(transformCellAttribute(element.open, 'activeCell', maps), 'sqref', maps);
    return open === element.open ? undefined : open;
  });
  return inner === views.inner ? xml : replaceInner(xml, views, inner);
}

/** Conditional formats and data validations: ranges move, rule formulas follow and rebase. */
function transformRuleContainer(xml: string, local: string, formulaElements: string[], transform: WorksheetTransform): string {
  return mapElements(xml, local, element => {
    const sqrefAttribute = xmlAttribute(element.open, 'sqref');
    const sqrefChild = sqrefAttribute === undefined && element.inner !== undefined ? firstXmlElement(element.inner, 'sqref') : undefined;
    const sqref = sqrefAttribute ?? (sqrefChild?.inner !== undefined ? decodeXml(sqrefChild.inner) : undefined);
    if (sqref === undefined) return undefined;
    const before = parseSqref(sqref);
    const nextSqref = transformSqref(sqref, transform.maps);
    if (nextSqref === null) return null;
    const after = parseSqref(nextSqref);
    let inner = element.inner;
    if (inner !== undefined) {
      for (const name of formulaElements) {
        inner = mapFormulaElements(inner, name, formula => transformAnchoredFormula(formula, transform.scope, transform.maps, before, after));
      }
      inner = mapElements(inner, 'cfvo', cfvo => {
        const value = xmlAttribute(cfvo.open, 'val');
        if (value === undefined) return undefined;
        const next = transformFormula(value, transform.scope);
        return next === value ? undefined : elementMarkup(cfvo, setXmlAttributes(cfvo.open, { val: next }), cfvo.inner);
      });
      if (sqrefChild && nextSqref !== sqref) {
        const child = firstXmlElement(inner, 'sqref')!;
        inner = replaceInner(inner, child, encodeXmlText(nextSqref));
      }
    }
    const open = sqrefAttribute !== undefined && nextSqref !== sqref ? setXmlAttributes(element.open, { sqref: nextSqref }) : element.open;
    if (open === element.open && inner === element.inner) return undefined;
    return elementMarkup(element, open, inner);
  });
}

/** Keep a container's `count` attribute honest, or drop the container when its children are gone. */
function recount(xml: string, container: string, child: string): string {
  return mapElements(xml, container, element => {
    if (element.inner === undefined) return undefined;
    const count = [...xmlElements(element.inner, child)].length;
    if (!count) return null;
    const existing = xmlAttribute(element.open, 'count');
    if (existing === undefined || Number(existing) === count) return undefined;
    return `${setXmlAttributes(element.open, { count: String(count) })}${element.inner}</${element.name}>`;
  });
}

function transformHyperlinks(xml: string, transform: WorksheetTransform): string {
  const container = firstXmlElement(xml, 'hyperlinks');
  if (!container?.inner) return xml;
  const inner = mapElements(container.inner, 'hyperlink', element => {
    const moved = mapRefAttribute(element.open, 'ref', transform.maps);
    if (moved === null) return null;
    let open = moved ?? element.open;
    const location = xmlAttribute(open, 'location');
    if (location !== undefined) {
      const next = transformFormula(location, transform.scope);
      if (next !== location) open = setXmlAttributes(open, { location: next });
    }
    return open === element.open ? undefined : elementMarkup(element, open, element.inner);
  });
  if (inner === container.inner) return xml;
  if (![...xmlElements(inner, 'hyperlink')].length) return xml.slice(0, container.start) + xml.slice(container.end);
  return replaceInner(xml, container, inner);
}

/** Filter and sort state; filter columns are numbered from the filter range's first column. */
export function transformAutoFilter(xml: string, maps: SheetMaps): string {
  return mapElements(xml, 'autoFilter', element => {
    const ref = xmlAttribute(element.open, 'ref');
    const range = ref ? parseRangeReference(ref) : undefined;
    if (!range) return undefined;
    const mapped = mapRange(maps, range);
    if (!mapped) return null;
    let inner = element.inner;
    if (inner !== undefined) {
      inner = mapElements(inner, 'filterColumn', column => {
        const id = Number(xmlAttribute(column.open, 'colId'));
        if (!Number.isInteger(id)) return undefined;
        const target = maps.columns.index(range.startColumn + id);
        if (target === null) return null;
        const next = target - mapped.startColumn;
        return next === id ? undefined : elementMarkup(column, setXmlAttributes(column.open, { colId: String(next) }), column.inner);
      });
    }
    const text = rangeReference(mapped);
    const open = text === ref ? element.open : setXmlAttributes(element.open, { ref: text });
    return open === element.open && inner === element.inner ? undefined : elementMarkup(element, open, inner);
  });
}

/** Every `sortState` of a part, whether it stands alone or sits inside a filter. */
function transformSortState(xml: string, maps: SheetMaps): string {
  return mapElements(xml, 'sortState', element => {
    const moved = mapRefAttribute(element.open, 'ref', maps);
    if (moved === null) return null;
    let inner = element.inner;
    if (inner !== undefined) inner = mapElements(inner, 'sortCondition', condition => mapRefAttribute(condition.open, 'ref', maps));
    const open = moved ?? element.open;
    return open === element.open && inner === element.inner ? undefined : elementMarkup(element, open, inner);
  });
}

function transformBreaks(xml: string, local: 'rowBreaks' | 'colBreaks', map: SheetMaps['rows']): string {
  return mapElements(xml, local, element => {
    if (element.inner === undefined || map.identity) return undefined;
    const seen = new Set<number>();
    let manual = 0;
    const inner = mapElements(element.inner, 'brk', brk => {
      const id = Number(xmlAttribute(brk.open, 'id'));
      if (!Number.isInteger(id)) return undefined;
      const target = map.settle(id);
      if (target <= 0 || seen.has(target)) return null;
      seen.add(target);
      if (['1', 'true'].includes(xmlAttribute(brk.open, 'man') ?? '')) manual++;
      return target === id ? undefined : setXmlAttributes(brk.open, { id: String(target) });
    });
    if (!seen.size) return null;
    const changes: Record<string, string | undefined> = { count: String(seen.size) };
    if (xmlAttribute(element.open, 'manualBreakCount') !== undefined) changes.manualBreakCount = String(manual);
    return `${setXmlAttributes(element.open, changes)}${inner}</${element.name}>`;
  });
}

function transformSqrefList(xml: string, container: string, child: string, maps: SheetMaps): string {
  const outer = firstXmlElement(xml, container);
  if (!outer?.inner) return xml;
  const inner = mapElements(outer.inner, child, element => {
    const moved = mapRefAttribute(element.open, 'sqref', maps);
    return moved === undefined ? undefined : moved === null ? null : elementMarkup(element, moved, element.inner);
  });
  if (inner === outer.inner) return xml;
  if (![...xmlElements(inner, child)].length) return xml.slice(0, outer.start) + xml.slice(outer.end);
  return replaceInner(xml, outer, inner);
}

function transformSparklines(xml: string, transform: WorksheetTransform): string {
  return mapElements(xml, 'sparklineGroup', group => {
    if (group.inner === undefined) return undefined;
    let inner = mapElements(group.inner, 'sparkline', sparkline => {
      if (sparkline.inner === undefined) return undefined;
      const sqref = firstXmlElement(sparkline.inner, 'sqref');
      let content = sparkline.inner;
      if (sqref?.inner !== undefined) {
        const location = decodeXml(sqref.inner);
        const next = transformSqref(location, transform.maps);
        if (next === null) return null;
        if (next !== location) content = replaceInner(content, sqref, encodeXmlText(next));
      }
      content = mapFormulaElements(content, 'f', formula => transformFormula(formula, transform.scope));
      return content === sparkline.inner ? undefined : `${sparkline.open}${content}</${sparkline.name}>`;
    });
    inner = mapFormulaElements(inner, 'f', formula => transformFormula(formula, transform.scope));
    if (inner === group.inner) return undefined;
    if (![...xmlElements(inner, 'sparkline')].length) return null;
    return `${group.open}${inner}</${group.name}>`;
  });
}

/** Every reference in a worksheet part: cells, rows, columns, merges, views and the rules that name ranges. */
export function transformWorksheet(xml: string, transform: WorksheetTransform): string {
  const { maps } = transform;
  let result = xml;
  if (!isIdentity(maps)) {
    result = alignSheetData(result, maps);
    result = alignColumns(result, maps);
    result = transformMergeCells(result, maps);
    result = transformDimension(result, maps);
    result = transformSheetViews(result, maps);
    result = transformBreaks(result, 'rowBreaks', maps.rows);
    result = transformBreaks(result, 'colBreaks', maps.columns);
    result = transformSqrefList(result, 'ignoredErrors', 'ignoredError', maps);
    result = transformSqrefList(result, 'protectedRanges', 'protectedRange', maps);
  }
  result = transformAutoFilter(result, maps);
  result = transformSortState(result, maps);
  result = transformRuleContainer(result, 'conditionalFormatting', ['formula', 'f'], transform);
  result = transformRuleContainer(result, 'dataValidation', ['formula1', 'formula2', 'f'], transform);
  result = recount(result, 'dataValidations', 'dataValidation');
  result = transformHyperlinks(result, transform);
  result = transformSparklines(result, transform);
  return result === xml ? xml : dropEmptyExtensions(result);
}

/** Extension containers emptied by dropped rules would be invalid; remove them and their `ext`. */
function dropEmptyExtensions(xml: string): string {
  let result = xml;
  for (const container of ['conditionalFormattings', 'dataValidations', 'sparklineGroups']) {
    result = mapElements(result, container, element => (element.inner !== undefined && !element.inner.trim() ? null : undefined));
  }
  if (result === xml) return xml;
  const list = /<((?:[\w.-]+:)?extLst)[\s>]/.exec(result);
  if (!list) return result;
  const listEnd = result.indexOf(`</${list[1]}>`, list.index);
  if (listEnd < 0) return result;
  const extPrefix = list[1].slice(0, list[1].length - 'extLst'.length);
  const inner = result.slice(result.indexOf('>', list.index) + 1, listEnd);
  // Direct `<ext>` children only; extensions may nest their own extension lists.
  const token = new RegExp(`<(/?)${extPrefix.replace(/[.]/g, '\\.')}ext(?=[\\s/>])[^>]*?(/?)>`, 'g');
  let depth = 0;
  let start = -1;
  const empty: [number, number][] = [];
  for (let match = token.exec(inner); match; match = token.exec(inner)) {
    if (match[1]) {
      if (--depth === 0 && start >= 0) {
        const end = match.index + match[0].length;
        const content = inner.slice(inner.indexOf('>', start) + 1, match.index);
        if (!content.trim()) empty.push([start, end]);
        start = -1;
      }
    } else if (!match[2]) {
      if (depth++ === 0) start = match.index;
    }
  }
  if (!empty.length) return result;
  let trimmed = inner;
  for (const [from, to] of empty.reverse()) trimmed = trimmed.slice(0, from) + trimmed.slice(to);
  const listStart = list.index;
  const openEnd = result.indexOf('>', listStart) + 1;
  return trimmed.trim()
    ? result.slice(0, openEnd) + trimmed + result.slice(listEnd)
    : result.slice(0, listStart) + result.slice(listEnd + list[1].length + 3);
}

// ---------------------------------------------------------------------------------------------
// Related parts: drawings, notes, tables and charts

/** Sizes along one axis, for positioning floating objects in EMUs. */
export class AxisGeometry {
  private readonly keys: number[];
  private readonly prefix: number[];

  constructor(private readonly defaultSize: number, private readonly overrides: Map<number, number>) {
    this.keys = [...overrides.keys()].sort((a, b) => a - b);
    this.prefix = [];
    let sum = 0;
    for (const key of this.keys) {
      sum += overrides.get(key)! - defaultSize;
      this.prefix.push(sum);
    }
  }

  static rows(sheet: Partial<IWorksheetData>): AxisGeometry {
    const overrides = new Map<number, number>();
    for (const [key, row] of Object.entries(sheet.rowData ?? {})) {
      if (row?.hd) overrides.set(Number(key), 0);
      else if (typeof row?.h === 'number') overrides.set(Number(key), row.h * EMU_PER_PIXEL);
    }
    return new AxisGeometry((sheet.defaultRowHeight ?? 20) * EMU_PER_PIXEL, overrides);
  }

  static columns(sheet: Partial<IWorksheetData>): AxisGeometry {
    const overrides = new Map<number, number>();
    for (const [key, column] of Object.entries(sheet.columnData ?? {})) {
      if (column?.hd) overrides.set(Number(key), 0);
      else if (typeof column?.w === 'number') overrides.set(Number(key), column.w * EMU_PER_PIXEL);
    }
    return new AxisGeometry((sheet.defaultColumnWidth ?? 72) * EMU_PER_PIXEL, overrides);
  }

  size(index: number): number {
    return this.overrides.get(index) ?? this.defaultSize;
  }

  /** Offset of the start of `index` from the sheet's edge. */
  start(index: number): number {
    let low = 0;
    let high = this.keys.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.keys[middle] < index) low = middle + 1;
      else high = middle;
    }
    return index * this.defaultSize + (low > 0 ? this.prefix[low - 1] : 0);
  }

  locate(position: number, limit: number): { index: number; offset: number } {
    let low = 0;
    let high = limit - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.start(middle) <= position) low = middle;
      else high = middle - 1;
    }
    return { index: low, offset: Math.max(0, Math.round(position - this.start(low))) };
  }
}

export interface SheetGeometry {
  before: { rows: AxisGeometry; columns: AxisGeometry };
  after: { rows: AxisGeometry; columns: AxisGeometry };
}

interface AnchorPoint { column: number; columnOffset: number; row: number; rowOffset: number }

function readPoint(xml: string): AnchorPoint | undefined {
  const value = (name: string) => Number(decodeXml(firstXmlElement(xml, name)?.inner ?? ''));
  const point = { column: value('col'), columnOffset: value('colOff'), row: value('row'), rowOffset: value('rowOff') };
  return Object.values(point).every(Number.isFinite) ? point : undefined;
}

function writePoint(xml: string, point: AnchorPoint): string {
  let result = xml;
  for (const [name, value] of [['col', point.column], ['colOff', point.columnOffset], ['row', point.row], ['rowOff', point.rowOffset]] as const) {
    const element = firstXmlElement(result, name);
    if (element?.inner !== undefined && decodeXml(element.inner) !== String(Math.round(value))) result = replaceInner(result, element, String(Math.round(value)));
  }
  return result;
}

function movePoint(point: AnchorPoint, maps: SheetMaps): AnchorPoint {
  const row = maps.rows.index(point.row);
  const column = maps.columns.index(point.column);
  return {
    row: row ?? maps.rows.settle(point.row), rowOffset: row === null ? 0 : point.rowOffset,
    column: column ?? maps.columns.settle(point.column), columnOffset: column === null ? 0 : point.columnOffset,
  };
}

/**
 * Drawing anchors follow Excel's placement settings: "move and size with cells" anchors stretch
 * and shrink with their rows and columns (and disappear with them), "move but don't size" keeps
 * the object's size, "don't move or size" keeps its position on the page.
 */
export function transformDrawing(xml: string, maps: SheetMaps, geometry: SheetGeometry, scope: FormulaScope): string {
  let result = xml;
  if (!isIdentity(maps)) {
    result = mapElements(result, 'twoCellAnchor', anchor => {
      if (anchor.inner === undefined) return undefined;
      const fromElement = firstXmlElement(anchor.inner, 'from');
      const toElement = firstXmlElement(anchor.inner, 'to');
      const from = fromElement?.inner && readPoint(fromElement.inner);
      const to = toElement?.inner && readPoint(toElement.inner);
      if (!fromElement || !toElement || !from || !to) return undefined;
      const mode = xmlAttribute(anchor.open, 'editAs') ?? 'twoCell';
      let nextFrom: AnchorPoint;
      let nextTo: AnchorPoint;
      if (mode === 'absolute') {
        const locate = (point: AnchorPoint): AnchorPoint => {
          const row = geometry.after.rows.locate(geometry.before.rows.start(point.row) + point.rowOffset, EXCEL_MAX_ROWS);
          const column = geometry.after.columns.locate(geometry.before.columns.start(point.column) + point.columnOffset, EXCEL_MAX_COLUMNS);
          return { row: row.index, rowOffset: row.offset, column: column.index, columnOffset: column.offset };
        };
        nextFrom = locate(from);
        nextTo = locate(to);
      } else if (mode === 'oneCell') {
        nextFrom = movePoint(from, maps);
        const height = geometry.before.rows.start(to.row) + to.rowOffset - geometry.before.rows.start(from.row) - from.rowOffset;
        const width = geometry.before.columns.start(to.column) + to.columnOffset - geometry.before.columns.start(from.column) - from.columnOffset;
        const row = geometry.after.rows.locate(geometry.after.rows.start(nextFrom.row) + nextFrom.rowOffset + height, EXCEL_MAX_ROWS);
        const column = geometry.after.columns.locate(geometry.after.columns.start(nextFrom.column) + nextFrom.columnOffset + width, EXCEL_MAX_COLUMNS);
        nextTo = { row: row.index, rowOffset: row.offset, column: column.index, columnOffset: column.offset };
      } else {
        const rows = maps.rows.range(from.row, to.row);
        const columns = maps.columns.range(from.column, to.column);
        if (!rows || !columns) return null;
        const fromRow = maps.rows.index(from.row);
        const fromColumn = maps.columns.index(from.column);
        const toRow = maps.rows.index(to.row);
        const toColumn = maps.columns.index(to.column);
        nextFrom = { row: rows[0], rowOffset: fromRow === null ? 0 : from.rowOffset, column: columns[0], columnOffset: fromColumn === null ? 0 : from.columnOffset };
        nextTo = {
          row: toRow === null ? rows[1] + 1 : rows[1], rowOffset: toRow === null ? 0 : to.rowOffset,
          column: toColumn === null ? columns[1] + 1 : columns[1], columnOffset: toColumn === null ? 0 : to.columnOffset,
        };
      }
      let inner = anchor.inner;
      const toNow = firstXmlElement(inner, 'to')!;
      inner = replaceInner(inner, toNow, writePoint(toNow.inner!, nextTo));
      const fromNow = firstXmlElement(inner, 'from')!;
      inner = replaceInner(inner, fromNow, writePoint(fromNow.inner!, nextFrom));
      return inner === anchor.inner ? undefined : `${anchor.open}${inner}</${anchor.name}>`;
    });
    result = mapElements(result, 'oneCellAnchor', anchor => {
      if (anchor.inner === undefined) return undefined;
      const fromElement = firstXmlElement(anchor.inner, 'from');
      const from = fromElement?.inner && readPoint(fromElement.inner);
      if (!fromElement || !from) return undefined;
      const inner = replaceInner(anchor.inner, fromElement, writePoint(fromElement.inner!, movePoint(from, maps)));
      return inner === anchor.inner ? undefined : `${anchor.open}${inner}</${anchor.name}>`;
    });
  }
  // Shapes can show a cell's text (`textlink`).
  result = result.replace(/(\stextlink\s*=\s*")([^"]*)(")/g, (match, head: string, value: string, tail: string) => {
    const formula = decodeXml(value);
    const next = transformFormula(formula, scope);
    return next === formula ? match : `${head}${encodeXmlAttribute(next)}${tail}`;
  });
  return result;
}

/** Legacy notes: the note's cell and the anchor of its box. */
export function transformVml(xml: string, maps: SheetMaps): string {
  if (isIdentity(maps)) return xml;
  return mapElements(xml, 'shape', shape => {
    if (shape.inner === undefined) return undefined;
    const data = firstXmlElement(shape.inner, 'ClientData');
    if (data?.inner === undefined) return undefined;
    const rowElement = firstXmlElement(data.inner, 'Row');
    const columnElement = firstXmlElement(data.inner, 'Column');
    const row = Number(rowElement?.inner?.trim());
    const column = Number(columnElement?.inner?.trim());
    if (!Number.isInteger(row) || !Number.isInteger(column)) return undefined;
    const target = mapCell(maps, row, column);
    if (!target) return null;
    if (target.row === row && target.column === column) return undefined;
    let inner = data.inner;
    inner = replaceInner(inner, firstXmlElement(inner, 'Row')!, String(target.row));
    inner = replaceInner(inner, firstXmlElement(inner, 'Column')!, String(target.column));
    const anchor = firstXmlElement(inner, 'Anchor');
    if (anchor?.inner !== undefined) {
      const values = anchor.inner.split(',').map(value => Number(value.trim()));
      if (values.length === 8 && values.every(Number.isFinite)) {
        const [dRow, dColumn] = [target.row - row, target.column - column];
        const moved = [values[0] + dColumn, values[1], values[2] + dRow, values[3], values[4] + dColumn, values[5], values[6] + dRow, values[7]].map(value => Math.max(0, value));
        inner = replaceInner(inner, anchor, ` ${moved.join(', ')}`);
      }
    }
    const content = replaceInner(shape.inner, data, inner);
    return `${shape.open}${content}</${shape.name}>`;
  });
}

/** Notes and threaded comments keyed by their cell. */
export function transformCommentRefs(xml: string, local: 'comment' | 'threadedComment', maps: SheetMaps): string {
  if (isIdentity(maps)) return xml;
  return mapElements(xml, local, element => {
    const ref = xmlAttribute(element.open, 'ref');
    const cell = ref ? parseCellReference(ref) : undefined;
    if (!cell) return undefined;
    const target = mapCell(maps, cell.row, cell.column);
    if (!target) return null;
    const text = cellReference(target.row, target.column);
    return text === ref ? undefined : elementMarkup(element, setXmlAttributes(element.open, { ref: text }), element.inner);
  });
}

/** A table header cell's text at a position of the current sheet. */
export type HeaderText = (row: number, column: number) => string | undefined;

/**
 * A table's columns over its new range, as Excel keeps them: `source` gives the existing column
 * that lands on a sheet column, if one does; a new column gets the next id and its header cell's
 * text for a name (`ColumnN` when that cell is empty or repeats a name).
 */
function rebuildTableColumns(xml: string, after: CellRange, source: (column: number) => number | undefined, headerText?: HeaderText): string {
  const element = firstXmlElement(xml, 'tableColumns');
  const table = firstXmlElement(xml, 'table');
  if (!table || element?.inner === undefined) return xml;
  const columns = [...xmlElements(element.inner, 'tableColumn')];
  const kept = new Map<number, XmlElement>();
  for (let column = after.startColumn; column <= after.endColumn; column++) {
    const index = source(column);
    if (index !== undefined && columns[index]) kept.set(column, columns[index]);
  }
  if (kept.size === columns.length && after.endColumn - after.startColumn + 1 === columns.length && [...kept.values()].every((column, index) => column === columns[index])) return xml;
  const names = new Set([...kept.values()].map(column => (xmlAttribute(column.open, 'name') ?? '').toLowerCase()));
  let nextId = Math.max(0, ...columns.map(column => Number(xmlAttribute(column.open, 'id')) || 0)) + 1;
  const header = Number(xmlAttribute(table.open, 'headerRowCount') ?? 1) > 0;
  const prefix = elementPrefix(element.name);
  const markup: string[] = [];
  for (let column = after.startColumn; column <= after.endColumn; column++) {
    const own = kept.get(column);
    if (own) {
      markup.push(element.inner.slice(own.start, own.end));
      continue;
    }
    let name = (header ? headerText?.(after.startRow, column) : undefined)?.trim() ?? '';
    if (!name || names.has(name.toLowerCase())) {
      let index = 1;
      while (names.has(`column${index}`)) index++;
      name = `Column${index}`;
    }
    names.add(name.toLowerCase());
    markup.push(`<${prefix}tableColumn id="${nextId++}" name="${encodeXmlAttribute(name)}"/>`);
  }
  const open = setXmlAttributes(element.open, { count: String(markup.length) });
  return `${xml.slice(0, element.start)}${open}${markup.join('')}${xml.slice(element.innerStart + element.inner.length)}`;
}

/**
 * A table grown by typing next to it (Excel's AutoExpansion) to its current range: its reference,
 * its filter over the header and data rows, and new columns on the right.
 */
export function resizeTable(xml: string, ranges: ReadonlyMap<string, CellRange>, headerText?: HeaderText): string {
  const table = firstXmlElement(xml, 'table');
  const name = table && (xmlAttribute(table.open, 'displayName') ?? xmlAttribute(table.open, 'name'));
  const range = name ? ranges.get(name) : undefined;
  const before = table && parseRangeReference(xmlAttribute(table.open, 'ref') ?? '');
  if (!table || !range || !before) return xml;
  const text = rangeReference(range);
  if (text === rangeReference(before)) return xml;
  let result = xml.slice(0, table.start) + setXmlAttributes(table.open, { ref: text }) + xml.slice(table.start + table.open.length);
  const totals = Number(xmlAttribute(table.open, 'totalsRowCount') ?? 0);
  result = mapElements(result, 'autoFilter', element => elementMarkup(element, setXmlAttributes(element.open, { ref: rangeReference({ ...range, endRow: range.endRow - totals }) }), element.inner));
  const width = before.endColumn - before.startColumn + 1;
  return rebuildTableColumns(result, range, column => (column - range.startColumn < width ? column - range.startColumn : undefined), headerText);
}

/** An Excel table's range, columns, filter, sort state and column formulas. */
export function transformTable(xml: string, maps: SheetMaps, scope: FormulaScope, headerText?: HeaderText): string {
  let result = xml;
  const table = firstXmlElement(result, 'table');
  if (table && !isIdentity(maps)) {
    const before = parseRangeReference(xmlAttribute(table.open, 'ref') ?? '');
    const moved = mapRefAttribute(table.open, 'ref', maps);
    if (moved) result = result.slice(0, table.start) + moved + result.slice(table.start + table.open.length);
    if (before && !maps.columns.identity) {
      const after = mapRange(maps, before);
      const sources = new Map<number, number>();
      for (let index = 0; index <= before.endColumn - before.startColumn; index++) {
        const column = maps.columns.index(before.startColumn + index);
        if (column !== null) sources.set(column, index);
      }
      if (after) result = rebuildTableColumns(result, after, column => sources.get(column), headerText);
    }
  }
  if (!isIdentity(maps)) {
    result = transformAutoFilter(result, maps);
    result = transformSortState(result, maps);
  }
  result = mapFormulaElements(result, 'calculatedColumnFormula', formula => transformFormula(formula, scope));
  result = mapFormulaElements(result, 'totalsRowFormula', formula => transformFormula(formula, scope));
  return result;
}

/** Series, labels and titles of a chart name their data by sheet-qualified references. */
export function transformChart(xml: string, scope: FormulaScope): string {
  let result = mapFormulaElements(xml, 'f', formula => transformFormula(formula, scope));
  result = mapFormulaElements(result, 'sqref', formula => transformFormula(formula, scope));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Sheet views: frozen panes, grid lines, zoom, tab color

export interface SheetViewState {
  freeze?: { xSplit: number; ySplit: number; startRow: number; startColumn: number } | null;
  showGridlines: boolean;
  /** Zoom in percent, as Excel stores it (10–400); undefined at 100%. */
  zoom?: number;
  tabColor?: string;
}

/** Excel's zoom range. */
const ZOOM_RANGE = [10, 400] as const;

export function sheetViewState(sheet: Partial<IWorksheetData> | undefined): SheetViewState {
  const freeze = sheet?.freeze;
  const zoom = typeof sheet?.zoomRatio === 'number' && Number.isFinite(sheet.zoomRatio)
    ? Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], Math.round(sheet.zoomRatio * 100))) : 100;
  return {
    freeze: freeze && (freeze.xSplit > 0 || freeze.ySplit > 0) ? { xSplit: freeze.xSplit, ySplit: freeze.ySplit, startRow: freeze.startRow, startColumn: freeze.startColumn } : null,
    showGridlines: sheet?.showGridlines !== 0,
    ...(zoom !== 100 ? { zoom } : {}),
    tabColor: normalizeTabColor(sheet?.tabColor),
  };
}

export function normalizeTabColor(color: unknown): string | undefined {
  if (typeof color !== 'string' || !color.trim()) return undefined;
  const value = color.trim();
  const hex = /^#?([\da-f]{6})$/i.exec(value);
  if (hex) return hex[1].toUpperCase();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
  if (short) return short.slice(1).map(char => char + char).join('').toUpperCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(value);
  if (rgb) return rgb.slice(1, 4).map(part => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
}

const sameFreeze = (a: SheetViewState['freeze'], b: SheetViewState['freeze']): boolean => (a?.xSplit ?? 0) === (b?.xSplit ?? 0) && (a?.ySplit ?? 0) === (b?.ySplit ?? 0);

export function viewChanged(before: SheetViewState, after: SheetViewState): boolean {
  return !sameFreeze(before.freeze, after.freeze) || before.showGridlines !== after.showGridlines || before.zoom !== after.zoom || before.tabColor !== after.tabColor;
}

/** The pane and selections Excel writes for a frozen view (or for none). */
function paneMarkup(freeze: SheetViewState['freeze'], prefix: string): string {
  if (!freeze) return addElementPrefix('<selection activeCell="A1" sqref="A1"/>', prefix);
  const row = Math.max(freeze.ySplit, freeze.startRow > 0 ? freeze.startRow : 0);
  const column = Math.max(freeze.xSplit, freeze.startColumn > 0 ? freeze.startColumn : 0);
  const topLeft = cellReference(freeze.ySplit ? row : 0, freeze.xSplit ? column : 0);
  const pane = freeze.xSplit && freeze.ySplit ? 'bottomRight' : freeze.ySplit ? 'bottomLeft' : 'topRight';
  const splits = `${freeze.xSplit ? ` xSplit="${freeze.xSplit}"` : ''}${freeze.ySplit ? ` ySplit="${freeze.ySplit}"` : ''}`;
  let markup = `<pane${splits} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/>`;
  if (freeze.xSplit && freeze.ySplit) {
    markup += `<selection pane="topRight" activeCell="${cellReference(0, column)}" sqref="${cellReference(0, column)}"/>`;
    markup += `<selection pane="bottomLeft" activeCell="${cellReference(row, 0)}" sqref="${cellReference(row, 0)}"/>`;
  }
  markup += `<selection pane="${pane}" activeCell="${topLeft}" sqref="${topLeft}"/>`;
  return addElementPrefix(markup, prefix);
}

/** Write frozen panes, grid lines, zoom and the tab color of a sheet that changed them. */
export function patchSheetView(xml: string, before: SheetViewState, after: SheetViewState): string {
  let result = xml;
  const views = firstXmlElement(result, 'sheetViews');
  const prefix = elementPrefix(firstXmlElement(result, 'worksheet')?.name ?? '');
  const zoomed = before.zoom !== after.zoom;
  if (!sameFreeze(before.freeze, after.freeze) || before.showGridlines !== after.showGridlines || zoomed) {
    const view = views?.inner !== undefined ? firstXmlElement(views.inner, 'sheetView') : undefined;
    if (views?.inner !== undefined && view) {
      let open = view.open;
      if (before.showGridlines !== after.showGridlines) open = setXmlAttributes(open, { showGridLines: after.showGridlines ? undefined : '0' });
      // Excel keeps the Normal view's zoom in zoomScaleNormal as well.
      if (zoomed) open = setXmlAttributes(open, { zoomScale: after.zoom ? String(after.zoom) : undefined, zoomScaleNormal: after.zoom ? String(after.zoom) : undefined });
      let inner = view.inner ?? '';
      if (!sameFreeze(before.freeze, after.freeze)) {
        inner = mapElements(inner, 'pane', () => null);
        inner = mapElements(inner, 'selection', () => null);
        inner = paneMarkup(after.freeze, prefix) + inner;
      }
      const markup = inner ? `${open.replace(/\/>$/, '>')}${inner}</${view.name}>` : open;
      result = replaceInner(result, views, views.inner.slice(0, view.start) + markup + views.inner.slice(view.end));
    } else {
      const zoom = after.zoom ? ` zoomScale="${after.zoom}" zoomScaleNormal="${after.zoom}"` : '';
      const sheetView = `<sheetView${after.showGridlines ? '' : ' showGridLines="0"'}${zoom} workbookViewId="0">${after.freeze ? paneMarkup(after.freeze, '') : ''}</sheetView>`;
      const markup = addElementPrefix(`<sheetViews>${sheetView}</sheetViews>`, prefix);
      if (views) {
        result = result.slice(0, views.start) + markup + result.slice(views.end);
      } else {
        const anchor = firstXmlElement(result, 'sheetFormatPr') ?? firstXmlElement(result, 'cols') ?? firstXmlElement(result, 'sheetData');
        if (anchor) result = result.slice(0, anchor.start) + markup + result.slice(anchor.start);
      }
    }
  }
  if (before.tabColor !== after.tabColor) result = patchTabColor(result, after.tabColor, prefix);
  return result;
}

function patchTabColor(xml: string, color: string | undefined, prefix: string): string {
  const tab = color ? addElementPrefix(`<tabColor rgb="FF${color}"/>`, prefix) : '';
  const sheetPr = firstXmlElement(xml, 'sheetPr');
  if (sheetPr) {
    const inner = mapElements(sheetPr.inner ?? '', 'tabColor', () => null);
    return replaceInner(xml, sheetPr, tab + inner);
  }
  if (!tab) return xml;
  const worksheet = firstXmlElement(xml, 'worksheet');
  if (!worksheet) return xml;
  const at = worksheet.innerStart;
  return xml.slice(0, at) + addElementPrefix(`<sheetPr>${tab}</sheetPr>`, prefix) + xml.slice(at);
}

/** Only the active sheet carries `tabSelected`; more would group the sheets in Excel. */
export function setTabSelected(xml: string, selected: boolean): string {
  const view = firstXmlElement(xml, 'sheetView');
  if (!view) return xml;
  const current = ['1', 'true'].includes(xmlAttribute(view.open, 'tabSelected') ?? '');
  if (current === selected) return xml;
  return xml.slice(0, view.start) + setXmlAttributes(view.open, { tabSelected: selected ? '1' : undefined }) + xml.slice(view.start + view.open.length);
}

// ---------------------------------------------------------------------------------------------
// New sheets

/**
 * An empty worksheet part. Its row and column defaults copy another sheet of the workbook
 * (unprefixed attributes of its `sheetFormatPr`), so Excel sizes it like the rest.
 */
export function blankWorksheet(template: string | undefined, defaultRowHeightPoints: number): string {
  const format = template ? firstXmlElement(template, 'sheetFormatPr') : undefined;
  const attributes = format ? [...format.open.matchAll(/\s([A-Za-z]+)\s*=\s*"([^"]*)"/g)].map(match => [match[1], match[2]] as const) : [];
  const values = new Map<string, string>(attributes);
  const height = String(Math.round(defaultRowHeightPoints * 100) / 100);
  if (values.get('defaultRowHeight') !== height) {
    values.set('defaultRowHeight', height);
    values.set('customHeight', '1');
  }
  const formatMarkup = `<sheetFormatPr${[...values].map(([name, value]) => ` ${name}="${value}"`).join('')}/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SHEET_MAIN_NS}" xmlns:r="${OFFICE_REL_NS}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>${formatMarkup}<sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}

/** Hyperlinks some writers store as relationships to `#Sheet!A1` instead of a `location`. */
export function transformHyperlinkTargets(rels: string, scope: FormulaScope): string {
  return mapElements(rels, 'Relationship', element => {
    const target = xmlAttribute(element.open, 'Target');
    if (!target?.startsWith('#') || !xmlAttribute(element.open, 'Type')?.endsWith('/hyperlink')) return undefined;
    const next = transformFormula(target.slice(1), scope);
    return next === target.slice(1) ? undefined : setXmlAttributes(element.open, { Target: `#${next}` });
  });
}

// ---------------------------------------------------------------------------------------------
// Workbook: sheets, names, views, relationships and content types

export interface NewSheetPart {
  id: string;
  part: string;
  relationshipId: string;
}

export interface WorkbookSheetState {
  name: string;
  state?: 'hidden' | 'veryHidden';
}

interface SheetEntry {
  originalIndex?: number;
  element?: XmlElement;
  id?: string;
}

/**
 * Rewrite `<sheets>`, `<definedNames>` and `<bookViews>` for renamed, added, deleted, reordered
 * and hidden sheets. Returns the new workbook XML and the sheet id now active.
 */
export function rewriteWorkbookSheets(xml: string, options: {
  baseline: WorkbookBaseline;
  plan: StructurePlan;
  order: string[];
  states: Map<string, WorkbookSheetState>;
  newParts: Map<string, NewSheetPart>;
  preferredActive?: string;
}): { xml: string; activeSheetId?: string; activeChanged: boolean } {
  const { baseline, plan, order, states, newParts } = options;
  const sheetsElement = firstXmlElement(xml, 'sheets');
  if (!sheetsElement?.inner) return { xml, activeChanged: false };
  const originals = [...xmlElements(sheetsElement.inner, 'sheet')];
  const idByIndex = new Map(baseline.sheets.map(sheet => [sheet.index, sheet.id]));
  const indexById = new Map(baseline.sheets.map(sheet => [sheet.id, sheet.index]));

  // New order: worksheets as the editor orders them; other sheets (charts) stay after the worksheet they followed.
  const followers = new Map<number, number[]>();
  const leading: number[] = [];
  let lastWorksheet = -1;
  originals.forEach((_element, index) => {
    if (idByIndex.has(index)) { lastWorksheet = index; return; }
    if (lastWorksheet < 0) leading.push(index);
    else followers.set(lastWorksheet, [...(followers.get(lastWorksheet) ?? []), index]);
  });
  const entries: SheetEntry[] = leading.map(index => ({ originalIndex: index, element: originals[index] }));
  for (const id of order) {
    const index = indexById.get(id);
    if (index !== undefined) {
      entries.push({ originalIndex: index, element: originals[index], id });
      for (const follower of followers.get(index) ?? []) entries.push({ originalIndex: follower, element: originals[follower] });
    } else {
      entries.push({ id });
    }
  }
  for (const sheet of plan.deleted) {
    for (const follower of followers.get(sheet.index) ?? []) entries.push({ originalIndex: follower, element: originals[follower] });
  }

  const relationshipAttribute = originals.map(element => [...element.open.matchAll(/\s([\w.-]+:id)\s*=/g)].map(match => match[1])[0]).find(Boolean) ?? 'r:id';
  let nextSheetId = Math.max(0, ...originals.map(element => Number(xmlAttribute(element.open, 'sheetId')) || 0)) + 1;
  const prefix = elementPrefix(originals[0]?.name ?? sheetsElement.name);
  const markup = entries.map(entry => {
    const state = entry.id ? states.get(entry.id) : undefined;
    if (entry.element) {
      const original = xml.slice(sheetsElement.innerStart + entry.element.start, sheetsElement.innerStart + entry.element.end);
      if (!state) return original;
      const changes: Record<string, string | undefined> = {};
      if (xmlAttribute(entry.element.open, 'name') !== state.name) changes.name = state.name;
      const was = xmlAttribute(entry.element.open, 'state');
      if ((was === 'visible' ? undefined : was) !== state.state) changes.state = state.state;
      if (!Object.keys(changes).length) return original;
      const open = setXmlAttributes(entry.element.open, changes);
      return entry.element.inner === undefined ? open : `${open}${entry.element.inner}</${entry.element.name}>`;
    }
    const part = newParts.get(entry.id!)!;
    return addElementPrefix(`<sheet name="${encodeXmlAttribute(state!.name)}" sheetId="${nextSheetId++}"${state?.state ? ` state="${state.state}"` : ''} ${relationshipAttribute}="${part.relationshipId}"/>`, prefix);
  }).join('');
  let result = replaceInner(xml, sheetsElement, markup);

  // Sheet-scoped names point at sheets by position.
  const newIndexByOriginal = new Map<number, number>();
  entries.forEach((entry, index) => { if (entry.originalIndex !== undefined) newIndexByOriginal.set(entry.originalIndex, index); });
  const workbookScope = plan.scope();
  const names = firstXmlElement(result, 'definedNames');
  if (names?.inner !== undefined) {
    let inner = mapElements(names.inner, 'definedName', element => {
      const local = xmlAttribute(element.open, 'localSheetId');
      let open = element.open;
      if (local !== undefined) {
        const target = newIndexByOriginal.get(Number(local));
        if (target === undefined) return null;
        if (target !== Number(local)) open = setXmlAttributes(open, { localSheetId: String(target) });
      }
      let inner = element.inner;
      if (inner !== undefined && plan.referencesMoved) {
        const formula = decodeXml(inner);
        const next = transformFormula(formula, workbookScope);
        if (next !== formula) inner = encodeXmlText(next);
      }
      return open === element.open && inner === element.inner ? undefined : elementMarkup(element, open, inner);
    });
    if (![...xmlElements(inner, 'definedName')].length) inner = '';
    result = inner
      ? (inner === names.inner ? result : replaceInner(result, firstXmlElement(result, 'definedNames')!, inner))
      : (() => { const element = firstXmlElement(result, 'definedNames')!; return result.slice(0, element.start) + result.slice(element.end); })();
  }

  // The active tab must stay on a visible sheet.
  const view = firstXmlElement(result, 'workbookView');
  const visible = (entry: SheetEntry) => (entry.id !== undefined && states.has(entry.id)
    ? !states.get(entry.id)!.state
    : !['hidden', 'veryHidden'].includes(xmlAttribute(entry.element?.open ?? '<x>', 'state') ?? ''));
  let activeSheetId: string | undefined;
  let activeChanged = false;
  if (view) {
    const originalActive = Number(xmlAttribute(view.open, 'activeTab') ?? 0);
    const originalId = idByIndex.get(originalActive);
    let target = entries.findIndex(entry => entry.originalIndex === originalActive);
    if (target < 0 || !visible(entries[target])) {
      const preferred = options.preferredActive ? entries.findIndex(entry => entry.id === options.preferredActive && visible(entry)) : -1;
      target = preferred >= 0 ? preferred : entries.findIndex(visible);
    }
    activeSheetId = entries[target]?.id;
    activeChanged = activeSheetId !== originalId;
    const changes: Record<string, string | undefined> = {};
    if (target >= 0 && target !== originalActive) changes.activeTab = target ? String(target) : undefined;
    const first = xmlAttribute(view.open, 'firstSheet');
    if (first !== undefined && Number(first) >= entries.length) changes.firstSheet = undefined;
    if (Object.keys(changes).length) result = result.slice(0, view.start) + setXmlAttributes(view.open, changes) + result.slice(view.start + view.open.length);
  }
  return { xml: result, activeSheetId, activeChanged };
}

/** Relationship and content-type bookkeeping for added and deleted worksheets. */
export function updateWorkbookRelationships(files: Map<string, Uint8Array>, baseline: WorkbookBaseline, newParts: NewSheetPart[], deleted: ImportedSheet[]): void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const before = reachableParts(files);
  const relsPath = relationshipsPath(baseline.workbookPart);
  let rels = decoder.decode(files.get(relsPath) ?? new Uint8Array());
  const deletedIds = new Set<string>();
  const workbookRelations = baseline.pkg.relationships(baseline.workbookPart);
  for (const sheet of deleted) {
    const relation = workbookRelations.find(item => item.type === RelationshipType.Worksheet && item.target === sheet.part);
    if (relation) deletedIds.add(relation.id);
  }
  if (deletedIds.size) rels = mapElements(rels, 'Relationship', element => (deletedIds.has(xmlAttribute(element.open, 'Id') ?? '') ? null : undefined));
  if (newParts.length) {
    const relsPrefix = elementPrefix(firstXmlElement(rels, 'Relationships')?.name ?? '');
    const workbookDir = baseline.workbookPart.slice(0, baseline.workbookPart.lastIndexOf('/') + 1);
    const additions = newParts.map(part => addElementPrefix(`<Relationship Id="${part.relationshipId}" Type="${RelationshipType.Worksheet}" Target="${part.part.startsWith(workbookDir) ? part.part.slice(workbookDir.length) : `/${part.part}`}"/>`, relsPrefix)).join('');
    rels = appendChildren(rels, 'Relationships', additions) ?? rels;
  }
  files.set(relsPath, encoder.encode(rels));

  // Parts only the deleted sheets used go with them.
  for (const sheet of deleted) {
    files.delete(sheet.part);
    files.delete(relationshipsPath(sheet.part));
  }
  const after = reachableParts(files);
  const removed = [...before].filter(part => !after.has(part));
  for (const part of removed) {
    files.delete(part);
    files.delete(relationshipsPath(part));
  }

  let types = decoder.decode(files.get('[Content_Types].xml') ?? new Uint8Array());
  const gone = new Set([...deleted.map(sheet => `/${sheet.part}`), ...removed.map(part => `/${part}`)]);
  if (gone.size) types = mapElements(types, 'Override', element => (gone.has(xmlAttribute(element.open, 'PartName') ?? '') ? null : undefined));
  if (newParts.length) {
    const additions = newParts.map(part => `<Override PartName="/${part.part}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`).join('');
    types = appendChildren(types, 'Types', additions) ?? types;
  }
  files.set('[Content_Types].xml', encoder.encode(types));
}

/** Parts reachable from the package root through internal relationships. */
function reachableParts(files: Map<string, Uint8Array>): Set<string> {
  const decoder = new TextDecoder();
  const seen = new Set<string>();
  const queue: string[] = [''];
  while (queue.length) {
    const part = queue.pop()!;
    const relsPath = part ? relationshipsPath(part) : '_rels/.rels';
    const rels = files.get(relsPath);
    if (!rels) continue;
    for (const element of xmlElements(decoder.decode(rels), 'Relationship')) {
      if (xmlAttribute(element.open, 'TargetMode')?.toLowerCase() === 'external') continue;
      const target = xmlAttribute(element.open, 'Target');
      if (target === undefined) continue;
      const resolved = resolveTarget(part, target);
      if (!seen.has(resolved) && files.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return seen;
}

function resolveTarget(source: string, target: string): string {
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') {
      try { segments.push(decodeURIComponent(segment)); } catch { segments.push(segment); }
    }
  }
  return segments.join('/');
}

/** Sheet titles in docProps/app.xml go stale when sheets change; Excel rebuilds them on save. */
export function dropStaleTitles(files: Map<string, Uint8Array>): void {
  const part = 'docProps/app.xml';
  const bytes = files.get(part);
  if (!bytes) return;
  const xml = new TextDecoder().decode(bytes);
  let result = mapElements(xml, 'HeadingPairs', () => null);
  result = mapElements(result, 'TitlesOfParts', () => null);
  if (result !== xml) files.set(part, new TextEncoder().encode(result));
}

/** The next free `xl/worksheets/sheetN.xml` and relationship id. */
export function allocateSheetParts(files: Map<string, Uint8Array>, baseline: WorkbookBaseline, ids: string[]): NewSheetPart[] {
  const used = new Set(files.keys());
  const rels = new TextDecoder().decode(files.get(relationshipsPath(baseline.workbookPart)) ?? new Uint8Array());
  const relationIds = new Set([...xmlElements(rels, 'Relationship')].map(element => xmlAttribute(element.open, 'Id') ?? ''));
  const directory = `${baseline.workbookPart.slice(0, baseline.workbookPart.lastIndexOf('/') + 1)}worksheets/`;
  let partNumber = 1;
  let relationNumber = 1;
  return ids.map(id => {
    while (used.has(`${directory}sheet${partNumber}.xml`)) partNumber++;
    const part = `${directory}sheet${partNumber}.xml`;
    used.add(part);
    while (relationIds.has(`rId${relationNumber}`)) relationNumber++;
    const relationshipId = `rId${relationNumber}`;
    relationIds.add(relationshipId);
    return { id, part, relationshipId };
  });
}

/** The parts related to a worksheet, by relationship type. */
export function relatedParts(files: Map<string, Uint8Array>, part: string, type: string): string[] {
  const rels = files.get(relationshipsPath(part));
  if (!rels) return [];
  const result: string[] = [];
  for (const element of xmlElements(new TextDecoder().decode(rels), 'Relationship')) {
    if (xmlAttribute(element.open, 'Type') !== type || xmlAttribute(element.open, 'TargetMode')?.toLowerCase() === 'external') continue;
    const target = xmlAttribute(element.open, 'Target');
    if (target !== undefined) result.push(resolveTarget(part, target));
  }
  return result;
}

export { mapElements };
