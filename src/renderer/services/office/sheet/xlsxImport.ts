import type { ICellData, IRange, IStyleData, IWorkbookData, IWorksheetData } from '@univerjs/core';

import { type CellRange, cellReference, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, parseCellReference, parseRangeReference } from './sheetAddress';
import { SHEET_CHART_COMPONENT } from './sheetChartHost';
import { expandThisRowReferences } from './sheetStructure';
import type { TableStyleOptions } from './sheetTableStyles';
import { parseChart } from './xlsxCharts';
import { CONDITIONAL_FORMATS_RESOURCE, importConditionalFormats, type ImportedConditionalFormat } from './xlsxConditionalFormats';
import { DATA_VALIDATIONS_RESOURCE, importDataValidations, type ImportedDataValidation } from './xlsxDataValidations';
import { DRAWINGS_RESOURCE, type ImportedDrawing, importSheetDrawings } from './xlsxDrawings';
import { FILTERS_RESOURCE, importAutoFilter, modelFilter, type SheetFilter } from './xlsxFilters';
import { importHyperlinks, linkCell } from './xlsxHyperlinks';
import { type ImportedNote, importNotes, NOTES_RESOURCE, notesResource } from './xlsxNotes';
import { RelationshipType, XlsxPackage } from './xlsxPackage';
import { AxisGeometry, RelationshipTypes } from './xlsxStructureExport';
import { type NumberFormatLocale, XlsxStyles } from './xlsxStyles';
import { decodeExcelString, decodeXml, firstXmlElement, plainText, xmlAttribute, xmlElements } from './xlsxXml';

/** Univer CellValueType values. */
export const CellType = { String: 1, Number: 2, Boolean: 3, ForceString: 4 } as const;
/** Univer WorksheetHiddenState values. */
const SheetHidden = { Hidden: 1, VeryHidden: 2 } as const;
const DEFINED_NAMES_RESOURCE = 'SHEET_DEFINED_NAME_PLUGIN';
const WORKBOOK_SCOPE = 'AllDefaultWorkbook';
const MIN_ROW_COUNT = 1000;
const MIN_COLUMN_COUNT = 26;
const ROW_PADDING = 100;
const COLUMN_PADDING = 10;
const PX_PER_POINT = 96 / 72;
/** Univer WrapStrategy.WRAP. */
const WRAP_TEXT = 3;
/** Univer style ids for cellXfs record N are `x<N>`, so export can find a cell's original record. */
export const STYLE_ID_PREFIX = 'x';
/** Excel date serials count from 1899-12-30 (1900 system) or 1904-01-01. */
const EXCEL_EPOCH_1900 = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1);
const DAY_MS = 86_400_000;
/** Formula prefixes Excel writes for newer functions; Univer parses the bare names. */
const FUTURE_FUNCTION_PREFIX = /_xl(?:fn|ws|pm)\./g;

export class XlsxImportError extends Error {
  constructor(readonly reason: 'invalid' | 'too-large', message: string) {
    super(message);
  }
}

export interface ImportedSheet {
  id: string;
  name: string;
  /** Package path of the worksheet part. */
  part: string;
  /** Position among all `<sheet>` entries of the workbook, chart sheets included. */
  index: number;
}

export interface WorkbookBaseline {
  pkg: XlsxPackage;
  styles: XlsxStyles;
  workbookPart: string;
  sheets: ImportedSheet[];
  /** A private copy of the snapshot handed to Univer; the reference for export diffs. */
  snapshot: IWorkbookData;
  maxDigitWidth: number;
  date1904: boolean;
  /** Conditional formats as imported, per sheet id, highest priority first. */
  conditionalFormats: Map<string, ImportedConditionalFormat[]>;
  /** Floating pictures and charts as imported, per sheet id, in stacking order. */
  drawings: Map<string, ImportedDrawing[]>;
  /** Data validation as imported, per sheet id, in document order. */
  dataValidations: Map<string, ImportedDataValidation[]>;
  /** AutoFilters as imported, per sheet id. */
  filters: Map<string, SheetFilter>;
  /** Cell notes (comments) as imported, per sheet id. */
  notes: Map<string, ImportedNote[]>;
}

