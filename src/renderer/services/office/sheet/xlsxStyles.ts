import type { IBorderData, IStyleData } from '@univerjs/core';

import { applyTint, themeColorGrid } from '../core/officeColors';
import {
  addElementPrefix, childInsertionPoint, elementPrefix, encodeXmlAttribute, firstXmlElement, setXmlAttributes, stripElementPrefix,
  xmlAttribute, xmlElements,
} from './xlsxXml';

/**
 * styles.xml and theme colors, mapped to Univer cell styles on import. On export a changed
 * style is written as a NEW cellXfs record derived from the cell's original record, so that
 * everything the editor does not model (protection, font scheme, gradients …) survives.
 */

// Univer enum values (BorderStyleTypes, HorizontalAlign, VerticalAlign, WrapStrategy, BaselineOffset).
const HORIZONTAL_TO_UNIVER: Record<string, number> = {
  left: 1, center: 2, centerContinuous: 2, right: 3, justify: 4, distributed: 6, fill: 1,
};
const HORIZONTAL_FROM_UNIVER: Record<number, string> = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' };
const VERTICAL_TO_UNIVER: Record<string, number> = { top: 1, center: 2, justify: 2, distributed: 2, bottom: 3 };
const VERTICAL_FROM_UNIVER: Record<number, string> = { 1: 'top', 2: 'center', 3: 'bottom' };
const WRAP = 3;
const SUPERSCRIPT = 3;
const SUBSCRIPT = 2;
const DOUBLE_UNDERLINE = 10;
const BORDER_TO_UNIVER: Record<string, number> = {
  thin: 1, hair: 2, dotted: 3, dashed: 4, dashDot: 5, dashDotDot: 6, double: 7, medium: 8,
  mediumDashed: 9, mediumDashDot: 10, mediumDashDotDot: 11, slantDashDot: 12, thick: 13,
};
const BORDER_FROM_UNIVER = Object.fromEntries(Object.entries(BORDER_TO_UNIVER).map(([name, value]) => [value, name])) as Record<number, string>;

/** Built-in number formats that do not depend on the reader's locale. */
const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  12: '# ?/?', 13: '# ??/??', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0',
  48: '##0.0E+0', 49: '@',
};
/** Built-ins whose display follows the reader's locale (ECMA-376 18.8.30); zh-CN codes for 27–36 and 50–58. */
const LOCALE_FORMATS: Record<'zh' | 'en', Record<number, string>> = {
  en: { 14: 'm/d/yyyy', 22: 'm/d/yyyy h:mm' },
  zh: {
    14: 'yyyy/m/d', 22: 'yyyy/m/d h:mm', 27: 'yyyy"年"m"月"', 28: 'm"月"d"日"', 29: 'm"月"d"日"', 30: 'm-d-yy',
    31: 'yyyy"年"m"月"d"日"', 32: 'h"时"mm"分"', 33: 'h"时"mm"分"ss"秒"', 34: '上午/下午h"时"mm"分"',
    35: '上午/下午h"时"mm"分"ss"秒"', 36: 'yyyy"年"m"月"', 50: 'yyyy"年"m"月"', 51: 'm"月"d"日"', 52: 'yyyy"年"m"月"',
    53: 'm"月"d"日"', 54: 'm"月"d"日"', 55: '上午/下午h"时"mm"分"', 56: '上午/下午h"时"mm"分"ss"秒"', 57: 'yyyy"年"m"月"',
    58: 'm"月"d"日"',
  },
};
const FIRST_CUSTOM_FORMAT = 164;

const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
const DEFAULT_INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  '000000', 'FFFFFF',
];

export type NumberFormatLocale = 'zh' | 'en';

/** Canonical, comparable form of the style properties the editor can change. */
export interface NormalizedStyle {
  font: {
    name?: string;
    size?: number;
    bold: boolean;
    italic: boolean;
    underline?: 'single' | 'double';
    strike: boolean;
    color?: string;
    vertAlign?: 'superscript' | 'subscript';
  };
  fill?: string;
  border: Partial<Record<BorderSide, { style: string; color?: string }>>;
  alignment: { horizontal?: string; vertical?: string; wrap: boolean; rotation?: number; shrink: boolean };
  numberFormat?: string;
}

type BorderSide = 'left' | 'right' | 'top' | 'bottom' | 'diagonalDown' | 'diagonalUp';
const BORDER_SIDES: BorderSide[] = ['left', 'right', 'top', 'bottom', 'diagonalDown', 'diagonalUp'];
const UNIVER_BORDER_KEY: Record<BorderSide, keyof IBorderData> = {
  left: 'l', right: 'r', top: 't', bottom: 'b', diagonalDown: 'tl_br', diagonalUp: 'bl_tr',
};

