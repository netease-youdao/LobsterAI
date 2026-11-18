import { SlidesEditError, SlidesRefusal } from './slidesDeck';
import { shapeBoxEmu } from './slidesModel';
import type { SlidesPackage } from './slidesPackage';
import {
  bodyText, formatLines, formatRange, linesOf, paragraphsOf, setAlignment, setBodyText, type SlidesAlign, type TextStyleChange,
} from './slidesText';
import { create, descendants, el, elements, named, remove } from './slidesXml';

/**
 * Shapes of a slide as the editor and the agent address them: by their p:cNvPr id, including the
 * members of groups, and the edits both make to them.
 */

const SHAPE_NAMES = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp']);

const nvProps = (shape: Element): Element | undefined => elements(shape).find(child => child.localName.startsWith('nv'));
export const shapeIdOf = (shape: Element): string => named(nvProps(shape), 'cNvPr')?.getAttribute('id') ?? '';
export const shapeNameOf = (shape: Element): string => named(nvProps(shape), 'cNvPr')?.getAttribute('name') ?? '';
export const placeholderOf = (shape: Element): Element | undefined => el(named(nvProps(shape), 'nvPr'), 'p:ph');
export const tableOf = (shape: Element): Element | undefined => (shape.localName === 'graphicFrame' ? el(named(shape, 'graphic'), 'a:graphicData', 'a:tbl') : undefined);

export function slideTree(doc: Document): Element {
  const tree = el(doc.documentElement, 'p:cSld', 'p:spTree');
  if (!tree) throw new SlidesEditError('The slide has no shape tree.');
  return tree;
}

/** Shapes of a tree in drawing order, each group followed by its members. */
export function shapesIn(tree: Element, group?: Element): { shape: Element; group?: Element }[] {
  const out: { shape: Element; group?: Element }[] = [];
  for (const raw of elements(tree)) {
    const shape = raw.localName === 'AlternateContent' ? elements(named(raw, 'Choice') ?? named(raw, 'Fallback'))[0] : raw;
    if (!shape || !SHAPE_NAMES.has(shape.localName)) continue;
    out.push({ shape, group });
    if (shape.localName === 'grpSp') out.push(...shapesIn(shape, shape));
  }
  return out;
}

export function findShape(tree: Element, id: unknown): Element {
  const wanted = String(id ?? '');
  if (!wanted) throw new SlidesEditError('"shape" is required.');
  const found = shapesIn(tree).find(({ shape }) => shapeIdOf(shape) === wanted)?.shape;
  if (!found) throw new SlidesEditError(`There is no shape ${wanted} on that slide; read the slide again for the ids.`);
  return found;
}

/** Text bodies of a shape; a table's are its cells in reading order. */
export function textBodies(shape: Element): Element[] {
  const table = tableOf(shape);
  if (table) return elements(table, 'a:tr').flatMap(row => elements(row, 'a:tc').map(cell => el(cell, 'a:txBody')).filter((body): body is Element => Boolean(body)));
  const body = named(shape, 'txBody');
  return body ? [body] : [];
}

/** A shape's text body, created (centered, as PowerPoint does) when a plain shape has none. */
export function ensureTextBody(shape: Element): Element {
  const body = named(shape, 'txBody');
  if (body) return body;
  if (shape.localName !== 'sp') throw new SlidesEditError('That shape cannot hold text.');
  const doc = shape.ownerDocument!;
  const created = create(doc, 'p:txBody');
  created.appendChild(create(doc, 'a:bodyPr', { rtlCol: '0', anchor: 'ctr' }));
  created.appendChild(create(doc, 'a:lstStyle'));
  const paragraph = create(doc, 'a:p');
  paragraph.appendChild(create(doc, 'a:pPr', { algn: 'ctr' }));
  created.appendChild(paragraph);
  shape.appendChild(created);
  return created;
}

/** A table cell's text body (from 0), created when the cell has none. */
export function cellBody(shape: Element, row: number, column: number): Element {
  const table = tableOf(shape);
  if (!table) throw new SlidesEditError('That shape is not a table.');
  const cell = elements(elements(table, 'a:tr')[row], 'a:tc')[column];
  if (!cell) throw new SlidesEditError('That table has no such cell.');
  const existing = el(cell, 'a:txBody');
  if (existing) return existing;
  const doc = cell.ownerDocument!;
  const body = create(doc, 'a:txBody');
  body.appendChild(create(doc, 'a:bodyPr'));
  body.appendChild(create(doc, 'a:lstStyle'));
  body.appendChild(create(doc, 'a:p'));
  cell.insertBefore(body, cell.firstChild);
  return body;
}

/** The shape's own xfrm, created from what it inherits when it has none. */
function ownXfrm(pkg: SlidesPackage, slidePart: string, shape: Element): Element {
  const frame = shape.localName === 'graphicFrame';
  const holder = frame ? shape : named(shape, 'spPr') ?? named(shape, 'grpSpPr');
  if (!holder) throw new SlidesEditError('That shape cannot be moved.');
  const qualified = frame ? 'p:xfrm' : 'a:xfrm';
  const existing = el(holder, qualified);
  if (existing && el(existing, 'a:off') && el(existing, 'a:ext')) return existing;
  const box = shapeBoxEmu(pkg, slidePart, shape);
  if (!box) throw new SlidesEditError('That shape has no position to change.');
  const doc = shape.ownerDocument!;
  const xfrm = existing ?? create(doc, qualified);
  while (xfrm.firstChild) xfrm.removeChild(xfrm.firstChild);
  xfrm.appendChild(create(doc, 'a:off', { x: box.x, y: box.y }));
  xfrm.appendChild(create(doc, 'a:ext', { cx: box.w, cy: box.h }));
  // p:xfrm follows the frame's non-visual properties; a:xfrm opens spPr.
  if (!existing) holder.insertBefore(xfrm, frame ? nvProps(shape)?.nextSibling ?? null : holder.firstChild);
  return xfrm;
}

