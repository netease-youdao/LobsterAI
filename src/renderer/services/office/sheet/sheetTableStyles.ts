import { BorderStyleTypes, type IBorderData, type IBorderStyleData, type IStyleData, type Nullable } from '@univerjs/core';

import type { CellRange } from './sheetAddress';
import type { XlsxStyles } from './xlsxStyles';
import { firstXmlElement, xmlAttribute, xmlElements } from './xlsxXml';

/**
 * Excel table styles drawn over the grid: the header, banded rows and columns, first and last
 * column and total row formats of a table's style, beneath the cells' own formats (direct
 * formatting wins, as in Excel). Only drawn: the cells keep their formats and the file its table.
 */

export const TableElement = {
  WholeTable: 'wholeTable', FirstColumnStripe: 'firstColumnStripe', SecondColumnStripe: 'secondColumnStripe', FirstRowStripe: 'firstRowStripe',
  SecondRowStripe: 'secondRowStripe', LastColumn: 'lastColumn', FirstColumn: 'firstColumn', HeaderRow: 'headerRow', TotalRow: 'totalRow',
  FirstHeaderCell: 'firstHeaderCell', LastHeaderCell: 'lastHeaderCell', FirstTotalCell: 'firstTotalCell', LastTotalCell: 'lastTotalCell',
} as const;
export type TableElement = typeof TableElement[keyof typeof TableElement];

/** Elements in the order they apply: later ones override earlier ones (ECMA-376 §18.8.40). */
const PRECEDENCE: TableElement[] = Object.values(TableElement);

type BorderSide = 'left' | 'right' | 'top' | 'bottom' | 'horizontal' | 'vertical';
/** One element's format, as a differential style with the inner borders of its region. */
export interface ElementStyle {
  style: IStyleData;
  horizontal?: IBorderStyleData;
  vertical?: IBorderStyleData;
}
export type ResolvedTableStyle = Partial<Record<TableElement, ElementStyle>>;

export interface TableStyleOptions {
  name: string;
  rowStripes: boolean;
  columnStripes: boolean;
  firstColumn: boolean;
  lastColumn: boolean;
}

// ---------------------------------------------------------------------------------------------
// Built-in styles: nine families, each in a dark (text 1) and six accent variants.

interface Color { theme: number; tint?: number }
interface Format { bold?: boolean; color?: Color; fill?: Color; border?: Partial<Record<BorderSide, { style: BorderStyleTypes; color: Color }>> }
type Definition = Partial<Record<TableElement, Format>>;

const LT1 = 0;
const TX1 = 1;
const thin = (color: Color) => ({ style: BorderStyleTypes.THIN, color });
const outline = (color: Color, style = BorderStyleTypes.THIN) => ({ left: { style, color }, right: { style, color }, top: { style, color }, bottom: { style, color } });
/** A light tint of the main color (text 1 gets gray). */
const pale = (main: number, accentTint: number, darkTint: number): Color => (main === TX1 ? { theme: TX1, tint: darkTint } : { theme: main, tint: accentTint });
const stripes = (format: Format): Definition => ({ [TableElement.FirstRowStripe]: format, [TableElement.FirstColumnStripe]: format });
const boldColumns: Definition = { [TableElement.FirstColumn]: { bold: true }, [TableElement.LastColumn]: { bold: true } };

