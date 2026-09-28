import { DrawingTypeEnum, ImageSourceType, type IWorkbookData } from '@univerjs/core';

import type { ChartSpec } from './xlsxCharts';
import { CHART_CONTENT_TYPE } from './xlsxChartWriter';
import { stable } from './xlsxConditionalFormatExport';
import { addContentType, addDefaultContentType, nextPartName, relationshipsPath, relativeTarget, XlsxPackage } from './xlsxPackage';
import type { AxisGeometry } from './xlsxStructureExport';
import { mapElements, RelationshipTypes } from './xlsxStructureExport';
import {
  addElementPrefix, decodeXml, elementPrefix, encodeXmlAttribute, firstXmlElement, setXmlAttributes, xmlAttribute, type XmlElement, xmlElements,
} from './xlsxXml';

/**
 * Pictures and charts floating over a worksheet, from its drawing part to Univer's drawing model
 * and back. Moving, resizing or deleting one rewrites only its anchor; everything else in the
 * drawing part (shapes, groups, the chart parts themselves) keeps its bytes.
 */

/** Resource the sheet drawing plugin loads its drawings from (SHEET_DRAWING_PLUGIN). */
export const DRAWINGS_RESOURCE = 'SHEET_DRAWING_PLUGIN';
const EMU_PER_PIXEL = 9525;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
const ANCHORS = ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'] as const;

/** Univer's SheetDrawingAnchorType: '0' moves with cells, '1' moves and sizes, '2' neither. */
export const AnchorType = { Position: '0', Both: '1', None: '2' } as const;
export type AnchorType = typeof AnchorType[keyof typeof AnchorType];

interface CellOffset { column: number; columnOffset: number; row: number; rowOffset: number }

export interface SheetImage {
  unitId: string;
  subUnitId: string;
  drawingId: string;
  drawingType: DrawingTypeEnum;
  imageSourceType: ImageSourceType;
  source: string;
  name?: string;
  srcRect?: { left?: number; top?: number; right?: number; bottom?: number };
  transform: { left: number; top: number; width: number; height: number; angle?: number; flipX?: boolean; flipY?: boolean };
  sheetTransform: { from: CellOffset; to: CellOffset; angle?: number; flipX?: boolean; flipY?: boolean };
  axisAlignSheetTransform: { from: CellOffset; to: CellOffset };
  anchorType: AnchorType;
}

export interface SheetChartDrawing {
  unitId: string;
  subUnitId: string;
  drawingId: string;
  drawingType: DrawingTypeEnum;
  /** Float DOM component that draws the chart; `data.spec` is the parsed chart part. */
  componentKey: string;
  data: { spec: unknown };
  allowTransform: boolean;
  transform: SheetImage['transform'];
  sheetTransform: SheetImage['sheetTransform'];
  axisAlignSheetTransform: SheetImage['axisAlignSheetTransform'];
  anchorType: AnchorType;
}

export type SheetDrawing = SheetImage | SheetChartDrawing;

export interface ImportedDrawing {
  drawingId: string;
  /** The drawing part and the object's `cNvPr` id in it. */
  part: string;
  shapeId: string;
  drawing: SheetDrawing;
}

export interface DrawingGeometry { rows: AxisGeometry; columns: AxisGeometry }

interface AnchorElement extends XmlElement { local: typeof ANCHORS[number] }

/** Top-level anchors of a drawing part in document (stacking) order. */
function anchorsOf(xml: string): AnchorElement[] {
  const all: AnchorElement[] = [];
  for (const local of ANCHORS) for (const element of xmlElements(xml, local)) all.push({ ...element, local });
  return all.sort((a, b) => a.start - b.start);
}

function readPoint(xml: string | undefined): { column: number; columnOffset: number; row: number; rowOffset: number } | undefined {
  if (!xml) return undefined;
  const value = (name: string) => Number(decodeXml(firstXmlElement(xml, name)?.inner ?? ''));
  const point = { column: value('col'), columnOffset: value('colOff'), row: value('row'), rowOffset: value('rowOff') };
  return Object.values(point).every(Number.isFinite) ? point : undefined;
}

