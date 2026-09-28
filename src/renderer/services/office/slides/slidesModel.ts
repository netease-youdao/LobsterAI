import { layoutOf, masterOf, presentationPart, slideSize, themeOf } from './slidesDeck';
import { isLineGeometry } from './slidesGeometry';
import type { SlidesPackage } from './slidesPackage';
import {
  colorChild, type ColorContext, type ColorMap, cssColor, readColorMap, readTheme, resolveColor, resolveTypeface, type Rgba, type ThemeView,
} from './slidesTheme';
import { el, elements, elementsNamed, flag, named, NS, num, pxFromEmu, relationshipId } from './slidesXml';

/**
 * What a slide shows, resolved from the slide, its layout, its master and the theme: positions
 * placeholders inherit, text styles by level, colors through the color map, backgrounds and the
 * shapes of the layout and master. Lengths are CSS pixels at 96 dpi.
 */

export type Fill =
  | { kind: 'none' }
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; css: string }
  | { kind: 'image'; part: string };

export interface Line {
  color: string;
  width: number;
  dash?: string;
  headEnd?: string;
  tailEnd?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

export interface RunStyle {
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  fontFamily: string;
  /** Superscript above 0, subscript below, in percent. */
  baseline: number;
  caps: boolean;
  highlight?: string;
}

export interface RunView {
  text: string;
  style: RunStyle;
  lineBreak?: boolean;
  /** Position among the paragraph's a:r elements, for in-place editing; fields have none. */
  run?: number;
}

export interface ParagraphView {
  runs: RunView[];
  align: 'left' | 'center' | 'right' | 'justify';
  level: number;
  marginLeft: number;
  indent: number;
  /** Line height as a multiple of the font size, or in pixels. */
  lineHeight: { factor: number } | { px: number };
  spaceBefore: number;
  spaceAfter: number;
  bullet?: { text: string; color?: string; fontFamily?: string; sizeFactor: number };
  endStyle: RunStyle;
}

export interface TextView {
  paragraphs: ParagraphView[];
  insets: { l: number; t: number; r: number; b: number };
  anchor: 'top' | 'middle' | 'bottom';
  wrap: boolean;
  vertical: boolean;
  fontScale: number;
  lineReduction: number;
}

export interface GeometryView {
  preset: string;
  adjust: Record<string, number>;
  /** a:custGeom paths, drawn scaled to the box. */
  paths?: Element[];
}

export interface TableCellView {
  text: TextView;
  fill: Fill;
  borders: { l?: Line; t?: Line; r?: Line; b?: Line };
  colSpan: number;
  rowSpan: number;
  merged: boolean;
}

export interface TableView {
  columns: number[];
  rows: { height: number; cells: TableCellView[] }[];
}

export const ShapeViewKind = {
  Shape: 'shape',
  Picture: 'picture',
  Table: 'table',
  Group: 'group',
  Graphic: 'graphic',
} as const;
export type ShapeViewKind = typeof ShapeViewKind[keyof typeof ShapeViewKind];

export interface ShapeView {
  id: string;
  name: string;
  kind: ShapeViewKind;
  box: Box;
  geometry: GeometryView;
  fill: Fill;
  line?: Line;
  text?: TextView;
  image?: { part: string; crop?: { l: number; t: number; r: number; b: number } };
  table?: TableView;
  children?: ShapeView[];
  placeholder?: { type: string; idx?: string };
  /** A shape of the slide itself (not of its layout or master): it can be selected and edited. */
  own: boolean;
  /** For an empty placeholder of the slide: the prompt to show, the layout's own text when it sets one. */
  prompt?: { custom?: string };
  /** For charts, diagrams and objects without a picture: what they are. */
  label?: string;
}

export interface SlideView {
  width: number;
  height: number;
  background: Fill;
  shapes: ShapeView[];
}

const PX_PER_PT = 96 / 72;
const DEFAULT_INSETS = { l: 91440, t: 45720, r: 91440, b: 45720 };
const FALLBACK_FONTS = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';
const ALIGN: Record<string, ParagraphView['align']> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify', thaiDist: 'justify', justLow: 'justify' };

interface Context {
  pkg: SlidesPackage;
  /** The part whose relationships resolve pictures (the slide, layout or master holding the shape). */
  part: string;
  theme: ThemeView;
  colors: ColorContext;
  master: Document;
  layout?: Document;
  presentation: Document;
}

/** Placeholder type as matching uses it: an untyped placeholder is a body/content one. */
const phType = (ph: Element | undefined): string => ph?.getAttribute('type') || 'obj';
const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const BODY_TYPES = new Set(['obj', 'body', 'subTitle']);

function spTree(doc: Document | undefined): Element | undefined {
  return doc ? el(doc.documentElement, 'p:cSld', 'p:spTree') : undefined;
}

const placeholderOf = (shape: Element): Element | undefined => {
  const nv = elements(shape).find(child => child.localName.startsWith('nv'));
  return el(named(nv, 'nvPr'), 'p:ph');
};

/** The layout or master shape a slide placeholder inherits from. */
function matchPlaceholder(tree: Element | undefined, ph: Element, byTypeOnly: boolean): Element | undefined {
  if (!tree) return undefined;
  const candidates = elementsNamed(tree, 'sp').filter(shape => placeholderOf(shape));
  const idx = ph.getAttribute('idx');
  const type = phType(ph);
  if (!byTypeOnly && idx) {
    const byIdx = candidates.find(shape => placeholderOf(shape)!.getAttribute('idx') === idx);
    if (byIdx) return byIdx;
  }
  const sameType = candidates.find(shape => phType(placeholderOf(shape)) === type);
  if (sameType) return sameType;
  if (TITLE_TYPES.has(type)) return candidates.find(shape => TITLE_TYPES.has(phType(placeholderOf(shape))));
  if (BODY_TYPES.has(type) || !TITLE_TYPES.has(type)) {
    return candidates.find(shape => ['body', 'obj'].includes(phType(placeholderOf(shape))))
      ?? (byTypeOnly ? undefined : candidates.find(shape => BODY_TYPES.has(phType(placeholderOf(shape)))));
  }
  return undefined;
}

/** The chain a slide shape inherits along: master placeholder, layout placeholder, then the shape. */
function inheritance(shape: Element, context: Context): Element[] {
  const ph = placeholderOf(shape);
  if (!ph) return [shape];
  const chain: Element[] = [];
  const masterTree = spTree(context.master);
  if (context.layout) {
    const layoutShape = matchPlaceholder(spTree(context.layout), ph, false);
    const masterShape = matchPlaceholder(masterTree, layoutShape ? placeholderOf(layoutShape)! : ph, true);
    if (masterShape) chain.push(masterShape);
    if (layoutShape) chain.push(layoutShape);
  } else {
    const masterShape = matchPlaceholder(masterTree, ph, true);
    if (masterShape && masterShape !== shape) chain.push(masterShape);
  }
  chain.push(shape);
  return chain;
}

function readXfrm(xfrm: Element | undefined): Box | undefined {
  const off = el(xfrm, 'a:off');
  const ext = el(xfrm, 'a:ext');
  if (!off || !ext) return undefined;
  return {
    x: pxFromEmu(num(off, 'x') ?? 0), y: pxFromEmu(num(off, 'y') ?? 0),
    w: pxFromEmu(num(ext, 'cx') ?? 0), h: pxFromEmu(num(ext, 'cy') ?? 0),
    rot: (num(xfrm, 'rot') ?? 0) / 60000, flipH: flag(xfrm, 'flipH') === true, flipV: flag(xfrm, 'flipV') === true,
  };
}

const shapeProperties = (shape: Element): Element | undefined => named(shape, 'spPr') ?? named(shape, 'grpSpPr');
const xfrmOf = (shape: Element): Element | undefined => (shape.localName === 'graphicFrame' ? named(shape, 'xfrm') : el(shapeProperties(shape), 'a:xfrm'));

/** A shape's box in CSS pixels, inherited from its placeholder when it has none. */
function shapeBox(shape: Element, chain: Element[]): Box | undefined {
  for (const item of [...chain].reverse()) {
    const box = readXfrm(xfrmOf(item));
    if (box) return item === shape ? box : { ...box, rot: 0, flipH: false, flipV: false };
  }
  return undefined;
}

function gradientCss(gradient: Element, colors: ColorContext): string | undefined {
  const stops = elements(el(gradient, 'a:gsLst'), 'a:gs')
    .map(stop => ({ position: (num(stop, 'pos') ?? 0) / 1000, color: cssColor(resolveColor(colorChild(stop), colors)) }))
    .filter(stop => stop.color)
    .sort((a, b) => a.position - b.position);
  if (stops.length < 2) return stops[0]?.color;
  const list = stops.map(stop => `${stop.color} ${stop.position}%`).join(', ');
  if (el(gradient, 'a:path')) return `radial-gradient(circle, ${list})`;
  const angle = (num(el(gradient, 'a:lin'), 'ang') ?? 0) / 60000;
  return `linear-gradient(${angle + 90}deg, ${list})`;
}

/** A fill element (solidFill, gradFill, blipFill, noFill, pattFill) as a Fill; undefined when not a fill. */
function readFill(fill: Element | undefined, context: Context, colors = context.colors): Fill | undefined {
  if (!fill) return undefined;
  switch (fill.localName) {
    case 'noFill': return { kind: 'none' };
    case 'solidFill': {
      const color = cssColor(resolveColor(colorChild(fill), colors));
      return color ? { kind: 'solid', color } : { kind: 'none' };
    }
    case 'gradFill': {
      const css = gradientCss(fill, colors);
      return css ? { kind: 'gradient', css } : { kind: 'none' };
    }
    case 'pattFill': {
      const color = cssColor(resolveColor(colorChild(el(fill, 'a:fgClr')), colors));
      return color ? { kind: 'solid', color } : { kind: 'none' };
    }
    case 'blipFill': {
      const part = context.pkg.target(context.part, relationshipId(el(fill, 'a:blip'), 'embed'));
      return part ? { kind: 'image', part } : { kind: 'none' };
    }
    default: return undefined;
  }
}

const FILL_NAMES = new Set(['noFill', 'solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill']);
const fillIn = (parent: Element | undefined): Element | undefined => elements(parent).find(child => FILL_NAMES.has(child.localName) && child.namespaceURI === NS.a);

/** A style matrix reference (fillRef, lnRef, bgRef) resolved against the theme's style lists. */
function styleReference(reference: Element | undefined, list: Element[], context: Context): { element: Element; colors: ColorContext } | undefined {
  const index = num(reference, 'idx') ?? 0;
  if (!reference || index < 1) return undefined;
  const element = list[(index >= 1000 ? index - 1000 : index) - 1];
  if (!element) return undefined;
  const placeholder: Rgba | undefined = resolveColor(colorChild(reference), context.colors);
  return { element, colors: { ...context.colors, placeholder } };
}

function readLine(line: Element | undefined, context: Context, colors = context.colors): Line | undefined {
  if (!line || el(line, 'a:noFill')) return undefined;
  const fill = el(line, 'a:solidFill') ?? el(line, 'a:gradFill');
  const color = fill?.localName === 'gradFill'
    ? cssColor(resolveColor(colorChild(el(fill, 'a:gsLst', 'a:gs')), colors))
    : cssColor(resolveColor(colorChild(fill), colors));
  if (!color) return undefined;
  const width = Math.max(0.75, pxFromEmu(num(line, 'w') ?? 12700));
  const dash = el(line, 'a:prstDash')?.getAttribute('val');
  return {
    color, width,
    ...(dash && dash !== 'solid' ? { dash } : {}),
    ...(el(line, 'a:headEnd')?.getAttribute('type') && el(line, 'a:headEnd')?.getAttribute('type') !== 'none' ? { headEnd: el(line, 'a:headEnd')!.getAttribute('type')! } : {}),
    ...(el(line, 'a:tailEnd')?.getAttribute('type') && el(line, 'a:tailEnd')?.getAttribute('type') !== 'none' ? { tailEnd: el(line, 'a:tailEnd')!.getAttribute('type')! } : {}),
  };
}

function shapeFill(chain: Element[], context: Context, groupFill?: Fill): Fill {
  for (const item of [...chain].reverse()) {
    const fill = fillIn(shapeProperties(item));
    if (fill?.localName === 'grpFill') return groupFill ?? { kind: 'none' };
    const read = readFill(fill, context);
    if (read) return read;
  }
  const reference = styleReference(el(named(chain[chain.length - 1], 'style'), 'a:fillRef'), context.theme.fillStyles, context);
  return (reference && readFill(reference.element, context, reference.colors)) ?? { kind: 'none' };
}

function shapeLine(chain: Element[], context: Context): Line | undefined {
  let width: number | undefined;
  for (const item of [...chain].reverse()) {
    const line = el(shapeProperties(item), 'a:ln');
    if (!line) continue;
    if (el(line, 'a:noFill')) return undefined;
    if (fillIn(line)) return readLine(line, context);
    // A width or dash without a color still takes its color from the style reference.
    width ??= num(line, 'w');
  }
  const reference = styleReference(el(named(chain[chain.length - 1], 'style'), 'a:lnRef'), context.theme.lineStyles, context);
  const line = reference ? readLine(reference.element, context, reference.colors) : undefined;
  return line && width !== undefined ? { ...line, width: Math.max(0.75, pxFromEmu(width)) } : line;
}

function geometry(chain: Element[]): GeometryView {
  for (const item of [...chain].reverse()) {
    const properties = shapeProperties(item);
    const preset = el(properties, 'a:prstGeom');
    if (preset) {
      const adjust: Record<string, number> = {};
      for (const guide of elements(el(preset, 'a:avLst'), 'a:gd')) {
        const value = /^val\s+(-?\d+)/.exec(guide.getAttribute('fmla') ?? '');
        if (value) adjust[guide.getAttribute('name') ?? ''] = Number(value[1]);
      }
      return { preset: preset.getAttribute('prst') ?? 'rect', adjust };
    }
    const custom = el(properties, 'a:custGeom');
    if (custom) return { preset: 'custom', adjust: {}, paths: elements(el(custom, 'a:pathLst'), 'a:path') };
  }
  return { preset: 'rect', adjust: {} };
}

/** a:lvlNpPr of a list style, or its a:defPPr for level -1. */
const levelStyle = (list: Element | undefined, level: number): Element | undefined => el(list, `a:lvl${level + 1}pPr`);

function masterTextStyle(context: Context, category: 'title' | 'body' | 'other'): Element | undefined {
  const styles = el(context.master.documentElement, 'p:txStyles');
  return el(styles, category === 'title' ? 'p:titleStyle' : category === 'body' ? 'p:bodyStyle' : 'p:otherStyle');
}

const categoryOf = (ph: Element | undefined): 'title' | 'body' | 'other' => {
  if (!ph) return 'other';
  const type = phType(ph);
  if (TITLE_TYPES.has(type)) return 'title';
  if (['dt', 'ftr', 'sldNum', 'hdr'].includes(type)) return 'other';
  return 'body';
};

/**
 * The list styles text at each level inherits, lowest priority first. The first `base` come from
 * the presentation and master; a shape style's or table style's text color sits above them.
 */
function listStyles(chain: Element[], context: Context, table = false): { lists: (Element | undefined)[]; base: number } {
  const shape = chain[chain.length - 1];
  const ph = placeholderOf(shape);
  const lists: (Element | undefined)[] = [];
  if (ph && !table) lists.push(masterTextStyle(context, categoryOf(ph)));
  else lists.push(el(context.presentation.documentElement, 'p:defaultTextStyle'), table ? undefined : masterTextStyle(context, 'other'));
  const base = lists.length;
  for (const item of chain) lists.push(el(named(item, 'txBody'), 'a:lstStyle'));
  return { lists, base };
}

interface ResolvedParagraph {
  pPr: Element[];
  defRPr: Element[];
  /** How many of `defRPr` come from the presentation and master. */
  baseDefRPr: number;
}

function paragraphStyles(styles: { lists: (Element | undefined)[]; base: number }, level: number, pPr: Element | undefined): ResolvedParagraph {
  const levels = styles.lists.map(list => levelStyle(list, level));
  const defaults = (items: (Element | undefined)[]) => items.map(style => el(style, 'a:defRPr')).filter((style): style is Element => Boolean(style));
  const all = [...levels, pPr].filter((style): style is Element => Boolean(style));
  return { pPr: all, defRPr: defaults(all), baseDefRPr: defaults(levels.slice(0, styles.base)).length };
}

/** The last value of an attribute along a list of elements. */
function last(elements_: Element[], name: string): string | undefined {
  for (let index = elements_.length - 1; index >= 0; index--) {
    const value = elements_[index].getAttribute(name);
    if (value !== null && value !== '') return value;
  }
  return undefined;
}

function lastChild(elements_: Element[], qualified: string): Element | undefined {
  for (let index = elements_.length - 1; index >= 0; index--) {
    const child = el(elements_[index], qualified);
    if (child) return child;
  }
  return undefined;
}

function fontFamily(properties: Element[], context: Context): string {
  const latin = resolveTypeface(lastChild(properties, 'a:latin')?.getAttribute('typeface'), context.theme) ?? context.theme.fonts.minorLatin;
  const eastAsian = resolveTypeface(lastChild(properties, 'a:ea')?.getAttribute('typeface'), context.theme) ?? context.theme.fonts.minorEastAsian;
  return [latin, eastAsian].filter(Boolean).map(name => `"${name.replace(/"/g, '')}"`).join(', ') + `, ${FALLBACK_FONTS}`;
}

/** What a table style gives its cells' text when the text does not say. */
interface TextDefaults {
  color?: string;
  bold?: boolean;
}

/** A run's style from its property chain (lowest priority first); the first `base` are the presentation's and master's. */
function runStyle(properties: Element[], context: Context, defaults: TextDefaults = {}, base = 0): RunStyle {
  let color: string | undefined;
  for (let index = properties.length - 1; index >= 0 && !color; index--) {
    // A shape or table style's text color comes before the presentation's defaults.
    if (index < base && defaults.color) break;
    const fill = fillIn(properties[index]);
    if (!fill) continue;
    const read = readFill(fill, context);
    color = read?.kind === 'solid' ? read.color : read?.kind === 'gradient' ? /#[0-9A-F]{6}|rgba\([^)]*\)/i.exec(read.css)?.[0] : undefined;
    if (!color) break;
  }
  color ??= defaults.color ?? '#000000';
  const underline = last(properties, 'u');
  const strike = last(properties, 'strike');
  const highlight = lastChild(properties, 'a:highlight');
  return {
    sizePt: (Number(last(properties, 'sz')) || 1800) / 100,
    bold: ['1', 'true'].includes(last(properties, 'b') ?? (defaults.bold ? '1' : '')),
    italic: ['1', 'true'].includes(last(properties, 'i') ?? ''),
    underline: Boolean(underline && underline !== 'none'),
    strike: Boolean(strike && strike !== 'noStrike'),
    color,
    fontFamily: fontFamily(properties, context),
    baseline: (Number(last(properties, 'baseline')) || 0) / 1000,
    caps: last(properties, 'cap') === 'all',
    ...(highlight ? { highlight: cssColor(resolveColor(colorChild(highlight), context.colors)) } : {}),
  };
}

const AUTO_NUMBER = (scheme: string, index: number): string => {
  const alpha = (value: number) => { let text = ''; for (let n = value; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(97 + ((n - 1) % 26)) + text; return text; };
  const roman = (value: number) => [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
    .reduce((acc, [amount, letters]) => { let text = acc.text; let rest = acc.rest; while (rest >= (amount as number)) { text += letters; rest -= amount as number; } return { text, rest }; }, { text: '', rest: value }).text;
  const base = scheme.startsWith('alphaLc') ? alpha(index) : scheme.startsWith('alphaUc') ? alpha(index).toUpperCase()
    : scheme.startsWith('romanLc') ? roman(index) : scheme.startsWith('romanUc') ? roman(index).toUpperCase()
      : scheme.startsWith('circleNum') ? String.fromCharCode(0x245f + Math.min(index, 20)) : String(index);
  if (scheme.endsWith('ParenBoth')) return `(${base})`;
  if (scheme.endsWith('ParenR')) return `${base})`;
  if (scheme.endsWith('Period')) return `${base}.`;
  return base;
};

function readText(body: Element, chain: Element[], context: Context, table = false, defaults: TextDefaults = {}): TextView {
  const lists = listStyles(chain, context, table);
  // The inherited bodies' properties, then this body's own.
  const bodyProps = [...chain.slice(0, -1).map(item => named(named(item, 'txBody'), 'bodyPr')), named(body, 'bodyPr')]
    .filter((props): props is Element => Boolean(props));
  const insets = { ...DEFAULT_INSETS };
  for (const props of bodyProps) {
    insets.l = num(props, 'lIns') ?? insets.l;
    insets.t = num(props, 'tIns') ?? insets.t;
    insets.r = num(props, 'rIns') ?? insets.r;
    insets.b = num(props, 'bIns') ?? insets.b;
  }
  const own = bodyProps[bodyProps.length - 1];
  const autofit = el(own, 'a:normAutofit');
  const anchor = last(bodyProps, 'anchor');
  const counters = new Map<number, number>();
  const paragraphs = elements(body, 'a:p').map((paragraph): ParagraphView => {
    const pPr = el(paragraph, 'a:pPr');
    const level = num(pPr, 'lvl') ?? 0;
    const styles = paragraphStyles(lists, level, pPr);
    const endProps = el(paragraph, 'a:endParaRPr');
    let runIndex = 0;
    const runs: RunView[] = [];
    for (const child of elements(paragraph)) {
      if (child.localName === 'br') {
        runs.push({ text: '\n', lineBreak: true, style: runStyle([...styles.defRPr, ...(el(child, 'a:rPr') ? [el(child, 'a:rPr')!] : [])], context, defaults, styles.baseDefRPr) });
      } else if (child.localName === 'r' || child.localName === 'fld') {
        const rPr = el(child, 'a:rPr');
        runs.push({
          text: el(child, 'a:t')?.textContent ?? '', style: runStyle(rPr ? [...styles.defRPr, rPr] : styles.defRPr, context, defaults, styles.baseDefRPr),
          ...(child.localName === 'r' ? { run: runIndex++ } : {}),
        });
      }
    }
    const endStyle = runStyle(endProps ? [...styles.defRPr, endProps] : styles.defRPr, context, defaults, styles.baseDefRPr);
    const lineSpacing = lastChild(styles.pPr, 'a:lnSpc');
    const spacing = (name: string): number => {
      const value = lastChild(styles.pPr, name);
      const points = num(el(value, 'a:spcPts'), 'val');
      if (points !== undefined) return (points / 100) * PX_PER_PT;
      const percent = num(el(value, 'a:spcPct'), 'val');
      return percent !== undefined ? (percent / 100000) * endStyle.sizePt * PX_PER_PT * 1.2 : 0;
    };
    const firstStyle = runs.find(run => !run.lineBreak)?.style ?? endStyle;
    let bullet: ParagraphView['bullet'];
    const bulletKind = [...styles.pPr].reverse().map(style => elements(style).find(child => ['buNone', 'buChar', 'buAutoNum', 'buBlip'].includes(child.localName))).find(Boolean);
    const hasText = runs.some(run => run.text.trim());
    if (bulletKind && bulletKind.localName !== 'buNone' && hasText) {
      const colorElement = lastChild(styles.pPr, 'a:buClr');
      const sizePct = num(lastChild(styles.pPr, 'a:buSzPct'), 'val');
      let text = '•';
      if (bulletKind.localName === 'buChar') text = bulletKind.getAttribute('char') || '•';
      if (bulletKind.localName === 'buAutoNum') {
        const count = (counters.get(level) ?? (num(bulletKind, 'startAt') ?? 1) - 1) + 1;
        counters.set(level, count);
        text = AUTO_NUMBER(bulletKind.getAttribute('type') ?? 'arabicPeriod', count);
      }
      const bulletFont = resolveTypeface(lastChild(styles.pPr, 'a:buFont')?.getAttribute('typeface'), context.theme);
      bullet = {
        text,
        ...(colorElement ? { color: cssColor(resolveColor(colorChild(colorElement), context.colors)) } : {}),
        ...(bulletFont && bulletKind.localName === 'buChar' ? { fontFamily: `"${bulletFont}", ${firstStyle.fontFamily}` } : {}),
        sizeFactor: sizePct ? sizePct / 100000 : 1,
      };
    }
    if (bulletKind?.localName !== 'buAutoNum') counters.delete(level);
    const pointsLine = num(el(lineSpacing, 'a:spcPts'), 'val');
    return {
      runs, level, endStyle,
      align: ALIGN[last(styles.pPr, 'algn') ?? 'l'] ?? 'left',
      marginLeft: pxFromEmu(Number(last(styles.pPr, 'marL') ?? 0)),
      indent: pxFromEmu(Number(last(styles.pPr, 'indent') ?? 0)),
      lineHeight: pointsLine !== undefined ? { px: (pointsLine / 100) * PX_PER_PT } : { factor: 1.2 * ((num(el(lineSpacing, 'a:spcPct'), 'val') ?? 100000) / 100000) },
      spaceBefore: spacing('a:spcBef'),
      spaceAfter: spacing('a:spcAft'),
      ...(bullet ? { bullet } : {}),
    };
  });
  return {
    paragraphs,
    insets: { l: pxFromEmu(insets.l), t: pxFromEmu(insets.t), r: pxFromEmu(insets.r), b: pxFromEmu(insets.b) },
    anchor: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
    wrap: last(bodyProps, 'wrap') !== 'none',
    vertical: ['eaVert', 'vert', 'wordArtVertRtl', 'mongolianVert'].includes(last(bodyProps, 'vert') ?? ''),
    fontScale: (num(autofit, 'fontScale') ?? 100000) / 100000,
    lineReduction: (num(autofit, 'lnSpcReduction') ?? 0) / 100000,
  };
}

/** Table style approximation: header row and banded rows in the first accent color. */
function readTable(frame: Element, context: Context): TableView | undefined {
  const table = el(named(frame, 'graphic'), 'a:graphicData', 'a:tbl');
  if (!table) return undefined;
  const props = el(table, 'a:tblPr');
  const styleId = el(props, 'a:tableStyleId')?.textContent ?? '';
  const plain = styleId === '{2D5ABB26-0587-4C30-8999-92F81FD0307C}' || styleId === '{5940675A-B579-460E-94D1-54222C63F5DA}';
  const grid = styleId === '{5940675A-B579-460E-94D1-54222C63F5DA}';
  const accent = context.theme.colors.accent1 ?? '4472C4';
  const tint = (amount: number) => {
    const rgb = [0, 2, 4].map(index => parseInt(accent.slice(index, index + 2), 16));
    return `#${rgb.map(channel => Math.round(channel + (255 - channel) * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
  };
  const firstRow = flag(props, 'firstRow') === true;
  const bandRow = flag(props, 'bandRow') === true;
  const light = context.theme.colors[context.colors.map.bg1 ?? 'lt1'] ?? 'FFFFFF';
  const rows = elements(table, 'a:tr').map((row, rowIndex) => ({
    height: pxFromEmu(num(row, 'h') ?? 0),
    cells: elements(row, 'a:tc').map((cell): TableCellView => {
      const cellProps = el(cell, 'a:tcPr');
      const header = firstRow && rowIndex === 0;
      const styleFill: Fill = plain ? { kind: 'none' } : header ? { kind: 'solid', color: `#${accent}` } : { kind: 'solid', color: bandRow && (rowIndex - (firstRow ? 1 : 0)) % 2 === 0 ? tint(0.4) : tint(0.2) };
      const border = (name: string): Line | undefined => {
        const line = el(cellProps, name);
        if (line) return readLine(line, context);
        return plain ? (grid ? { color: '#000000', width: 1 } : undefined) : { color: `#${light}`, width: 1 };
      };
      const body = el(cell, 'a:txBody') ?? cell.ownerDocument!.createElementNS(NS.a, 'a:txBody');
      const text = readText(body, [cell], context, true, header && !plain ? { color: `#${light}`, bold: true } : {});
      text.insets = {
        l: pxFromEmu(num(cellProps, 'marL') ?? 91440), r: pxFromEmu(num(cellProps, 'marR') ?? 91440),
        t: pxFromEmu(num(cellProps, 'marT') ?? 45720), b: pxFromEmu(num(cellProps, 'marB') ?? 45720),
      };
      const anchor = cellProps?.getAttribute('anchor');
      text.anchor = anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top';
      return {
        text,
        fill: readFill(fillIn(cellProps), context) ?? styleFill,
        borders: { l: border('a:lnL'), t: border('a:lnT'), r: border('a:lnR'), b: border('a:lnB') },
        colSpan: num(cell, 'gridSpan') ?? 1,
        rowSpan: num(cell, 'rowSpan') ?? 1,
        merged: flag(cell, 'hMerge') === true || flag(cell, 'vMerge') === true,
      };
    }),
  }));
  return { columns: elements(el(table, 'a:tblGrid'), 'a:gridCol').map(column => pxFromEmu(num(column, 'w') ?? 0)), rows };
}

