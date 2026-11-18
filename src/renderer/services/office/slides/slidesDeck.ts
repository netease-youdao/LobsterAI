import { ContentType, RelType, type SlidesPackage } from './slidesPackage';
import { bodyText, formatLines, linesOf, setBodyText } from './slidesText';
import { create, descendants, el, elements, elementsNamed, flag, named, NS, num, relationshipId, remove } from './slidesXml';

/**
 * The presentation's structure: slide order, layouts, masters, notes and sections, and the
 * operations that change it the way PowerPoint does (ids, relationships, content types,
 * sections and custom shows kept consistent).
 */

/** Why an edit was refused, for the editor's notices; agent calls get the message. */
export const SlidesRefusal = {
  Invalid: 'invalid',
  Animated: 'animated',
  CopyUnsupported: 'copyUnsupported',
  NoNotesMaster: 'noNotesMaster',
} as const;
export type SlidesRefusal = typeof SlidesRefusal[keyof typeof SlidesRefusal];

export class SlidesEditError extends Error {
  constructor(message: string, readonly code: SlidesRefusal = SlidesRefusal.Invalid) {
    super(message);
  }
}

export interface SlideRef {
  /** Position from 0. */
  index: number;
  /** p:sldId/@id, stable while the slide exists. */
  id: number;
  relId: string;
  part: string;
  hidden: boolean;
}

const SLIDE_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
const EMPTY_GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
/** Placeholders a new slide does not copy from its layout. */
const LAYOUT_ONLY_PLACEHOLDERS = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
/** Relationships a duplicated slide can share with its original. */
const SHAREABLE = new Set<string>([
  RelType.SlideLayout, RelType.Image, RelType.Hyperlink, RelType.NotesSlide,
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio',
  'http://schemas.microsoft.com/office/2007/relationships/media',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
]);

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function presentationPart(pkg: SlidesPackage): string {
  const part = pkg.relationships('').find(relation => relation.type === RelType.OfficeDocument)?.target;
  if (!part) throw new SlidesEditError('The package has no presentation part.');
  return part;
}

export function slideRefs(pkg: SlidesPackage): SlideRef[] {
  const presentation = presentationPart(pkg);
  const list = el(pkg.xml(presentation).documentElement, 'p:sldIdLst');
  return elements(list, 'p:sldId').flatMap((item, index) => {
    const relId = relationshipId(item, 'id') ?? '';
    const part = pkg.target(presentation, relId);
    if (!part || !pkg.has(part)) return [];
    return [{ index, id: num(item, 'id') ?? 0, relId, part, hidden: flag(pkg.xml(part).documentElement, 'show') === false }];
  }).map((ref, index) => ({ ...ref, index }));
}

export function slideSize(pkg: SlidesPackage): { cx: number; cy: number } {
  const size = el(pkg.xml(presentationPart(pkg)).documentElement, 'p:sldSz');
  return { cx: num(size, 'cx') ?? 12192000, cy: num(size, 'cy') ?? 6858000 };
}

const relatedPart = (pkg: SlidesPackage, source: string, type: string): string | undefined => pkg.relationships(source).find(relation => relation.type === type && !relation.external)?.target;

export const layoutOf = (pkg: SlidesPackage, slide: string): string | undefined => relatedPart(pkg, slide, RelType.SlideLayout);
export const masterOf = (pkg: SlidesPackage, layout: string): string | undefined => relatedPart(pkg, layout, RelType.SlideMaster);
export const themeOf = (pkg: SlidesPackage, master: string): string | undefined => relatedPart(pkg, master, RelType.Theme);
export const notesOf = (pkg: SlidesPackage, slide: string): string | undefined => relatedPart(pkg, slide, RelType.NotesSlide);

export const layoutName = (pkg: SlidesPackage, layout: string): string => el(pkg.xml(layout).documentElement, 'p:cSld')?.getAttribute('name') ?? '';