interface StyleRecords {
  /** Raw element markup, in index order. */
  records: string[];
  /** Container element (e.g. `<fonts count="3">…</fonts>`) bounds within styles.xml. */
  start: number;
  end: number;
  open: string;
  name: string;
  /** Namespace prefix of the container, e.g. `x:`; records share it. */
  prefix: string;
}

export class XlsxStyles {
  readonly numberFormats = new Map<number, string>();
  readonly fonts?: StyleRecords;
  readonly fills?: StyleRecords;
  readonly borders?: StyleRecords;
  readonly cellXfs?: StyleRecords;
  readonly dxfs?: StyleRecords;
  private readonly theme: string[];
  private readonly indexed: string[];
  private readonly univerStyles = new Map<number, IStyleData>();

  constructor(readonly xml: string | undefined, themeXml: string | undefined, private readonly locale: NumberFormatLocale) {
    this.theme = parseTheme(themeXml);
    const palette = xml ? firstXmlElement(xml, 'indexedColors') : undefined;
    this.indexed = palette?.inner
      ? [...xmlElements(palette.inner, 'rgbColor')].map(element => (xmlAttribute(element.open, 'rgb') ?? '000000').slice(-6))
      : DEFAULT_INDEXED;
    if (!xml) return;
    const numFmts = firstXmlElement(xml, 'numFmts');
    for (const element of numFmts?.inner ? xmlElements(numFmts.inner, 'numFmt') : []) {
      const id = Number(xmlAttribute(element.open, 'numFmtId'));
      const code = xmlAttribute(element.open, 'formatCode');
      if (Number.isInteger(id) && code !== undefined) this.numberFormats.set(id, code);
    }
    this.fonts = records(xml, 'fonts', 'font');
    this.fills = records(xml, 'fills', 'fill');
    this.borders = records(xml, 'borders', 'border');
    this.cellXfs = records(xml, 'cellXfs', 'xf');
    this.dxfs = records(xml, 'dxfs', 'dxf');
  }

  get xfCount(): number { return this.cellXfs?.records.length ?? 0; }

  /**
   * The workbook's default font (the Normal style) as a Univer default style. Univer leaves
   * font properties a cell inherits out of its own style, so comparisons use both together.
   */
  defaultStyle(): IStyleData {
    const font = this.fonts?.records[0];
    if (!font) return {};
    const style = normalizedFont(font, this);
    return {
      ...(style.name ? { ff: style.name } : {}),
      ...(style.size ? { fs: style.size } : {}),
      ...(style.color ? { cl: { rgb: style.color } } : {}),
    };
  }

  /** The fonts the cell formats use, the default font first. */
  fontNames(): string[] {
    const ids = new Set([0]);
    for (const xf of this.cellXfs?.records ?? []) ids.add(Number(xmlAttribute(xf.match(/^<[^>]+>/)![0], 'fontId') ?? 0));
    const names = new Set<string>();
    for (const id of ids) {
      const record = this.fonts?.records[id];
      const name = record ? childValue(record, 'name') : undefined;
      if (name) names.add(name);
    }
    return [...names];
  }

  numberFormatCode(id: number): string | undefined {
    return this.numberFormats.get(id) ?? BUILTIN_FORMATS[id] ?? LOCALE_FORMATS[this.locale][id] ?? LOCALE_FORMATS.zh[id];
  }

  color(open: string): string | undefined {
    const rgb = xmlAttribute(open, 'rgb');
    const theme = xmlAttribute(open, 'theme');
    const indexed = xmlAttribute(open, 'indexed');
    let base: string | undefined;
    if (rgb && /^[\da-f]{6,8}$/i.test(rgb)) base = rgb.slice(-6);
    else if (theme !== undefined) base = this.theme[Number(theme)];
    else if (indexed !== undefined) base = this.indexed[Number(indexed)] ?? DEFAULT_INDEXED[Number(indexed)];
    if (!base) return undefined;
    const tint = Number(xmlAttribute(open, 'tint') ?? 0);
    return `#${(tint ? applyTint(base, tint) : base).toUpperCase()}`;
  }

  /** A DrawingML scheme color by name (`accent1`, `tx1`, `bg2` …) as RRGGBB. */
  themeColor(name: string): string | undefined {
    const alias: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
    const index = order.indexOf(alias[name] ?? name);
    return index >= 0 ? this.theme[index] : undefined;
  }

  /**
   * Excel's "Theme Colors" palette: a column per theme color (background 1, text 1, background 2,
   * text 2, accents 1–6) with the color first and its five lighter or darker variants below.
   */
  themeColorGrid(): string[][] {
    return themeColorGrid(this.theme.slice(0, 10));
  }

