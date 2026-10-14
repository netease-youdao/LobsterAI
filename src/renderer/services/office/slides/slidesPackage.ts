import { unzipSync, type Zippable, zipSync } from 'fflate';

import { create, elements, NS, type XmlCodec } from './slidesXml';

/**
 * A presentation package held as its parts: XML parts are parsed on first use and only the parts
 * an edit touched are written again, so everything the editor does not understand survives
 * byte for byte. Edits run in transactions that record what they changed, for undo and for
 * rolling back an agent call that fails halfway.
 */

const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const RelType = {
  OfficeDocument: `${OFFICE_REL}/officeDocument`,
  Slide: `${OFFICE_REL}/slide`,
  SlideLayout: `${OFFICE_REL}/slideLayout`,
  SlideMaster: `${OFFICE_REL}/slideMaster`,
  Theme: `${OFFICE_REL}/theme`,
  Image: `${OFFICE_REL}/image`,
  NotesSlide: `${OFFICE_REL}/notesSlide`,
  NotesMaster: `${OFFICE_REL}/notesMaster`,
  Chart: `${OFFICE_REL}/chart`,
  Comments: `${OFFICE_REL}/comments`,
  Hyperlink: `${OFFICE_REL}/hyperlink`,
  DiagramDrawing: 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
} as const;

const PRESENTATIONML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const ContentType = {
  Slide: `${PRESENTATIONML}.slide+xml`,
  NotesSlide: `${PRESENTATIONML}.notesSlide+xml`,
} as const;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
/** Fixed entry time, so that saving the same content twice gives the same bytes. */
const ENTRY_TIME = new Date(1980, 0, 1, 0, 0, 0);
/** Formats that do not shrink: stored, so saving a picture-heavy deck stays fast. */
const STORED = /\.(png|jpe?g|gif|mp4|m4v|mov|mp3|m4a|wav|wmv|avi|webm|webp)$/i;

export interface Relationship {
  id: string;
  type: string;
  /** A part name for internal targets, the URL for external ones. */
  target: string;
  external: boolean;
}

/** What one transaction changed: each touched part before and after (undefined when absent). */
export interface PackageChange {
  before: Map<string, string | Uint8Array | undefined>;
  after: Map<string, string | Uint8Array | undefined>;
}

const relsPartOf = (part: string): string => {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Relationship targets are URIs: characters outside the safe set are percent-encoded. */
const encodeSegment = (segment: string): string => segment.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]/g, character => encodeURIComponent(character));

/** Resolve a relationship target against the part that owns it. */
export function resolvePart(source: string, target: string): string {
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(decodeSegment(segment));
  }
  return segments.join('/');
}

/** The target to write for a part referenced from `source`. */
export function relativeTarget(source: string, part: string): string {
  const from = source.split('/').slice(0, -1);
  const to = part.split('/');
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => '..'), ...to.slice(common).map(encodeSegment)].join('/');
}

export class SlidesPackage {
  private readonly files = new Map<string, Uint8Array>();
  private readonly docs = new Map<string, Document>();
  private readonly dirty = new Set<string>();
  private readonly order: string[] = [];
  private change?: PackageChange;

  private constructor(readonly codec: XmlCodec) {}

  static open(bytes: Uint8Array, codec: XmlCodec): SlidesPackage {
    const pkg = new SlidesPackage(codec);
    for (const [name, content] of Object.entries(unzipSync(bytes))) {
      if (name.endsWith('/')) continue;
      pkg.files.set(name, content);
      pkg.order.push(name);
    }
    return pkg;
  }

  has(part: string): boolean {
    return this.files.has(part) || this.docs.has(part);
  }

  get parts(): string[] {
    return this.order.filter(part => this.has(part));
  }

  bytes(part: string): Uint8Array | undefined {
    const doc = this.docs.get(part);
    if (doc && this.dirty.has(part)) return new TextEncoder().encode(this.serialize(doc));
    return this.files.get(part);
  }

  xml(part: string): Document {
    let doc = this.docs.get(part);
    if (!doc) {
      const bytes = this.files.get(part);
      if (!bytes) throw new Error(`Missing part ${part}`);
      doc = this.codec.parse(new TextDecoder().decode(bytes));
      this.docs.set(part, doc);
    }
    return doc;
  }

  /** The part to change: recorded for undo and written again on save. */
  edit(part: string): Document {
    this.record(part);
    const doc = this.xml(part);
    this.dirty.add(part);
    return doc;
  }

  put(part: string, content: string | Uint8Array, contentType?: string): void {
    this.record(part);
    this.restore(part, content);
    if (!this.order.includes(part)) this.order.push(part);
    if (contentType) this.setContentType(part, contentType);
  }

  delete(part: string): void {
    this.record(part);
    this.restore(part, undefined);
    const types = this.edit('[Content_Types].xml');
    for (const override of elements(types.documentElement, 'ct:Override')) {
      if (override.getAttribute('PartName') === `/${part}`) types.documentElement.removeChild(override);
    }
    const rels = relsPartOf(part);
    if (this.has(rels)) {
      this.record(rels);
      this.restore(rels, undefined);
    }
  }

  contentType(part: string): string | undefined {
    const types = this.xml('[Content_Types].xml').documentElement;
    const override = elements(types, 'ct:Override').find(item => item.getAttribute('PartName') === `/${part}`);
    if (override) return override.getAttribute('ContentType') ?? undefined;
    const extension = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
    return elements(types, 'ct:Default').find(item => item.getAttribute('Extension')?.toLowerCase() === extension)?.getAttribute('ContentType') ?? undefined;
  }