const nameOf = (shape: Element): { id: string; name: string } => {
  const nv = elements(shape).find(child => child.localName.startsWith('nv'));
  const cNvPr = named(nv, 'cNvPr');
  return { id: cNvPr?.getAttribute('id') ?? '', name: cNvPr?.getAttribute('name') ?? '' };
};

/** Map a child box of a group into the group's parent coordinates. */
function intoGroup(box: Box, group: Element): Box {
  const xfrm = el(shapeProperties(group), 'a:xfrm');
  const outer = readXfrm(xfrm);
  const childOff = el(xfrm, 'a:chOff');
  const childExt = el(xfrm, 'a:chExt');
  if (!outer) return box;
  const chX = pxFromEmu(num(childOff, 'x') ?? 0);
  const chY = pxFromEmu(num(childOff, 'y') ?? 0);
  const chW = pxFromEmu(num(childExt, 'cx') ?? 0) || outer.w;
  const chH = pxFromEmu(num(childExt, 'cy') ?? 0) || outer.h;
  const sx = chW ? outer.w / chW : 1;
  const sy = chH ? outer.h / chH : 1;
  let next: Box = { ...box, x: outer.x + (box.x - chX) * sx, y: outer.y + (box.y - chY) * sy, w: box.w * sx, h: box.h * sy };
  const cx = outer.x + outer.w / 2;
  const cy = outer.y + outer.h / 2;
  if (outer.flipH) next = { ...next, x: 2 * cx - next.x - next.w, flipH: !next.flipH, rot: -next.rot };
  if (outer.flipV) next = { ...next, y: 2 * cy - next.y - next.h, flipV: !next.flipV, rot: -next.rot };
  if (outer.rot) {
    const angle = (outer.rot * Math.PI) / 180;
    const mx = next.x + next.w / 2 - cx;
    const my = next.y + next.h / 2 - cy;
    const rx = mx * Math.cos(angle) - my * Math.sin(angle);
    const ry = mx * Math.sin(angle) + my * Math.cos(angle);
    next = { ...next, x: cx + rx - next.w / 2, y: cy + ry - next.h / 2, rot: next.rot + outer.rot };
  }
  return next;
}