/** An Excel table (ListObject), so formulas can resolve structured references like `Sales[Amount]`. */
export interface ImportedTable {
  sheetId: string;
  name: string;
  range: IRange;
  /** Column name → zero-based offset from the table's first column. */
  columns: [string, number][];
  showHeader: boolean;
  showFooter: boolean;
  /** The table's style (`tableStyleInfo`), drawn beneath the cells' own formats. */
  style?: TableStyleOptions;
  /** Offsets of calculated columns (one formula for the whole column), which new rows fill. */
  calculatedColumns?: number[];
}

export interface ImportedWorkbook {
  data: IWorkbookData;
  baseline: WorkbookBaseline;
  activeSheetId?: string;
  cellCount: number;
  tables: ImportedTable[];
  /** Rows Excel sizes to their content (no fixed height) that hold wrapped or multi-line text. */
  autoFitRows: Record<string, number[]>;
  /** Drawing objects the editor does not show: shapes, groups, pictures in formats it cannot draw. */
  hiddenDrawings: number;
  /** Hyperlinks the grid does not show: on numbers or formulas, or to defined names. */
  hiddenHyperlinks: number;
  /** Cells, by sheet id, of links the grid does not carry (kept in the file as they are): they cannot follow sorted cells. */
  unshownLinks: Map<string, CellRange[]>;
}

export interface ImportOptions {
  /** Workbook display name. */
  name: string;
  /** Univer LocaleType value stored in the snapshot. */
  univerLocale: string;
  /** Which built-in date formats to show for locale-dependent format ids. */
  formatLocale: NumberFormatLocale;
  maxCells: number;
  /**
   * Pixel width of a digit in the default font as the grid renders it. Excel column widths count
   * digits; with a canvas font the fractional width keeps the same number of characters visible.
   */
  digitWidth?: number;
}

/** Excel's max digit width in pixels for common default fonts, per point of size. */
const DIGIT_WIDTH_RATIO: Record<string, number> = {
  calibri: 0.506, arial: 0.556, 'times new roman': 0.5, cambria: 0.55, '等线': 0.54, dengxian: 0.54,
  '宋体': 0.5, simsun: 0.5, '微软雅黑': 0.57, 'microsoft yahei': 0.57, '黑体': 0.5, simhei: 0.5,
};

/** An estimate of the default font's digit width; the editor measures the real one when it can. */
export function maxDigitWidth(fontName: string | undefined, sizePt: number | undefined): number {
  const ratio = DIGIT_WIDTH_RATIO[(fontName ?? 'calibri').toLowerCase()] ?? 0.52;
  return Math.max(5, Math.round((sizePt ?? 11) * PX_PER_POINT * ratio * 100) / 100);
}

/** Column width in Excel's stored units (characters plus padding) → pixels. */
export function columnWidthToPixels(width: number, mdw: number): number {
  return Math.max(0, Math.trunc(((256 * width + Math.trunc(128 / mdw)) / 256) * mdw));
}

export function pixelsToColumnWidth(pixels: number, mdw: number): number {
  return Math.trunc((pixels / mdw) * 256) / 256;
}

export const pointsToPixels = (points: number): number => Math.round(points * PX_PER_POINT * 100) / 100;
export const pixelsToPoints = (pixels: number): number => Math.round((pixels / PX_PER_POINT) * 100) / 100;