const FAMILIES: Record<string, (main: number, second: number) => Definition> = {
  // Light 1–7: colored text, lines above and below, banded fill.
  light1: main => ({
    [TableElement.WholeTable]: { color: main === TX1 ? { theme: TX1 } : { theme: main, tint: -0.249977111117893 }, border: { top: thin({ theme: main }), bottom: thin({ theme: main }) } },
    [TableElement.HeaderRow]: { bold: true, border: { bottom: thin({ theme: main }) } },
    [TableElement.TotalRow]: { bold: true, border: { top: thin({ theme: main }) } },
    ...boldColumns,
    ...stripes({ fill: pale(main, 0.7999816888943144, 0.8499862666707358) }),
  }),
  // Light 8–14: filled header, outlined table, lines between banded rows.
  light2: main => ({
    [TableElement.WholeTable]: { border: outline({ theme: main }) },
    [TableElement.HeaderRow]: { bold: true, color: { theme: LT1 }, fill: { theme: main } },
    [TableElement.TotalRow]: { bold: true, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: main } } } },
    ...boldColumns,
    [TableElement.FirstRowStripe]: { border: { top: thin({ theme: main }), bottom: thin({ theme: main }) } },
    [TableElement.FirstColumnStripe]: { border: { left: thin({ theme: main }), right: thin({ theme: main }) } },
  }),
  // Light 15–21: outlined table, underlined header, banded fill.
  light3: main => ({
    [TableElement.WholeTable]: { border: outline({ theme: main }) },
    [TableElement.HeaderRow]: { bold: true, border: { bottom: { style: BorderStyleTypes.MEDIUM, color: { theme: main } } } },
    [TableElement.TotalRow]: { bold: true, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: main } } } },
    ...boldColumns,
    ...stripes({ fill: main === TX1 ? { theme: LT1, tint: -0.14999847407452621 } : { theme: main, tint: 0.7999816888943144 } }),
  }),
  // Medium 1–7 (Medium 2 is Excel's default): filled header, light lines, banded fill.
  medium1: main => {
    const line = thin(pale(main, 0.3999755851924192, 0.3499862666707358));
    return {
      [TableElement.WholeTable]: { color: { theme: TX1 }, border: { left: line, right: line, top: line, bottom: line, horizontal: line } },
      [TableElement.HeaderRow]: { bold: true, color: { theme: LT1 }, fill: { theme: main } },
      [TableElement.TotalRow]: { bold: true, color: { theme: TX1 }, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: main } } } },
      ...boldColumns,
      ...stripes({ fill: pale(main, 0.7999816888943144, 0.8499862666707358) }),
    };
  },
  // Medium 8–14: tinted body with white grid lines, filled header, first/last column and totals.
  medium2: main => {
    const white = { theme: LT1 };
    const strong: Format = { bold: true, color: white, fill: { theme: main } };
    return {
      [TableElement.WholeTable]: { color: { theme: TX1 }, fill: pale(main, 0.7999816888943144, 0.8499862666707358), border: { horizontal: thin(white), vertical: thin(white) } },
      [TableElement.HeaderRow]: { ...strong, border: { bottom: { style: BorderStyleTypes.THICK, color: white } } },
      [TableElement.TotalRow]: { ...strong, border: { top: { style: BorderStyleTypes.THICK, color: white } } },
      [TableElement.FirstColumn]: strong,
      [TableElement.LastColumn]: strong,
      ...stripes({ fill: pale(main, 0.5999938962981048, 0.6999816888943144) }),
    };
  },
  // Medium 15–21: filled header between dark lines, gray bands.
  medium3: main => {
    const strong: Format = { bold: true, color: { theme: LT1 }, fill: { theme: main } };
    return {
      [TableElement.WholeTable]: { color: { theme: TX1 }, border: { top: thin({ theme: TX1 }), bottom: thin({ theme: TX1 }) } },
      [TableElement.HeaderRow]: { ...strong, border: { bottom: thin({ theme: TX1 }) } },
      [TableElement.TotalRow]: { bold: true, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: TX1 } } } },
      [TableElement.FirstColumn]: strong,
      [TableElement.LastColumn]: strong,
      ...stripes({ fill: { theme: LT1, tint: -0.14999847407452621 } }),
    };
  },
  // Medium 22–28: tinted grid, bold header, darker bands.
  medium4: main => {
    const line = thin(pale(main, 0.3999755851924192, 0.3499862666707358));
    return {
      [TableElement.WholeTable]: { color: { theme: TX1 }, fill: pale(main, 0.7999816888943144, 0.8499862666707358), border: { left: line, right: line, top: line, bottom: line, horizontal: line, vertical: line } },
      [TableElement.HeaderRow]: { bold: true },
      [TableElement.TotalRow]: { bold: true, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: main } } } },
      ...boldColumns,
      ...stripes({ fill: pale(main, 0.5999938962981048, 0.6999816888943144) }),
    };
  },
  // Dark 1–7: dark body with white text, black header.
  dark1: main => {
    const white = { theme: LT1 };
    const deep: Color = main === TX1 ? { theme: TX1, tint: 0.1499984740745262 } : { theme: main, tint: -0.4999847407452621 };
    return {
      [TableElement.WholeTable]: { color: white, fill: main === TX1 ? { theme: TX1, tint: 0.249977111117893 } : { theme: main, tint: -0.249977111117893 } },
      [TableElement.HeaderRow]: { bold: true, color: white, fill: { theme: TX1 }, border: { bottom: { style: BorderStyleTypes.MEDIUM, color: white } } },
      [TableElement.TotalRow]: { bold: true, color: white, fill: deep, border: { top: { style: BorderStyleTypes.DOUBLE, color: white } } },
      [TableElement.FirstColumn]: { bold: true, color: white, fill: deep, border: { right: { style: BorderStyleTypes.MEDIUM, color: white } } },
      [TableElement.LastColumn]: { bold: true, color: white, fill: deep, border: { left: { style: BorderStyleTypes.MEDIUM, color: white } } },
      ...stripes({ fill: deep }),
    };
  },
  // Dark 8–11: light body, header in the paired color.
  dark2: (main, second) => ({
    [TableElement.WholeTable]: { fill: pale(main, 0.7999816888943144, 0.8499862666707358) },
    [TableElement.HeaderRow]: { bold: true, color: { theme: LT1 }, fill: { theme: second } },
    [TableElement.TotalRow]: { bold: true, border: { top: { style: BorderStyleTypes.DOUBLE, color: { theme: TX1 } } } },
    ...boldColumns,
    ...stripes({ fill: pale(main, 0.5999938962981048, 0.6999816888943144) }),
  }),
};

