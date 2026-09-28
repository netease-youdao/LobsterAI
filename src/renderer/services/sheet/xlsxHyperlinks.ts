import { CustomRangeType, type ICellData, type IDocumentData, type IStyleData, type IWorksheetData } from '@univerjs/core';

import { type CellRange, cellReference, parseRangeReference } from './sheetAddress';
import { formulaSheetName } from './sheetStructure';
import type { Relationship } from './xlsxPackage';
import { mapElements } from './xlsxStructureExport';
import { addElementPrefix, elementPrefix, encodeXmlAttribute, firstXmlElement, xmlAttribute, xmlElements } from './xlsxXml';

/**
 * Hyperlinks of a worksheet. Univer keeps a link inside the cell's rich text, so a linked text
 * cell is loaded as a one-link document. The file's `<hyperlinks>` stay as written unless a link
 * was added, changed or removed in the editor; typing over a linked cell keeps its link, as in Excel.
 */

export const HYPERLINK_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKBOOK_LINK = /^#gid=([^&]+)&range=([A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?)$/i;
const CELL_RANGE = /^[A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?$/;
/** Worksheet children that follow `<hyperlinks>`, in schema order. */
const AFTER_HYPERLINKS = ['printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches',
  'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls',
  'webPublishItems', 'tableParts', 'extLst'];
/** Text properties a rich-text cell carries itself; Univer draws them from the document, not the cell style. */
const TEXT_STYLE_KEYS = ['ff', 'fs', 'it', 'bl', 'ul', 'st', 'ol', 'cl', 'va'] as const;

export interface ImportedHyperlink {
  row: number;
  column: number;
  /** The cells the link covers (usually just its top-left cell). */
  range: CellRange;
  /** A web address, or `#gid=<sheet id>&range=A1` for a place in the workbook. */
  url: string;
}

/** Univer's link to a place in the workbook, or undefined for names and places it cannot follow. */
export function workbookLink(location: string, homeSheetId: string, sheetId: (name: string) => string | undefined): string | undefined {
  const bang = location.lastIndexOf('!');
  const range = (bang >= 0 ? location.slice(bang + 1) : location).replace(/\$/g, '').toUpperCase();
  if (!CELL_RANGE.test(range)) return undefined;
  const name = bang >= 0 ? location.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, '\'') : undefined;
  const gid = name === undefined ? homeSheetId : sheetId(name);
  return gid ? `#gid=${gid}&range=${range}` : undefined;
}

/** The links of a worksheet part the grid can show, by top-left cell, and the cells of those it cannot. */
export function importHyperlinks(
  xml: string, relationships: Relationship[], homeSheetId: string, sheetId: (name: string) => string | undefined,
): { links: ImportedHyperlink[]; skipped: CellRange[] } {
  const container = firstXmlElement(xml, 'hyperlinks');
  if (!container?.inner) return { links: [], skipped: [] };
  const links: ImportedHyperlink[] = [];
  const skipped: CellRange[] = [];
  for (const element of xmlElements(container.inner, 'hyperlink')) {
    const range = parseRangeReference(xmlAttribute(element.open, 'ref') ?? '');
    const id = xmlAttribute(element.open, 'r:id') ?? xmlAttribute(element.open, 'id');
    const location = xmlAttribute(element.open, 'location');
    const target = id ? relationships.find(item => item.id === id && item.type === HYPERLINK_RELATIONSHIP && item.external)?.target : undefined;
    let url: string | undefined;
    // Some writers store a place in the workbook as an external `#Sheet!A1` target; Excel follows it.
    if (target?.startsWith('#')) url = workbookLink(target.slice(1), homeSheetId, sheetId);
    else if (target !== undefined) url = location ? `${target}#${location}` : target;
    else if (location) url = workbookLink(location, homeSheetId, sheetId);
    if (range && url) links.push({ row: range.startRow, column: range.startColumn, range, url });
    else if (range) skipped.push(range);
  }
  return { links, skipped };
}