const toPixels = (point: { column: number; columnOffset: number; row: number; rowOffset: number }): CellOffset => ({
  column: point.column, columnOffset: point.columnOffset / EMU_PER_PIXEL, row: point.row, rowOffset: point.rowOffset / EMU_PER_PIXEL,
});

function locate(geometry: DrawingGeometry, left: number, top: number): CellOffset {
  const row = geometry.rows.locate(top * EMU_PER_PIXEL, 1_048_576);
  const column = geometry.columns.locate(left * EMU_PER_PIXEL, 16_384);
  return { column: column.index, columnOffset: column.offset / EMU_PER_PIXEL, row: row.index, rowOffset: row.offset / EMU_PER_PIXEL };
}

const positionOf = (geometry: DrawingGeometry, point: CellOffset) => ({
  left: geometry.columns.start(point.column) / EMU_PER_PIXEL + point.columnOffset,
  top: geometry.rows.start(point.row) / EMU_PER_PIXEL + point.rowOffset,
});

const CHART_URI = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const CHART_EX_URI = 'http://schemas.microsoft.com/office/drawing/2014/chartex';

/** Where an anchor puts its object, in Univer's terms. */
function placementOf(anchor: AnchorElement, geometry: DrawingGeometry): { from: CellOffset; to: CellOffset; anchorType: AnchorType } | undefined {
  const inner = anchor.inner ?? '';
  if (anchor.local === 'twoCellAnchor') {
    const start = readPoint(firstXmlElement(inner, 'from')?.inner);
    const end = readPoint(firstXmlElement(inner, 'to')?.inner);
    if (!start || !end) return undefined;
    const mode = xmlAttribute(anchor.open, 'editAs');
    return { from: toPixels(start), to: toPixels(end), anchorType: mode === 'oneCell' ? AnchorType.Position : mode === 'absolute' ? AnchorType.None : AnchorType.Both };
  }
  const extent = firstXmlElement(inner, 'ext');
  const width = Number(xmlAttribute(extent?.open ?? '<x>', 'cx')) / EMU_PER_PIXEL;
  const height = Number(xmlAttribute(extent?.open ?? '<x>', 'cy')) / EMU_PER_PIXEL;
  if (!(width > 0) || !(height > 0)) return undefined;
  let from: CellOffset;
  let anchorType: AnchorType;
  if (anchor.local === 'oneCellAnchor') {
    const start = readPoint(firstXmlElement(inner, 'from')?.inner);
    if (!start) return undefined;
    from = toPixels(start);
    anchorType = AnchorType.Position;
  } else {
    const position = firstXmlElement(inner, 'pos');
    const left = Number(xmlAttribute(position?.open ?? '<x>', 'x')) / EMU_PER_PIXEL;
    const top = Number(xmlAttribute(position?.open ?? '<x>', 'y')) / EMU_PER_PIXEL;
    if (!Number.isFinite(left) || !Number.isFinite(top)) return undefined;
    from = locate(geometry, left, top);
    anchorType = AnchorType.None;
  }
  const origin = positionOf(geometry, from);
  return { from, to: locate(geometry, origin.left + width, origin.top + height), anchorType };
}

/**
 * The pictures and charts of one drawing part as Univer drawings, in stacking order, and how many
 * other objects (shapes, groups, pictures it cannot draw) the part holds.
 */
