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
const STORY_PART_PATTERN = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|numbering)\.xml$/i;
const RFONTS_TAG_PATTERN = /<(?:[^\s<>/=:]+:)?rFonts\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g;
const SYM_TAG_PATTERN = /<(?:[^\s<>/=:]+:)?sym\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g;
const STYLE_REF_PATTERN = /<(?:[^\s<>/=:]+:)?(?:pStyle|rStyle|tblStyle)\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g;
const STYLE_BLOCK_PATTERN = /<(?:[^\s<>/=:]+:)?style\b((?:[^"'>]|"[^"]*"|'[^']*')*)(?:\/>|>([\s\S]*?)<\/(?:[^\s<>/=:]+:)?style>)/g;
const DOC_DEFAULTS_PATTERN = /<(?:[^\s<>/=:]+:)?docDefaults\b[^>]*>([\s\S]*?)<\/(?:[^\s<>/=:]+:)?docDefaults>/;
const THEME_FONT_LANG_PATTERN = /<(?:[^\s<>/=:]+:)?themeFontLang\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/;

const FontSlot = { Ascii: 'ascii', HAnsi: 'hAnsi', EastAsia: 'eastAsia', Cs: 'cs' } as const;
type FontSlot = typeof FontSlot[keyof typeof FontSlot];

const SLOT_THEME_ATTR: readonly [FontSlot, string][] = [
  [FontSlot.Ascii, 'asciiTheme'],
  [FontSlot.HAnsi, 'hAnsiTheme'],
  [FontSlot.EastAsia, 'eastAsiaTheme'],
  [FontSlot.Cs, 'cstheme'],
];

const localAttr = (attributes: Map<string, string>, local: string): string | undefined => (
  [...attributes].find(([key]) => key.split(':').pop() === local)?.[1]
);

/** `w:font` entries of `word/fontTable.xml`: names, alternates and the classes Word falls back on. */
function parseFontTable(xml: string | undefined): WordDocumentFontDecl[] {
  if (!xml) return [];
  const fonts: WordDocumentFontDecl[] = [];
  const pattern = /<(?:[^\s<>/=:]+:)?font\b((?:[^"'>]|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/(?:[^\s<>/=:]+:)?font>)/g;
  const child = (body: string, local: string): string | undefined => {
    const match = body.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${local}\\b((?:[^"'>]|"[^"]*"|'[^']*')*)\\/?>`));
    return match ? localAttr(xmlAttributes(match[0]), 'val') : undefined;
  };
  for (const match of xml.matchAll(pattern)) {
    const name = localAttr(xmlAttributes(`<x${match[1]}>`), 'name')?.trim();
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

function collectRunFontsFromXml(
  fragment: string,
  explicitFonts: Set<string>,
  themeRefs: Set<string>,
  coveredSlots?: Set<FontSlot>,
): void {
  for (const match of fragment.matchAll(RFONTS_TAG_PATTERN)) {
    const attrs = xmlAttributes(`<x${match[1]}>`);
    for (const [slot, themeAttr] of SLOT_THEME_ATTR) {
      const explicit = localAttr(attrs, slot)?.trim();
      const theme = localAttr(attrs, themeAttr)?.trim();
      if (explicit && explicit.length <= 64) {
        explicitFonts.add(explicit);
        coveredSlots?.add(slot);
      } else if (theme) {
        themeRefs.add(theme);
        coveredSlots?.add(slot);
      }
    }
  }
}

function eastAsiaScriptTag(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const lower = lang.toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-mo') || lower.includes('hant')) return 'Hant';
  if (lower.startsWith('zh')) return 'Hans';
  if (lower.startsWith('ja')) return 'Jpan';
  if (lower.startsWith('ko')) return 'Hang';
  return undefined;
}

function resolveThemeFonts(
  themeXml: string | undefined,
  settingsXml: string | undefined,
  themeRefs: ReadonlySet<string>,
  out: Set<string>,
): void {
  if (!themeXml || themeRefs.size === 0) return;
  const langMatch = settingsXml?.match(THEME_FONT_LANG_PATTERN);
  const eaLang = langMatch ? localAttr(xmlAttributes(`<x${langMatch[1]}>`), 'eastAsia') : undefined;
  const preferredScript = eastAsiaScriptTag(eaLang);

  const readSection = (sectionName: 'majorFont' | 'minorFont') => {
    const match = themeXml.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${sectionName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[^\\s<>/=:]+:)?${sectionName}>`));
    const body = match?.[1] ?? '';
    const pickTypeface = (tag: string): string | undefined => {
      const m = body.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${tag}\\b((?:[^"'>]|"[^"]*"|'[^']*')*)\\/?>`));
      const value = m ? localAttr(xmlAttributes(`<x${m[1]}>`), 'typeface')?.trim() : undefined;
      return value && value.length <= 64 ? value : undefined;
    };
    const scripts = new Map<string, string>();
    for (const m of body.matchAll(/<(?:[^\s<>/=:]+:)?font\b((?:[^"'>]|"[^"]*"|'[^']*')*)\/?>/g)) {
      const attrs = xmlAttributes(`<x${m[1]}>`);
      const script = localAttr(attrs, 'script')?.trim();
      const typeface = localAttr(attrs, 'typeface')?.trim();
      if (script && typeface && typeface.length <= 64) scripts.set(script, typeface);
    }
    return { latin: pickTypeface('latin'), ea: pickTypeface('ea'), cs: pickTypeface('cs'), scripts };
  };

  const major = readSection('majorFont');
  const minor = readSection('minorFont');
  for (const ref of themeRefs) {
    const section = ref.startsWith('major') ? major : ref.startsWith('minor') ? minor : undefined;
    if (!section) continue;
    if (ref.endsWith('HAnsi') || ref.endsWith('Ascii')) {
      if (section.latin) out.add(section.latin);
    } else if (ref.endsWith('EastAsia')) {
      if (section.ea) {
        out.add(section.ea);
      } else if (preferredScript && section.scripts.has(preferredScript)) {
        out.add(section.scripts.get(preferredScript)!);
      } else {
        // Without a declared East Asian language, include the CJK theme scripts conservatively.
        for (const script of ['Hans', 'Hant', 'Jpan', 'Hang']) {
          const face = section.scripts.get(script);
          if (face) out.add(face);
        }
      }
    } else if (ref.endsWith('Bidi')) {
      if (section.cs) out.add(section.cs);
    }
  }
}

/**
 * Collect font families actually referenced by story parts and active styles (transitively
 * following `basedOn` / `link` chains and `docDefaults` fallback slots). Unused latent styles
 * in `styles.xml` are excluded so heavy system fonts are not loaded for unused template styles.
 */
export function collectActiveWordFonts(xml: ReadonlyMap<string, string>): string[] | undefined {
  const explicitFonts = new Set<string>();
  const themeRefs = new Set<string>();
  const activeStyleIds = new Set<string>();

  for (const [name, text] of xml) {
    if (!STORY_PART_PATTERN.test(name)) continue;
    collectRunFontsFromXml(text, explicitFonts, themeRefs);
    for (const match of text.matchAll(SYM_TAG_PATTERN)) {
      const font = localAttr(xmlAttributes(`<x${match[1]}>`), 'font')?.trim();
      if (font && font.length <= 64) explicitFonts.add(font);
    }
    for (const match of text.matchAll(STYLE_REF_PATTERN)) {
      const styleId = localAttr(xmlAttributes(`<x${match[1]}>`), 'val')?.trim();
      if (styleId) activeStyleIds.add(styleId);
    }
  }

  const stylesXml = xml.get('word/styles.xml');
  if (stylesXml) {
    interface ParsedStyle {
      type?: string;
      isDefault: boolean;
      basedOn?: string;
      link?: string;
      body: string;
    }
    const stylesById = new Map<string, ParsedStyle>();
    const childVal = (body: string, tag: string): string | undefined => {
      const m = body.match(new RegExp(`<(?:[^\\s<>/=:]+:)?${tag}\\b((?:[^"'>]|"[^"]*"|'[^']*')*)\\/?>`));
      return m ? localAttr(xmlAttributes(`<x${m[1]}>`), 'val')?.trim() : undefined;
    };
    for (const match of stylesXml.matchAll(STYLE_BLOCK_PATTERN)) {
      const attrs = xmlAttributes(`<x${match[1]}>`);
      const id = localAttr(attrs, 'styleId')?.trim();
      if (!id) continue;
      const isDefault = localAttr(attrs, 'default') === '1' || localAttr(attrs, 'default') === 'true';
      const body = match[2] ?? '';
      const entry: ParsedStyle = {
        type: localAttr(attrs, 'type')?.trim(),
        isDefault,
        basedOn: childVal(body, 'basedOn'),
        link: childVal(body, 'link'),
        body,
      };
      stylesById.set(id, entry);
      if (isDefault) activeStyleIds.add(id);
    }

    // Transitively expand basedOn and link chains for every active style.
    const queue = [...activeStyleIds];
    for (let index = 0; index < queue.length; index++) {
      const style = stylesById.get(queue[index]);
      if (!style) continue;
      for (const related of [style.basedOn, style.link]) {
        if (related && !activeStyleIds.has(related)) {
          activeStyleIds.add(related);
          queue.push(related);
        }
      }
    }

    const defaultParaCoveredSlots = new Set<FontSlot>();
    for (const id of activeStyleIds) {
      const style = stylesById.get(id);
      if (!style) continue;
      collectRunFontsFromXml(
        style.body,
        explicitFonts,
        themeRefs,
        style.isDefault && style.type === 'paragraph' ? defaultParaCoveredSlots : undefined,
      );
    }

    // Only pull docDefaults slots that the default paragraph style (e.g. Normal) does not override.
    const docDefaultsMatch = stylesXml.match(DOC_DEFAULTS_PATTERN);
    if (docDefaultsMatch) {
      for (const match of docDefaultsMatch[1].matchAll(RFONTS_TAG_PATTERN)) {
        const attrs = xmlAttributes(`<x${match[1]}>`);
        for (const [slot, themeAttr] of SLOT_THEME_ATTR) {
          if (defaultParaCoveredSlots.has(slot)) continue;
          const explicit = localAttr(attrs, slot)?.trim();
          const theme = localAttr(attrs, themeAttr)?.trim();
          if (explicit && explicit.length <= 64) explicitFonts.add(explicit);
          else if (theme) themeRefs.add(theme);
        }
      }
    }
  }

  resolveThemeFonts(xml.get('word/theme/theme1.xml'), xml.get('word/settings.xml'), themeRefs, explicitFonts);
  return explicitFonts.size > 0 ? [...explicitFonts].slice(0, MAX_FONT_DECLARATIONS) : undefined;
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
  return {
    readOnly: [...readOnly].sort(),
    fonts: parseFontTable(xml.get('word/fontTable.xml')),
    activeFonts: collectActiveWordFonts(xml),
  };
}