/** A text cell's content as a document holding one link; false when the cell cannot carry one. */
export function linkCell(cell: ICellData | undefined, url: string, rangeId: string, style: IStyleData | undefined): boolean {
  // One paragraph only: Univer ends paragraphs with \r, and multi-line links are rare.
  if (!cell || cell.f || cell.si || cell.p || typeof cell.v !== 'string' || !cell.v || /[\r\n]/.test(cell.v)) return false;
  const text = cell.v;
  const textStyle: Record<string, unknown> = {};
  for (const key of TEXT_STYLE_KEYS) if (style?.[key] !== undefined) textStyle[key] = style[key];
  const document: IDocumentData = {
    id: 'd',
    documentStyle: { textStyle },
    body: {
      dataStream: `${text}\r\n`,
      textRuns: Object.keys(textStyle).length ? [{ st: 0, ed: text.length, ts: textStyle }] : [],
      paragraphs: [{ startIndex: text.length, paragraphId: `${rangeId}p` }],
      sectionBreaks: [{ startIndex: text.length + 1, sectionId: `${rangeId}s` }],
      customRanges: [{ startIndex: 0, endIndex: text.length - 1, rangeId, rangeType: CustomRangeType.HYPERLINK, properties: { url } }],
    },
  };
  cell.p = document;
  return true;
}

const key = (row: number, column: number) => `${row}:${column}`;

function cellText(cell: ICellData | null | undefined): string {
  const stream = cell?.p?.body?.dataStream;
  if (typeof stream === 'string') return stream.replace(/\r?\n$/, '');
  return cell?.v === undefined || cell.v === null ? '' : String(cell.v);
}

/** The first link of every rich-text cell of a sheet snapshot. */
export function cellLinks(sheet: Partial<IWorksheetData> | undefined): Map<string, { url: string; tooltip?: string }> {
  const links = new Map<string, { url: string; tooltip?: string }>();
  for (const [row, columns] of Object.entries(sheet?.cellData ?? {})) {
    for (const [column, cell] of Object.entries(columns as Record<string, ICellData | null>)) {
      const range = cell?.p?.body?.customRanges?.find(item => item.rangeType === CustomRangeType.HYPERLINK);
      const url = range?.properties?.url;
      if (typeof url === 'string' && url) links.set(key(Number(row), Number(column)), { url, ...(range?.properties?.tooltip ? { tooltip: String(range.properties.tooltip) } : {}) });
    }
  }
  return links;
}

export interface HyperlinkChanges {
  /** Top-left cells (current coordinates) whose link was removed or replaced. */
  dropped: Set<string>;
  /** Links to write, by top-left cell. */
  written: Map<string, { url: string; tooltip?: string }>;
}

/**
 * How the sheet's links differ from what was loaded. `aligned` is the loaded sheet moved through
 * the row and column edits, so both sides use current coordinates.
 */
export function hyperlinkChanges(aligned: Partial<IWorksheetData>, now: Partial<IWorksheetData>): HyperlinkChanges | undefined {
  const before = cellLinks(aligned);
  const after = cellLinks(now);
  const text = (sheet: Partial<IWorksheetData>, cell: string) => {
    const [row, column] = cell.split(':').map(Number);
    return cellText((sheet.cellData as Record<number, Record<number, ICellData>> | undefined)?.[row]?.[column]);
  };
  const dropped = new Set<string>();
  const written = new Map<string, { url: string; tooltip?: string }>();
  // Links that appear in new places: added, or moved there by cut and paste or a sort (also onto a linked cell).
  const arrived = [...after].filter(([cell, link]) => before.get(cell)?.url !== link.url).map(([cell, link]) => `${link.url}\u0000${text(now, cell)}`);
  for (const [cell, link] of before) {
    const current = after.get(cell);
    if (current?.url === link.url) continue;
    if (current) {
      dropped.add(cell);
      written.set(cell, current);
      continue;
    }
    // Typing over a linked cell keeps its link, as in Excel; removing the link leaves the text,
    // and a moved cell takes its link along.
    if (text(aligned, cell) === text(now, cell) || arrived.includes(`${link.url}\u0000${text(aligned, cell)}`)) dropped.add(cell);
  }
  for (const [cell, link] of after) if (!before.has(cell)) written.set(cell, link);
  return dropped.size || written.size ? { dropped, written } : undefined;
}