/** The text body a plain shape gets when text is typed into it (see ensureTextBody): centered both ways. */
function emptyTextBody(doc: Document): Element {
  const body = doc.createElementNS(NS.p, 'p:txBody');
  const bodyPr = doc.createElementNS(NS.a, 'a:bodyPr');
  bodyPr.setAttribute('anchor', 'ctr');
  body.appendChild(bodyPr);
  const paragraph = doc.createElementNS(NS.a, 'a:p');
  const pPr = doc.createElementNS(NS.a, 'a:pPr');
  pPr.setAttribute('algn', 'ctr');
  paragraph.appendChild(pPr);
  body.appendChild(paragraph);
  return body;
}

/** A shape style's font reference gives the text color a shape's text takes when it sets none (white on PowerPoint's default shapes). */
function styleTextDefaults(shape: Element, context: Context): TextDefaults {
  const color = cssColor(resolveColor(colorChild(el(named(shape, 'style'), 'a:fontRef')), context.colors));
  return color ? { color } : {};
}

/**
 * A layout's custom prompt for an empty placeholder. Without one PowerPoint shows its own prompt
 * ("单击此处添加标题"), not the layout's sample text.
 */
function customPromptOf(chain: Element[]): string | undefined {
  for (const item of chain.slice(0, -1).reverse()) {
    if (flag(placeholderOf(item), 'hasCustomPrompt') !== true) continue;
    const text = elements(named(item, 'txBody'), 'a:p').map(paragraph => elements(paragraph, 'a:r').map(run => el(run, 'a:t')?.textContent ?? '').join('')).join('\n').trim();
    if (text) return text;
  }
  return undefined;
}

