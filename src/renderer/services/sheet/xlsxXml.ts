/**
 * Minimal SpreadsheetML text helpers. Parts are read and patched as text so that
 * markup the editor does not touch stays byte-identical in the saved package.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

/** Decode XML character and predefined entity references. */
export function decodeXml(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity[0] !== '#') return ENTITIES[entity];
    const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

export function encodeXmlText(text: string): string {
  return text.replace(/[&<>]/g, char => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

export function encodeXmlAttribute(text: string): string {
  return text.replace(/[&<>"\t\n\r]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
  })[char]!);
}

/** SpreadsheetML ST_Xstring escapes characters XML cannot carry as `_xHHHH_`. */
export function decodeExcelString(text: string): string {
  return text.includes('_x') ? text.replace(/_x([\da-fA-F]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : text;
}

export function encodeExcelString(text: string): string {
  return text
    .replace(/_(x[\da-fA-F]{4}_)/g, '_x005F_$1')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\r\uFFFE\uFFFF]/g, char => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
}

const NAME = '(?:[A-Za-z_][\\w.-]*:)?';
/** Attribute list of an opening tag, quote-aware so values may contain `>`. */
const ATTRIBUTES = '((?:[^"\'>]|"[^"]*"|\'[^\']*\')*?)';

export interface XmlElement {
  /** Offset of `<` of the opening tag. */
  start: number;
  /** Offset just past the closing tag (or the self-closing opening tag). */
  end: number;
  /** Qualified element name as written, e.g. `c` or `x:c`. */
  name: string;
  /** Opening tag text including `<` and `>`. */
  open: string;
  /** Content between the tags; undefined for a self-closing element. */
  inner?: string;
  innerStart: number;
}

const openingTags = new Map<string, RegExp>();
function openingTag(local: string): RegExp {
  let pattern = openingTags.get(local);
  if (!pattern) {
    pattern = new RegExp(`<(${NAME}${local})(?=[\\s/>])${ATTRIBUTES}(\\/?)>`, 'g');
    openingTags.set(local, pattern);
  }
  return pattern;
}

/**
 * Every `<local …/>` or `<local …>…</local>` element in `[from, to)`, optionally namespace
 * prefixed. The element must not nest inside itself, which holds for the SpreadsheetML
 * elements this module reads (rows, cells, style records, relationships …).
 */
export function* xmlElements(xml: string, local: string, from = 0, to = xml.length): Generator<XmlElement> {
  const pattern = new RegExp(openingTag(local).source, 'g');
  pattern.lastIndex = from;
  for (let match = pattern.exec(xml); match && match.index < to; match = pattern.exec(xml)) {
    const start = match.index;
    const name = match[1];
    const open = match[0];
    const innerStart = start + open.length;
    if (match[3] === '/') {
      yield { start, end: innerStart, name, open, innerStart };
      continue;
    }
    const close = xml.indexOf(`</${name}>`, innerStart);
    if (close < 0 || close >= to) throw new Error(`Unclosed <${name}> element`);
    const end = close + name.length + 3;
    pattern.lastIndex = end;
    yield { start, end, name, open, inner: xml.slice(innerStart, close), innerStart };
  }
}

export function firstXmlElement(xml: string, local: string, from = 0, to = xml.length): XmlElement | undefined {
  for (const element of xmlElements(xml, local, from, to)) return element;
  return undefined;
}

/** Attributes of an opening tag by qualified name, values decoded. */
export function xmlAttributes(open: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const body = open.replace(/^<[^\s/>]+/, '');
  for (const match of body.matchAll(/([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    attributes.set(match[1], decodeXml(match[3]));
  }
  return attributes;
}

/** An attribute by local name, ignoring any namespace prefix (`r:id` matches `id` only when asked with the prefix). */
export function xmlAttribute(open: string, name: string): string | undefined {
  const attributes = xmlAttributes(open);
  if (attributes.has(name)) return attributes.get(name);
  if (name.includes(':')) return undefined;
  for (const [key, value] of attributes) if (key.split(':').pop() === name && !key.startsWith('xmlns')) return value;
  return undefined;
}

/** Rewrite some attributes of an opening tag, keeping the others in place. `undefined` removes one. */
export function setXmlAttributes(open: string, changes: Record<string, string | undefined>): string {
  const selfClosing = /\/>$/.test(open);
  const head = open.match(/^<[^\s/>]+/)![0];
  const body = open.slice(head.length, open.length - (selfClosing ? 2 : 1));
  const pending = new Map(Object.entries(changes));
  let rewritten = body.replace(/(\s*)([^\s=/>]+)(\s*=\s*)(["'])([\s\S]*?)\4/g, (match, space: string, key: string) => {
    if (!pending.has(key)) return match;
    const value = pending.get(key);
    pending.delete(key);
    return value === undefined ? '' : `${space || ' '}${key}="${encodeXmlAttribute(value)}"`;
  });
  for (const [key, value] of pending) if (value !== undefined) rewritten += ` ${key}="${encodeXmlAttribute(value)}"`;
  return `${head}${rewritten.replace(/\s+$/, '')}${selfClosing ? '/>' : '>'}`;
}

/** `x:` for `x:fonts`, '' for an unprefixed element name. */
export function elementPrefix(qualifiedName: string): string {
  const colon = qualifiedName.indexOf(':');
  return colon < 0 ? '' : qualifiedName.slice(0, colon + 1);
}

/** Remove one namespace prefix from element names (not attributes) in `markup`. */
export function stripElementPrefix(markup: string, prefix: string): string {
  return prefix ? markup.split(`</${prefix}`).join('</').split(`<${prefix}`).join('<') : markup;
}

/** Give unprefixed element names in generated `markup` the prefix of the part being patched. */
export function addElementPrefix(markup: string, prefix: string): string {
  return prefix ? markup.replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, `<$1${prefix}$2`) : markup;
}

/** Text of every `<t>` in `xml`, skipping phonetic runs (`<rPh>`), with Excel escapes decoded. */
export function plainText(xml: string): string {
  const withoutPhonetics = xml.replace(new RegExp(`<(${NAME}rPh)\\b[\\s\\S]*?</\\1>`, 'g'), '');
  let text = '';
  for (const element of xmlElements(withoutPhonetics, 't')) text += decodeExcelString(decodeXml(element.inner ?? ''));
  return text;
}