export function excelSerialFromIso(value: string, date1904: boolean): number | undefined {
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}${value.includes('T') ? '' : 'T00:00:00'}Z`);
  if (!Number.isFinite(time)) return undefined;
  return (time - (date1904 ? EXCEL_EPOCH_1904 : EXCEL_EPOCH_1900)) / DAY_MS;
}

export function formulaForUniver(text: string): string {
  // Some writers keep Excel's `Table[@Column]` shorthand, which the formula engine cannot read.
  return `=${expandThisRowReferences(text.replace(FUTURE_FUNCTION_PREFIX, ''))}`;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xmlElements(xml, 'si')].map(element => plainText(element.inner ?? ''));
}

const R = /\sr\s*=\s*"([^"]*)"/;
const S = /\ss\s*=\s*"(\d+)"/;
const T = /\st\s*=\s*"([^"]*)"/;
const quick = (pattern: RegExp, open: string): string | undefined => pattern.exec(open)?.[1];
/** Fall back to the full attribute parser for single-quoted attributes. */
const attribute = (pattern: RegExp, open: string, name: string): string | undefined =>
  quick(pattern, open) ?? (open.includes('\'') ? xmlAttribute(open, name) : undefined);

function cellValue(open: string, inner: string, strings: string[], date1904: boolean): ICellData {
  const type = attribute(T, open, 't') ?? 'n';
  const cell: ICellData = {};
  const formula = firstXmlElement(inner, 'f');
  const value = firstXmlElement(inner, 'v');
  const text = value?.inner !== undefined ? decodeXml(value.inner) : undefined;
  if (formula) {
    const formulaType = xmlAttribute(formula.open, 't');
    const shared = xmlAttribute(formula.open, 'si');
    if (formula.inner !== undefined && formula.inner.trim() && formulaType !== 'dataTable') {
      cell.f = formulaForUniver(decodeXml(formula.inner));
    }
    if (formulaType === 'shared' && shared !== undefined) cell.si = shared;
    if (formulaType === 'array') {
      cell.ft = 2;
      const ref = xmlAttribute(formula.open, 'ref');
      if (ref) cell.ref = ref;
    }
  }
  switch (type) {
    case 's': {
      const index = Number(text);
      if (text !== undefined && Number.isInteger(index)) {
        cell.v = strings[index] ?? '';
        cell.t = CellType.String;
      }
      break;
    }
    case 'inlineStr': {
      const inline = firstXmlElement(inner, 'is');
      cell.v = inline?.inner ? plainText(inline.inner) : '';
      cell.t = CellType.String;
      break;
    }
    case 'str':
    case 'e':
      if (text !== undefined) {
        cell.v = decodeExcelString(text);
        cell.t = CellType.String;
      }
      break;
    case 'b':
      if (text !== undefined) {
        cell.v = text === '1' || text.toLowerCase() === 'true';
        cell.t = CellType.Boolean;
      }
      break;
    case 'd': {
      const serial = text !== undefined ? excelSerialFromIso(text, date1904) : undefined;
      if (serial !== undefined) {
        cell.v = serial;
        cell.t = CellType.Number;
      }
      break;
    }
    default:
      if (text !== undefined && text.trim() !== '') {
        const number = Number(text);
        if (Number.isFinite(number)) {
          cell.v = number;
          cell.t = CellType.Number;
        }
      }
  }
  return cell;
}

interface SheetContext {
  strings: string[];
  styles: XlsxStyles;
  styleMap: Record<string, IStyleData>;
  mdw: number;
  date1904: boolean;
  sheetIndex: number;
  remainingCells: number;
}

function parseWorksheet(xml: string, context: SheetContext): { data: Partial<IWorksheetData>; cells: number; autoFitRows: number[] } {
  const data: Partial<IWorksheetData> = {};
  const cellData: IWorksheetData['cellData'] = {};
  const rowData: IWorksheetData['rowData'] = {};
  const columnData: IWorksheetData['columnData'] = {};
  let maxRow = -1;
  let maxColumn = -1;
  let cells = 0;
  const autoFitRows: number[] = [];

  const tabColor = firstXmlElement(firstXmlElement(xml, 'sheetPr')?.inner ?? '', 'tabColor');
  const tab = tabColor && context.styles.color(tabColor.open);
  if (tab) data.tabColor = tab;

  const view = firstXmlElement(xml, 'sheetView');
  if (view) {
    if (xmlAttribute(view.open, 'showGridLines') === '0') data.showGridlines = 0;
    if (xmlAttribute(view.open, 'rightToLeft') === '1') data.rightToLeft = 1;
    const zoom = Number(xmlAttribute(view.open, 'zoomScale'));
    if (Number.isFinite(zoom) && zoom >= 10 && zoom <= 400) data.zoomRatio = zoom / 100;
    const pane = firstXmlElement(view.inner ?? '', 'pane');
    const state = pane && xmlAttribute(pane.open, 'state');
    if (pane && (state === 'frozen' || state === 'frozenSplit')) {
      const xSplit = Math.max(0, Math.trunc(Number(xmlAttribute(pane.open, 'xSplit') ?? 0)) || 0);
      const ySplit = Math.max(0, Math.trunc(Number(xmlAttribute(pane.open, 'ySplit') ?? 0)) || 0);
      if (xSplit || ySplit) data.freeze = { xSplit, ySplit, startRow: ySplit || -1, startColumn: xSplit || -1 };
    }
  }

  const format = firstXmlElement(xml, 'sheetFormatPr');
  if (format) {
    const rowHeight = Number(xmlAttribute(format.open, 'defaultRowHeight'));
    if (rowHeight > 0) data.defaultRowHeight = pointsToPixels(rowHeight);
    const colWidth = Number(xmlAttribute(format.open, 'defaultColWidth'));
    const baseWidth = Number(xmlAttribute(format.open, 'baseColWidth'));
    if (colWidth > 0) data.defaultColumnWidth = columnWidthToPixels(colWidth, context.mdw);
    else if (baseWidth > 0) data.defaultColumnWidth = Math.round(baseWidth * context.mdw + 5 + context.mdw / 2);
  }
  data.defaultColumnWidth ??= Math.round(8.43 * context.mdw + 5);
  data.defaultRowHeight ??= 20;

  const cols = firstXmlElement(xml, 'cols');
  for (const col of cols?.inner ? xmlElements(cols.inner, 'col') : []) {
    const min = Number(xmlAttribute(col.open, 'min'));
    const max = Math.min(Number(xmlAttribute(col.open, 'max')), EXCEL_MAX_COLUMNS);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) continue;
    const width = Number(xmlAttribute(col.open, 'width'));
    const hidden = xmlAttribute(col.open, 'hidden') === '1';
    if (!(width > 0) && !hidden) continue;
    for (let column = min - 1; column < max; column++) {
      const entry: { w?: number; hd?: 0 | 1 } = {};
      if (width > 0) entry.w = columnWidthToPixels(width, context.mdw);
      if (hidden) entry.hd = 1;
      columnData[column] = entry;
    }
    // Styled whole-row ranges often run to column XFD; only count real widths.
    if (max < EXCEL_MAX_COLUMNS) maxColumn = Math.max(maxColumn, max - 1);
  }

  const sheetData = firstXmlElement(xml, 'sheetData');
  let previousRow = -1;
  for (const row of sheetData?.inner ? xmlElements(sheetData.inner, 'row') : []) {
    const explicitRow = attribute(R, row.open, 'r');
    const rowIndex = explicitRow ? Number(explicitRow) - 1 : previousRow + 1;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= EXCEL_MAX_ROWS) throw new XlsxImportError('invalid', 'Invalid row index');
    previousRow = rowIndex;
    const height = Number(xmlAttribute(row.open, 'ht'));
    const hidden = xmlAttribute(row.open, 'hidden') === '1';
    const fixed = ['1', 'true'].includes(xmlAttribute(row.open, 'customHeight') ?? '');
    if (height > 0 || hidden || fixed) {
      const entry: { h?: number; hd?: 0 | 1; ia?: 0 | 1 } = {};
      if (height > 0) entry.h = pointsToPixels(height);
      if (hidden) entry.hd = 1;
      // A height the user fixed in Excel does not grow with its content.
      if (fixed) entry.ia = 0;
      rowData[rowIndex] = entry;
    }
    if (!row.inner) continue;
    let fitsContent = false;
    let previousColumn = -1;
    let rowCells: Record<number, ICellData> | undefined;
    for (const cell of xmlElements(row.inner, 'c')) {
      const reference = attribute(R, cell.open, 'r');
      const address = reference ? parseCellReference(reference) : { row: rowIndex, column: previousColumn + 1 };
      if (!address || address.row !== rowIndex) throw new XlsxImportError('invalid', `Invalid cell reference ${reference ?? ''}`);
      previousColumn = address.column;
      const data = cellValue(cell.open, cell.inner ?? '', context.strings, context.date1904);
      const styleIndex = Number(attribute(S, cell.open, 's') ?? 0);
      if (styleIndex > 0 && styleIndex < context.styles.xfCount) {
        const id = `${STYLE_ID_PREFIX}${styleIndex}`;
        if (!(id in context.styleMap)) context.styleMap[id] = context.styles.univerStyle(styleIndex) ?? {};
        data.s = id;
      }
      if (data.si !== undefined) data.si = `${context.sheetIndex}:${data.si}`;
      if (!fixed && !fitsContent && ((typeof data.v === 'string' && data.v.includes('\n'))
        || (typeof data.s === 'string' && context.styleMap[data.s]?.tb === WRAP_TEXT))) fitsContent = true;
      if (data.v === undefined && data.f === undefined && data.si === undefined && data.s === undefined) continue;
      if (++cells > context.remainingCells) throw new XlsxImportError('too-large', 'Too many cells to edit');
      rowCells ??= cellData[rowIndex] = {};
      rowCells[address.column] = data;
      maxRow = Math.max(maxRow, rowIndex);
      maxColumn = Math.max(maxColumn, address.column);
    }
    if (fitsContent) autoFitRows.push(rowIndex);
  }

  const mergeData: IRange[] = [];
  const merges = firstXmlElement(xml, 'mergeCells');
  for (const merge of merges?.inner ? xmlElements(merges.inner, 'mergeCell') : []) {
    const range = parseRangeReference(xmlAttribute(merge.open, 'ref') ?? '');
    if (!range) continue;
    mergeData.push({ ...range });
    maxRow = Math.max(maxRow, range.endRow);
    maxColumn = Math.max(maxColumn, range.endColumn);
  }

  data.cellData = cellData;
  data.rowData = rowData;
  data.columnData = columnData;
  data.mergeData = mergeData;
  data.rowCount = Math.min(EXCEL_MAX_ROWS, Math.max(MIN_ROW_COUNT, maxRow + 1 + ROW_PADDING));
  data.columnCount = Math.min(EXCEL_MAX_COLUMNS, Math.max(MIN_COLUMN_COUNT, maxColumn + 1 + COLUMN_PADDING));
  return { data, cells, autoFitRows };
}

function sheetTables(pkg: XlsxPackage, part: string, sheetId: string): ImportedTable[] {
  const tables: ImportedTable[] = [];
  for (const relation of pkg.relationships(part)) {
    if (relation.type !== RelationshipType.Table || relation.external) continue;
    const xml = pkg.text(relation.target);
    const table = xml && firstXmlElement(xml, 'table');
    if (!xml || !table) continue;
    const name = xmlAttribute(table.open, 'displayName') ?? xmlAttribute(table.open, 'name');
    const range = parseRangeReference(xmlAttribute(table.open, 'ref') ?? '');
    const columnsElement = firstXmlElement(xml, 'tableColumns');
    if (!name || !range || !columnsElement?.inner) continue;
    const elements = [...xmlElements(columnsElement.inner, 'tableColumn')];
    const columns = elements.map((element, index): [string, number] => [xmlAttribute(element.open, 'name') ?? '', index]).filter(([column]) => column);
    const calculated = elements.flatMap((element, index) => (element.inner && firstXmlElement(element.inner, 'calculatedColumnFormula') ? [index] : []));
    const info = firstXmlElement(xml, 'tableStyleInfo');
    const styleName = info && xmlAttribute(info.open, 'name');
    const on = (attribute: string) => ['1', 'true'].includes(xmlAttribute(info!.open, attribute) ?? '');
    tables.push({
      sheetId, name, range: { ...range }, columns,
      showHeader: xmlAttribute(table.open, 'headerRowCount') !== '0',
      showFooter: Number(xmlAttribute(table.open, 'totalsRowCount') ?? 0) > 0,
      ...(styleName ? { style: { name: styleName, rowStripes: on('showRowStripes'), columnStripes: on('showColumnStripes'), firstColumn: on('showFirstColumn'), lastColumn: on('showLastColumn') } } : {}),
      ...(calculated.length ? { calculatedColumns: calculated } : {}),
    });
  }
  return tables;
}

function definedNames(workbookXml: string, sheets: ImportedSheet[], sheetIdsByIndex: Map<number, string>): IWorkbookData['resources'] {
  const names: Record<string, { id: string; name: string; formulaOrRefString: string; localSheetId: string; hidden?: boolean }> = {};
  const container = firstXmlElement(workbookXml, 'definedNames');
  let index = 0;
  for (const element of container?.inner ? xmlElements(container.inner, 'definedName') : []) {
    const name = xmlAttribute(element.open, 'name');
    const text = decodeXml(element.inner ?? '').trim();
    // Built-in names (print areas, filter databases) are not referenced by formulas.
    if (!name || !text || name.startsWith('_xlnm.') || /\[\d+\]/.test(text)) continue;
    const local = xmlAttribute(element.open, 'localSheetId');
    const localSheetId = local !== undefined ? sheetIdsByIndex.get(Number(local)) : WORKBOOK_SCOPE;
    if (!localSheetId) continue;
    const id = `name-${index++}`;
    names[id] = {
      id, name, localSheetId,
      formulaOrRefString: text.replace(FUTURE_FUNCTION_PREFIX, ''),
      ...(xmlAttribute(element.open, 'hidden') === '1' ? { hidden: true } : {}),
    };
  }
  return index && sheets.length ? [{ name: DEFINED_NAMES_RESOURCE, data: JSON.stringify(names) }] : [];
}

/** Unzip an .xlsx file. */
export function readXlsxPackage(bytes: Uint8Array): XlsxPackage {
  try {
    return XlsxPackage.read(bytes);
  } catch (error) {
    throw new XlsxImportError('invalid', `Not a ZIP package: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The workbook part, its relationships and its formats. */
