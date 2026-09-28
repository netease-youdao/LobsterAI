import {
  BooleanNumber, ColorKit, DateSystem, excelSerialToDateTimeParts, type IRange, type IRowData, type IStyleData, type IWorkbookData, type IWorksheetData,
} from '@univerjs/core';

import { columnLabel, parseRangeReference, rangeReference } from './sheetAddress';
import { formulaSheetName, mapRange, type SheetMaps } from './sheetStructure';
import { stable } from './xlsxConditionalFormatExport';
import { mapElements } from './xlsxStructureExport';
import {
  addElementPrefix, appendChildren, childInsertionPoint, elementPrefix, encodeXmlAttribute, encodeXmlText, firstChildElement, firstXmlElement, setXmlAttributes, xmlAttribute,
  xmlElements,
} from './xlsxXml';

/**
 * A worksheet's AutoFilter in Univer's filter model, whose shape follows the file's. Excel keeps
 * filtered-out rows as hidden rows, so those rows load as filtered (not hidden by hand) and are
 * written back as hidden rows. The `<autoFilter>` element is rewritten only when the filter changed.
 */

/** Resource the filter plugin stores its filters in (SHEET_FILTER_PLUGIN). */
export const FILTERS_RESOURCE = 'SHEET_FILTER_PLUGIN';
const FILTER_DATABASE = '_xlnm._FilterDatabase';
const OPERATORS = new Set(['equal', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'notEqual']);
/** Worksheet children that follow `<autoFilter>`, in schema order. */
const AFTER_AUTO_FILTER = ['sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting',
  'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties',
  'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst'];
/** Workbook children that follow `<definedNames>`, in schema order. */
const AFTER_DEFINED_NAMES = ['calcPr', 'oleSize', 'customWorkbookViews', 'pivotCaches', 'smartTagPr', 'smartTagTypes', 'webPublishing',
  'fileRecoveryPr', 'webPublishObjects', 'extLst'];

export interface FilterColumn {
  /** Sheet column index (Excel counts from the filter's first column). */
  colId: number;
  filters?: { blank?: true; filters?: string[] };
  customFilters?: { and?: 1; customFilters: { val: string | number; operator?: string }[] };
  colorFilters?: { cellFillColors?: (string | null)[]; cellTextColors?: string[] };
}

export interface SheetFilter {
  ref: IRange;
  filterColumns?: FilterColumn[];
  /** Rows the filter hides. */
  cachedFilteredOut?: number[];
  /** Criteria the grid shows as value lists once the workbook is loaded; not part of the filter model. */
  pending?: PendingFilterColumn[];
}

/** How far a `dateGroupItem` matches a date. */
export const DateGrouping = { Year: 'year', Month: 'month', Day: 'day', Hour: 'hour', Minute: 'minute', Second: 'second' } as const;
export type DateGrouping = typeof DateGrouping[keyof typeof DateGrouping];
const DATE_PARTS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