/** Excel's location for a link inside the workbook, or undefined for names it cannot write. */
function excelLocation(url: string, sheetName: (sheetId: string) => string | undefined): string | undefined {
  const match = WORKBOOK_LINK.exec(url);
  if (!match) return undefined;
  const name = sheetName(match[1]);
  return name === undefined ? undefined : `${formulaSheetName(name)}!${match[2].toUpperCase()}`;
}

const isWorkbookLink = (url: string) => url.startsWith('#');

/**
 * The worksheet's `<hyperlinks>` and relationships after the editor's link changes. Dropped links
 * lose their element (and relationship); written links get fresh ones.
 */
export function rewriteHyperlinks(
  xml: string, relationships: string | undefined, changes: HyperlinkChanges, sheetName: (sheetId: string) => string | undefined,
): { xml: string; relationships: string | undefined } {
  const worksheet = firstXmlElement(xml, 'worksheet');
  const prefix = elementPrefix(worksheet?.name ?? '');
  const removedIds = new Set<string>();
  let result = mapElements(xml, 'hyperlink', element => {
    const range = parseRangeReference(xmlAttribute(element.open, 'ref') ?? '');
    if (!range || !changes.dropped.has(key(range.startRow, range.startColumn))) return undefined;
    const id = xmlAttribute(element.open, 'r:id') ?? xmlAttribute(element.open, 'id');
    if (id) removedIds.add(id);
    return null;
  });
  let rels = relationships;
  if (rels && removedIds.size) rels = mapElements(rels, 'Relationship', element => (removedIds.has(xmlAttribute(element.open, 'Id') ?? '') ? null : undefined));
  const used = new Set([...(rels ?? '').matchAll(/\bId="([^"]+)"/g)].map(match => match[1]));
  let next = 1;
  const newRelationships: string[] = [];
  const elements: string[] = [];
  for (const [cell, link] of changes.written) {
    const [row, column] = cell.split(':').map(Number);
    const ref = cellReference(row, column);
    const tooltip = link.tooltip ? ` tooltip="${encodeXmlAttribute(link.tooltip)}"` : '';
    if (isWorkbookLink(link.url)) {
      const location = excelLocation(link.url, sheetName);
      if (location) elements.push(`<hyperlink ref="${ref}" location="${encodeXmlAttribute(location)}"${tooltip}/>`);
      continue;
    }
    while (used.has(`rId${next}`)) next++;
    const id = `rId${next}`;
    used.add(id);
    newRelationships.push(`<Relationship Id="${id}" Type="${HYPERLINK_RELATIONSHIP}" Target="${encodeXmlAttribute(link.url)}" TargetMode="External"/>`);
    elements.push(`<hyperlink ref="${ref}" r:id="${id}"${tooltip}/>`);
  }
  if (newRelationships.length) {
    rels = rels
      ? rels.replace(/<\/((?:[\w.-]+:)?Relationships)>\s*$/, `${newRelationships.join('')}</$1>`)
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${newRelationships.join('')}</Relationships>`;
  }
  if (elements.length) {
    const markup = addElementPrefix(elements.join(''), prefix);
    const container = firstXmlElement(result, 'hyperlinks');
    if (container?.inner !== undefined) {
      const close = container.start + container.open.length + container.inner.length;
      result = result.slice(0, close) + markup + result.slice(close);
    } else {
      const next = AFTER_HYPERLINKS.map(name => firstXmlElement(result, name)).filter(Boolean).sort((a, b) => a!.start - b!.start)[0];
      const at = next ? next.start : result.lastIndexOf('</');
      result = result.slice(0, at) + addElementPrefix(`<hyperlinks>${elements.join('')}</hyperlinks>`, prefix) + result.slice(at);
    }
    // New relationship ids need the relationships namespace on the worksheet.
    if (newRelationships.length && worksheet && !/\sxmlns:r=/.test(worksheet.open)) {
      result = result.replace(worksheet.open, worksheet.open.replace(/>$/, ` xmlns:r="${RELATIONSHIPS_NS}">`));
    }
  }
  // A container left without links would be invalid.
  result = mapElements(result, 'hyperlinks', element => (element.inner !== undefined && ![...xmlElements(element.inner, 'hyperlink')].length ? null : undefined));
  return { xml: result, relationships: rels };
}
