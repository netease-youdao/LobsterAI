import { type CellRange, parseRangeReference } from './sheetAddress';
import { hasThreeDimensionalReference, mapRange, sheetMaps, StructureAction, StructureAxis, type StructureOp } from './sheetStructure';
import type { WorkbookBaseline } from './xlsxImport';
import { RelationshipType } from './xlsxPackage';
import { RelationshipTypes } from './xlsxStructureExport';
import { firstXmlElement, xmlAttribute, xmlElements } from './xlsxXml';

/**
 * Which row, column and sheet operations the writer can carry into a particular workbook. The
 * editor refuses the rest before they run, with a reason the user can act on.
 */

export const StructureRefusal = {
  /** Form controls anchor to cells through parts the writer does not move. */
  FormControls: 'form-controls',
  /** Scenarios, custom views, OLE objects and similar content that names cells. */
  UnsupportedContent: 'unsupported-content',
  /** References spanning sheets (`Sheet1:Sheet3!A1`) depend on sheet order and rows together. */
  ThreeDimensionalReferences: 'three-dimensional-references',
  /** A table keeps at least one column. */
  TableColumns: 'table-columns',
  /** Formulas use a table column being deleted by its name. */
  TableColumnInUse: 'table-column-in-use',
  /** A table always keeps its header row and at least one data row. */
  TableRows: 'table-rows',
  /** Copying a sheet would drop its charts, images, comments or rules. */
  CopyWithContent: 'copy-with-content',
  /** Formulas elsewhere use a table on the sheet being deleted. */
  TableInUse: 'table-in-use',
  /** Sorting would leave links the grid does not show (on numbers or formulas) on the cells' old positions. */
  SortAttachments: 'sort-attachments',
  /** Grouping, cropping, flipping or restacking pictures, and pictures inside cells, are not saved yet. */
  ImageEdit: 'image-edit',
  /** A chart needs numbers in the selected cells. */
  ChartData: 'chart-data',
  /** Pictures are saved as PNG, JPEG, GIF or BMP. */
  ImageFormat: 'image-format',
  /** An operation the editor does not save yet. */
  Unsupported: 'unsupported',
} as const;
export type StructureRefusal = typeof StructureRefusal[keyof typeof StructureRefusal];

export interface SheetTableInfo {
  name: string;
  range: CellRange;
  headerRows: number;
  totalsRows: number;
}

export interface SheetStructureInfo {
  /** Why rows and columns of this sheet cannot be inserted or deleted, if they cannot. */
  rowsAndColumns?: StructureRefusal;
  tables: SheetTableInfo[];
  /** Content the editor keeps but a copy of the sheet would lose: tables, shapes, extensions, links on numbers. */
  keepsHiddenContent: boolean;
  /** Cells of links kept in the file that the grid does not carry: a sort would leave them behind. */
  attachments: CellRange[];
}

export interface WorkbookStructureInfo {
  sheets: Map<string, SheetStructureInfo>;
  threeDimensional: boolean;
}