/** Every layout of every master, in the order PowerPoint lists them. */
export function layouts(pkg: SlidesPackage): { part: string; name: string }[] {
  const presentation = presentationPart(pkg);
  const masters = elements(el(pkg.xml(presentation).documentElement, 'p:sldMasterIdLst'), 'p:sldMasterId')
    .map(item => pkg.target(presentation, relationshipId(item, 'id')))
    .filter((part): part is string => Boolean(part && pkg.has(part)));
  return masters.flatMap(master => elements(el(pkg.xml(master).documentElement, 'p:sldLayoutIdLst'), 'p:sldLayoutId')
    .map(item => pkg.target(master, relationshipId(item, 'id')))
    .filter((part): part is string => Boolean(part && pkg.has(part)))
    .map(part => ({ part, name: layoutName(pkg, part) })));
}

/**
 * The layout PowerPoint gives a slide added after `slide`: the same one, except that a title slide
 * is followed by its master's "Title and Content" layout.
 */
export function layoutAfter(pkg: SlidesPackage, slide: string | undefined): string | undefined {
  const current = slide ? layoutOf(pkg, slide) : undefined;
  if (!current) return layouts(pkg)[0]?.part;
  if (pkg.xml(current).documentElement.getAttribute('type') !== 'title') return current;
  const master = masterOf(pkg, current);
  return layouts(pkg).find(layout => masterOf(pkg, layout.part) === master && pkg.xml(layout.part).documentElement.getAttribute('type') === 'obj')?.part ?? current;
}

/** p14:sldIdLst of each section, when the presentation has sections. */
function sectionLists(presentation: Document): Element[] {
  return descendants(presentation, 'p14:section').map(section => el(section, 'p14:sldIdLst')).filter((list): list is Element => Boolean(list));
}

function sectionEntry(presentation: Document, id: number): Element | undefined {
  for (const list of sectionLists(presentation)) {
    const entry = elements(list, 'p14:sldId').find(item => num(item, 'id') === id);
    if (entry) return entry;
  }
  return undefined;
}

/** Put slide `id` into the section of its neighbor, next to it; slides without neighbors join the first section. */
function placeInSection(presentation: Document, id: number, neighbor: { id: number; before: boolean } | undefined): void {
  const lists = sectionLists(presentation);
  if (!lists.length) return;
  remove(sectionEntry(presentation, id));
  const entry = create(presentation, 'p14:sldId', { id });
  const anchor = neighbor ? sectionEntry(presentation, neighbor.id) : undefined;
  if (anchor) anchor.parentNode!.insertBefore(entry, neighbor!.before ? anchor : anchor.nextSibling);
  else lists[0].appendChild(entry);
}

function newSlideId(presentation: Document): number {
  const ids = descendants(presentation, 'p:sldId').map(item => num(item, 'id') ?? 0);
  return Math.max(255, ...ids) + 1;
}

/** Insert a slide part into the presentation after position `after` (-1: first). */
function insertSlide(pkg: SlidesPackage, part: string, after: number): SlideRef {
  const presentation = presentationPart(pkg);
  const relId = pkg.relate(presentation, RelType.Slide, part);
  const doc = pkg.edit(presentation);
  const root = doc.documentElement;
  let list = el(root, 'p:sldIdLst');
  if (!list) {
    list = create(doc, 'p:sldIdLst');
    root.insertBefore(list, el(root, 'p:sldSz') ?? null);
  }
  const existing = elements(list, 'p:sldId');
  const id = newSlideId(doc);
  const entry = create(doc, 'p:sldId', { id, 'r:id': relId });
  list.insertBefore(entry, existing[after + 1] ?? null);
  const previous = existing[after];
  const next = existing[after + 1];
  placeInSection(doc, id, previous ? { id: num(previous, 'id')!, before: false } : next ? { id: num(next, 'id')!, before: true } : undefined);
  return slideRefs(pkg).find(ref => ref.id === id)!;
}