/** A built-in style's family and colors: `TableStyleMedium2` → medium1 on accent 1. */
function builtIn(name: string): Definition | undefined {
  const match = /^TableStyle(Light|Medium|Dark)(\d{1,2})$/.exec(name);
  if (!match) return undefined;
  const number = Number(match[2]);
  const kind = match[1];
  const accent = (position: number) => (position === 0 ? TX1 : 3 + position);
  if (kind === 'Light' && number >= 1 && number <= 21) return FAMILIES[`light${Math.ceil(number / 7)}`](accent((number - 1) % 7), 0);
  if (kind === 'Medium' && number >= 1 && number <= 28) return FAMILIES[`medium${Math.ceil(number / 7)}`](accent((number - 1) % 7), 0);
  if (kind === 'Dark' && number >= 1 && number <= 7) return FAMILIES.dark1(accent(number - 1), 0);
  if (kind === 'Dark' && number >= 8 && number <= 11) {
    const pair = number - 8;
    return pair === 0 ? FAMILIES.dark2(TX1, TX1) : FAMILIES.dark2(accent(pair * 2 - 1), accent(pair * 2));
  }
  return undefined;
}

const colorTag = (color: Color) => `<color theme="${color.theme}"${color.tint ? ` tint="${color.tint}"` : ''}/>`;

function resolveFormat(format: Format, styles: XlsxStyles): ElementStyle {
  const style: IStyleData = {};
  if (format.bold) style.bl = 1;
  const text = format.color && styles.color(colorTag(format.color));
  if (text) style.cl = { rgb: text };
  const fill = format.fill && styles.color(colorTag(format.fill));
  if (fill) style.bg = { rgb: fill };
  const border: IBorderData = {};
  const side = (value: { style: BorderStyleTypes; color: Color } | undefined): IBorderStyleData | undefined => {
    const rgb = value && styles.color(colorTag(value.color));
    return value && rgb ? { s: value.style, cl: { rgb } } : undefined;
  };
  const sides = format.border ?? {};
  const [left, right, top, bottom] = [side(sides.left), side(sides.right), side(sides.top), side(sides.bottom)];
  if (left) border.l = left;
  if (right) border.r = right;
  if (top) border.t = top;
  if (bottom) border.b = bottom;
  if (Object.keys(border).length) style.bd = border;
  const horizontal = side(sides.horizontal);
  const vertical = side(sides.vertical);
  return { style, ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) };
}