export interface DateGroup {
  grouping: DateGrouping;
  year: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/**
 * Criteria Univer cannot evaluate: they become the list of values that pass, which needs the
 * cells' displayed text (so it is worked out once the grid has the workbook).
 */
export interface PendingFilterColumn {
  colId: number;
  /** Values listed next to the date groups. */
  values: string[];
  blank: boolean;
  /** Dates in any of these pass (Excel's date tree). */
  dateGroups: DateGroup[];
  /** A dynamic filter by month (1–12) or quarter (1–4) of any year. */
  month?: number;
  quarter?: number;
  /** Criteria nothing here can evaluate (icon sets, relative dates): the rows shown now pass. */
  shown?: true;
}

/** The sheet's own AutoFilter element: not one saved inside a custom view. */
const sheetAutoFilter = (xml: string) => firstChildElement(xml, 'worksheet', 'autoFilter');

function dateGroup(open: string): DateGroup | undefined {
  const grouping = xmlAttribute(open, 'dateTimeGrouping') as DateGrouping | undefined;
  const level = grouping ? DATE_PARTS.indexOf(grouping) : -1;
  const year = Number(xmlAttribute(open, 'year'));
  if (level < 0 || !Number.isInteger(year)) return undefined;
  const group: DateGroup = { grouping: grouping!, year };
  for (const part of DATE_PARTS.slice(1, level + 1)) {
    const value = Number(xmlAttribute(open, part));
    if (!Number.isInteger(value)) return undefined;
    group[part] = value;
  }
  return group;
}

const rgbText = (color: string): string => new ColorKit(color).toRgbString();

/**
 * A worksheet's AutoFilter, or undefined without one. Criteria Univer has no model for become
 * conditions where Excel saved the numbers they stand for (top 10 threshold, average, date range),
 * colors where the format resolves, and value lists worked out after loading otherwise; the
 * `<autoFilter>` keeps its markup unless the filter is changed.
 */
export function importAutoFilter(xml: string, hidden: (row: number) => boolean, dxfStyle?: (id: number) => IStyleData | undefined): SheetFilter | undefined {
  const element = sheetAutoFilter(xml);
  const ref = element && parseRangeReference(xmlAttribute(element.open, 'ref') ?? '');
  if (!element || !ref) return undefined;
  const filterColumns: FilterColumn[] = [];
  const pending: PendingFilterColumn[] = [];
  const later = (colId: number, criteria: Partial<PendingFilterColumn>) => pending.push({ colId, values: [], blank: false, dateGroups: [], ...criteria });
  const condition = (colId: number, customFilters: { val: number; operator?: string }[], and = false) => filterColumns.push({ colId, customFilters: { ...(and ? { and: 1 as const } : {}), customFilters } });
  for (const column of element.inner ? xmlElements(element.inner, 'filterColumn') : []) {
    const offset = Number(xmlAttribute(column.open, 'colId'));
    if (!Number.isInteger(offset) || !column.inner) continue;
    const colId = ref.startColumn + offset;
    const filters = firstXmlElement(column.inner, 'filters');
    const custom = firstXmlElement(column.inner, 'customFilters');
    const top10 = firstXmlElement(column.inner, 'top10');
    const dynamic = firstXmlElement(column.inner, 'dynamicFilter');
    const color = firstXmlElement(column.inner, 'colorFilter');
    if (filters) {
      const values = filters.inner ? [...xmlElements(filters.inner, 'filter')].map(item => xmlAttribute(item.open, 'val') ?? '') : [];
      const blank = xmlAttribute(filters.open, 'blank') === '1';
      const dateGroups = filters.inner ? [...xmlElements(filters.inner, 'dateGroupItem')].map(item => dateGroup(item.open)).filter((group): group is DateGroup => Boolean(group)) : [];
      if (dateGroups.length) later(colId, { values, blank, dateGroups });
      else filterColumns.push({ colId, filters: { ...(blank ? { blank: true as const } : {}), ...(values.length ? { filters: values } : {}) } });
    } else if (custom?.inner) {
      const items = [...xmlElements(custom.inner, 'customFilter')].map(item => {
        const operator = xmlAttribute(item.open, 'operator') ?? 'equal';
        const raw = xmlAttribute(item.open, 'val') ?? '';
        const number = Number(raw);
        return { val: raw !== '' && Number.isFinite(number) && !raw.includes('*') ? number : raw, ...(operator !== 'equal' ? { operator } : {}) };
      });
      if (!items.length || items.length > 2 || items.some(item => item.operator && !OPERATORS.has(item.operator))) later(colId, { shown: true });
      else filterColumns.push({ colId, customFilters: { ...(xmlAttribute(custom.open, 'and') === '1' ? { and: 1 as const } : {}), customFilters: items } });
    } else if (top10) {
      // Excel saves the value the top or bottom items start at.
      const threshold = Number(xmlAttribute(top10.open, 'filterVal') ?? NaN);
      if (Number.isFinite(threshold)) condition(colId, [{ operator: xmlAttribute(top10.open, 'top') === '0' ? 'lessThanOrEqual' : 'greaterThanOrEqual', val: threshold }]);
      else later(colId, { shown: true });
    } else if (dynamic) {
      const type = xmlAttribute(dynamic.open, 'type') ?? '';
      const value = Number(xmlAttribute(dynamic.open, 'val') ?? NaN);
      const maximum = Number(xmlAttribute(dynamic.open, 'maxVal') ?? NaN);
      const period = /^([MQ])(\d{1,2})$/.exec(type);
      if ((type === 'aboveAverage' || type === 'belowAverage') && Number.isFinite(value)) condition(colId, [{ operator: type === 'aboveAverage' ? 'greaterThan' : 'lessThan', val: value }]);
      // Relative dates (today, this month, …) are saved with the range they stood for.
      else if (Number.isFinite(value) && Number.isFinite(maximum)) condition(colId, [{ operator: 'greaterThanOrEqual', val: value }, { operator: 'lessThan', val: maximum }], true);
      else if (period?.[1] === 'M' && Number(period[2]) >= 1 && Number(period[2]) <= 12) later(colId, { month: Number(period[2]) });
      else if (period?.[1] === 'Q' && Number(period[2]) >= 1 && Number(period[2]) <= 4) later(colId, { quarter: Number(period[2]) });
      else later(colId, { shown: true });
    } else if (color) {
      const style = dxfStyle?.(Number(xmlAttribute(color.open, 'dxfId')));
      const byFont = xmlAttribute(color.open, 'cellColor') === '0';
      const rgb = byFont ? style?.cl?.rgb : style?.bg?.rgb;
      if (rgb) filterColumns.push({ colId, colorFilters: byFont ? { cellTextColors: [rgbText(rgb)] } : { cellFillColors: [rgbText(rgb)] } });
      else later(colId, { shown: true });
    } else if (firstXmlElement(column.inner, 'iconFilter')) {
      later(colId, { shown: true });
    }
  }
  const cachedFilteredOut: number[] = [];
  if (filterColumns.length || pending.length) for (let row = ref.startRow + 1; row <= ref.endRow; row++) if (hidden(row)) cachedFilteredOut.push(row);
  return { ref, ...(filterColumns.length ? { filterColumns } : {}), ...(cachedFilteredOut.length ? { cachedFilteredOut } : {}), ...(pending.length ? { pending } : {}) };
}

/** The filter as the filter model loads it: without the criteria worked out after loading. */
export function modelFilter(filter: SheetFilter): SheetFilter {
  const { pending: _pending, ...model } = filter;
  return model;
}

/**
 * The value list a pending column shows: the displayed text of the cells that pass it. `cell`
 * reads a row's displayed text and, for dates, its serial number.
 */
export function pendingFilterValues(
  pending: PendingFilterColumn, filter: SheetFilter, cell: (row: number) => { text: string; serial?: number }, dateSystem: DateSystem = DateSystem.Date1900,
): { filters?: string[]; blank?: true } {
  const hiddenRows = new Set(filter.cachedFilteredOut ?? []);
  const values = new Set<string>();
  let blank = false;
  for (let row = filter.ref.startRow + 1; row <= filter.ref.endRow; row++) {
    const { text, serial } = cell(row);
    const parts = serial === undefined ? null : excelSerialToDateTimeParts(serial, { dateSystem });
    let passes: boolean;
    if (pending.shown) passes = !hiddenRows.has(row);
    else if (!text) passes = pending.blank;
    else if (pending.month !== undefined) passes = parts?.month === pending.month;
    else if (pending.quarter !== undefined) passes = Boolean(parts) && Math.ceil(parts!.month / 3) === pending.quarter;
    else {
      const fields = parts && { year: parts.year, month: parts.month, day: parts.day, hour: parts.hours, minute: parts.minutes, second: parts.seconds };
      passes = pending.values.includes(text) || Boolean(fields && pending.dateGroups.some(group => DATE_PARTS.every(part => group[part] === undefined || group[part] === fields[part])));
    }
    if (!passes) continue;
    if (text) values.add(text);
    else blank = true;
  }
  return { ...(blank ? { blank: true as const } : {}), ...(values.size ? { filters: [...values] } : {}) };
}

/** Compare later saves against the filters as the model holds them right after loading (criteria worked out included). */
export function adoptLoadedFilters(filters: Map<string, SheetFilter>, snapshot: IWorkbookData): void {
  const loaded = filtersOf(snapshot);
  if (!loaded) return;
  for (const [sheetId, filter] of Object.entries(loaded)) if (filters.has(sheetId) && filter) filters.set(sheetId, structuredClone(filter));
}

/** A sheet snapshot with the given rows hidden, as the file stores rows a filter hides. */
export function withFilteredRows<T extends Partial<IWorksheetData>>(sheet: T, rows: readonly number[] | undefined): T {
  if (!rows?.length) return sheet;
  const rowData = { ...(sheet.rowData ?? {}) } as Record<number, IRowData>;
  for (const row of rows) rowData[row] = { ...(rowData[row] ?? {}), hd: BooleanNumber.TRUE };
  return { ...sheet, rowData };
}

/** Filters of a Univer snapshot, per sheet id; undefined when the plugin is not loaded. */
export function filtersOf(snapshot: IWorkbookData): Record<string, SheetFilter> | undefined {
  const resource = snapshot.resources?.find(item => item.name === FILTERS_RESOURCE);
  if (!resource) return undefined;
  if (!resource.data) return {};
  try {
    const parsed = JSON.parse(resource.data) as Record<string, SheetFilter>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** A loaded filter as the row and column edits have moved it; null when its range was deleted. */
export function moveFilter(filter: SheetFilter, maps: SheetMaps): SheetFilter | null {
  const ref = mapRange(maps, filter.ref);
  if (!ref) return null;
  const filterColumns = (filter.filterColumns ?? []).flatMap(column => {
    const colId = maps.columns.index(column.colId);
    return colId === null ? [] : [{ ...column, colId }];
  });
  const cachedFilteredOut = (filter.cachedFilteredOut ?? []).map(row => maps.rows.index(row)).filter((row): row is number => row !== null);
  return { ref, ...(filterColumns.length ? { filterColumns } : {}), ...(cachedFilteredOut.length ? { cachedFilteredOut } : {}) };
}

/** Whether two filters have the same range and criteria (hidden rows are compared as rows). */
export function sameFilter(a: SheetFilter | null | undefined, b: SheetFilter | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const criteria = (filter: SheetFilter) => stable([...(filter.filterColumns ?? [])].sort((x, y) => x.colId - y.colId));
  return rangeReference(a.ref) === rangeReference(b.ref) && criteria(a) === criteria(b);
}

/**
 * The `<autoFilter>` element for a filter; colors need a differential format each. `kept` gives
 * the markup to keep for a column whose criteria did not change (its `colId` is updated).
 */
export function autoFilterMarkup(filter: SheetFilter, dxf: (style: IStyleData) => number, prefix = '', kept?: (column: FilterColumn) => string | undefined): string {
  const columns = [...(filter.filterColumns ?? [])].sort((a, b) => a.colId - b.colId).map(column => {
    const colId = column.colId - filter.ref.startColumn;
    const original = kept?.(column);
    if (original !== undefined) return original.replace(/^<[^>]*>/, open => setXmlAttributes(open, { colId: String(colId) }));
    let markup = '';
    if (column.filters) {
      const values = (column.filters.filters ?? []).map(value => `<filter val="${encodeXmlAttribute(value)}"/>`).join('');
      markup = `<filterColumn colId="${colId}"><filters${column.filters.blank ? ' blank="1"' : ''}>${values}</filters></filterColumn>`;
    } else if (column.customFilters) {
      const items = column.customFilters.customFilters.map(item => `<customFilter${item.operator && item.operator !== 'equal' ? ` operator="${item.operator}"` : ''} val="${encodeXmlAttribute(String(item.val))}"/>`).join('');
      markup = `<filterColumn colId="${colId}"><customFilters${column.customFilters.and ? ' and="1"' : ''}>${items}</customFilters></filterColumn>`;
    } else {
      // Excel filters one color per column.
      const fills = column.colorFilters?.cellFillColors?.filter((color): color is string => Boolean(color)) ?? [];
      const texts = column.colorFilters?.cellTextColors ?? [];
      if (fills.length === 1 && !texts.length) markup = `<filterColumn colId="${colId}"><colorFilter dxfId="${dxf({ bg: { rgb: fills[0] } })}"/></filterColumn>`;
      if (texts.length === 1 && !fills.length) markup = `<filterColumn colId="${colId}"><colorFilter dxfId="${dxf({ cl: { rgb: texts[0] } })}" cellColor="0"/></filterColumn>`;
    }
    return markup && addElementPrefix(markup, prefix);
  }).join('');
  return `${addElementPrefix(`<autoFilter ref="${rangeReference(filter.ref)}">`, prefix)}${columns}${addElementPrefix('</autoFilter>', prefix)}`;
}

/**
 * The worksheet with its AutoFilter replaced (or removed when `filter` is null). Columns whose
 * criteria match `previous` (the loaded filter, moved through row and column edits) keep their
 * markup, so criteria the editor shows another way (top 10, date groups, icons) stay Excel's.
 */
export function rewriteAutoFilter(xml: string, filter: SheetFilter | null, dxf: (style: IStyleData) => number, previous?: SheetFilter | null): string {
  const prefix = elementPrefix(firstXmlElement(xml, 'worksheet')?.name ?? '');
  const existing = sheetAutoFilter(xml);
  const existingRef = existing && parseRangeReference(xmlAttribute(existing.open, 'ref') ?? '');
  const originals = new Map<number, string>();
  if (existing?.inner && existingRef) {
    for (const column of xmlElements(existing.inner, 'filterColumn')) {
      const offset = Number(xmlAttribute(column.open, 'colId'));
      if (Number.isInteger(offset)) originals.set(existingRef.startColumn + offset, existing.inner.slice(column.start, column.end));
    }
  }
  const before = new Map((previous?.filterColumns ?? []).map(column => [column.colId, stable(column)]));
  const kept = (column: FilterColumn) => (before.get(column.colId) === stable(column) ? originals.get(column.colId) : undefined);
  const markup = filter ? autoFilterMarkup(filter, dxf, prefix, kept) : '';
  if (existing) return xml.slice(0, existing.start) + markup + xml.slice(existing.end);
  if (!markup) return xml;
  const at = childInsertionPoint(xml, 'worksheet', AFTER_AUTO_FILTER) ?? xml.lastIndexOf('</');
  return xml.slice(0, at) + markup + xml.slice(at);
}

const absoluteRange = (range: IRange): string => `$${columnLabel(range.startColumn)}$${range.startRow + 1}:$${columnLabel(range.endColumn)}$${range.endRow + 1}`;

/**
 * Keep each sheet's hidden `_xlnm._FilterDatabase` name on its AutoFilter range: Excel and other
 * readers find the filter's data through it. `updates` maps sheet names to their filter range, or
 * to null when the filter was removed.
 */
export function syncFilterDatabases(workbookXml: string, updates: Map<string, IRange | null>): string {
  if (!updates.size) return workbookXml;
  const prefix = elementPrefix(firstXmlElement(workbookXml, 'workbook')?.name ?? '');
  const sheets = firstXmlElement(workbookXml, 'sheets');
  const names = sheets?.inner ? [...xmlElements(sheets.inner, 'sheet')].map(sheet => xmlAttribute(sheet.open, 'name') ?? '') : [];
  const pending = new Map<number, { text: string | null }>();
  for (const [name, range] of updates) {
    const index = names.indexOf(name);
    if (index >= 0) pending.set(index, { text: range ? `${formulaSheetName(name)}!${absoluteRange(range)}` : null });
  }
  let result = mapElements(workbookXml, 'definedName', element => {
    if (xmlAttribute(element.open, 'name') !== FILTER_DATABASE) return undefined;
    const index = Number(xmlAttribute(element.open, 'localSheetId'));
    const update = pending.get(index);
    if (!update) return undefined;
    pending.delete(index);
    return update.text === null ? null : `${element.open}${encodeXmlText(update.text)}</${element.name}>`;
  });
  const added = [...pending].filter(([, update]) => update.text !== null)
    .map(([index, update]) => `<definedName name="${FILTER_DATABASE}" localSheetId="${index}" hidden="1">${encodeXmlText(update.text!)}</definedName>`);
  if (added.length) {
    const markup = addElementPrefix(added.join(''), prefix);
    // An existing list, even an empty `<definedNames/>`: a second one would be invalid.
    if (firstChildElement(result, 'workbook', 'definedNames')) {
      result = appendChildren(result, 'definedNames', markup) ?? result;
    } else {
      const at = childInsertionPoint(result, 'workbook', AFTER_DEFINED_NAMES) ?? result.lastIndexOf('</');
      result = result.slice(0, at) + addElementPrefix(`<definedNames>${added.join('')}</definedNames>`, prefix) + result.slice(at);
    }
  }
  return mapElements(result, 'definedNames', element => (element.inner !== undefined && !element.inner.trim() ? null : undefined));
}