/** A layout placeholder as a new slide's empty placeholder. */
function placeholderFrom(shape: Element, text: string | undefined): string {
  const cNvPr = el(shape, 'p:nvSpPr', 'p:cNvPr');
  const ph = el(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph');
  const attributes = ['type', 'orient', 'sz', 'idx', 'hasCustomPrompt'].map(name => {
    const value = ph?.getAttribute(name);
    return value && name !== 'hasCustomPrompt' ? ` ${name}="${escapeXml(value)}"` : '';
  }).join('');
  const paragraphs = text === undefined ? '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>'
    : linesOf(text).map(line => `<a:p>${line.level ? `<a:pPr lvl="${line.level}"/>` : ''}${line.text ? `<a:r><a:rPr lang="zh-CN" altLang="en-US" dirty="0"/><a:t>${escapeXml(line.text)}</a:t></a:r>` : '<a:endParaRPr lang="zh-CN" altLang="en-US"/>'}</a:p>`).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${cNvPr?.getAttribute('id') ?? 2}" name="${escapeXml(cNvPr?.getAttribute('name') ?? '')}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${attributes}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

const isTitle = (type: string | null | undefined): boolean => type === 'title' || type === 'ctrTitle';
const isBody = (type: string | null | undefined): boolean => !type || type === 'body' || type === 'obj' || type === 'subTitle';

/** Add a slide with `layout` after position `after` (-1: first), filling its title and body placeholders. */
export function addSlide(pkg: SlidesPackage, options: { layout: string; after: number; title?: string; body?: string }): SlideRef {
  const part = pkg.freePart('ppt/slides/slide', '.xml');
  let titled = false;
  let bodied = false;
  const shapes = elementsNamed(el(pkg.xml(options.layout).documentElement, 'p:cSld', 'p:spTree'), 'sp').flatMap(shape => {
    const type = el(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.getAttribute('type');
    if (!el(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph') || LAYOUT_ONLY_PLACEHOLDERS.has(type ?? '')) return [];
    let text: string | undefined;
    if (isTitle(type) && !titled) { text = options.title; titled = true; }
    else if (isBody(type) && !bodied) { text = options.body; bodied = true; }
    return [placeholderFrom(shape, text)];
  });
  if (options.title !== undefined && !titled) throw new SlidesEditError('That layout has no title placeholder.');
  if (options.body !== undefined && !bodied) throw new SlidesEditError('That layout has no body placeholder.');
  pkg.put(part, `<p:sld ${SLIDE_NS}><p:cSld><p:spTree>${EMPTY_GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`, ContentType.Slide);
  pkg.relate(part, RelType.SlideLayout, options.layout);
  return insertSlide(pkg, part, options.after);
}

/** Copy slide `index` (its notes too) right after it. */
export function duplicateSlide(pkg: SlidesPackage, index: number): SlideRef {
  const source = slideRefs(pkg)[index];
  if (!source) throw new SlidesEditError(`There is no slide ${index + 1}.`);
  const relationships = pkg.relationships(source.part);
  if (relationships.some(relation => !relation.external && !SHAREABLE.has(relation.type) && relation.type !== RelType.Comments)) {
    throw new SlidesEditError('This slide has charts, diagrams or embedded objects, which cannot be copied here yet.', SlidesRefusal.CopyUnsupported);
  }
  const part = pkg.freePart('ppt/slides/slide', '.xml');
  pkg.put(part, pkg.codec.serialize(pkg.xml(source.part)), ContentType.Slide);
  for (const relation of relationships) {
    if (relation.type === RelType.NotesSlide || relation.type === RelType.Comments) continue;
    const id = pkg.relate(part, relation.type, relation.target, relation.external);
    if (id !== relation.id) renameRelationship(pkg, part, id, relation.id);
  }
  const notes = notesOf(pkg, source.part);
  if (notes) copyNotes(pkg, notes, part);
  return insertSlide(pkg, part, index);
}

/** Give a just-created relationship the id the copied XML refers to. */
function renameRelationship(pkg: SlidesPackage, part: string, from: string, to: string): void {
  const slash = part.lastIndexOf('/');
  const rels = pkg.edit(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`);
  const items = elements(rels.documentElement, 'rel:Relationship');
  const clash = items.find(item => item.getAttribute('Id') === to);
  const created = items.find(item => item.getAttribute('Id') === from);
  if (clash && created && clash !== created) clash.setAttribute('Id', `${to}_${from}`);
  created?.setAttribute('Id', to);
}

function copyNotes(pkg: SlidesPackage, notes: string, slide: string): void {
  const part = pkg.freePart('ppt/notesSlides/notesSlide', '.xml');
  pkg.put(part, pkg.codec.serialize(pkg.xml(notes)), ContentType.NotesSlide);
  for (const relation of pkg.relationships(notes)) {
    const target = relation.type === RelType.Slide ? slide : relation.target;
    const id = pkg.relate(part, relation.type, target, relation.external);
    if (id !== relation.id) renameRelationship(pkg, part, id, relation.id);
  }
  pkg.relate(slide, RelType.NotesSlide, part);
}

/** Parts reachable from the package root through relationships. */
function reachable(pkg: SlidesPackage): Set<string> {
  const seen = new Set<string>();
  const queue = [''];
  while (queue.length) {
    const part = queue.pop()!;
    for (const relation of pkg.relationships(part)) {
      if (relation.external || seen.has(relation.target) || !pkg.has(relation.target)) continue;
      seen.add(relation.target);
      queue.push(relation.target);
    }
  }
  return seen;
}

export function deleteSlide(pkg: SlidesPackage, index: number): void {
  const target = slideRefs(pkg)[index];
  if (!target) throw new SlidesEditError(`There is no slide ${index + 1}.`);
  const before = reachable(pkg);
  const presentation = presentationPart(pkg);
  const doc = pkg.edit(presentation);
  for (const item of descendants(doc, 'p:sldId')) if (num(item, 'id') === target.id) remove(item);
  remove(sectionEntry(doc, target.id));
  // Custom shows list slides by the presentation's relationship id.
  for (const show of descendants(doc, 'p:custShow')) {
    for (const entry of elements(el(show, 'p:sldLst'), 'p:sld')) if (relationshipId(entry, 'id') === target.relId) remove(entry);
  }
  pkg.unrelate(presentation, target.relId);
  // Pictures, charts and notes used only by this slide go with it.
  const after = reachable(pkg);
  for (const part of before) if (!after.has(part)) pkg.delete(part);
}

export function moveSlide(pkg: SlidesPackage, from: number, to: number): void {
  const refs = slideRefs(pkg);
  const moving = refs[from];
  if (!moving) throw new SlidesEditError(`There is no slide ${from + 1}.`);
  const position = Math.max(0, Math.min(refs.length - 1, to));
  if (position === from) return;
  const doc = pkg.edit(presentationPart(pkg));
  const list = el(doc.documentElement, 'p:sldIdLst')!;
  const entries = elements(list, 'p:sldId');
  const entry = entries[from];
  list.removeChild(entry);
  const rest = elements(list, 'p:sldId');
  list.insertBefore(entry, rest[position] ?? null);
  const order = elements(list, 'p:sldId').map(item => num(item, 'id')!);
  const previous = order[position - 1];
  const next = order[position + 1];
  placeInSection(doc, moving.id, previous !== undefined ? { id: previous, before: false } : next !== undefined ? { id: next, before: true } : undefined);
}

/** The body placeholder of a notes slide. */
const notesBody = (doc: Document): Element | undefined => elementsNamed(el(doc.documentElement, 'p:cSld', 'p:spTree'), 'sp')
  .find(shape => el(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.getAttribute('type') === 'body');

export function notesText(pkg: SlidesPackage, slide: string): string {
  const notes = notesOf(pkg, slide);
  if (!notes) return '';
  return formatLines(bodyText(named(notesBody(pkg.xml(notes)), 'txBody')));
}

export function setNotes(pkg: SlidesPackage, slide: string, text: string): void {
  let notes = notesOf(pkg, slide);
  if (!notes) {
    const presentation = presentationPart(pkg);
    const master = pkg.target(presentation, relationshipId(el(pkg.xml(presentation).documentElement, 'p:notesMasterIdLst', 'p:notesMasterId'), 'id'));
    if (!master) throw new SlidesEditError('This presentation has no notes master, so speaker notes cannot be added here.', SlidesRefusal.NoNotesMaster);
    notes = pkg.freePart('ppt/notesSlides/notesSlide', '.xml');
    pkg.put(notes, `<p:notes ${SLIDE_NS}><p:cSld><p:spTree>${EMPTY_GROUP}`
      + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
      + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p></p:txBody></p:sp>'
      + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>', ContentType.NotesSlide);
    pkg.relate(notes, RelType.NotesMaster, master);
    pkg.relate(notes, RelType.Slide, slide);
    pkg.relate(slide, RelType.NotesSlide, notes);
  }
  const doc = pkg.edit(notes);
  const body = named(notesBody(doc), 'txBody');
  if (!body) throw new SlidesEditError('The speaker notes of this slide have no text area.');
  setBodyText(body, linesOf(text));
}
