import { create, el, elements, ensure, NS, num, remove, removeChildren } from './slidesXml';

/**
 * Text bodies (p:txBody, a:txBody) as the editor and the agent change them. Every write keeps
 * the paragraph and run properties it can: unchanged paragraphs stay as they were, new text takes
 * the formatting of the text it replaces.
 */

export interface ParagraphText {
  text: string;
  level: number;
}

export interface TextStyleChange {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** RRGGBB, without the hash; null takes the color the text inherits. */
  color?: string | null;
  /** Points. */
  size?: number;
  font?: string;
}

export const SlidesAlign = { Left: 'l', Center: 'ctr', Right: 'r', Justify: 'just' } as const;

/** a:rPr children in schema order; a fill goes after a:ln, fonts before the hyperlinks. */
const RPR_AFTER_FILL = ['a:effectLst', 'a:effectDag', 'a:highlight', 'a:uLnTx', 'a:uLn', 'a:uFillTx', 'a:uFill', 'a:latin', 'a:ea', 'a:cs', 'a:sym', 'a:hlinkClick', 'a:hlinkMouseOver', 'a:rtl', 'a:extLst'];
const RPR_FILLS = ['a:noFill', 'a:solidFill', 'a:gradFill', 'a:blipFill', 'a:pattFill', 'a:grpFill'];

export const paragraphsOf = (body: Element | undefined): Element[] => elements(body, 'a:p');

export function paragraphLevel(paragraph: Element): number {
  return num(el(paragraph, 'a:pPr'), 'lvl') ?? 0;
}

/** A paragraph's text; a line break reads as a newline. */
export function paragraphText(paragraph: Element): string {
  let text = '';
  for (const child of elements(paragraph)) {
    if (child.localName === 'r' || child.localName === 'fld') text += el(child, 'a:t')?.textContent ?? '';
    else if (child.localName === 'br') text += '\n';
  }
  return text;
}

export const bodyText = (body: Element | undefined): ParagraphText[] => paragraphsOf(body).map(paragraph => ({ text: paragraphText(paragraph), level: paragraphLevel(paragraph) }));

/** One line per paragraph; tabs before a line give its level. */
export function linesOf(text: string): ParagraphText[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const level = /^\t*/.exec(line)![0].length;
    return { text: line.slice(level), level: Math.min(level, 8) };
  });
}

export const formatLines = (lines: ParagraphText[]): string => lines.map(line => `${'\t'.repeat(line.level)}${line.text}`).join('\n');

/** The run properties new text in a paragraph gets: its first run's, else its end-of-paragraph ones. */
function runPropertiesOf(paragraph: Element | undefined): Element | undefined {
  const first = elements(paragraph, 'a:r')[0];
  const rPr = el(first, 'a:rPr');
  if (rPr) return rPr.cloneNode(true) as Element;
  const end = el(paragraph, 'a:endParaRPr');
  if (!end || !paragraph) return undefined;
  const converted = create(paragraph.ownerDocument!, 'a:rPr');
  for (const attribute of Array.from(end.attributes)) converted.setAttribute(attribute.name, attribute.value);
  for (const child of elements(end)) converted.appendChild(child.cloneNode(true));
  return converted;
}

function makeRun(document: Document, text: string, rPr?: Element): Element {
  const run = create(document, 'a:r');
  run.appendChild(rPr ? rPr.cloneNode(true) : create(document, 'a:rPr', { lang: 'zh-CN', altLang: 'en-US', dirty: '0' }));
  const t = create(document, 'a:t');
  t.textContent = text;
  run.appendChild(t);
  return run;
}

/** A new paragraph with `template`'s properties holding `line`. */
function makeParagraph(document: Document, line: ParagraphText, template: Element | undefined): Element {
  const paragraph = create(document, 'a:p');
  const pPr = el(template, 'a:pPr')?.cloneNode(true) as Element | undefined ?? (line.level ? create(document, 'a:pPr') : undefined);
  if (pPr) {
    if (line.level) pPr.setAttribute('lvl', String(line.level));
    else pPr.removeAttribute('lvl');
    paragraph.appendChild(pPr);
  }
  const rPr = runPropertiesOf(template);
  const pieces = line.text.split('\n');
  pieces.forEach((piece, index) => {
    if (index) paragraph.appendChild(create(document, 'a:br', {}));
    if (piece) paragraph.appendChild(makeRun(document, piece, rPr));
  });
  const end = el(template, 'a:endParaRPr');
  if (end) paragraph.appendChild(end.cloneNode(true));
  else if (rPr) {
    const converted = create(document, 'a:endParaRPr');
    for (const attribute of Array.from(rPr.attributes)) converted.setAttribute(attribute.name, attribute.value);
    paragraph.appendChild(converted);
  }
  return paragraph;
}