  /** Normalized style of a cellXfs record, straight from the XML. */
  normalized(xfIndex: number): NormalizedStyle {
    const xf = this.cellXfs?.records[xfIndex];
    const style: NormalizedStyle = { font: { bold: false, italic: false, strike: false }, border: {}, alignment: { wrap: false, shrink: false } };
    if (!xf) return style;
    const open = xf.match(/^<[^>]+>/)![0];
    const font = this.fonts?.records[Number(xmlAttribute(open, 'fontId') ?? 0)];
    if (font) style.font = normalizedFont(font, this);
    const fill = this.fills?.records[Number(xmlAttribute(open, 'fillId') ?? 0)];
    if (fill) style.fill = fillColor(fill, this);
    const border = this.borders?.records[Number(xmlAttribute(open, 'borderId') ?? 0)];
    if (border) style.border = normalizedBorder(border, this);
    const alignment = firstXmlElement(xf, 'alignment');
    if (alignment) style.alignment = normalizedAlignment(alignment.open);
    const format = this.numberFormatCode(Number(xmlAttribute(open, 'numFmtId') ?? 0));
    if (format && format !== 'General') style.numberFormat = format;
    return style;
  }

  /**
   * A differential format (conditional formatting style) as a Univer style. `dxf` is the record
   * markup; the index form reads styles.xml's `<dxfs>`. Solid DXF fills keep their color in
   * `bgColor`, unlike cell fills.
   */
  dxfStyle(dxf: number | string): IStyleData | undefined {
    const xml = typeof dxf === 'number' ? this.dxfs?.records[dxf] : dxf;
    if (!xml) return undefined;
    const style: IStyleData = {};
    const font = firstXmlElement(xml, 'font');
    if (font?.inner) {
      const value = normalizedFont(`${font.open}${font.inner}</${font.name}>`, this);
      if (value.bold) style.bl = 1;
      if (value.italic) style.it = 1;
      if (value.underline) style.ul = { s: 1 };
      if (value.strike) style.st = { s: 1 };
      if (value.color) style.cl = { rgb: value.color };
    }
    const pattern = firstXmlElement(xml, 'patternFill');
    if (pattern?.inner) {
      const type = xmlAttribute(pattern.open, 'patternType');
      const bg = firstXmlElement(pattern.inner, 'bgColor');
      const fg = firstXmlElement(pattern.inner, 'fgColor');
      const color = (bg && this.color(bg.open)) ?? (fg && this.color(fg.open));
      if (color && type !== 'none') style.bg = { rgb: color };
    }
    const border = firstXmlElement(xml, 'border');
    if (border?.inner) {
      const sides = normalizedBorder(`${border.open}${border.inner}</${border.name}>`, this);
      const data: IBorderData = {};
      for (const side of BORDER_SIDES) {
        const value = sides[side];
        if (value) data[UNIVER_BORDER_KEY[side]] = { s: BORDER_TO_UNIVER[value.style], cl: { rgb: value.color ?? '#000000' } };
      }
      if (Object.keys(data).length) style.bd = data;
    }
    const format = firstXmlElement(xml, 'numFmt');
    const code = format && xmlAttribute(format.open, 'formatCode');
    if (code && code !== 'General') style.n = { pattern: code };
    return style;
  }

  /** Univer style of a cellXfs record; undefined for the default record. */
  univerStyle(xfIndex: number): IStyleData | undefined {
    if (!this.cellXfs?.records[xfIndex]) return undefined;
    let style = this.univerStyles.get(xfIndex);
    if (!style) {
      style = toUniverStyle(this.normalized(xfIndex));
      this.univerStyles.set(xfIndex, style);
    }
    return style;
  }
}

function records(xml: string, container: string, item: string): StyleRecords | undefined {
  const element = firstXmlElement(xml, container);
  if (!element) return undefined;
  const items = element.inner ? [...xmlElements(element.inner, item)].map(record => record.open + (record.inner === undefined ? '' : `${record.inner}</${record.name}>`)) : [];
  return { records: items, start: element.start, end: element.end, open: element.open, name: element.name, prefix: elementPrefix(element.name) };
}