function readShapes(tree: Element | undefined, context: Context, own: boolean, skipPlaceholders: boolean, groups: Element[] = []): ShapeView[] {
  const out: ShapeView[] = [];
  for (const raw of elements(tree)) {
    const item = raw.localName === 'AlternateContent'
      ? elements(named(raw, 'Fallback') ?? named(raw, 'Choice'))[0]
      : raw;
    if (!item) continue;
    const view = readShape(item, context, own, skipPlaceholders, groups);
    if (view) out.push(view);
  }
  return out;
}

function mapBox(box: Box, groups: Element[]): Box {
  return groups.reduceRight((current, group) => intoGroup(current, group), box);
}

function readShape(shape: Element, context: Context, own: boolean, skipPlaceholders: boolean, groups: Element[]): ShapeView | undefined {
  const { id, name } = nameOf(shape);
  const ph = placeholderOf(shape);
  if (skipPlaceholders && ph) return undefined;
  const base = { id, name, own, geometry: { preset: 'rect', adjust: {} }, fill: { kind: 'none' } as Fill };
  switch (shape.localName) {
    case 'sp':
    case 'cxnSp': {
      const chain = inheritance(shape, context);
      const box = shapeBox(shape, chain);
      if (!box) return undefined;
      const outline = geometry(chain);
      // A plain shape of the slide can be typed into: it gets the text body PowerPoint would give it.
      const body = named(shape, 'txBody') ?? (shape.localName === 'sp' && own && !isLineGeometry(outline) ? emptyTextBody(shape.ownerDocument!) : undefined);
      const text = body ? readText(body, chain, context, false, styleTextDefaults(shape, context)) : undefined;
      const empty = !text || !text.paragraphs.some(paragraph => paragraph.runs.some(run => run.text));
      return {
        ...base, kind: ShapeViewKind.Shape, box: mapBox(box, groups), geometry: outline, fill: shapeFill(chain, context),
        ...(shapeLine(chain, context) ? { line: shapeLine(chain, context) } : {}),
        ...(text ? { text } : {}),
        ...(ph ? { placeholder: { type: phType(ph), ...(ph.getAttribute('idx') ? { idx: ph.getAttribute('idx')! } : {}) } } : {}),
        ...(ph && empty && own ? { prompt: { custom: customPromptOf(chain) } } : {}),
      };
    }
    case 'pic': {
      const chain = inheritance(shape, context);
      const box = shapeBox(shape, chain);
      const blip = el(named(shape, 'blipFill'), 'a:blip');
      const part = context.pkg.target(context.part, relationshipId(blip, 'embed'));
      if (!box) return undefined;
      const crop = el(named(shape, 'blipFill'), 'a:srcRect');
      return {
        ...base, kind: ShapeViewKind.Picture, box: mapBox(box, groups), geometry: geometry(chain),
        ...(shapeLine(chain, context) ? { line: shapeLine(chain, context) } : {}),
        ...(part ? { image: { part, ...(crop ? { crop: { l: (num(crop, 'l') ?? 0) / 100000, t: (num(crop, 't') ?? 0) / 100000, r: (num(crop, 'r') ?? 0) / 100000, b: (num(crop, 'b') ?? 0) / 100000 } } : {}) } } : { label: 'picture' }),
      };
    }
    case 'graphicFrame': {
      const box = readXfrm(named(shape, 'xfrm'));
      if (!box) return undefined;
      const data = el(named(shape, 'graphic'), 'a:graphicData');
      const uri = data?.getAttribute('uri') ?? '';
      const mapped = mapBox(box, groups);
      if (uri.endsWith('/table')) {
        const table = readTable(shape, context);
        if (table) return { ...base, kind: ShapeViewKind.Table, box: mapped, table };
      }
      // Embedded objects carry a picture of themselves; use it.
      const fallbackPicture = data ? Array.from(data.getElementsByTagNameNS(NS.p, 'pic'))[0] : undefined;
      const embed = fallbackPicture ? context.pkg.target(context.part, relationshipId(el(named(fallbackPicture, 'blipFill'), 'a:blip'), 'embed')) : undefined;
      if (embed) return { ...base, kind: ShapeViewKind.Picture, box: mapped, image: { part: embed } };
      const diagram = uri.includes('/diagram') ? readDiagram(shape, context, mapped) : undefined;
      if (diagram) return { ...base, kind: ShapeViewKind.Group, box: mapped, children: diagram };
      return { ...base, kind: ShapeViewKind.Graphic, box: mapped, label: uri.includes('/chart') ? 'chart' : uri.includes('/diagram') ? 'diagram' : 'object' };
    }
    case 'grpSp': {
      const box = readXfrm(el(shapeProperties(shape), 'a:xfrm'));
      if (!box) return undefined;
      const children = readShapes(shape, context, own, false, [...groups, shape]);
      return { ...base, kind: ShapeViewKind.Group, box: mapBox(box, groups), children };
    }
    default: return undefined;
  }
}