export function importSheetDrawings(options: {
  xml: string;
  part: string;
  unitId: string;
  sheetId: string;
  geometry: DrawingGeometry;
  /** Media bytes by relationship id of the drawing part. */
  media: (relationshipId: string) => { bytes: Uint8Array; extension: string } | undefined;
  /** A chart's description by relationship id; undefined when the part is missing. */
  chart?: (relationshipId: string, extended: boolean) => unknown;
  chartComponent?: string;
}): { drawings: ImportedDrawing[]; skipped: number } {
  const { xml, geometry } = options;
  const drawings: ImportedDrawing[] = [];
  const anchors = anchorsOf(xml);
  for (const anchor of anchors) {
    const inner = anchor.inner;
    // Groups and shapes are neither pictures nor charts; they stay in the file untouched.
    if (!inner || firstXmlElement(inner, 'grpSp')) continue;
    const frame = firstXmlElement(inner, 'graphicFrame');
    const picture = frame ? undefined : firstXmlElement(inner, 'pic');
    const properties = firstXmlElement((frame ?? picture)?.inner ?? '', 'cNvPr');
    const shapeId = properties && xmlAttribute(properties.open, 'id');
    const placement = placementOf(anchor, geometry);
    if (!shapeId || !placement || (!frame && !picture?.inner)) continue;
    const { from, to, anchorType } = placement;
    const origin = positionOf(geometry, from);
    const end = positionOf(geometry, to);
    const transform = firstXmlElement((frame ?? picture)!.inner ?? '', 'xfrm');
    const angle = transform ? Number(xmlAttribute(transform.open, 'rot') ?? 0) / 60000 : 0;
    const flipX = transform ? xmlAttribute(transform.open, 'flipH') === '1' : false;
    const flipY = transform ? xmlAttribute(transform.open, 'flipV') === '1' : false;
    const box = { left: origin.left, top: origin.top, width: Math.max(1, end.left - origin.left), height: Math.max(1, end.top - origin.top) };
    if (frame) {
      const data = firstXmlElement(frame.inner ?? '', 'graphicData');
      const uri = data && xmlAttribute(data.open, 'uri');
      const reference = data?.inner ? firstXmlElement(data.inner, 'chart') : undefined;
      const relationshipId = reference && (xmlAttribute(reference.open, 'r:id') ?? xmlAttribute(reference.open, 'id'));
      if (!options.chart || !options.chartComponent || !relationshipId || (uri !== CHART_URI && uri !== CHART_EX_URI)) continue;
      const spec = options.chart(relationshipId, uri === CHART_EX_URI);
      if (!spec) continue;
      const drawingId = `lobster-chart-${options.sheetId}-${shapeId}`;
      const chart: SheetChartDrawing = {
        unitId: options.unitId, subUnitId: options.sheetId, drawingId,
        drawingType: DrawingTypeEnum.DRAWING_DOM,
        componentKey: options.chartComponent,
        data: { spec },
        allowTransform: true,
        transform: box,
        sheetTransform: { from, to },
        axisAlignSheetTransform: { from, to },
        anchorType,
      };
      drawings.push({ drawingId, part: options.part, shapeId, drawing: chart });
      continue;
    }
    const blip = firstXmlElement(picture!.inner!, 'blip');
    const relationshipId = blip && (xmlAttribute(blip.open, 'r:embed') ?? xmlAttribute(blip.open, 'embed'));
    const media = relationshipId ? options.media(relationshipId) : undefined;
    const mime = media && MIME[media.extension.toLowerCase()];
    if (!media || !mime) continue;
    const crop = firstXmlElement(picture!.inner!, 'srcRect');
    const drawingId = `lobster-image-${options.sheetId}-${shapeId}`;
    const cropValue = (name: string) => Number(xmlAttribute(crop?.open ?? '<x>', name) ?? 0) / 1000;
    drawings.push({
      drawingId, part: options.part, shapeId,
      drawing: {
        unitId: options.unitId,
        subUnitId: options.sheetId,
        drawingId,
        drawingType: DrawingTypeEnum.DRAWING_IMAGE,
        imageSourceType: ImageSourceType.BASE64,
        source: `data:${mime};base64,${base64(media.bytes)}`,
        ...(properties && xmlAttribute(properties.open, 'name') ? { name: xmlAttribute(properties.open, 'name') } : {}),
        ...(crop ? { srcRect: { left: cropValue('l'), top: cropValue('t'), right: cropValue('r'), bottom: cropValue('b') } } : {}),
        transform: { ...box, angle, flipX, flipY },
        sheetTransform: { from, to, angle, flipX, flipY },
        axisAlignSheetTransform: { from, to },
        anchorType,
      },
    });
  }
  return { drawings, skipped: anchors.length - drawings.length };
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

// ---------------------------------------------------------------------------------------------
// Writing moved, resized and deleted pictures and charts back

interface ModelImage {
  drawingId: string;
  sheetTransform?: { from: CellOffset; to: CellOffset };
  transform?: { left: number; top: number; width: number; height: number };
  anchorType?: string;
  drawingType?: number;
  /** Pictures: their image, as a data URL for pictures added in the editor. */
  source?: string;
  name?: string;
  /** Float DOM drawings (charts): the component and its data. */
  componentKey?: string;
  data?: { spec?: ChartSpec; origin?: { edits: number } };
}

/** Drawings of a Univer snapshot, per sheet id. */
export function drawingsOf(snapshot: IWorkbookData): Record<string, { data: Record<string, ModelImage>; order: string[] }> | undefined {
  const resource = snapshot.resources?.find(item => item.name === DRAWINGS_RESOURCE);
  if (!resource) return undefined;
  if (!resource.data) return {};
  try {
    return JSON.parse(resource.data) as Record<string, { data: Record<string, ModelImage>; order: string[] }>;
  } catch {
    return {};
  }
}

const placement = (drawing: ModelImage | SheetDrawing | undefined): string => {
  const transform = drawing?.sheetTransform;
  if (!transform) return '';
  const point = (value: CellOffset) => `${value.column}:${Math.round(value.columnOffset)}:${value.row}:${Math.round(value.rowOffset)}`;
  return `${point(transform.from)}|${point(transform.to)}|${drawing?.anchorType ?? ''}`;
};

/** Compare later saves with the pictures and charts as the model holds them right after loading. */
export function adoptLoadedDrawings(imported: Map<string, ImportedDrawing[]>, snapshot: IWorkbookData): void {
  const drawings = drawingsOf(snapshot);
  if (!drawings) return;
  for (const [sheetId, list] of imported) {
    for (const item of list) {
      const loaded = drawings[sheetId]?.data[item.drawingId];
      if (loaded?.sheetTransform) item.drawing = { ...item.drawing, sheetTransform: structuredClone(loaded.sheetTransform) as SheetImage['sheetTransform'], anchorType: (loaded.anchorType as AnchorType) ?? item.drawing.anchorType };
    }
  }
}

/** Whether a sheet's pictures and charts are where they were loaded. */
export function drawingsUnchanged(imported: ImportedDrawing[], current: Record<string, ModelImage> | undefined): boolean {
  return imported.every(item => {
    const now = current?.[item.drawingId];
    return now && placement(now) === placement(item.drawing);
  });
}

function writePoint(xml: string, point: CellOffset): string {
  let result = xml;
  const values: [string, number][] = [['col', point.column], ['colOff', Math.round(point.columnOffset * EMU_PER_PIXEL)], ['row', point.row], ['rowOff', Math.round(point.rowOffset * EMU_PER_PIXEL)]];
  for (const [name, value] of values) {
    const element = firstXmlElement(result, name);
    if (element?.inner !== undefined) result = result.slice(0, element.innerStart) + String(value) + result.slice(element.innerStart + element.inner.length);
  }
  return result;
}

function replaceChild(inner: string, local: string, transform: (element: XmlElement) => string): string {
  const element = firstXmlElement(inner, local);
  return element ? inner.slice(0, element.start) + transform(element) + inner.slice(element.end) : inner;
}

/**
 * A drawing part with moved pictures and charts re-anchored and deleted ones removed. `current`
 * is the sheet's drawing model; objects the editor did not load (shapes, groups) are left alone.
 */
export function rewriteSheetDrawings(xml: string, imported: ImportedDrawing[], current: Record<string, ModelImage> | undefined): string {
  const byShape = new Map(imported.map(item => [item.shapeId, item]));
  const rewrite = (anchor: XmlElement, local: typeof ANCHORS[number]): string | null | undefined => {
    if (!anchor.inner) return undefined;
    const frame = firstXmlElement(anchor.inner, 'graphicFrame');
    const picture = frame ?? firstXmlElement(anchor.inner, 'pic');
    const properties = picture?.inner ? firstXmlElement(picture.inner, 'cNvPr') : undefined;
    const item = properties ? byShape.get(xmlAttribute(properties.open, 'id') ?? '') : undefined;
    if (!item) return undefined;
    const now = current?.[item.drawingId];
    if (!now) return null;
    if (placement(now) === placement(item.drawing) || !now.sheetTransform) return undefined;
    const { from, to } = now.sheetTransform;
    let open = anchor.open;
    let inner = anchor.inner;
    if (local === 'twoCellAnchor') {
      const mode = now.anchorType === AnchorType.Position ? 'oneCell' : now.anchorType === AnchorType.None ? 'absolute' : undefined;
      open = setXmlAttributes(open, { editAs: mode });
      inner = replaceChild(inner, 'from', element => `${element.open}${writePoint(element.inner ?? '', from)}</${element.name}>`);
      inner = replaceChild(inner, 'to', element => `${element.open}${writePoint(element.inner ?? '', to)}</${element.name}>`);
    } else if (local === 'oneCellAnchor') {
      inner = replaceChild(inner, 'from', element => `${element.open}${writePoint(element.inner ?? '', from)}</${element.name}>`);
    }
    // Position and size in EMUs. A chart frame's own transform stays as Excel wrote it: the anchor
    // alone places the chart. A move keeps the size the file wrote, so pixel rounding cannot
    // resize the object.
    const box = now.transform;
    const loaded = item.drawing.transform;
    const width = Math.round((box?.width ?? 0) * EMU_PER_PIXEL);
    const height = Math.round((box?.height ?? 0) * EMU_PER_PIXEL);
    const resized = Boolean(box && width > 0 && height > 0)
      && (!loaded || Math.abs(loaded.width - box!.width) >= 0.5 || Math.abs(loaded.height - box!.height) >= 0.5);
    const offset = box ? { x: String(Math.round(box.left * EMU_PER_PIXEL)), y: String(Math.round(box.top * EMU_PER_PIXEL)) } : undefined;
    if (local === 'absoluteAnchor' && offset) inner = replaceChild(inner, 'pos', element => setXmlAttributes(element.open, offset));
    if (resized && local !== 'twoCellAnchor') {
      const objectStart = (firstXmlElement(inner, 'graphicFrame') ?? firstXmlElement(inner, 'pic'))?.start ?? 0;
      inner = mapElements(inner, 'ext', element => (xmlAttribute(element.open, 'cx') !== undefined && element.start < objectStart ? setXmlAttributes(element.open, { cx: String(width), cy: String(height) }) : undefined));
    }
    if (!frame && box) {
      inner = replaceChild(inner, 'xfrm', element => {
        if (element.inner === undefined) return element.open;
        let content = element.inner;
        if (resized) content = replaceChild(content, 'ext', ext => setXmlAttributes(ext.open, { cx: String(width), cy: String(height) }));
        if (offset) content = replaceChild(content, 'off', off => setXmlAttributes(off.open, offset));
        return `${element.open}${content}</${element.name}>`;
      });
    }
    return `${open}${inner}</${anchor.name}>`;
  };
  let result = xml;
  for (const local of ANCHORS) result = mapElements(result, local, element => rewrite(element, local));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Charts made or changed in the editor

const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const SPREADSHEET_DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Worksheet children that follow `<drawing>`, in schema order. */
const AFTER_DRAWING = ['legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

export interface NewSheetChart {
  drawingId: string;
  spec: ChartSpec;
  sheetTransform: { from: CellOffset; to: CellOffset };
  anchorType?: string;
  /** How many row and column edits preceded the chart; its references follow only later ones. */
  origin?: number;
}

/** A picture added in the editor: an image file embedded as a data URL. */
export interface NewSheetImage {
  drawingId: string;
  /** `data:image/png;base64,…` */
  source: string;
  name?: string;
  sheetTransform: { from: CellOffset; to: CellOffset };
  anchorType?: string;
}

/** Image formats a picture may be saved in, by MIME type, with the file extension they use. */
const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const DATA_URL = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/;

/** Whether a picture's source can be saved in a workbook: an embedded PNG, JPEG, GIF or BMP. */
export const isSavableImageSource = (source: unknown): boolean => {
  const match = typeof source === 'string' ? DATA_URL.exec(source) : null;
  return Boolean(match && IMAGE_EXTENSIONS[match[1].toLowerCase()]);
};

/** Pictures a sheet gained in the editor, in stacking order. */
export function imageChanges(imported: ImportedDrawing[], current: { data: Record<string, ModelImage>; order?: string[] } | undefined): NewSheetImage[] {
  if (!current) return [];
  const loaded = new Set(imported.map(item => item.drawingId));
  const order = current.order?.length ? current.order : Object.keys(current.data);
  const added: NewSheetImage[] = [];
  for (const id of order) {
    const drawing = current.data[id];
    if (!drawing || loaded.has(id) || drawing.drawingType !== DrawingTypeEnum.DRAWING_IMAGE || !drawing.sheetTransform || !isSavableImageSource(drawing.source)) continue;
    added.push({ drawingId: id, source: drawing.source!, ...(drawing.name ? { name: drawing.name } : {}), sheetTransform: drawing.sheetTransform, anchorType: drawing.anchorType });
  }
  return added;
}

export interface ChartChanges {
  /** Charts made in the editor, in stacking order. */
  added: NewSheetChart[];
  /** Charts from the file whose type, title or legend changed: their chart part is written anew. */
  edited: { item: ImportedDrawing; spec: ChartSpec }[];
}

const specOf = (drawing: SheetDrawing | ModelImage): ChartSpec | undefined => (drawing as { data?: { spec?: ChartSpec } }).data?.spec;

/** Charts a sheet gained or whose description changed since loading; undefined when none. */
export function chartChanges(imported: ImportedDrawing[], current: { data: Record<string, ModelImage>; order?: string[] } | undefined, component: string): ChartChanges | undefined {
  if (!current) return undefined;
  const loaded = new Set(imported.map(item => item.drawingId));
  const order = current.order?.length ? current.order : Object.keys(current.data);
  const added: NewSheetChart[] = [];
  for (const id of order) {
    const drawing = current.data[id];
    const spec = drawing && specOf(drawing);
    if (!drawing || loaded.has(id) || drawing.componentKey !== component || !spec || !drawing.sheetTransform || spec.unsupported) continue;
    added.push({ drawingId: id, spec, sheetTransform: drawing.sheetTransform, anchorType: drawing.anchorType, origin: drawing.data?.origin?.edits });
  }
  const edited: ChartChanges['edited'] = [];
  for (const item of imported) {
    const before = specOf(item.drawing);
    const now = current.data[item.drawingId];
    const after = now && specOf(now);
    if (before && after && !after.unsupported && stable(before) !== stable(after)) edited.push({ item, spec: after });
  }
  return added.length || edited.length ? { added, edited } : undefined;
}

/** The chart part a chart from the file lives in. */
export function chartPartOf(files: Map<string, Uint8Array>, item: ImportedDrawing): string | undefined {
  const pkg = new XlsxPackage(files);
  const xml = pkg.text(item.part);
  if (!xml) return undefined;
  for (const anchor of anchorsOf(xml)) {
    const frame = anchor.inner ? firstXmlElement(anchor.inner, 'graphicFrame') : undefined;
    const properties = frame?.inner ? firstXmlElement(frame.inner, 'cNvPr') : undefined;
    if (!properties || xmlAttribute(properties.open, 'id') !== item.shapeId) continue;
    const reference = firstXmlElement(frame!.inner!, 'chart');
    const id = reference && (xmlAttribute(reference.open, 'r:id') ?? xmlAttribute(reference.open, 'id'));
    return pkg.relationships(item.part).find(relation => relation.id === id && relation.type === RelationshipTypes.Chart && !relation.external)?.target;
  }
  return undefined;
}

function nextRelationshipId(rels: string | undefined): string {
  const used = new Set([...(rels ?? '').matchAll(/\bId="([^"]+)"/g)].map(match => match[1]));
  let number = 1;
  while (used.has(`rId${number}`)) number++;
  return `rId${number}`;
}

function withRelationship(rels: string | undefined, id: string, type: string, target: string): string {
  const element = `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  return rels
    ? rels.replace(/<\/((?:[\w.-]+:)?Relationships)>\s*$/, `${element}</$1>`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${element}</Relationships>`;
}

function point(name: string, value: CellOffset, prefix: string): string {
  return addElementPrefix(`<${name}><col>${value.column}</col><colOff>${Math.round(value.columnOffset * EMU_PER_PIXEL)}</colOff><row>${value.row}</row><rowOff>${Math.round(value.rowOffset * EMU_PER_PIXEL)}</rowOff></${name}>`, prefix);
}

function chartAnchor(chart: NewSheetChart, shapeId: number, relationshipId: string, prefix: string): string {
  const mode = chart.anchorType === AnchorType.Position ? ' editAs="oneCell"' : chart.anchorType === AnchorType.None ? ' editAs="absolute"' : '';
  const name = `Chart ${shapeId}`;
  const frame = addElementPrefix(`<graphicFrame macro=""><nvGraphicFramePr><cNvPr id="${shapeId}" name="${name}"/><cNvGraphicFramePr/></nvGraphicFramePr>`, prefix)
    + `${addElementPrefix('<xfrm>', prefix)}<a:off x="0" y="0"/><a:ext cx="0" cy="0"/>${addElementPrefix('</xfrm>', prefix)}`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${RELATIONSHIPS_NS}" r:id="${relationshipId}"/></a:graphicData></a:graphic>`
    + addElementPrefix('</graphicFrame>', prefix);
  return `${addElementPrefix(`<twoCellAnchor${mode}>`, prefix)}${point('from', chart.sheetTransform.from, prefix)}${point('to', chart.sheetTransform.to, prefix)}`
    + `${frame.replace(/^<([\w.:-]*graphicFrame) /, `<$1 xmlns:a="${DRAWINGML_NS}" `)}${addElementPrefix('<clientData/></twoCellAnchor>', prefix)}`;
}

function pictureAnchor(image: NewSheetImage, shapeId: number, relationshipId: string, prefix: string): string {
  // Excel inserts pictures to move with cells without resizing.
  const mode = image.anchorType === AnchorType.Both ? '' : image.anchorType === AnchorType.None ? ' editAs="absolute"' : ' editAs="oneCell"';
  const name = encodeXmlAttribute(image.name || `Picture ${shapeId}`);
  const picture = addElementPrefix(`<pic><nvPicPr><cNvPr id="${shapeId}" name="${name}"/><cNvPicPr>`, prefix) + '<a:picLocks noChangeAspect="1"/>'
    + addElementPrefix('</cNvPicPr></nvPicPr><blipFill>', prefix)
    + `<a:blip xmlns:r="${RELATIONSHIPS_NS}" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch>`
    + addElementPrefix('</blipFill><spPr>', prefix) + '<a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    + addElementPrefix('</spPr></pic>', prefix);
  return `${addElementPrefix(`<twoCellAnchor${mode}>`, prefix)}${point('from', image.sheetTransform.from, prefix)}${point('to', image.sheetTransform.to, prefix)}`
    + `${picture.replace(/^<([\w.:-]*pic)>/, `<$1 xmlns:a="${DRAWINGML_NS}">`)}${addElementPrefix('<clientData/></twoCellAnchor>', prefix)}`;
}

/** What a sheet gained in the editor: pictures, then charts, each above the ones before it. */
export interface NewSheetDrawings {
  images: NewSheetImage[];
  charts: NewSheetChart[];
}

/**
 * Pictures and charts made in the editor added to a worksheet: each gets its media or chart part,
 * and the sheet's drawing part an anchor for it (a sheet without one gets a drawing part, its
 * relationship and a `<drawing>` element). Returns the worksheet XML, changed when the drawing
 * element was added.
 */
export function addSheetDrawings(files: Map<string, Uint8Array>, sheetPart: string, sheetXml: string, added: NewSheetDrawings, chartXml: (spec: ChartSpec) => string): string {
  const { images, charts } = added;
  if (!charts.length && !images.length) return sheetXml;
  const encoder = new TextEncoder();
  const pkg = new XlsxPackage(files);
  let sheet = sheetXml;
  let drawingPart = pkg.relationships(sheetPart).find(relation => relation.type === RelationshipTypes.Drawing && !relation.external)?.target;
  let drawing = drawingPart ? pkg.text(drawingPart) : undefined;
  if (!drawingPart || drawing === undefined) {
    drawingPart = nextPartName(files, index => `xl/drawings/drawing${index}.xml`);
    drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${SPREADSHEET_DRAWING_NS}" xmlns:a="${DRAWINGML_NS}"></xdr:wsDr>`;
    addContentType(files, `/${drawingPart}`, DRAWING_CONTENT_TYPE);
    const sheetRelsPath = relationshipsPath(sheetPart);
    const sheetRels = pkg.text(sheetRelsPath);
    const id = nextRelationshipId(sheetRels);
    files.set(sheetRelsPath, encoder.encode(withRelationship(sheetRels, id, RelationshipTypes.Drawing, relativeTarget(sheetPart, drawingPart))));
    const worksheet = firstXmlElement(sheet, 'worksheet');
    const prefix = elementPrefix(worksheet?.name ?? '');
    const next = AFTER_DRAWING.map(name => firstXmlElement(sheet, name)).filter(Boolean).sort((a, b) => a!.start - b!.start)[0];
    const at = next ? next.start : sheet.lastIndexOf('</');
    sheet = sheet.slice(0, at) + addElementPrefix(`<drawing r:id="${id}"/>`, prefix) + sheet.slice(at);
    if (worksheet && !/\sxmlns:r=/.test(worksheet.open)) sheet = sheet.replace(worksheet.open, worksheet.open.replace(/>$/, ` xmlns:r="${RELATIONSHIPS_NS}">`));
  }
  const drawingRelsPath = relationshipsPath(drawingPart);
  let drawingRels = pkg.text(drawingRelsPath);
  const root = firstXmlElement(drawing, 'wsDr');
  const prefix = elementPrefix(root?.name ?? '');
  let shapeId = Math.max(0, ...[...drawing.matchAll(/<(?:[\w.-]+:)?cNvPr\b[^>]*\sid="(\d+)"/g)].map(match => Number(match[1])));
  const anchors: string[] = [];
  for (const image of images) {
    const [, mime, data] = DATA_URL.exec(image.source)!;
    const extension = IMAGE_EXTENSIONS[mime.toLowerCase()];
    const mediaPart = nextPartName(files, index => `xl/media/image${index}.${extension}`);
    files.set(mediaPart, base64Bytes(data));
    addDefaultContentType(files, extension, mime.toLowerCase());
    const id = nextRelationshipId(drawingRels);
    drawingRels = withRelationship(drawingRels, id, IMAGE_RELATIONSHIP, relativeTarget(drawingPart, mediaPart));
    anchors.push(pictureAnchor(image, ++shapeId, id, prefix));
  }
  for (const chart of charts) {
    const chartPart = nextPartName(files, index => `xl/charts/chart${index}.xml`);
    files.set(chartPart, encoder.encode(chartXml(chart.spec)));
    addContentType(files, `/${chartPart}`, CHART_CONTENT_TYPE);
    const id = nextRelationshipId(drawingRels);
    drawingRels = withRelationship(drawingRels, id, RelationshipTypes.Chart, relativeTarget(drawingPart, chartPart));
    anchors.push(chartAnchor(chart, ++shapeId, id, prefix));
  }
  drawing = drawing.replace(/<\/((?:[\w.-]+:)?wsDr)>\s*$/, `${anchors.join('')}</$1>`);
  files.set(drawingPart, encoder.encode(drawing));
  files.set(drawingRelsPath, encoder.encode(drawingRels!));
  return sheet;
}