function parseTheme(xml: string | undefined): string[] {
  if (!xml) return DEFAULT_THEME;
  const scheme = firstXmlElement(xml, 'clrScheme');
  if (!scheme?.inner) return DEFAULT_THEME;
  const colors = new Map<string, string>();
  for (const name of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
    const element = firstXmlElement(scheme.inner, name);
    const srgb = element?.inner && firstXmlElement(element.inner, 'srgbClr');
    const sys = element?.inner && firstXmlElement(element.inner, 'sysClr');
    const value = (srgb && xmlAttribute(srgb.open, 'val')) || (sys && xmlAttribute(sys.open, 'lastClr'));
    if (value && /^[\da-f]{6}$/i.test(value)) colors.set(name, value);
  }
  // SpreadsheetML theme indexes swap the first pairs: 0 = lt1 (background), 1 = dk1 (text).
  return ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
    .map((name, index) => colors.get(name) ?? DEFAULT_THEME[index]);
}

function flag(xml: string, name: string): boolean {
  const element = firstXmlElement(xml, name);
  if (!element) return false;
  const value = xmlAttribute(element.open, 'val');
  return value === undefined || !['0', 'false'].includes(value.toLowerCase());
}

function childValue(xml: string, name: string): string | undefined {
  const element = firstXmlElement(xml, name);
  return element ? xmlAttribute(element.open, 'val') : undefined;
}

function normalizedFont(xml: string, styles: XlsxStyles): NormalizedStyle['font'] {
  const underline = firstXmlElement(xml, 'u');
  const underlineValue = underline ? (xmlAttribute(underline.open, 'val') ?? 'single') : 'none';
  const color = firstXmlElement(xml, 'color');
  const vertAlign = childValue(xml, 'vertAlign');
  const size = Number(childValue(xml, 'sz'));
  return {
    name: childValue(xml, 'name'),
    size: Number.isFinite(size) && size > 0 ? size : undefined,
    bold: flag(xml, 'b'),
    italic: flag(xml, 'i'),
    underline: underlineValue === 'none' ? undefined : underlineValue.startsWith('double') ? 'double' : 'single',
    strike: flag(xml, 'strike'),
    color: color && xmlAttribute(color.open, 'auto') !== '1' ? styles.color(color.open) : undefined,
    vertAlign: vertAlign === 'superscript' || vertAlign === 'subscript' ? vertAlign : undefined,
  };
}

function fillColor(xml: string, styles: XlsxStyles): string | undefined {
  const pattern = firstXmlElement(xml, 'patternFill');
  if (!pattern) {
    // Gradient fills have no single color; show their first stop.
    const stop = firstXmlElement(xml, 'stop');
    const color = stop?.inner && firstXmlElement(stop.inner, 'color');
    return color ? styles.color(color.open) : undefined;
  }
  const type = xmlAttribute(pattern.open, 'patternType') ?? (pattern.inner ? 'solid' : 'none');
  if (type === 'none' || !pattern.inner) return undefined;
  const fg = firstXmlElement(pattern.inner, 'fgColor');
  const bg = firstXmlElement(pattern.inner, 'bgColor');
  if (type === 'gray125' && !fg) return undefined;
  return (fg && styles.color(fg.open)) ?? (bg && styles.color(bg.open));
}

function normalizedBorder(xml: string, styles: XlsxStyles): NormalizedStyle['border'] {
  const border: NormalizedStyle['border'] = {};
  const open = xml.match(/^<[^>]+>/)![0];
  const side = (name: string, key: BorderSide) => {
    const element = firstXmlElement(xml, name);
    const style = element && xmlAttribute(element.open, 'style');
    if (!element || !style || style === 'none' || !BORDER_TO_UNIVER[style]) return;
    const color = element.inner && firstXmlElement(element.inner, 'color');
    border[key] = { style, color: (color && styles.color(color.open)) || '#000000' };
  };
  side('left', 'left');
  side('start', 'left');
  side('right', 'right');
  side('end', 'right');
  side('top', 'top');
  side('bottom', 'bottom');
  if (xmlAttribute(open, 'diagonalDown') === '1') side('diagonal', 'diagonalDown');
  if (xmlAttribute(open, 'diagonalUp') === '1') {
    const element = firstXmlElement(xml, 'diagonal');
    const style = element && xmlAttribute(element.open, 'style');
    if (style && BORDER_TO_UNIVER[style]) {
      const color = element.inner && firstXmlElement(element.inner, 'color');
      border.diagonalUp = { style, color: (color && styles.color(color.open)) || '#000000' };
    }
  }
  return border;
}