/** Move or resize a shape (EMU); a placeholder without a position of its own gets one. */
export function setShapeBounds(pkg: SlidesPackage, slidePart: string, shape: Element, bounds: { x?: number; y?: number; w?: number; h?: number }): void {
  const xfrm = ownXfrm(pkg, slidePart, shape);
  const off = el(xfrm, 'a:off')!;
  const ext = el(xfrm, 'a:ext')!;
  if (bounds.x !== undefined) off.setAttribute('x', String(Math.round(bounds.x)));
  if (bounds.y !== undefined) off.setAttribute('y', String(Math.round(bounds.y)));
  if (bounds.w !== undefined) ext.setAttribute('cx', String(Math.max(0, Math.round(bounds.w))));
  if (bounds.h !== undefined) ext.setAttribute('cy', String(Math.max(0, Math.round(bounds.h))));
}

/**
 * Delete a shape. An animated one is refused: its animation would point at nothing, which
 * PowerPoint reports as damage. Connectors attached to it are left in place, unattached.
 */
export function deleteShape(doc: Document, shape: Element): void {
  const ids = new Set([shapeIdOf(shape), ...(shape.localName === 'grpSp' ? shapesIn(shape).map(({ shape: member }) => shapeIdOf(member)) : [])]);
  if (descendants(doc, 'p:spTgt').some(target => ids.has(target.getAttribute('spid') ?? ''))) {
    throw new SlidesEditError('This shape is animated; remove its animation in PowerPoint first.', SlidesRefusal.Animated);
  }
  for (const name of ['a:stCxn', 'a:endCxn']) {
    for (const connection of descendants(doc, name)) if (ids.has(connection.getAttribute('id') ?? '')) remove(connection);
  }
  const wrapper = shape.parentNode as Element | null;
  remove(wrapper && (wrapper.localName === 'Choice' || wrapper.localName === 'Fallback') ? wrapper.parentNode : shape);
}

function nextShapeId(tree: Element): number {
  const ids = shapesIn(tree).map(({ shape }) => Number(shapeIdOf(shape)) || 0);
  return Math.max(1, Number(el(tree, 'p:nvGrpSpPr', 'p:cNvPr')?.getAttribute('id')) || 1, ...ids) + 1;
}

/** A text box like PowerPoint's: word-wrapped and growing with its text. Returns its id. */
export function addTextBox(doc: Document, tree: Element, box: { x: number; y: number; w: number; h: number }, text: string,
  style: TextStyleChange = {}, align?: typeof SlidesAlign[keyof typeof SlidesAlign], name = 'TextBox'): string {
  const id = nextShapeId(tree);
  const sp = create(doc, 'p:sp');
  const nv = create(doc, 'p:nvSpPr');
  nv.appendChild(create(doc, 'p:cNvPr', { id, name: `${name} ${id - 1}` }));
  nv.appendChild(create(doc, 'p:cNvSpPr', { txBox: '1' }));
  nv.appendChild(create(doc, 'p:nvPr'));
  sp.appendChild(nv);
  const spPr = create(doc, 'p:spPr');
  const xfrm = create(doc, 'a:xfrm');
  xfrm.appendChild(create(doc, 'a:off', { x: Math.round(box.x), y: Math.round(box.y) }));
  xfrm.appendChild(create(doc, 'a:ext', { cx: Math.round(box.w), cy: Math.round(box.h) }));
  spPr.appendChild(xfrm);
  const geometry = create(doc, 'a:prstGeom', { prst: 'rect' });
  geometry.appendChild(create(doc, 'a:avLst'));
  spPr.appendChild(geometry);
  spPr.appendChild(create(doc, 'a:noFill'));
  sp.appendChild(spPr);
  const body = create(doc, 'p:txBody');
  const bodyPr = create(doc, 'a:bodyPr', { wrap: 'square', rtlCol: '0' });
  bodyPr.appendChild(create(doc, 'a:spAutoFit'));
  body.appendChild(bodyPr);
  body.appendChild(create(doc, 'a:lstStyle'));
  const paragraph = create(doc, 'a:p');
  paragraph.appendChild(create(doc, 'a:endParaRPr', { lang: 'zh-CN', altLang: 'en-US', dirty: '0' }));
  body.appendChild(paragraph);
  sp.appendChild(body);
  // Ahead of an extension list the tree may end with.
  tree.insertBefore(sp, el(tree, 'p:extLst') ?? null);
  setBodyText(body, linesOf(text));
  for (const item of paragraphsOf(body)) {
    if (Object.keys(style).length) formatRange(item, style);
    if (align) setAlignment(item, align);
  }
  return String(id);
}

/** A shape's text as ppt_read and "Add to chat" give it: paragraphs by line, table cells by tab. */
export function shapeText(shape: Element): string {
  const table = tableOf(shape);
  if (table) return elements(table, 'a:tr').map(row => elements(row, 'a:tc').map(cell => formatLines(bodyText(el(cell, 'a:txBody'))).replace(/\n/g, ' ')).join('\t')).join('\n');
  return formatLines(bodyText(named(shape, 'txBody')));
}