function workbookParts(pkg: XlsxPackage, formatLocale: NumberFormatLocale) {
  const workbookPart = pkg.relationships('').find(relation => relation.type === RelationshipType.OfficeDocument && !relation.external)?.target;
  const workbookXml = workbookPart && pkg.text(workbookPart);
  if (!workbookPart || !workbookXml) throw new XlsxImportError('invalid', 'Missing workbook part');
  const relations = pkg.relationships(workbookPart);
  const partOf = (type: string) => relations.find(relation => relation.type === type && !relation.external)?.target;
  const stylesPart = partOf(RelationshipType.Styles);
  const themePart = partOf(RelationshipType.Theme);
  const styles = new XlsxStyles(stylesPart && pkg.text(stylesPart), themePart && pkg.text(themePart), formatLocale);
  return { workbookPart, workbookXml, relations, partOf, styles };
}

/** A workbook's default font and the fonts its cells use, to load before measuring column widths. */
export interface WorkbookFonts {
  name?: string;
  size?: number;
  fonts: string[];
}

export function workbookFonts(pkg: XlsxPackage, formatLocale: NumberFormatLocale): WorkbookFonts {
  const { styles } = workbookParts(pkg, formatLocale);
  const defaults = styles.defaultStyle();
  return { name: defaults.ff ?? undefined, size: defaults.fs ?? undefined, fonts: styles.fontNames() };
}

