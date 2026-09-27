import { crc32, inflateRawSync } from 'node:zlib';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  WORD_MAX_EXPANDED_BYTES, WORD_MAX_FILE_BYTES, WORD_MAX_PART_BYTES, WORD_MAX_PARTS,
  WordFileError, type WordPackageInfo, WordReadOnlyReason,
} from '../../shared/artifactPreview/wordEditing';
import type { WordDocumentFontDecl } from '../../shared/artifactPreview/wordFonts';

export class WordFileException extends Error {
  constructor(readonly code: WordFileError, message: string) {
    super(message);
  }
}

const invalid = (message: string): never => {
  throw new WordFileException(WordFileError.InvalidFile, message);
};
const unsupported = (message: string): never => {
  throw new WordFileException(WordFileError.Unsupported, message);
};
const tooLarge = (): never => {
  throw new WordFileException(WordFileError.TooLarge, 'DOCX exceeds editing limits');
};

const commentPartParser = new XMLParser({
  ignoreAttributes: true, removeNSPrefix: true, ignoreDeclaration: true, ignorePiTags: true,
  parseTagValue: false, trimValues: true, processEntities: false,
});

/** Generators can emit an empty comments.xml even when no annotations exist. */
function isEmptyCommentPart(xml: string): boolean {
  if (XMLValidator.validate(xml) !== true) return false;
  try {
    const parsed: Record<string, unknown> = commentPartParser.parse(xml);
    // Admit only the empty container; unknown children, text and even a blank
    // comment record must keep using preview until review editing is supported.
    return Object.keys(parsed).length === 1 && parsed.comments === '';
  } catch {
    return false;
  }
}

/** Decode XML attribute references once; DTD-defined entities are rejected above. */
function relationshipAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  for (const match of tag.matchAll(/\s([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    const value = match[3].replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_reference, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity];
      const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) invalid('Invalid XML character reference');
      return String.fromCodePoint(code);
    });
    attributes.set(match[1], value);
  }
  return attributes;
}

const MAX_FONT_DECLARATIONS = 256;