function normalizedAlignment(open: string): NormalizedStyle['alignment'] {
  const horizontal = xmlAttribute(open, 'horizontal');
  const vertical = xmlAttribute(open, 'vertical');
  const rotation = Number(xmlAttribute(open, 'textRotation') ?? 0);
  return {
    horizontal: horizontal && HORIZONTAL_TO_UNIVER[horizontal] ? HORIZONTAL_FROM_UNIVER[HORIZONTAL_TO_UNIVER[horizontal]] : undefined,
    vertical: vertical && vertical !== 'bottom' && VERTICAL_TO_UNIVER[vertical] ? VERTICAL_FROM_UNIVER[VERTICAL_TO_UNIVER[vertical]] : undefined,
    wrap: ['1', 'true'].includes(xmlAttribute(open, 'wrapText') ?? ''),
    rotation: Number.isInteger(rotation) && rotation > 0 && (rotation <= 180 || rotation === 255) ? rotation : undefined,
    shrink: ['1', 'true'].includes(xmlAttribute(open, 'shrinkToFit') ?? ''),
  };
}

/** Normalize CSS-ish colors (`#abc`, `#aabbcc`, `rgb(…)`) to `#RRGGBB`. */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const text = value.trim();
  let match = /^#?([\da-f]{6})(?:[\da-f]{2})?$/i.exec(text);
  if (match) return `#${match[1].toUpperCase()}`;
  match = /^#?([\da-f])([\da-f])([\da-f])$/i.exec(text);
  if (match) return `#${match.slice(1).map(char => char + char).join('').toUpperCase()}`;
  match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
  if (match) return `#${match.slice(1, 4).map(part => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return undefined;
}

export function toUniverStyle(style: NormalizedStyle): IStyleData {
  const result: IStyleData = {};
  const { font, alignment } = style;
  if (font.name) result.ff = font.name;
  if (font.size) result.fs = font.size;
  if (font.bold) result.bl = 1;
  if (font.italic) result.it = 1;
  if (font.underline) result.ul = font.underline === 'double' ? { s: 1, t: DOUBLE_UNDERLINE } : { s: 1 };
  if (font.strike) result.st = { s: 1 };
  if (font.color) result.cl = { rgb: font.color };
  if (font.vertAlign) result.va = font.vertAlign === 'superscript' ? SUPERSCRIPT : SUBSCRIPT;
  if (style.fill) result.bg = { rgb: style.fill };
  const border: IBorderData = {};
  for (const side of BORDER_SIDES) {
    const value = style.border[side];
    if (value) border[UNIVER_BORDER_KEY[side]] = { s: BORDER_TO_UNIVER[value.style], cl: { rgb: value.color ?? '#000000' } };
  }
  if (Object.keys(border).length) result.bd = border;
  if (alignment.horizontal) result.ht = HORIZONTAL_TO_UNIVER[alignment.horizontal];
  if (alignment.vertical) result.vt = VERTICAL_TO_UNIVER[alignment.vertical];
  if (alignment.wrap) result.tb = WRAP;
  // Excel turns text counterclockwise by 1–90 degrees and clockwise by 91–180 (90 plus the degrees);
  // Univer's angle turns it clockwise.
  if (alignment.rotation !== undefined) {
    result.tr = alignment.rotation === 255 ? { a: 0, v: 1 } : { a: alignment.rotation <= 90 ? -alignment.rotation : alignment.rotation - 90 };
  }
  if (alignment.shrink) result.stf = 1;
  if (style.numberFormat) result.n = { pattern: style.numberFormat };
  return result;
}

export function fromUniverStyle(style: IStyleData | null | undefined): NormalizedStyle {
  const result: NormalizedStyle = { font: { bold: false, italic: false, strike: false }, border: {}, alignment: { wrap: false, shrink: false } };
  if (!style) return result;
  result.font = {
    name: style.ff || undefined,
    size: typeof style.fs === 'number' && style.fs > 0 ? style.fs : undefined,
    bold: style.bl === 1,
    italic: style.it === 1,
    underline: style.ul?.s === 1 ? (style.ul.t === DOUBLE_UNDERLINE ? 'double' : 'single') : undefined,
    strike: style.st?.s === 1,
    color: normalizeColor(style.cl?.rgb),
    vertAlign: style.va === SUPERSCRIPT ? 'superscript' : style.va === SUBSCRIPT ? 'subscript' : undefined,
  };
  result.fill = normalizeColor(style.bg?.rgb);
  for (const side of BORDER_SIDES) {
    const value = style.bd?.[UNIVER_BORDER_KEY[side]];
    const name = value ? BORDER_FROM_UNIVER[value.s] : undefined;
    if (name) result.border[side] = { style: name, color: normalizeColor(value?.cl?.rgb) ?? '#000000' };
  }
  const rotation = style.tr ? (style.tr.v === 1 ? 255 : style.tr.a < 0 ? Math.min(90, -style.tr.a) : style.tr.a > 0 ? Math.min(180, 90 + style.tr.a) : undefined) : undefined;
  result.alignment = {
    horizontal: style.ht ? HORIZONTAL_FROM_UNIVER[style.ht] : undefined,
    vertical: style.vt && style.vt !== 3 ? VERTICAL_FROM_UNIVER[style.vt] : undefined,
    wrap: style.tb === WRAP,
    rotation,
    shrink: style.stf === 1,
  };
  const pattern = style.n?.pattern;
  result.numberFormat = pattern && pattern !== 'General' ? pattern : undefined;
  return result;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What a cell shows: the workbook default style overlaid with the cell's own properties. */
export function effectiveStyle(defaults: IStyleData | undefined, style: IStyleData | null | undefined): NormalizedStyle {
  return fromUniverStyle({ ...(defaults ?? {}), ...(style ?? {}) });
}

/**
 * Appends derived records to styles.xml. Records are never rewritten in place: cells that
 * keep their original record keep every attribute the editor does not understand.
 */
export class XlsxStyleWriter {
  /** Unprefixed markup of every record, original ones first. */
  private readonly fonts: string[];
  private readonly fills: string[];
  private readonly borders: string[];
  private readonly xfs: string[];
  private readonly dxfs: string[];
  private readonly addedFormats = new Map<string, number>();
  private readonly derived = new Map<string, number>();
  private nextFormatId: number;
  private changed = false;

  constructor(private readonly styles: XlsxStyles, private readonly defaults: IStyleData) {
    const unprefixed = (records: StyleRecords | undefined) => (records?.records ?? []).map(record => stripElementPrefix(record, records!.prefix));
    this.fonts = unprefixed(styles.fonts);
    this.fills = unprefixed(styles.fills);
    this.borders = unprefixed(styles.borders);
    this.xfs = unprefixed(styles.cellXfs);
    this.dxfs = unprefixed(styles.dxfs);
    this.nextFormatId = Math.max(FIRST_CUSTOM_FORMAT - 1, ...styles.numberFormats.keys()) + 1;
  }

  /**
   * The record index for a cell whose original record was `originalXf` and whose Univer style is
   * now `style`. Groups of properties that did not change keep the original markup.
   */
  xfFor(originalXf: number, style: IStyleData | undefined): number {
    if (!this.styles.cellXfs) throw new Error('Workbook has no cell style records');
    const base = this.xfs[originalXf] ? originalXf : 0;
    const target = effectiveStyle(this.defaults, style);
    const key = `${base}\u0000${JSON.stringify(target)}`;
    const cached = this.derived.get(key);
    if (cached !== undefined) return cached;
    const before = effectiveStyle(this.defaults, this.styles.univerStyle(base));
    const original = this.xfs[base] ?? '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    let open = original.match(/^<[^>]+>/)![0].replace(/\/>$/, '>');
    let inner = original.endsWith('/>') ? '' : original.slice(original.indexOf('>') + 1, original.lastIndexOf('</'));
    if (!sameJson(before.font, target.font)) {
      const fontId = Number(xmlAttribute(open, 'fontId') ?? 0);
      open = setXmlAttributes(open, { fontId: String(this.append(this.fonts, buildFont(this.fonts[fontId], target.font, open => this.styles.color(open)))), applyFont: '1' });
    }
    if (before.fill !== target.fill) {
      const fillId = target.fill ? this.append(this.fills, buildFill(target.fill)) : 0;
      open = setXmlAttributes(open, { fillId: String(fillId), applyFill: '1' });
    }
    if (!sameJson(before.border, target.border)) {
      const borderId = Number(xmlAttribute(open, 'borderId') ?? 0);
      open = setXmlAttributes(open, { borderId: String(this.append(this.borders, buildBorder(this.borders[borderId], before.border, target.border))), applyBorder: '1' });
    }
    if (!sameJson(before.alignment, target.alignment)) {
      const current = firstXmlElement(inner, 'alignment');
      const alignment = buildAlignment(current?.open, target.alignment);
      inner = current ? inner.slice(0, current.start) + alignment + inner.slice(current.end) : alignment + inner;
      open = setXmlAttributes(open, { applyAlignment: '1' });
    }
    if (before.numberFormat !== target.numberFormat) {
      open = setXmlAttributes(open, { numFmtId: String(this.formatId(target.numberFormat)), applyNumberFormat: '1' });
    }
    const record = inner ? `${open}${inner}</xf>` : open.replace(/>$/, '/>');
    const index = this.append(this.xfs, record);
    this.derived.set(key, index);
    return index;
  }

  /** The differential format (conditional formatting style) record for a Univer style. */
  dxfFor(style: IStyleData | undefined): number {
    const font = [
      style?.bl === 1 ? '<b/>' : '', style?.it === 1 ? '<i/>' : '', style?.st?.s === 1 ? '<strike/>' : '', style?.ul?.s === 1 ? '<u/>' : '',
      normalizeColor(style?.cl?.rgb) ? `<color rgb="FF${normalizeColor(style?.cl?.rgb)!.slice(1)}"/>` : '',
    ].join('');
    const format = style?.n?.pattern && style.n.pattern !== 'General'
      ? `<numFmt numFmtId="${this.formatId(style.n.pattern)}" formatCode="${encodeXmlAttribute(style.n.pattern)}"/>` : '';
    const fill = normalizeColor(style?.bg?.rgb);
    const fillMarkup = fill ? `<fill><patternFill patternType="solid"><fgColor rgb="FF${fill.slice(1)}"/><bgColor rgb="FF${fill.slice(1)}"/></patternFill></fill>` : '';
    const record = `<dxf>${font ? `<font>${font}</font>` : ''}${format}${fillMarkup}</dxf>`;
    return this.append(this.dxfs, record);
  }

  private append(list: string[], record: string): number {
    const existing = list.indexOf(record);
    if (existing >= 0) return existing;
    list.push(record);
    this.changed = true;
    return list.length - 1;
  }

  private formatId(code: string | undefined): number {
    if (!code) return 0;
    for (const [id, existing] of this.styles.numberFormats) if (existing === code) return id;
    for (const [id, existing] of Object.entries(BUILTIN_FORMATS)) if (existing === code) return Number(id);
    let id = this.addedFormats.get(code);
    if (id === undefined) {
      id = this.nextFormatId++;
      this.addedFormats.set(code, id);
      this.changed = true;
    }
    return id;
  }

  /** The updated styles.xml, or undefined when no record was added. */
  toXml(): string | undefined {
    const xml = this.styles.xml;
    if (!this.changed || !xml) return undefined;
    const replacements: { start: number; end: number; text: string }[] = [];
    const container = (records: StyleRecords | undefined, list: string[]) => {
      if (!records || list.length === records.records.length) return;
      const open = setXmlAttributes(records.open.replace(/\/>$/, '>'), { count: String(list.length) });
      const added = list.slice(records.records.length).map(record => addElementPrefix(record, records.prefix)).join('');
      replacements.push({ start: records.start, end: records.end, text: `${open}${records.records.join('')}${added}</${records.name}>` });
    };
    container(this.styles.fonts, this.fonts);
    container(this.styles.fills, this.fills);
    container(this.styles.borders, this.borders);
    container(this.styles.cellXfs, this.xfs);
    if (this.styles.dxfs) container(this.styles.dxfs, this.dxfs);
    else if (this.dxfs.length) {
      const prefix = elementPrefix(firstXmlElement(xml, 'styleSheet')?.name ?? '');
      const markup = addElementPrefix(`<dxfs count="${this.dxfs.length}">${this.dxfs.join('')}</dxfs>`, prefix);
      // Before the stylesheet's own table styles, colors or extensions (not an `extLst` inside a cell style).
      const at = childInsertionPoint(xml, 'styleSheet', ['tableStyles', 'colors', 'extLst']) ?? xml.lastIndexOf('</');
      replacements.push({ start: at, end: at, text: markup });
    }
    if (this.addedFormats.size) {
      const added = [...this.addedFormats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${encodeXmlAttribute(code)}"/>`).join('');
      const numFmts = firstXmlElement(xml, 'numFmts');
      if (numFmts) {
        const prefix = elementPrefix(numFmts.name);
        const open = setXmlAttributes(numFmts.open.replace(/\/>$/, '>'), { count: String(this.styles.numberFormats.size + this.addedFormats.size) });
        replacements.push({ start: numFmts.start, end: numFmts.end, text: `${open}${numFmts.inner ?? ''}${addElementPrefix(added, prefix)}</${numFmts.name}>` });
      } else {
        const anchor = firstXmlElement(xml, 'fonts') ?? firstXmlElement(xml, 'cellXfs')!;
        const prefix = elementPrefix(anchor.name);
        replacements.push({ start: anchor.start, end: anchor.start, text: addElementPrefix(`<numFmts count="${this.addedFormats.size}">${added}</numFmts>`, prefix) });
      }
    }
    replacements.sort((a, b) => b.start - a.start);
    let result = xml;
    for (const { start, end, text } of replacements) result = result.slice(0, start) + text + result.slice(end);
    return result;
  }
}