/** Read an .xlsx file into a Univer workbook snapshot plus what export needs to patch it. */
export function importXlsx(bytes: Uint8Array, options: ImportOptions): ImportedWorkbook {
  return importXlsxPackage(readXlsxPackage(bytes), options);
}

export function importXlsxPackage(pkg: XlsxPackage, options: ImportOptions): ImportedWorkbook {
  const { workbookPart, workbookXml, relations, partOf, styles } = workbookParts(pkg, options.formatLocale);
  const stringsPart = partOf(RelationshipType.SharedStrings);
  const strings = sharedStrings(stringsPart && pkg.text(stringsPart));
  const properties = firstXmlElement(workbookXml, 'workbookPr');
  const date1904 = ['1', 'true'].includes(properties ? xmlAttribute(properties.open, 'date1904') ?? '' : '');
  const defaultStyle = styles.defaultStyle();
  const mdw = options.digitWidth ?? maxDigitWidth(defaultStyle.ff ?? undefined, defaultStyle.fs);

  const styleMap: Record<string, IStyleData> = {};
  const sheets: ImportedSheet[] = [];
  const sheetData: IWorkbookData['sheets'] = {};
  const sheetIdsByIndex = new Map<number, string>();
  let activeSheetId: string | undefined;
  const activeTab = Number(xmlAttribute(firstXmlElement(workbookXml, 'workbookView')?.open ?? '<x>', 'activeTab') ?? 0);
  let cellCount = 0;
  const tables: ImportedTable[] = [];
  const autoFitRows: Record<string, number[]> = {};
  const conditionalFormats = new Map<string, ImportedConditionalFormat[]>();
  const dataValidations = new Map<string, ImportedDataValidation[]>();
  const filters = new Map<string, SheetFilter>();
  const notes = new Map<string, ImportedNote[]>();
  const drawingParts = new Map<string, string>();
  let index = -1;
  for (const element of xmlElements(firstXmlElement(workbookXml, 'sheets')?.inner ?? '', 'sheet')) {
    index++;
    const name = xmlAttribute(element.open, 'name');
    const relationId = xmlAttribute(element.open, 'r:id') ?? xmlAttribute(element.open, 'id');
    const relation = relations.find(item => item.id === relationId);
    // Chart sheets and legacy dialog/macro sheets stay in the package but are not editable here.
    if (!name || !relation || relation.external || relation.type !== RelationshipType.Worksheet) continue;
    const xml = pkg.text(relation.target);
    if (!xml) throw new XlsxImportError('invalid', `Missing worksheet ${relation.target}`);
    const id = `sheet-${index}`;
    const { data, cells, autoFitRows: fitRows } = parseWorksheet(xml, {
      strings, styles, styleMap, mdw, date1904, sheetIndex: index, remainingCells: options.maxCells - cellCount,
    });
    cellCount += cells;
    if (fitRows.length) autoFitRows[id] = fitRows;
    const state = xmlAttribute(element.open, 'state');
    sheetData[id] = {
      ...data, id, name,
      ...(state === 'hidden' ? { hidden: SheetHidden.Hidden } : state === 'veryHidden' ? { hidden: SheetHidden.VeryHidden } : {}),
    };
    sheets.push({ id, name, part: relation.target, index });
    const formats = importConditionalFormats(xml, styles);
    if (formats.length) conditionalFormats.set(id, formats);
    const validations = importDataValidations(xml, { rows: data.rowCount ?? EXCEL_MAX_ROWS, columns: data.columnCount ?? EXCEL_MAX_COLUMNS });
    if (validations.length) dataValidations.set(id, validations);
    const rowData = data.rowData as Record<number, { hd?: number }> | undefined;
    const filter = importAutoFilter(xml, row => Boolean(rowData?.[row]?.hd), id => styles.dxfStyle(id));
    if (filter) {
      // Rows the filter hides are filtered, not hidden by hand: clearing the filter shows them.
      for (const row of filter.cachedFilteredOut ?? []) if (rowData?.[row]) delete rowData[row].hd;
      filters.set(id, filter);
    }
    const sheetNotes = importNotes(pkg, workbookPart, relation.target, id);
    if (sheetNotes.length) notes.set(id, sheetNotes);
    const drawing = pkg.relationships(relation.target).find(item => item.type === RelationshipTypes.Drawing && !item.external);
    if (drawing) drawingParts.set(id, drawing.target);
    tables.push(...sheetTables(pkg, relation.target, id));
    sheetIdsByIndex.set(index, id);
    if (index === activeTab && !state) activeSheetId = id;
  }
  if (!sheets.length) throw new XlsxImportError('invalid', 'Workbook has no worksheets');
  // Links become one-link rich text on their cells (Univer keeps links in cell text).
  const sheetIdByName = new Map(sheets.map(sheet => [sheet.name.toLowerCase(), sheet.id]));
  let hiddenHyperlinks = 0;
  const unshownLinks = new Map<string, CellRange[]>();
  for (const sheet of sheets) {
    const xml = pkg.text(sheet.part) ?? '';
    if (!xml.includes('hyperlink')) continue;
    const { links, skipped } = importHyperlinks(xml, pkg.relationships(sheet.part), sheet.id, name => sheetIdByName.get(name.toLowerCase()));
    hiddenHyperlinks += skipped.length;
    const unshown = [...skipped];
    const cells = sheetData[sheet.id].cellData as Record<number, Record<number, ICellData>> | undefined;
    links.forEach((link, index) => {
      const cell = cells?.[link.row]?.[link.column];
      const style = { ...defaultStyle, ...(typeof cell?.s === 'string' ? styleMap[cell.s] : cell?.s ?? {}) };
      const shown = linkCell(cell, link.url, `lobster-link-${sheet.index}-${index}`, style);
      if (!shown) hiddenHyperlinks++;
      // Only the top-left cell of a link over several cells carries it in the grid.
      if (!shown || link.range.endRow > link.range.startRow || link.range.endColumn > link.range.startColumn) unshown.push(link.range);
    });
    if (unshown.length) unshownLinks.set(sheet.id, unshown);
  }
  const unitId = `lobster-sheet-${Math.random().toString(36).slice(2, 10)}`;
  const drawings = new Map<string, ImportedDrawing[]>();
  let hiddenDrawings = 0;
  for (const [sheetId, part] of drawingParts) {
    const xml = pkg.text(part);
    if (!xml) continue;
    const relations = pkg.relationships(part);
    const { drawings: list, skipped } = importSheetDrawings({
      xml, part, unitId, sheetId,
      chartComponent: SHEET_CHART_COMPONENT,
      chart: (relationshipId, extended) => {
        const target = relations.find(item => item.id === relationshipId && !item.external)?.target;
        const chartXml = target ? pkg.text(target) : undefined;
        if (!chartXml) return undefined;
        return extended ? { plots: [], unsupported: 'chartEx' } : parseChart(chartXml, styles);
      },
      geometry: { rows: AxisGeometry.rows(sheetData[sheetId]), columns: AxisGeometry.columns(sheetData[sheetId]) },
      media: relationshipId => {
        const target = relations.find(item => item.id === relationshipId && !item.external)?.target;
        const bytes = target ? pkg.files.get(target) : undefined;
        return target && bytes ? { bytes, extension: target.split('.').pop() ?? '' } : undefined;
      },
    });
    if (list.length) drawings.set(sheetId, list);
    hiddenDrawings += skipped;
  }

  const data: IWorkbookData = {
    id: unitId,
    name: options.name,
    appVersion: '1.0.0',
    locale: options.univerLocale as IWorkbookData['locale'],
    styles: styleMap,
    sheetOrder: sheets.map(sheet => sheet.id),
    sheets: sheetData,
    ...(Object.keys(defaultStyle).length ? { defaultStyle } : {}),
    ...(date1904 ? { dateSystem: 'date1904' as IWorkbookData['dateSystem'] } : {}),
    resources: [
      ...definedNames(workbookXml, sheets, sheetIdsByIndex) ?? [],
      ...(conditionalFormats.size ? [{
        name: CONDITIONAL_FORMATS_RESOURCE,
        data: JSON.stringify(Object.fromEntries([...conditionalFormats].map(([sheetId, formats]) => [sheetId, formats.map(format => format.rule)]))),
      }] : []),
      ...(dataValidations.size ? [{
        name: DATA_VALIDATIONS_RESOURCE,
        data: JSON.stringify(Object.fromEntries([...dataValidations].map(([sheetId, rules]) => [sheetId, rules.map(item => item.rule)]))),
      }] : []),
      ...(filters.size ? [{ name: FILTERS_RESOURCE, data: JSON.stringify(Object.fromEntries([...filters].map(([id, filter]) => [id, modelFilter(filter)]))) }] : []),
      ...(notes.size ? [{ name: NOTES_RESOURCE, data: notesResource(notes) }] : []),
      ...(drawings.size ? [{
        name: DRAWINGS_RESOURCE,
        data: JSON.stringify(Object.fromEntries([...drawings].map(([sheetId, list]) => [sheetId, {
          data: Object.fromEntries(list.map(item => [item.drawingId, item.drawing])),
          order: list.map(item => item.drawingId),
        }]))),
      }] : []),
    ],
  };
  return {
    data,
    baseline: { pkg, styles, workbookPart, sheets, snapshot: structuredClone(data), maxDigitWidth: mdw, date1904, conditionalFormats, drawings, dataValidations, filters, notes },
    activeSheetId: activeSheetId ?? sheets.find(sheet => !sheetData[sheet.id].hidden)?.id,
    cellCount,
    tables,
    autoFitRows,
    hiddenDrawings,
    hiddenHyperlinks,
    unshownLinks,
  };
}

/** For diagnostics and tests: the A1 reference of a snapshot position. */
export const referenceOf = (row: number, column: number): string => cellReference(row, column);