/**
 * Replace a body's paragraphs with `lines`. A paragraph whose text and level are unchanged at the
 * same position stays as it was; new ones take the properties of a paragraph with their level.
 */
export function setBodyText(body: Element, lines: ParagraphText[]): void {
  const document = body.ownerDocument!;
  const originals = paragraphsOf(body);
  const next = (lines.length ? lines : [{ text: '', level: 0 }]).map((line, index) => {
    const same = originals[index];
    if (same && paragraphText(same) === line.text && paragraphLevel(same) === line.level) return same;
    const template = originals.find(paragraph => paragraphLevel(paragraph) === line.level) ?? originals[Math.min(index, originals.length - 1)];
    return makeParagraph(document, line, template);
  });
  const kept = new Set(next);
  for (const paragraph of originals) if (!kept.has(paragraph)) body.removeChild(paragraph);
  for (const paragraph of next) body.appendChild(paragraph);
}

interface Segment {
  node: Element;
  start: number;
  end: number;
  /** Runs can be split; fields and breaks move as a whole. */
  splittable: boolean;
}

function segmentsOf(paragraph: Element): Segment[] {
  const segments: Segment[] = [];
  let offset = 0;
  for (const child of elements(paragraph)) {
    const length = child.localName === 'br' ? 1 : child.localName === 'r' || child.localName === 'fld' ? (el(child, 'a:t')?.textContent ?? '').length : -1;
    if (length < 0) continue;
    segments.push({ node: child, start: offset, end: offset + length, splittable: child.localName === 'r' });
    offset += length;
  }
  return segments;
}

export interface TextMatch {
  paragraph: number;
  start: number;
  end: number;
}

/** The `occurrence`-th (from 1) exact match of `find` in the body. */
export function findInBody(body: Element, find: string, occurrence = 1): TextMatch | undefined {
  if (!find) return undefined;
  let seen = 0;
  const paragraphs = paragraphsOf(body);
  for (let index = 0; index < paragraphs.length; index++) {
    const text = paragraphText(paragraphs[index]);
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) {
      if (++seen === occurrence) return { paragraph: index, start: at, end: at + find.length };
    }
  }
  return undefined;
}

export const countInBody = (body: Element, find: string): number => {
  let count = 0;
  for (const paragraph of paragraphsOf(body)) {
    const text = paragraphText(paragraph);
    for (let at = text.indexOf(find); find && at >= 0; at = text.indexOf(find, at + find.length)) count++;
  }
  return count;
};

/** Split runs so that [start, end) of the paragraph is covered by whole runs; returns them. */
function isolate(paragraph: Element, start: number, end: number): Element[] {
  const covered: Element[] = [];
  for (const segment of segmentsOf(paragraph)) {
    if (segment.end <= start || segment.start >= end || segment.node.localName === 'br') continue;
    if (!segment.splittable) {
      covered.push(segment.node);
      continue;
    }
    const text = el(segment.node, 'a:t')!.textContent ?? '';
    const from = Math.max(0, start - segment.start);
    const to = Math.min(text.length, end - segment.start);
    let run = segment.node;
    if (from > 0) {
      const before = run.cloneNode(true) as Element;
      el(before, 'a:t')!.textContent = text.slice(0, from);
      paragraph.insertBefore(before, run);
    }
    if (to < text.length) {
      const after = run.cloneNode(true) as Element;
      el(after, 'a:t')!.textContent = text.slice(to);
      paragraph.insertBefore(after, run.nextSibling);
    }
    el(run, 'a:t')!.textContent = text.slice(from, to);
    run = segment.node;
    covered.push(run);
  }
  return covered;
}

/** Replace [start, end) of a paragraph; the new text takes the formatting of the first run replaced. */
export function replaceRange(paragraph: Element, start: number, end: number, replacement: string): void {
  const runs = isolate(paragraph, start, end).filter(run => run.localName === 'r');
  if (!runs.length) {
    const rPr = runPropertiesOf(paragraph);
    const anchor = segmentsOf(paragraph).find(segment => segment.start >= start)?.node ?? el(paragraph, 'a:endParaRPr') ?? null;
    if (replacement) paragraph.insertBefore(makeRun(paragraph.ownerDocument!, replacement, rPr), anchor);
    return;
  }
  el(runs[0], 'a:t')!.textContent = replacement;
  for (const run of runs.slice(1)) remove(run);
  if (!replacement) remove(runs[0]);
}

/** Set run properties on [start, end) of a paragraph, or the whole paragraph. */
export function formatRange(paragraph: Element, change: TextStyleChange, start = 0, end = Number.POSITIVE_INFINITY): void {
  const runs = isolate(paragraph, start, end);
  for (const run of runs) applyStyle(ensure(run, 'a:rPr', ['a:t']), change);
  // An empty paragraph keeps the change for the text typed into it later.
  const endProperties = el(paragraph, 'a:endParaRPr');
  if (endProperties && (end === Number.POSITIVE_INFINITY || !runs.length)) applyStyle(endProperties, change);
}