/** `w:font` entries of `word/fontTable.xml`: names, alternates and the classes Word falls back on. */
function parseFontTable(xml: string | undefined): WordDocumentFontDecl[] {
  if (!xml) return [];
  const fonts: WordDocumentFontDecl[] = [];
  const pattern = /<(?:[^\s<>/=:]+:)?font\b((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/(?:[^\s<>/=:]+:)?font>)/g;
  const child = (body: string, local: string): string | undefined => {
    const match = body.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${local}\\b((?:[^"'>]|"[^"]*"|'[^']*')*)\\/?>`));
    return match ? [...relationshipAttributes(match[0])].find(([key]) => key.split(':').pop() === 'val')?.[1] : undefined;
  };
  for (const match of xml.matchAll(pattern)) {
    const name = [...relationshipAttributes(`<x${match[1]}>`)].find(([key]) => key.split(':').pop() === 'name')?.[1]?.trim();
    if (!name || name.length > 64) continue;
    const body = match[3] ?? '';
    const decl: WordDocumentFontDecl = { name };
    const altName = child(body, 'altName')?.trim();
    if (altName && altName.length <= 64) decl.altName = altName;
    const family = child(body, 'family');
    if (family) decl.family = family;
    const charset = child(body, 'charset');
    if (charset && /^[0-9a-f]{1,2}$/i.test(charset)) decl.charset = charset.toUpperCase();
    const pitch = child(body, 'pitch');
    if (pitch) decl.pitch = pitch;
    fonts.push(decl);
    if (fonts.length >= MAX_FONT_DECLARATIONS) break;
  }
  return fonts;
}

const REVIEW_ELEMENT = /<(?:[^\s<>/=:]+:)?(ins|del|moveFrom|moveTo|rPrChange|pPrChange|sectPrChange|tblPrChange|trPrChange|tcPrChange|numberingChange|comment|commentRangeStart|commentRangeEnd|commentReference|documentProtection|altChunk|object)(?:\s|\/?>)/g;
const REASON_BY_ELEMENT: Record<string, WordReadOnlyReason> = {
  ins: WordReadOnlyReason.Revisions, del: WordReadOnlyReason.Revisions,
  moveFrom: WordReadOnlyReason.Revisions, moveTo: WordReadOnlyReason.Revisions,
  rPrChange: WordReadOnlyReason.Revisions, pPrChange: WordReadOnlyReason.Revisions,
  sectPrChange: WordReadOnlyReason.Revisions, tblPrChange: WordReadOnlyReason.Revisions,
  trPrChange: WordReadOnlyReason.Revisions, tcPrChange: WordReadOnlyReason.Revisions,
  numberingChange: WordReadOnlyReason.Revisions,
  comment: WordReadOnlyReason.Comments, commentRangeStart: WordReadOnlyReason.Comments,
  commentRangeEnd: WordReadOnlyReason.Comments, commentReference: WordReadOnlyReason.Comments,
  documentProtection: WordReadOnlyReason.Protection, altChunk: WordReadOnlyReason.Embedded, object: WordReadOnlyReason.Embedded,
};

/**
 * Inspect the ZIP directory BEFORE inflation. Never trust the declared expanded size:
 * zlib gets an output cap too. No entries are extracted to filesystem paths.
 * Malformed, encrypted and ZIP64 packages are refused. Review, protected, signed and
 * embedded content still opens with true pagination, but read only: the open core does
 * not manage those structures, and editing around them could break what Word expects.
 */
export function inspectWordPackage(input: Uint8Array): WordPackageInfo {
  if (!(input instanceof Uint8Array)) invalid('Expected DOCX bytes');
  if (input.byteLength > WORD_MAX_FILE_BYTES) tooLarge();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 22) invalid('Not a ZIP archive');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) invalid('Missing ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
    || bytes.readUInt16LE(end + 8) !== count) unsupported('ZIP64/multi-disk DOCX');
  if (count > WORD_MAX_PARTS) tooLarge();
  if (directoryStart + directorySize !== end) invalid('Invalid ZIP directory bounds');
  const names = new Set<string>();
  const xml = new Map<string, string>();
  const readOnly = new Set<WordReadOnlyReason>();
  let offset = directoryStart;
  let expandedTotal = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) invalid('Invalid ZIP entry');
    const flags = bytes.readUInt16LE(offset + 8);
    const compression = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const entryEnd = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    if (entryEnd > end || local + 30 > directoryStart) invalid('ZIP entry out of bounds');
    if (flags & 1 || ![0, 8].includes(compression)) unsupported('Encrypted or unsupported ZIP entry');
    if (expanded > WORD_MAX_PART_BYTES || expandedTotal + expanded > WORD_MAX_EXPANDED_BYTES) tooLarge();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')
      || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) invalid('Invalid or duplicate ZIP path');
    names.add(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 8) !== compression || bytes.readUInt16LE(local + 6) !== flags) invalid('ZIP header mismatch');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (dataStart + compressed > directoryStart
      || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) invalid('ZIP content bounds mismatch');
    const packed = bytes.subarray(dataStart, dataStart + compressed);
    let content: Buffer;
    try {
      content = compression === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, Math.min(expanded, WORD_MAX_PART_BYTES)) });
    } catch {
      invalid('Invalid or oversized ZIP stream');
    }
    if (content.length !== expanded) invalid('ZIP expanded size mismatch');
    if (crc32(content) !== bytes.readUInt32LE(offset + 16)) invalid('ZIP content checksum mismatch');
    expandedTotal += content.length;
    if (/\.xml$|\.rels$/i.test(name)) {
      const text = decoder.decode(content);
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) unsupported('XML entities are not supported');
      xml.set(name, text);
      for (const match of text.matchAll(REVIEW_ELEMENT)) readOnly.add(REASON_BY_ELEMENT[match[1]]);
    }
    if (/^_xmlsignatures\//i.test(name)) readOnly.add(WordReadOnlyReason.Signature);
    if (/vbaProject\.bin$/i.test(name)) readOnly.add(WordReadOnlyReason.Macros);
    if (/^word\/embeddings\//i.test(name)) readOnly.add(WordReadOnlyReason.Embedded);
    if (/^word\/comments[^/]*\.xml$/i.test(name)
      && !(name === 'word/comments.xml' && isEmptyCommentPart(xml.get(name)!))) {
      readOnly.add(WordReadOnlyReason.Comments);
    }
    offset = entryEnd;
  }
  if (offset !== end) invalid('ZIP directory size mismatch');
  const types = xml.get('[Content_Types].xml');
  const document = xml.get('word/document.xml');
  if (!types?.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    || !document || !xml.has('_rels/.rels')) invalid('Not a DOCX document package');
  // Linked (not embedded) resources other than hyperlinks are never fetched; keep them untouched.
  for (const [name, text] of xml) {
    if (!name.endsWith('.rels')) continue;
    const relations = text.match(/<(?:[^\s<>/=:]+:)?Relationship\b(?:[^"'>]|"[^"]*"|'[^']*')*>/g) ?? [];
    if (relations.some(relation => {
      const attributes = relationshipAttributes(relation);
      return attributes.get('TargetMode')?.toLowerCase() === 'external'
        && !attributes.get('Type')?.endsWith('/hyperlink');
    })) readOnly.add(WordReadOnlyReason.ExternalContent);
  }
  return { readOnly: [...readOnly].sort(), fonts: parseFontTable(xml.get('word/fontTable.xml')) };
}