/** A SmartArt graphic through the drawing PowerPoint saves with it. */
function readDiagram(frame: Element, context: Context, box: Box): ShapeView[] | undefined {
  const relIds = elements(el(named(frame, 'graphic'), 'a:graphicData')).find(child => child.localName === 'relIds');
  const data = context.pkg.target(context.part, relIds?.getAttributeNS(NS.r, 'dm') ?? undefined);
  // The data part names the drawing through a relationship of the slide.
  const drawingId = data ? Array.from(context.pkg.xml(data).getElementsByTagNameNS(NS.dsp, 'dataModelExt'))[0]?.getAttribute('relId') : undefined;
  const drawing = context.pkg.relationships(context.part).find(relation => (drawingId ? relation.id === drawingId : false) && relation.type.endsWith('/diagramDrawing'));
  if (!drawing || !context.pkg.has(drawing.target)) return undefined;
  const tree = named(context.pkg.xml(drawing.target).documentElement, 'spTree');
  if (!tree) return undefined;
  const inner: Context = { ...context, part: drawing.target };
  return readShapes(tree, inner, false, false).map(child => ({ ...child, box: { ...child.box, x: child.box.x + box.x, y: child.box.y + box.y } }));
}

function background(docs: (Document | undefined)[], parts: string[], context: Context): Fill {
  for (let index = 0; index < docs.length; index++) {
    const bg = el(docs[index]?.documentElement, 'p:cSld', 'p:bg');
    if (!bg) continue;
    const scoped: Context = { ...context, part: parts[index] };
    const properties = el(bg, 'p:bgPr');
    if (properties) return readFill(fillIn(properties), scoped) ?? { kind: 'none' };
    const reference = styleReference(el(bg, 'p:bgRef'), context.theme.backgroundFillStyles, scoped);
    if (reference) return readFill(reference.element, scoped, reference.colors) ?? { kind: 'none' };
  }
  return { kind: 'solid', color: '#FFFFFF' };
}

