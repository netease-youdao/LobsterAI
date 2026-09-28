import { unzipSync, type Zippable, zipSync } from 'fflate';

import { appendChildren, xmlAttribute, xmlElements } from './xlsxXml';

/** Fixed entry time so that saving the same content twice yields the same bytes. */
const ENTRY_TIME = new Date(1980, 0, 1, 0, 0, 0);
/** Media that is already compressed; deflating it again only costs time. */
const STORED = /\.(png|jpe?g|gif|emf|wmf|bin|mp3|mp4|wav)$/i;

export const RelationshipType = {
  OfficeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  Worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  SharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  Styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  Theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  CalcChain: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain',
  Table: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table',
} as const;

export interface Relationship {
  id: string;
  type: string;
  /** Resolved package path for internal targets; the raw target for external ones. */
  target: string;
  external: boolean;
}

/** The decompressed parts of an OOXML package, kept in their original order. */
export class XlsxPackage {
  private readonly decoder = new TextDecoder('utf-8');

  constructor(readonly files: Map<string, Uint8Array>) {}

  static read(bytes: Uint8Array): XlsxPackage {
    return new XlsxPackage(new Map(Object.entries(unzipSync(bytes))));
  }

  text(name: string): string | undefined {
    const bytes = this.files.get(name);
    if (!bytes) return undefined;
    const text = this.decoder.decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  relationships(part: string): Relationship[] {
    const xml = this.text(relationshipsPath(part));
    return xml ? parseRelationships(xml, part) : [];
  }
}

/** The first free part name of a numbered series (`xl/charts/chart{n}.xml`). */
export function nextPartName(files: Map<string, Uint8Array>, pattern: (index: number) => string): string {
  let index = 1;
  while (files.has(pattern(index))) index++;
  return pattern(index);
}

/** A part's path relative to another part's folder, as relationships write it: `../comments1.xml`. */
export function relativeTarget(from: string, to: string): string {
  const source = from.split('/').slice(0, -1);
  const target = to.split('/');
  let common = 0;
  while (common < source.length && common < target.length - 1 && source[common] === target[common]) common++;
  return [...Array(source.length - common).fill('..'), ...target.slice(common)].join('/');
}

const CONTENT_TYPES = '[Content_Types].xml';
const contentTypes = (files: Map<string, Uint8Array>) => new TextDecoder().decode(files.get(CONTENT_TYPES) ?? new Uint8Array());
const withinTypes = (types: string, markup: string) => appendChildren(types, 'Types', markup) ?? types;

export function addContentType(files: Map<string, Uint8Array>, partName: string, contentType: string): void {
  const types = contentTypes(files);
  if (types.includes(`PartName="${partName}"`)) return;
  files.set(CONTENT_TYPES, new TextEncoder().encode(withinTypes(types, `<Override PartName="${partName}" ContentType="${contentType}"/>`)));
}

export function addDefaultContentType(files: Map<string, Uint8Array>, extension: string, contentType: string): void {
  const types = contentTypes(files);
  if (new RegExp(`Extension="${extension}"`, 'i').test(types)) return;
  files.set(CONTENT_TYPES, new TextEncoder().encode(withinTypes(types, `<Default Extension="${extension}" ContentType="${contentType}"/>`)));
}

export function removeContentType(files: Map<string, Uint8Array>, partName: string): void {
  const types = contentTypes(files);
  let next = types;
  for (const element of [...xmlElements(types, 'Override')].reverse()) {
    if (xmlAttribute(element.open, 'PartName') === partName) next = next.slice(0, element.start) + next.slice(element.end);
  }
  if (next !== types) files.set(CONTENT_TYPES, new TextEncoder().encode(next));
}

export function relationshipsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Resolve an OPC relationship target against the part that owns the relationship. */
export function resolvePartPath(sourcePart: string, target: string): string {
  const segments = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const segment of target.replace(/^\//, '').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(decodeURIComponentSafe(segment));
  }
  return segments.join('/');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRelationships(xml: string, sourcePart: string): Relationship[] {
  const relationships: Relationship[] = [];
  for (const element of xmlElements(xml, 'Relationship')) {
    const id = xmlAttribute(element.open, 'Id');
    const type = xmlAttribute(element.open, 'Type');
    const target = xmlAttribute(element.open, 'Target');
    if (!id || !type || target === undefined) continue;
    const external = xmlAttribute(element.open, 'TargetMode')?.toLowerCase() === 'external';
    relationships.push({ id, type, external, target: external ? target : resolvePartPath(sourcePart, target) });
  }
  return relationships;
}

/** Zip parts in the given order. Stored media stays stored; XML is deflated. */
export function writePackage(files: Map<string, Uint8Array>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, bytes] of files) {
    if (name.endsWith('/')) continue;
    zippable[name] = [bytes, { level: STORED.test(name) ? 0 : 6, mtime: ENTRY_TIME }];
  }
  return zipSync(zippable);
}
