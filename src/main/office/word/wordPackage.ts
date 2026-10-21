import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { OfficeFileError } from '../../../shared/office/core/officeFile';
import { WORD_PACKAGE_LIMITS, type WordPackageInfo, WordReadOnlyReason } from '../../../shared/office/word/wordFile';
import type { WordDocumentFontDecl } from '../../../shared/office/word/wordFonts';
import { OfficePackageException, packageRelationships, readOfficeZip, xmlAttributes } from '../core/officeZip';

const DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

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

const MAX_FONT_DECLARATIONS = 256;

/** `w:font` entries of `word/fontTable.xml`: names, alternates and the classes Word falls back on. */
function parseFontTable(xml: string | undefined): WordDocumentFontDecl[] {
  if (!xml) return [];
  const fonts: WordDocumentFontDecl[] = [];
  const pattern = /<(?:[^\s<>/=:]+:)?font\b((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/(?:[^\s<>/=:]+:)?font>)/g;
  const localValue = (attributes: Map<string, string>, local: string) => [...attributes].find(([key]) => key.split(':').pop() === local)?.[1];
  const child = (body: string, local: string): string | undefined => {
    const match = body.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${local}\\b((?:[^"'>]|"[^"]*"|'[^']*')*)\\/?>`));
    return match ? localValue(xmlAttributes(match[0]), 'val') : undefined;
  };
  for (const match of xml.matchAll(pattern)) {
    const name = localValue(xmlAttributes(`<x${match[1]}>`), 'name')?.trim();
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
 * Admission for in-place document editing; the package itself is checked by `readOfficeZip`.
 * Review, protected, signed and embedded content still opens with true pagination, but read
 * only: the open core does not manage those structures, and editing around them could break
 * what Word expects.
 */
export function inspectWordPackage(bytes: Uint8Array): WordPackageInfo {
  const { names, xml } = readOfficeZip(bytes, WORD_PACKAGE_LIMITS);
  const types = xml.get('[Content_Types].xml');
  if (!types?.includes(DOCUMENT_CONTENT_TYPE) || !xml.has('word/document.xml') || !xml.has('_rels/.rels')) {
    throw new OfficePackageException(OfficeFileError.InvalidFile, 'Not a DOCX document package');
  }
  const readOnly = new Set<WordReadOnlyReason>();
  for (const name of names) {
    if (/^_xmlsignatures\//i.test(name)) readOnly.add(WordReadOnlyReason.Signature);
    if (/vbaProject\.bin$/i.test(name)) readOnly.add(WordReadOnlyReason.Macros);
    if (/^word\/embeddings\//i.test(name)) readOnly.add(WordReadOnlyReason.Embedded);
    if (/^word\/comments[^/]*\.xml$/i.test(name)
      && !(name === 'word/comments.xml' && isEmptyCommentPart(xml.get(name) ?? ''))) {
      readOnly.add(WordReadOnlyReason.Comments);
    }
  }
  for (const [name, text] of xml) {
    if (!/\.xml$|\.rels$/i.test(name)) continue;
    for (const match of text.matchAll(REVIEW_ELEMENT)) readOnly.add(REASON_BY_ELEMENT[match[1]]);
    // Linked (not embedded) resources other than hyperlinks are never fetched; keep them untouched.
    if (name.endsWith('.rels') && packageRelationships(text, name).some(relation => relation.external && !relation.type.endsWith('/hyperlink'))) {
      readOnly.add(WordReadOnlyReason.ExternalContent);
    }
  }
  return { readOnly: [...readOnly].sort(), fonts: parseFontTable(xml.get('word/fontTable.xml')) };
}