const showsMasterShapes = (doc: Document | undefined): boolean => flag(doc?.documentElement, 'showMasterSp') !== false;

/** Everything needed to draw one slide. */
export function buildSlideView(pkg: SlidesPackage, slidePart: string): SlideView {
  const layoutPart = layoutOf(pkg, slidePart);
  const masterPart = layoutPart ? masterOf(pkg, layoutPart) : undefined;
  if (!layoutPart || !masterPart) throw new Error(`Slide ${slidePart} has no layout or master`);
  const themePart = themeOf(pkg, masterPart);
  const slide = pkg.xml(slidePart);
  const layout = pkg.xml(layoutPart);
  const master = pkg.xml(masterPart);
  const theme = readTheme(themePart ? pkg.xml(themePart) : undefined);
  let map: ColorMap = readColorMap(el(master.documentElement, 'p:clrMap'));
  map = readColorMap(el(layout.documentElement, 'p:clrMapOvr'), map);
  map = readColorMap(el(slide.documentElement, 'p:clrMapOvr'), map);
  const presentation = pkg.xml(presentationPart(pkg));
  const base = { pkg, theme, colors: { theme, map }, master, presentation };
  const slideContext: Context = { ...base, part: slidePart, layout };
  const layoutContext: Context = { ...base, part: layoutPart };
  const masterContext: Context = { ...base, part: masterPart };
  const shapes: ShapeView[] = [];
  if (showsMasterShapes(slide) && showsMasterShapes(layout)) shapes.push(...readShapes(spTree(master), masterContext, false, true));
  if (showsMasterShapes(slide)) shapes.push(...readShapes(spTree(layout), { ...layoutContext, layout: undefined }, false, true));
  shapes.push(...readShapes(spTree(slide), slideContext, true, false));
  const size = slideSize(pkg);
  return {
    width: pxFromEmu(size.cx),
    height: pxFromEmu(size.cy),
    background: background([slide, layout, master], [slidePart, layoutPart, masterPart], slideContext),
    shapes,
  };
}