/** Write a style change into a:rPr (or a:endParaRPr / a:defRPr, which share its shape). */
function applyStyle(rPr: Element, change: TextStyleChange): void {
  if (change.bold !== undefined) rPr.setAttribute('b', change.bold ? '1' : '0');
  if (change.italic !== undefined) rPr.setAttribute('i', change.italic ? '1' : '0');
  if (change.underline !== undefined) rPr.setAttribute('u', change.underline ? 'sng' : 'none');
  if (change.strike !== undefined) rPr.setAttribute('strike', change.strike ? 'sngStrike' : 'noStrike');
  if (change.size !== undefined) rPr.setAttribute('sz', String(Math.round(Math.min(4000, Math.max(1, change.size)) * 100)));
  if (change.color !== undefined) {
    for (const fill of RPR_FILLS) removeChildren(rPr, fill);
    if (change.color) {
      const fill = create(rPr.ownerDocument!, 'a:solidFill');
      fill.appendChild(create(rPr.ownerDocument!, 'a:srgbClr', { val: change.color.replace(/^#/, '').toUpperCase() }));
      const anchor = elements(rPr).find(child => RPR_AFTER_FILL.includes(`a:${child.localName}`) && child.namespaceURI === NS.a);
      rPr.insertBefore(fill, anchor ?? null);
    }
  }
  if (change.font !== undefined) {
    for (const name of ['a:latin', 'a:ea']) {
      const font = ensure(rPr, name, RPR_AFTER_FILL.slice(RPR_AFTER_FILL.indexOf(name) + 1));
      font.setAttribute('typeface', change.font);
    }
  }
  rPr.removeAttribute('dirty');
}

export function setAlignment(paragraph: Element, align: typeof SlidesAlign[keyof typeof SlidesAlign]): void {
  const pPr = el(paragraph, 'a:pPr') ?? paragraph.insertBefore(create(paragraph.ownerDocument!, 'a:pPr'), paragraph.firstChild);
  pPr.setAttribute('algn', align);
}

export function setLevel(paragraph: Element, level: number): void {
  const pPr = el(paragraph, 'a:pPr') ?? paragraph.insertBefore(create(paragraph.ownerDocument!, 'a:pPr'), paragraph.firstChild);
  if (level > 0) pPr.setAttribute('lvl', String(Math.min(8, Math.floor(level))));
  else pPr.removeAttribute('lvl');
}

/** A paragraph as edited in place: runs point back at the run whose formatting they keep. */
export interface EditedRun {
  text: string;
  /** Index of the source run within the source paragraph's runs, when there is one. */
  run?: number;
  lineBreak?: boolean;
}

export interface EditedParagraph {
  /** Index of the paragraph this one came from, when there is one. */
  source?: number;
  runs: EditedRun[];
}

/**
 * Write paragraphs edited in place back into a body. Paragraphs whose runs are unchanged stay as
 * they were (fields, links and all); a changed one keeps its paragraph properties and each run's
 * properties.
 */
export function applyEditedParagraphs(body: Element, edited: EditedParagraph[]): void {
  const document = body.ownerDocument!;
  const originals = paragraphsOf(body);
  const used = new Set<number>();
  const next = edited.map((paragraph, index) => {
    const source = paragraph.source !== undefined && paragraph.source < originals.length ? originals[paragraph.source] : undefined;
    const first = source && !used.has(paragraph.source!);
    if (source) used.add(paragraph.source!);
    const template = source ?? originals[Math.min(index, originals.length - 1)];
    const sourceRuns = elements(source, 'a:r');
    const text = paragraph.runs.map(run => (run.lineBreak ? '\n' : run.text)).join('');
    // Formatting is written straight into the part, so unchanged text means an unchanged paragraph.
    if (first && text === paragraphText(source!)) return source!;
    const out = create(document, 'a:p');
    const pPr = el(template, 'a:pPr');
    if (pPr) out.appendChild(pPr.cloneNode(true));
    const fallback = runPropertiesOf(template);
    let last = fallback;
    for (const run of paragraph.runs) {
      if (run.lineBreak) {
        out.appendChild(create(document, 'a:br', {}));
        continue;
      }
      if (!run.text) continue;
      const rPr = run.run !== undefined ? el(sourceRuns[run.run] ?? elements(template, 'a:r')[run.run], 'a:rPr') ?? last : last;
      out.appendChild(makeRun(document, run.text, rPr));
      last = rPr;
    }
    const end = el(template, 'a:endParaRPr');
    if (end) out.appendChild(end.cloneNode(true));
    return out;
  });
  const kept = new Set(next);
  for (const paragraph of originals) if (!kept.has(paragraph)) body.removeChild(paragraph);
  for (const paragraph of next.length ? next : [create(document, 'a:p')]) body.appendChild(paragraph);
}
