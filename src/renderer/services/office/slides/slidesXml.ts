/**
 * The DOM subset the presentation code uses, so the same code runs on the browser's DOMParser and,
 * in tests, on @xmldom/xmldom: namespace-aware lookups over childNodes, no selectors.
 */

export const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  dsp: 'http://schemas.microsoft.com/office/drawing/2008/diagram',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
} as const;
type Prefix = keyof typeof NS;

export interface XmlCodec {
  parse: (text: string) => Document;
  serialize: (document: Document) => string;
}

function checked(document: Document): Document {
  if (document.getElementsByTagName('parsererror').length) throw new Error('Invalid XML part');
  return document;
}

export const browserXmlCodec: XmlCodec = {
  parse: text => checked(new DOMParser().parseFromString(text, 'application/xml')),
  serialize: document => new XMLSerializer().serializeToString(document),
};

export const EMU_PER_PT = 12700;
export const EMU_PER_PX = 9525;
export const ptFromEmu = (emu: number): number => Math.round((emu / EMU_PER_PT) * 100) / 100;
export const emuFromPt = (pt: number): number => Math.round(pt * EMU_PER_PT);
export const pxFromEmu = (emu: number): number => emu / EMU_PER_PX;

const split = (qualified: string): [string, string] => {
  const [prefix, local] = qualified.split(':') as [Prefix, string];
  return [NS[prefix], local];
};

export const isElement = (node: Node | null | undefined): node is Element => node?.nodeType === 1;

/** Element children, optionally only those named `prefix:local`. */
export function elements(parent: Node | null | undefined, qualified?: string): Element[] {
  if (!parent) return [];
  const [ns, local] = qualified ? split(qualified) : [undefined, undefined];
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (isElement(node) && (!local || (node.localName === local && node.namespaceURI === ns))) out.push(node);
  }
  return out;
}

/** Element children by local name in any namespace (p:sp and dsp:sp alike). */
export function elementsNamed(parent: Node | null | undefined, local: string): Element[] {
  if (!parent) return [];
  const out: Element[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) if (isElement(node) && node.localName === local) out.push(node);
  return out;
}

/** The first child along a path of qualified names, e.g. `el(sp, 'p:nvSpPr', 'p:cNvPr')`. */
export function el(parent: Node | null | undefined, ...path: string[]): Element | undefined {
  let current: Node | undefined | null = parent;
  for (const step of path) {
    current = elements(current, step)[0];
    if (!current) return undefined;
  }
  return current as Element | undefined;
}

/** The first child by local name in any namespace. */
export const named = (parent: Node | null | undefined, local: string): Element | undefined => elementsNamed(parent, local)[0];

export function descendants(root: Element | Document, qualified: string): Element[] {
  const [ns, local] = split(qualified);
  return Array.from(root.getElementsByTagNameNS(ns, local));
}

export function num(element: Element | undefined, name: string): number | undefined {
  const value = element?.getAttribute(name);
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** OOXML booleans: "1", "true" and "on" are true. */
export function flag(element: Element | undefined, name: string): boolean | undefined {
  const value = element?.getAttribute(name);
  if (value === null || value === undefined || value === '') return undefined;
  return value === '1' || value === 'true' || value === 'on';
}

export function create(document: Document, qualified: string, attributes: Record<string, string | number> = {}): Element {
  const [ns] = split(qualified);
  const element = document.createElementNS(ns, qualified);
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith('r:')) element.setAttributeNS(NS.r, name, String(value));
    else element.setAttribute(name, String(value));
  }
  return element;
}

/** The child `prefix:local`, created in schema position before the first of `before` when missing. */
export function ensure(parent: Element, qualified: string, before: string[] = []): Element {
  const existing = el(parent, qualified);
  if (existing) return existing;
  const created = create(parent.ownerDocument!, qualified);
  const anchor = elements(parent).find(child => before.some(name => {
    const [ns, local] = split(name);
    return child.localName === local && child.namespaceURI === ns;
  }));
  parent.insertBefore(created, anchor ?? null);
  return created;
}

export function remove(node: Node | undefined | null): void {
  node?.parentNode?.removeChild(node);
}

export function removeChildren(parent: Element, qualified: string): void {
  for (const child of elements(parent, qualified)) parent.removeChild(child);
}

export function relationshipId(element: Element | undefined, local: string): string | undefined {
  return element?.getAttributeNS(NS.r, local) || undefined;
}