const FONT_ORDER = ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme'];

function buildFont(original: string | undefined, font: NormalizedStyle['font'], resolveColor: (open: string) => string | undefined): string {
  const children = new Map<string, string>();
  const source = original ?? '<font/>';
  const body = source.endsWith('/>') ? '' : source.slice(source.indexOf('>') + 1, source.lastIndexOf('</'));
  for (const name of FONT_ORDER) {
    const element = firstXmlElement(body, name);
    if (element) children.set(name, body.slice(element.start, element.end));
  }
  const set = (name: string, markup: string | undefined) => { if (markup) children.set(name, markup); else children.delete(name); };
  set('b', font.bold ? '<b/>' : undefined);
  set('i', font.italic ? '<i/>' : undefined);
  set('strike', font.strike ? '<strike/>' : undefined);
  const underline = firstXmlElement(children.get('u') ?? '', 'u');
  const underlineValue = underline ? xmlAttribute(underline.open, 'val') ?? 'single' : undefined;
  const keepUnderline = font.underline && underlineValue && (underlineValue.startsWith('double') ? 'double' : 'single') === font.underline;
  if (!keepUnderline) set('u', font.underline === 'double' ? '<u val="double"/>' : font.underline ? '<u/>' : undefined);
  set('vertAlign', font.vertAlign ? `<vertAlign val="${font.vertAlign}"/>` : undefined);
  set('sz', font.size ? `<sz val="${font.size}"/>` : undefined);
  // Keep a theme or indexed color reference while it still resolves to the same color.
  const color = children.get('color');
  const originalColor = color ? resolveColor(firstXmlElement(color, 'color')!.open) : undefined;
  if (font.color !== originalColor) set('color', font.color ? `<color rgb="FF${font.color.slice(1)}"/>` : undefined);
  const name = children.get('name');
  const originalName = name ? xmlAttribute(firstXmlElement(name, 'name')!.open, 'val') : undefined;
  if (font.name !== originalName) {
    set('name', font.name ? `<name val="${encodeXmlAttribute(font.name)}"/>` : undefined);
    // A theme font scheme overrides the name; a new name must not be replaced by the theme font.
    set('scheme', undefined);
    set('charset', undefined);
  }
  return `<font>${FONT_ORDER.map(key => children.get(key) ?? '').join('')}</font>`;
}