const BORDER_TYPES: Record<string, BorderStyleTypes> = {
  thin: BorderStyleTypes.THIN, medium: BorderStyleTypes.MEDIUM, thick: BorderStyleTypes.THICK, double: BorderStyleTypes.DOUBLE,
  dashed: BorderStyleTypes.DASHED, dotted: BorderStyleTypes.DOTTED, hair: BorderStyleTypes.HAIR,
};

/** A table style defined in the workbook (`<tableStyles>` in styles.xml), from its differential formats. */
function customStyle(name: string, stylesXml: string | undefined, styles: XlsxStyles): ResolvedTableStyle | undefined {
  const container = stylesXml ? firstXmlElement(stylesXml, 'tableStyles') : undefined;
  const definition = container?.inner ? [...xmlElements(container.inner, 'tableStyle')].find(item => xmlAttribute(item.open, 'name') === name) : undefined;
  if (!definition?.inner) return undefined;
  const resolved: ResolvedTableStyle = {};
  for (const element of xmlElements(definition.inner, 'tableStyleElement')) {
    const type = xmlAttribute(element.open, 'type') as TableElement | undefined;
    const dxfId = Number(xmlAttribute(element.open, 'dxfId'));
    if (!type || !PRECEDENCE.includes(type) || !Number.isInteger(dxfId)) continue;
    const style = styles.dxfStyle(dxfId) ?? {};
    const record = styles.dxfs?.records[dxfId] ?? '';
    const inner = (local: string) => {
      const border = firstXmlElement(record, 'border');
      const edge = border?.inner ? firstXmlElement(border.inner, local) : undefined;
      const kind = edge && BORDER_TYPES[xmlAttribute(edge.open, 'style') ?? ''];
      const colorElement = edge?.inner ? firstXmlElement(edge.inner, 'color') : undefined;
      const rgb = colorElement ? styles.color(colorElement.open) : '#000000';
      return kind && rgb ? { s: kind, cl: { rgb } } : undefined;
    };
    const horizontal = inner('horizontal');
    const vertical = inner('vertical');
    resolved[type] = { style, ...(horizontal ? { horizontal } : {}), ...(vertical ? { vertical } : {}) };
  }
  return resolved;
}

/** A table style's formats with the workbook's theme colors; undefined for an unknown name. */
export function resolveTableStyle(name: string, styles: XlsxStyles, stylesXml?: string): ResolvedTableStyle | undefined {
  const custom = customStyle(name, stylesXml, styles);
  if (custom) return custom;
  const definition = builtIn(name);
  if (!definition) return undefined;
  const resolved: ResolvedTableStyle = {};
  for (const [element, format] of Object.entries(definition) as [TableElement, Format][]) resolved[element] = resolveFormat(format, styles);
  return resolved;
}

export interface DrawnTable {
  range: CellRange;
  headerRow: boolean;
  totalRow: boolean;
  options: TableStyleOptions;
  style: ResolvedTableStyle;
}

type Region = { startRow: number; endRow: number; startColumn: number; endColumn: number };