/** The families a slide's text uses, for loading metric-compatible stand-ins before drawing. */
export function fontsOf(view: SlideView): string[] {
  const families = new Set<string>();
  const visit = (shapes: ShapeView[]) => {
    for (const shape of shapes) {
      for (const paragraph of shape.text?.paragraphs ?? []) for (const run of paragraph.runs) families.add(run.style.fontFamily.split(',')[0].replace(/"/g, '').trim());
      for (const row of shape.table?.rows ?? []) for (const cell of row.cells) for (const paragraph of cell.text.paragraphs) for (const run of paragraph.runs) families.add(run.style.fontFamily.split(',')[0].replace(/"/g, '').trim());
      if (shape.children) visit(shape.children);
    }
  };
  visit(view.shapes);
  return [...families].filter(Boolean);
}

/** The inherited box of a slide shape in EMU, for the agent tools. */
export function shapeBoxEmu(pkg: SlidesPackage, slidePart: string, shape: Element): { x: number; y: number; w: number; h: number } | undefined {
  const layoutPart = layoutOf(pkg, slidePart);
  const masterPart = layoutPart ? masterOf(pkg, layoutPart) : undefined;
  if (!layoutPart || !masterPart) return undefined;
  const theme = readTheme(undefined);
  const context: Context = { pkg, part: slidePart, theme, colors: { theme, map: {} }, master: pkg.xml(masterPart), layout: pkg.xml(layoutPart), presentation: pkg.xml(presentationPart(pkg)) };
  const chain = inheritance(shape, context);
  for (const item of [...chain].reverse()) {
    const xfrm = xfrmOf(item);
    const off = el(xfrm, 'a:off');
    const ext = el(xfrm, 'a:ext');
    if (off && ext) return { x: num(off, 'x') ?? 0, y: num(off, 'y') ?? 0, w: num(ext, 'cx') ?? 0, h: num(ext, 'cy') ?? 0 };
  }
  return undefined;
}