function buildFill(color: string): string {
  return `<fill><patternFill patternType="solid"><fgColor rgb="FF${color.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`;
}

const BORDER_ELEMENTS: [BorderSide | 'diagonal', string][] = [['left', 'left'], ['right', 'right'], ['top', 'top'], ['bottom', 'bottom'], ['diagonal', 'diagonal']];

function buildBorder(original: string | undefined, before: NormalizedStyle['border'], target: NormalizedStyle['border']): string {
  const source = original ?? '<border/>';
  const body = source.endsWith('/>') ? '' : source.slice(source.indexOf('>') + 1, source.lastIndexOf('</'));
  const side = (key: BorderSide, name: string): string => {
    const value = target[key];
    if (sameJson(before[key], value)) {
      const element = firstXmlElement(body, name) ?? (name === 'left' ? firstXmlElement(body, 'start') : name === 'right' ? firstXmlElement(body, 'end') : undefined);
      if (element) return body.slice(element.start, element.end).replace(/^<(start|end)\b/, `<${name}`).replace(/<\/(start|end)>$/, `</${name}>`);
    }
    return value ? `<${name} style="${value.style}"><color rgb="FF${(value.color ?? '#000000').slice(1)}"/></${name}>` : `<${name}/>`;
  };
  const diagonal = target.diagonalDown ?? target.diagonalUp;
  const diagonalMarkup = diagonal ? `<diagonal style="${diagonal.style}"><color rgb="FF${(diagonal.color ?? '#000000').slice(1)}"/></diagonal>` : '<diagonal/>';
  const attributes = `${target.diagonalUp ? ' diagonalUp="1"' : ''}${target.diagonalDown ? ' diagonalDown="1"' : ''}`;
  const parts = BORDER_ELEMENTS.map(([key, name]) => (key === 'diagonal' ? diagonalMarkup : side(key, name)));
  for (const extra of ['vertical', 'horizontal']) {
    const element = firstXmlElement(body, extra);
    if (element) parts.push(body.slice(element.start, element.end));
  }
  return `<border${attributes}>${parts.join('')}</border>`;
}

function buildAlignment(originalOpen: string | undefined, alignment: NormalizedStyle['alignment']): string {
  const open = originalOpen ?? '<alignment/>';
  const updated = setXmlAttributes(open.endsWith('/>') ? open : open.replace(/>$/, '/>'), {
    horizontal: alignment.horizontal,
    vertical: alignment.vertical,
    wrapText: alignment.wrap ? '1' : undefined,
    textRotation: alignment.rotation !== undefined ? String(alignment.rotation) : undefined,
    shrinkToFit: alignment.shrink ? '1' : undefined,
  });
  return updated === '<alignment/>' ? '' : updated;
}