/** The formats of a table's style at one of its cells, merged in the elements' order. */
export function tableCellStyle(table: DrawnTable, row: number, column: number): IStyleData | undefined {
  const { range, options, style } = table;
  const header = table.headerRow ? range.startRow : -1;
  const total = table.totalRow ? range.endRow : -1;
  const dataStart = range.startRow + (table.headerRow ? 1 : 0);
  const dataEnd = range.endRow - (table.totalRow ? 1 : 0);
  const inData = row >= dataStart && row <= dataEnd;
  const applies = new Map<TableElement, Region>();
  applies.set(TableElement.WholeTable, range);
  if (options.columnStripes && inData) {
    const odd = (column - range.startColumn) % 2 === 1;
    applies.set(odd ? TableElement.SecondColumnStripe : TableElement.FirstColumnStripe, { startRow: dataStart, endRow: dataEnd, startColumn: column, endColumn: column });
  }
  if (options.rowStripes && inData) {
    const odd = (row - dataStart) % 2 === 1;
    applies.set(odd ? TableElement.SecondRowStripe : TableElement.FirstRowStripe, { startRow: row, endRow: row, startColumn: range.startColumn, endColumn: range.endColumn });
  }
  if (options.lastColumn && column === range.endColumn) applies.set(TableElement.LastColumn, { startRow: range.startRow, endRow: range.endRow, startColumn: column, endColumn: column });
  if (options.firstColumn && column === range.startColumn) applies.set(TableElement.FirstColumn, { startRow: range.startRow, endRow: range.endRow, startColumn: column, endColumn: column });
  if (row === header) {
    applies.set(TableElement.HeaderRow, { startRow: row, endRow: row, startColumn: range.startColumn, endColumn: range.endColumn });
    if (options.firstColumn && column === range.startColumn) applies.set(TableElement.FirstHeaderCell, { startRow: row, endRow: row, startColumn: column, endColumn: column });
    if (options.lastColumn && column === range.endColumn) applies.set(TableElement.LastHeaderCell, { startRow: row, endRow: row, startColumn: column, endColumn: column });
  }
  if (row === total) {
    applies.set(TableElement.TotalRow, { startRow: row, endRow: row, startColumn: range.startColumn, endColumn: range.endColumn });
    if (options.firstColumn && column === range.startColumn) applies.set(TableElement.FirstTotalCell, { startRow: row, endRow: row, startColumn: column, endColumn: column });
    if (options.lastColumn && column === range.endColumn) applies.set(TableElement.LastTotalCell, { startRow: row, endRow: row, startColumn: column, endColumn: column });
  }
  let result: IStyleData | undefined;
  for (const element of PRECEDENCE) {
    const region = applies.get(element);
    const format = region && style[element];
    if (!region || !format) continue;
    const { bd, ...rest } = format.style;
    const next: IStyleData = { ...result, ...rest };
    const border: IBorderData = { ...result?.bd };
    if (bd?.l && column === region.startColumn) border.l = bd.l;
    if (bd?.r && column === region.endColumn) border.r = bd.r;
    if (bd?.t && row === region.startRow) border.t = bd.t;
    if (bd?.b && row === region.endRow) border.b = bd.b;
    if (format.horizontal && row < region.endRow) border.b = format.horizontal;
    if (format.vertical && column < region.endColumn) border.r = format.vertical;
    if (Object.keys(border).length) next.bd = border;
    result = next;
  }
  return result && Object.keys(result).length ? result : undefined;
}

/**
 * A cell's own formats over its table's: the cell wins property by property, border by border.
 * As in Excel, what the cell only shares with the Normal style (`defaults`: the automatic font
 * color, no bold, no fill, no line) lets the table's format show through.
 */
export function underCellStyle(table: IStyleData, own: Nullable<IStyleData>, defaults?: Nullable<IStyleData>): IStyleData {
  if (!own) return table;
  const direct: IStyleData = { ...own };
  if (!direct.bl) delete direct.bl;
  if (!direct.it) delete direct.it;
  if (!direct.bg?.rgb) delete direct.bg;
  const automatic = defaults?.cl?.rgb ?? '#000000';
  if (!direct.cl?.rgb || direct.cl.rgb.toUpperCase() === automatic.toUpperCase()) delete direct.cl;
  delete direct.bd;
  const merged: IStyleData = { ...table, ...direct };
  const lines = Object.entries(own.bd ?? {}).filter(([, line]) => line && line.s !== BorderStyleTypes.NONE);
  if (table.bd || lines.length) merged.bd = { ...table.bd, ...Object.fromEntries(lines) };
  return merged;
}