const UNSUPPORTED_ELEMENTS = ['customSheetViews', 'scenarios', 'dataConsolidate', 'cellWatches', 'oleObjects', 'controls', 'webPublishItems', 'smartTags'];
/** Worksheet content a copy of the sheet would not carry (rules, validation, links and the filter it does). */
const UNCOPIED_ELEMENTS = ['extLst', 'picture', 'legacyDrawingHF', 'protectedRanges'];
/** Worksheet extensions whose references the writer moves (or that hold none). */
const KNOWN_EXTENSIONS = new Set([
  '{78C0D931-6437-407d-A8EE-F0AAD7539E65}', // x14 conditional formatting
  '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}', // x14 data validation
  '{05C60535-1F16-4fd2-B633-F4F36F0B64E0}', // sparklines
  '{A8765BA9-456A-4dab-B4F3-ACF838C121DE}', // slicer list
  '{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}', // slicer list (2013)
  '{FC87AEE6-9EDD-4A0A-B7FB-166176984837}', // x14 protected ranges
].map(uri => uri.toLowerCase()));
const PRINTER_SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings';
/** Parts a copy of the sheet carries: its pictures and charts, notes (with their VML) and printer settings. */
const COPIED_RELATIONSHIPS = new Set<string>([RelationshipTypes.Drawing, RelationshipTypes.Comments, RelationshipTypes.VmlDrawing, PRINTER_SETTINGS]);
const DRAWING_ANCHOR = /<(?:[\w.-]+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b/g;
const FORMULA_TEXT = /<(?:[\w.-]+:)?f\b[^>]*>([^<]+)</g;
const NOTE = /ObjectType\s*=\s*["']Note["']/;
const CLIENT_DATA = /<(?:[\w.-]+:)?ClientData\b[^>]*ObjectType\s*=\s*["']([^"']+)["']/g;

function hasElement(xml: string, local: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?${local}(?=[\\s/>])`).test(xml);
}

function formulasHaveThreeDimensionalReferences(xml: string): boolean {
  if (!xml.includes(':') || !xml.includes('!')) return false;
  for (const match of xml.matchAll(FORMULA_TEXT)) {
    const text = match[1];
    if (text.includes(':') && text.includes('!') && hasThreeDimensionalReference(text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, '\''))) return true;
  }
  return false;
}

export function analyzeWorkbookStructure(baseline: WorkbookBaseline, unshownLinks?: Map<string, CellRange[]>): WorkbookStructureInfo {
  const { pkg } = baseline;
  const sheets = new Map<string, SheetStructureInfo>();
  let threeDimensional = false;
  for (const sheet of baseline.sheets) {
    const xml = pkg.text(sheet.part) ?? '';
    const relations = pkg.relationships(sheet.part);
    let rowsAndColumns: StructureRefusal | undefined;
    let uncopied = false;
    if (UNSUPPORTED_ELEMENTS.some(local => hasElement(xml, local))) rowsAndColumns = StructureRefusal.UnsupportedContent;
    const extensionList = firstXmlElement(xml, 'extLst');
    if (!rowsAndColumns && extensionList?.inner) {
      for (const ext of xmlElements(extensionList.inner, 'ext')) {
        const uri = xmlAttribute(ext.open, 'uri')?.toLowerCase();
        if (!uri || !KNOWN_EXTENSIONS.has(uri)) { rowsAndColumns = StructureRefusal.UnsupportedContent; break; }
      }
    }
    for (const relation of relations) {
      if (relation.type !== RelationshipTypes.VmlDrawing || relation.external) continue;
      const vml = pkg.text(relation.target) ?? '';
      for (const match of vml.matchAll(CLIENT_DATA)) {
        if (NOTE.test(match[0])) continue;
        rowsAndColumns ??= StructureRefusal.FormControls;
        uncopied = true;
      }
    }
    if (formulasHaveThreeDimensionalReferences(xml)) threeDimensional = true;
    const tables: SheetTableInfo[] = [];
    for (const relation of relations) {
      if (relation.type !== RelationshipType.Table || relation.external) continue;
      const table = firstXmlElement(pkg.text(relation.target) ?? '', 'table');
      const range = table && parseRangeReference(xmlAttribute(table.open, 'ref') ?? '');
      if (!table || !range) continue;
      tables.push({
        name: xmlAttribute(table.open, 'displayName') ?? xmlAttribute(table.open, 'name') ?? '',
        range,
        headerRows: Number(xmlAttribute(table.open, 'headerRowCount') ?? 1),
        totalsRows: Number(xmlAttribute(table.open, 'totalsRowCount') ?? 0),
      });
    }
    // Notes and the links the grid shows move with sorted cells; the rest stay where the file has them.
    const attachments = unshownLinks?.get(sheet.id) ?? [];
    // A copy carries what the editor shows: every drawing must be a picture or chart it draws.
    const anchors = relations.filter(relation => relation.type === RelationshipTypes.Drawing && !relation.external)
      .reduce((count, relation) => count + ((pkg.text(relation.target) ?? '').match(DRAWING_ANCHOR)?.length ?? 0), 0);
    const drawn = (baseline.drawings.get(sheet.id) ?? []).filter(item => !('data' in item.drawing && (item.drawing.data as { spec?: { unsupported?: string } } | undefined)?.spec?.unsupported)).length;
    const keepsHiddenContent = uncopied || anchors !== drawn || attachments.length > 0
      || relations.some(relation => !relation.external && !COPIED_RELATIONSHIPS.has(relation.type))
      || UNCOPIED_ELEMENTS.some(local => hasElement(xml, local));
    sheets.set(sheet.id, { rowsAndColumns, tables, keepsHiddenContent, attachments });
  }
  const workbook = pkg.text(baseline.workbookPart) ?? '';
  const names = firstXmlElement(workbook, 'definedNames');
  for (const name of names?.inner ? xmlElements(names.inner, 'definedName') : []) {
    if (name.inner && hasThreeDimensionalReference(name.inner)) threeDimensional = true;
  }
  for (const [part] of pkg.files) {
    if (/^xl\/charts\/chart(?:Ex)?\d*\.xml$/i.test(part) && formulasHaveThreeDimensionalReferences(pkg.text(part) ?? '')) threeDimensional = true;
  }
  return { sheets, threeDimensional };
}

export interface StructureRequest {
  sheetId: string;
  axis: StructureAxis;
  action: StructureAction;
  start: number;
  end: number;
}

/** Why an insertion or deletion of rows or columns would be refused, given the edits already made. */
export function refuseRowsOrColumns(
  info: WorkbookStructureInfo | undefined, ops: readonly StructureOp[], request: StructureRequest, extents?: TableExtents,
): StructureRefusal | undefined {
  const sheet = info?.sheets.get(request.sheetId);
  if (!info || !sheet) return undefined;
  if (sheet.rowsAndColumns) return sheet.rowsAndColumns;
  if (info.threeDimensional) return StructureRefusal.ThreeDimensionalReferences;
  const ranges = currentTableRanges(info, ops, extents);
  for (const table of sheet.tables) {
    const range = ranges.get(table.name);
    if (!range) continue;
    if (request.axis === StructureAxis.Columns) {
      // Columns inserted inside a table become table columns; deleting them all would delete the table.
      if (request.action === StructureAction.Remove && request.start <= range.startColumn && request.end >= range.endColumn) return StructureRefusal.TableColumns;
    } else if (request.action === StructureAction.Remove) {
      const dataStart = range.startRow + table.headerRows;
      const dataEnd = range.endRow - table.totalsRows;
      if (table.headerRows > 0 && request.start <= range.startRow && request.end >= range.startRow) return StructureRefusal.TableRows;
      if (request.start <= dataStart && request.end >= dataEnd) return StructureRefusal.TableRows;
    }
  }
  return undefined;
}

/** Whether a range (in current coordinates) holds cells with links the grid does not carry. */
export function hasAttachments(info: WorkbookStructureInfo | undefined, ops: readonly StructureOp[], sheetId: string, range: CellRange): boolean {
  const sheet = info?.sheets.get(sheetId);
  if (!sheet?.attachments.length) return false;
  const maps = sheetMaps(ops, sheetId);
  return sheet.attachments.some(item => {
    const moved = mapRange(maps, item);
    return Boolean(moved && moved.startRow <= range.endRow && moved.endRow >= range.startRow && moved.startColumn <= range.endColumn && moved.endColumn >= range.startColumn);
  });
}

/**
 * A table's range as an edit other than a row or column edit set it (Excel's AutoExpansion when
 * typing next to a table), in the coordinates after the first `after` entries of the edit log.
 */
export interface TableExtent {
  range: CellRange;
  after: number;
}
export type TableExtents = ReadonlyMap<string, TableExtent>;

/** The tables of the workbook with their ranges moved by the row and column edits so far and grown by typing next to them. */
export function currentTableRanges(info: WorkbookStructureInfo | undefined, ops: readonly StructureOp[], extents?: TableExtents): Map<string, CellRange> {
  const ranges = new Map<string, CellRange>();
  for (const [sheetId, sheet] of info?.sheets ?? []) {
    const maps = sheetMaps(ops, sheetId);
    for (const table of sheet.tables) {
      const extent = extents?.get(table.name);
      const range = extent ? mapRange(sheetMaps(ops.slice(extent.after), sheetId), extent.range) : mapRange(maps, table.range);
      if (range) ranges.set(table.name, range);
    }
  }
  return ranges;
}