  private setContentType(part: string, contentType: string): void {
    const doc = this.edit('[Content_Types].xml');
    const root = doc.documentElement;
    const existing = elements(root, 'ct:Override').find(item => item.getAttribute('PartName') === `/${part}`);
    if (existing) existing.setAttribute('ContentType', contentType);
    else root.appendChild(create(doc, 'ct:Override', { PartName: `/${part}`, ContentType: contentType }));
  }

  relationships(source: string): Relationship[] {
    const rels = relsPartOf(source);
    if (!this.has(rels)) return [];
    return elements(this.xml(rels).documentElement, 'rel:Relationship').map(item => {
      const external = item.getAttribute('TargetMode')?.toLowerCase() === 'external';
      const target = item.getAttribute('Target') ?? '';
      return { id: item.getAttribute('Id') ?? '', type: item.getAttribute('Type') ?? '', target: external ? target : resolvePart(source, target), external };
    });
  }

  target(source: string, id: string | undefined): string | undefined {
    const relationship = id ? this.relationships(source).find(item => item.id === id) : undefined;
    return relationship && !relationship.external ? relationship.target : undefined;
  }

  /** Add a relationship from `source` to `part` (or an external URL); returns its id. */
  relate(source: string, type: string, part: string, external = false): string {
    const relsPart = relsPartOf(source);
    if (!this.has(relsPart)) this.put(relsPart, `${XML_DECLARATION}<Relationships xmlns="${NS.rel}"/>`);
    const doc = this.edit(relsPart);
    const used = new Set(elements(doc.documentElement, 'rel:Relationship').map(item => item.getAttribute('Id')));
    let index = used.size + 1;
    while (used.has(`rId${index}`)) index++;
    const id = `rId${index}`;
    doc.documentElement.appendChild(create(doc, 'rel:Relationship', {
      Id: id, Type: type, Target: external ? part : relativeTarget(source, part), ...(external ? { TargetMode: 'External' } : {}),
    }));
    return id;
  }

  unrelate(source: string, id: string): void {
    const relsPart = relsPartOf(source);
    if (!this.has(relsPart)) return;
    const doc = this.edit(relsPart);
    for (const item of elements(doc.documentElement, 'rel:Relationship')) if (item.getAttribute('Id') === id) doc.documentElement.removeChild(item);
  }

  /** A part name like `ppt/slides/slide7.xml` that is not taken yet. */
  freePart(prefix: string, extension: string): string {
    for (let index = 1; ; index++) {
      const part = `${prefix}${index}${extension}`;
      if (!this.has(part)) return part;
    }
  }

  /**
   * Run `operation` as one change. When it throws, every part is put back as it was and the error
   * propagates, so a refused agent call never leaves half an edit behind.
   */
  transaction<T>(operation: () => T): { result: T; change: PackageChange } {
    if (this.change) throw new Error('Nested package transaction');
    const change: PackageChange = { before: new Map(), after: new Map() };
    this.change = change;
    try {
      const result = operation();
      for (const part of change.before.keys()) change.after.set(part, this.snapshot(part));
      for (const [part, before] of change.before) {
        // A part opened for changing but left as it was keeps its original bytes.
        const after = change.after.get(part);
        if (before instanceof Uint8Array && typeof after === 'string' && this.serialize(this.codec.parse(new TextDecoder().decode(before))) === after) {
          this.restore(part, before);
          change.before.delete(part);
          change.after.delete(part);
        }
      }
      return { result, change };
    } catch (error) {
      for (const [part, content] of change.before) this.restore(part, content);
      throw error;
    } finally {
      this.change = undefined;
    }
  }

  undo(change: PackageChange): void {
    for (const [part, content] of change.before) this.restore(part, content);
  }

  redo(change: PackageChange): void {
    for (const [part, content] of change.after) this.restore(part, content);
  }

  /** Remember a part's current content in the running transaction. */
  record(part: string): void {
    if (this.change && !this.change.before.has(part)) this.change.before.set(part, this.snapshot(part));
  }

  /** A part's content: its original bytes until it is changed, so undoing every change restores them exactly. */
  private snapshot(part: string): string | Uint8Array | undefined {
    const doc = this.docs.get(part);
    if (doc && this.dirty.has(part)) return this.serialize(doc);
    return this.files.get(part) ?? (doc ? this.serialize(doc) : undefined);
  }

  private restore(part: string, content: string | Uint8Array | undefined): void {
    this.docs.delete(part);
    this.files.delete(part);
    this.dirty.delete(part);
    if (content === undefined) return;
    if (typeof content === 'string') {
      this.docs.set(part, this.codec.parse(content));
      this.dirty.add(part);
    } else {
      this.files.set(part, content);
    }
    if (!this.order.includes(part)) this.order.push(part);
  }

  private serialize(doc: Document): string {
    const text = this.codec.serialize(doc).replace(/^<\?xml[^>]*\?>\s*/, '');
    return XML_DECLARATION + text;
  }

  /** The package as a file: untouched parts keep their exact bytes. */
  toBytes(): Uint8Array {
    const entries: Zippable = {};
    const names = this.parts;
    const ordered = ['[Content_Types].xml', ...names.filter(name => name !== '[Content_Types].xml')];
    for (const name of ordered) {
      const bytes = this.bytes(name);
      if (bytes) entries[name] = [bytes, { level: STORED.test(name) ? 0 : 6, mtime: ENTRY_TIME }];
    }
    return zipSync(entries);
  }
}
