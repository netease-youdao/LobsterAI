import type { Fill } from './slidesModel';
import type { SlidesPackage } from './slidesPackage';
import {
  colorChild, type ColorContext, cssColor, readColorMap, resolveColor, resolveTypeface,
} from './slidesTheme';
import { el, elements, flag, named, NS, num } from './slidesXml';

/**
 * DrawingML chart parts (`ppt/charts/chart*.xml`) parsed into a plain view model for vector SVG
 * chart rendering on slides and thumbnails.
 */

export const SlideChartPlotType = {
  Bar: 'bar',
  Line: 'line',
  Area: 'area',
  Pie: 'pie',
  Doughnut: 'doughnut',
  Scatter: 'scatter',
  Radar: 'radar',
  Bubble: 'bubble',
} as const;
export type SlideChartPlotType = typeof SlideChartPlotType[keyof typeof SlideChartPlotType];

export const SlideChartGrouping = {
  Clustered: 'clustered',
  Stacked: 'stacked',
  PercentStacked: 'percentStacked',
  Standard: 'standard',
} as const;
export type SlideChartGrouping = typeof SlideChartGrouping[keyof typeof SlideChartGrouping];

export interface ChartTextStyle {
  color?: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  fontName?: string;
}

export interface ChartLineStyle {
  color?: string;
  widthPt?: number;
  dash?: string;
  none?: boolean;
}

export interface ChartTitleView {
  text: string;
  style?: ChartTextStyle;
  overlay?: boolean;
}

export interface ChartDataLabels {
  value?: boolean;
  percent?: boolean;
  category?: boolean;
  series?: boolean;
  bubbleSize?: boolean;
  position?: string;
  separator?: string;
  formatCode?: string;
  sourceLinked?: boolean;
  style?: ChartTextStyle;
}

export interface ChartCategoryData {
  /** Labels for the level nearest the axis. */
  labels: string[];
  /** Outer category levels (nearest the axis first) for multi-level category axes. */
  levels?: string[][];
}

export interface ChartSeriesView {
  name?: string;
  categories?: ChartCategoryData;
  values: (number | null)[];
  valueFormatCode?: string;
  /** Scatter and bubble x values. */
  x?: (number | null)[];
  xFormatCode?: string;
  /** Bubble sizes. */
  sizes?: (number | null)[];
  color?: string;
  noFill?: boolean;
  line?: ChartLineStyle;
  marker?: { symbol: string; size?: number; color?: string; borderColor?: string };
  smooth?: boolean;
  labels?: ChartDataLabels;
  pointLabels?: Record<number, ChartDataLabels | null>;
  pointColors?: Record<number, string>;
}

export interface ChartPlotView {
  type: SlideChartPlotType;
  horizontal?: boolean;
  grouping?: SlideChartGrouping;
  holeSize?: number;
  firstSliceAngle?: number;
  varyColors?: boolean;
  secondary?: boolean;
  scatterStyle?: string;
  radarStyle?: string;
  gapWidth?: number;
  overlap?: number;
  showMarkers?: boolean;
  series: ChartSeriesView[];
}

export interface ChartAxisView {
  title?: ChartTitleView;
  deleted?: boolean;
  position?: 'b' | 't' | 'l' | 'r';
  tickLabelPos?: 'none' | 'low' | 'high' | 'nextTo';
  majorTickMark?: 'out' | 'in' | 'cross' | 'none';
  reverse?: boolean;
  min?: number;
  max?: number;
  majorUnit?: number;
  logBase?: number;
  formatCode?: string;
  sourceLinked?: boolean;
  gridlines?: boolean;
  gridlineStyle?: ChartLineStyle;
  axisLine?: ChartLineStyle;
  labelStyle?: ChartTextStyle;
  labelRotate?: number;
  noMultiLevelLabels?: boolean;
}

export interface SlideChartView {
  title?: ChartTitleView;
  palette: string[];
  plots: ChartPlotView[];
  legend?: { position: string; overlay?: boolean; style?: ChartTextStyle };
  categoryAxis?: ChartAxisView;
  valueAxis?: ChartAxisView;
  secondaryValueAxis?: ChartAxisView;
  background?: string;
  border?: ChartLineStyle;
  plotBackground?: string;
  plotBorder?: ChartLineStyle;
  textStyle?: ChartTextStyle;
  darkSurface: boolean;
  date1904?: boolean;
  dispBlanksAs?: 'gap' | 'zero' | 'span';
  /** Fonts referenced by chart text styles, for metric-compatible font preloading. */
  fonts: string[];
}

const EMU_PER_PT = 12700;
// Single-quoted names: ECharts's SVG renderer embeds fontFamily verbatim inside style="...".
export const CHART_FALLBACK_FONTS = "'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif";
export const CHART_DEFAULT_PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];
const COLOR_STYLE_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle';
const FILL_NAMES = new Set(['noFill', 'solidFill', 'gradFill', 'pattFill']);

const PLOT_TYPES: Record<string, SlideChartPlotType> = {
  barChart: SlideChartPlotType.Bar,
  bar3DChart: SlideChartPlotType.Bar,
  lineChart: SlideChartPlotType.Line,
  line3DChart: SlideChartPlotType.Line,
  areaChart: SlideChartPlotType.Area,
  area3DChart: SlideChartPlotType.Area,
  pieChart: SlideChartPlotType.Pie,
  pie3DChart: SlideChartPlotType.Pie,
  ofPieChart: SlideChartPlotType.Pie,
  doughnutChart: SlideChartPlotType.Doughnut,
  scatterChart: SlideChartPlotType.Scatter,
  radarChart: SlideChartPlotType.Radar,
  bubbleChart: SlideChartPlotType.Bubble,
};
const UNSUPPORTED_PLOTS = new Set(['stockChart', 'surfaceChart', 'surface3DChart']);

const VALID_GROUPINGS = new Set<string>(Object.values(SlideChartGrouping));
const VALID_AXIS_POS = new Set(['b', 't', 'l', 'r']);
const VALID_TICK_POS = new Set(['none', 'low', 'high', 'nextTo']);
const VALID_TICK_MARK = new Set(['out', 'in', 'cross', 'none']);

function chartVal(parent: Element | undefined, local: string): string | undefined {
  return el(parent, `c:${local}`)?.getAttribute('val') ?? undefined;
}

function chartNum(parent: Element | undefined, local: string): number | undefined {
  const raw = chartVal(parent, local);
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** OOXML chart booleans default to true when the element is present without a `val` attribute. */
function chartFlag(parent: Element | undefined, local: string): boolean | undefined {
  const child = el(parent, `c:${local}`);
  if (!child) return undefined;
  const raw = child.getAttribute('val');
  if (raw === null || raw === '') return true;
  return raw === '1' || raw === 'true';
}

function fillIn(parent: Element | undefined): Element | undefined {
  return elements(parent).find(child => FILL_NAMES.has(child.localName) && child.namespaceURI === NS.a);
}

function resolveFillColor(fill: Element | undefined, colors: ColorContext): { color?: string; none?: boolean } {
  if (!fill) return {};
  switch (fill.localName) {
    case 'noFill': return { none: true };
    case 'solidFill': {
      const color = cssColor(resolveColor(colorChild(fill), colors));
      return color ? { color } : {};
    }
    case 'gradFill': {
      const color = cssColor(resolveColor(colorChild(el(fill, 'a:gsLst', 'a:gs')), colors));
      return color ? { color } : {};
    }
    case 'pattFill': {
      const color = cssColor(resolveColor(colorChild(el(fill, 'a:fgClr')), colors));
      return color ? { color } : {};
    }
    default: return {};
  }
}

function readChartLine(line: Element | undefined, colors: ColorContext): ChartLineStyle | undefined {
  if (!line) return undefined;
  if (el(line, 'a:noFill')) return { none: true };
  const fill = resolveFillColor(fillIn(line), colors);
  const widthEmu = num(line, 'w');
  const dash = el(line, 'a:prstDash')?.getAttribute('val') ?? undefined;
  if (!fill.color && widthEmu === undefined && !dash) return undefined;
  return {
    ...(fill.color ? { color: fill.color } : {}),
    ...(widthEmu !== undefined ? { widthPt: widthEmu / EMU_PER_PT } : {}),
    ...(dash && dash !== 'solid' ? { dash } : {}),
  };
}

function readShapeStyle(spPr: Element | undefined, colors: ColorContext): {
  fill?: string;
  noFill?: boolean;
  line?: ChartLineStyle;
} {
  if (!spPr) return {};
  const fill = resolveFillColor(fillIn(spPr), colors);
  const line = readChartLine(el(spPr, 'a:ln'), colors);
  return {
    ...(fill.color ? { fill: fill.color } : {}),
    ...(fill.none ? { noFill: true } : {}),
    ...(line ? { line } : {}),
  };
}

function buildFontFamily(latin: string | undefined, eastAsian: string | undefined): string | undefined {
  const names = [latin, eastAsian]
    .filter((name): name is string => Boolean(name))
    .map(name => name.replace(/['"\\<>;&]/g, '').trim())
    .filter(Boolean);
  if (!names.length) return undefined;
  return `${names.map(name => `'${name}'`).join(', ')}, ${CHART_FALLBACK_FONTS}`;
}

function readRunProps(props: (Element | undefined)[], colors: ColorContext, fonts: Set<string>): ChartTextStyle | undefined {
  let color: string | undefined;
  let sizePt: number | undefined;
  let bold: boolean | undefined;
  let italic: boolean | undefined;
  let latin: string | undefined;
  let eastAsian: string | undefined;

  for (const item of props) {
    if (!item) continue;
    const fill = resolveFillColor(fillIn(item), colors);
    if (fill.color) color = fill.color;
    const sz = num(item, 'sz');
    if (sz !== undefined && sz > 0) sizePt = sz / 100;
    const b = flag(item, 'b');
    if (b !== undefined) bold = b;
    const i = flag(item, 'i');
    if (i !== undefined) italic = i;
    const l = resolveTypeface(el(item, 'a:latin')?.getAttribute('typeface'), colors.theme);
    if (l) latin = l;
    const ea = resolveTypeface(el(item, 'a:ea')?.getAttribute('typeface'), colors.theme);
    if (ea) eastAsian = ea;
  }

  const fontFamily = buildFontFamily(latin, eastAsian);
  const fontName = latin ?? eastAsian;
  if (fontName) fonts.add(fontName);
  if (color === undefined && sizePt === undefined && bold === undefined && italic === undefined && !fontFamily) return undefined;
  return {
    ...(color ? { color } : {}),
    ...(sizePt !== undefined ? { sizePt } : {}),
    ...(bold !== undefined ? { bold } : {}),
    ...(italic !== undefined ? { italic } : {}),
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontName ? { fontName } : {}),
  };
}

function readTextProperties(container: Element | undefined, colors: ColorContext, fonts: Set<string>): {
  style?: ChartTextStyle;
  rotation?: number;
} {
  if (!container) return {};
  const bodyPr = el(container, 'a:bodyPr');
  const rotRaw = num(bodyPr, 'rot');
  // DrawingML `rot` is clockwise in 1/60000 deg; ECharts `rotate` is counter-clockwise in deg.
  const rotation = rotRaw !== undefined ? Math.max(-90, Math.min(90, -rotRaw / 60000)) : undefined;
  const paragraph = el(container, 'a:p');
  const firstRun = el(paragraph, 'a:r');
  const style = readRunProps(
    [el(paragraph, 'a:endParaRPr'), el(paragraph, 'a:pPr', 'a:defRPr'), el(firstRun, 'a:rPr')],
    colors,
    fonts,
  );
  return {
    ...(style ? { style } : {}),
    ...(rotation !== undefined && rotation !== 0 ? { rotation } : {}),
  };
}

function mergeTextStyles(base: ChartTextStyle | undefined, override: ChartTextStyle | undefined): ChartTextStyle | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

function readRichText(rich: Element | undefined): string | undefined {
  if (!rich) return undefined;
  const paragraphs = elements(rich, 'a:p').map(paragraph => {
    let text = '';
    for (const child of elements(paragraph)) {
      if (child.localName === 'br') text += '\n';
      else if (child.localName === 'r' || child.localName === 'fld') text += el(child, 'a:t')?.textContent ?? '';
    }
    return text;
  });
  const joined = paragraphs.join('\n').trim();
  return joined || undefined;
}

function readPoints(container: Element | undefined): { count: number; entries: [number, string][] } {
  if (!container) return { count: 0, entries: [] };
  const declared = chartNum(container, 'ptCount') ?? 0;
  const entries: [number, string][] = [];
  let maxIndex = -1;
  for (const pt of elements(container, 'c:pt')) {
    const idx = num(pt, 'idx');
    if (idx === undefined || !Number.isInteger(idx) || idx < 0) continue;
    if (idx > maxIndex) maxIndex = idx;
    entries.push([idx, el(pt, 'c:v')?.textContent ?? '']);
  }
  return { count: Math.max(declared, maxIndex + 1), entries };
}

function readNumericList(element: Element | undefined): { values: (number | null)[]; formatCode?: string } {
  if (!element) return { values: [] };
  const source = el(element, 'c:numRef', 'c:numCache') ?? el(element, 'c:numLit');
  if (!source) return { values: [] };
  const { count, entries } = readPoints(source);
  const values: (number | null)[] = Array.from({ length: count }, () => null);
  for (const [idx, raw] of entries) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    values[idx] = Number.isFinite(parsed) ? parsed : null;
  }
  const formatCode = el(source, 'c:formatCode')?.textContent ?? undefined;
  return { values, ...(formatCode ? { formatCode } : {}) };
}

function readStringCache(container: Element | undefined): string[] {
  const { count, entries } = readPoints(container);
  const out = Array.from({ length: count }, () => '');
  for (const [idx, text] of entries) out[idx] = text;
  return out;
}

function readSeriesName(tx: Element | undefined): string | undefined {
  if (!tx) return undefined;
  const strCache = el(tx, 'c:strRef', 'c:strCache');
  if (strCache) {
    const joined = readStringCache(strCache).filter(Boolean).join(' ').trim();
    return joined || undefined;
  }
  const direct = el(tx, 'c:v')?.textContent?.trim();
  return direct || undefined;
}

function readCategories(
  cat: Element | undefined,
  date1904: boolean,
  axisFormatCode?: string,
): ChartCategoryData | undefined {
  if (!cat) return undefined;
  const multi = el(cat, 'c:multiLvlStrRef', 'c:multiLvlStrCache');
  if (multi) {
    const declared = chartNum(multi, 'ptCount') ?? 0;
    const rawLevels = elements(multi, 'c:lvl').map(level => {
      const { count, entries } = readPoints(level);
      const size = Math.max(declared, count);
      const labels = Array.from({ length: size }, () => '');
      for (const [idx, text] of entries) labels[idx] = text;
      return labels;
    });
    if (!rawLevels.length) return undefined;
    return {
      labels: rawLevels[0],
      ...(rawLevels.length > 1 ? { levels: rawLevels.slice(1) } : {}),
    };
  }
  const strSource = el(cat, 'c:strRef', 'c:strCache') ?? el(cat, 'c:strLit');
  if (strSource) {
    return { labels: readStringCache(strSource) };
  }
  const numSource = el(cat, 'c:numRef', 'c:numCache') ?? el(cat, 'c:numLit');
  if (numSource) {
    const { values, formatCode } = readNumericList(cat);
    const effectiveFormat = axisFormatCode ?? formatCode;
    return {
      labels: values.map(value => (value === null ? '' : formatChartNumber(value, effectiveFormat, date1904))),
    };
  }
  return undefined;
}

function readTitle(titleEl: Element | undefined, colors: ColorContext, fonts: Set<string>): ChartTitleView | undefined {
  if (!titleEl) return undefined;
  const tx = el(titleEl, 'c:tx');
  if (!tx) return undefined;
  const overlay = chartFlag(titleEl, 'overlay');
  const rich = el(tx, 'c:rich');
  if (rich) {
    const text = readRichText(rich);
    if (!text) return undefined;
    const style = mergeTextStyles(
      readTextProperties(el(titleEl, 'c:txPr'), colors, fonts).style,
      readTextProperties(rich, colors, fonts).style,
    );
    return { text, ...(style ? { style } : {}), ...(overlay !== undefined ? { overlay } : {}) };
  }
  const strCache = el(tx, 'c:strRef', 'c:strCache');
  if (strCache) {
    const text = readStringCache(strCache).filter(Boolean).join(' ').trim();
    if (!text) return undefined;
    const style = readTextProperties(el(titleEl, 'c:txPr'), colors, fonts).style;
    return { text, ...(style ? { style } : {}), ...(overlay !== undefined ? { overlay } : {}) };
  }
  return undefined;
}

interface ParsedDataLabels {
  deleted?: boolean;
  labels: ChartDataLabels;
  points?: Record<number, ChartDataLabels | null>;
}

function readDataLabelNode(node: Element | undefined, colors: ColorContext, fonts: Set<string>): { deleted?: boolean; labels: ChartDataLabels } | undefined {
  if (!node) return undefined;
  const deleted = chartFlag(node, 'delete');
  const numFmt = el(node, 'c:numFmt');
  const formatCode = numFmt?.getAttribute('formatCode') ?? undefined;
  const sourceLinked = numFmt ? flag(numFmt, 'sourceLinked') : undefined;
  const style = readTextProperties(el(node, 'c:txPr'), colors, fonts).style;
  const position = chartVal(node, 'dLblPos');
  const separator = el(node, 'c:separator')?.textContent ?? undefined;
  const value = chartFlag(node, 'showVal');
  const percent = chartFlag(node, 'showPercent');
  const category = chartFlag(node, 'showCatName');
  const series = chartFlag(node, 'showSerName');
  const bubbleSize = chartFlag(node, 'showBubbleSize');
  return {
    ...(deleted !== undefined ? { deleted } : {}),
    labels: {
      ...(value !== undefined ? { value } : {}),
      ...(percent !== undefined ? { percent } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(series !== undefined ? { series } : {}),
      ...(bubbleSize !== undefined ? { bubbleSize } : {}),
      ...(position ? { position } : {}),
      ...(separator !== undefined ? { separator } : {}),
      ...(formatCode ? { formatCode } : {}),
      ...(sourceLinked !== undefined ? { sourceLinked } : {}),
      ...(style ? { style } : {}),
    },
  };
}

function mergeDataLabels(base: ChartDataLabels | undefined, override: ChartDataLabels | undefined): ChartDataLabels | undefined {
  if (!base && !override) return undefined;
  const merged: ChartDataLabels = {
    ...base,
    ...override,
    ...(base?.style || override?.style ? { style: mergeTextStyles(base?.style, override?.style) } : {}),
  };
  return merged;
}

function readDataLabels(container: Element | undefined, colors: ColorContext, fonts: Set<string>): ParsedDataLabels | undefined {
  const base = readDataLabelNode(container, colors, fonts);
  if (!container || !base) return undefined;
  const points: Record<number, ChartDataLabels | null> = {};
  for (const point of elements(container, 'c:dLbl')) {
    const idx = chartNum(point, 'idx');
    if (idx === undefined || !Number.isInteger(idx) || idx < 0) continue;
    const parsed = readDataLabelNode(point, colors, fonts);
    if (!parsed) continue;
    if (parsed.deleted) {
      points[idx] = null;
    } else {
      points[idx] = mergeDataLabels(base.labels, parsed.labels) ?? parsed.labels;
    }
  }
  return {
    deleted: base.deleted,
    labels: base.labels,
    ...(Object.keys(points).length ? { points } : {}),
  };
}

export function hasVisibleChartLabel(labels: ChartDataLabels | undefined | null): labels is ChartDataLabels {
  return Boolean(labels && (labels.value || labels.percent || labels.category || labels.series || labels.bubbleSize));
}

function readAxis(axis: Element | undefined, colors: ColorContext, fonts: Set<string>): ChartAxisView | undefined {
  if (!axis) return undefined;
  const scaling = el(axis, 'c:scaling');
  const posRaw = chartVal(axis, 'axPos');
  const tickPosRaw = chartVal(axis, 'tickLblPos');
  const tickMarkRaw = chartVal(axis, 'majorTickMark');
  const numFmt = el(axis, 'c:numFmt');
  const formatCode = numFmt?.getAttribute('formatCode') ?? undefined;
  const sourceLinked = numFmt ? flag(numFmt, 'sourceLinked') : undefined;
  const gridEl = el(axis, 'c:majorGridlines');
  const gridlineStyle = gridEl ? readChartLine(el(gridEl, 'c:spPr', 'a:ln'), colors) : undefined;
  const axisLine = readChartLine(el(axis, 'c:spPr', 'a:ln'), colors);
  const { style: labelStyle, rotation: labelRotate } = readTextProperties(el(axis, 'c:txPr'), colors, fonts);
  const title = readTitle(el(axis, 'c:title'), colors, fonts);
  const deleted = chartFlag(axis, 'delete');
  const reverse = chartVal(scaling, 'orientation') === 'maxMin';
  const min = chartNum(scaling, 'min');
  const max = chartNum(scaling, 'max');
  const logBase = chartNum(scaling, 'logBase');
  const majorUnit = chartNum(axis, 'majorUnit');
  const noMultiLevelLabels = chartFlag(axis, 'noMultiLvlLbl');

  return {
    ...(title ? { title } : {}),
    ...(deleted !== undefined ? { deleted } : {}),
    ...(posRaw && VALID_AXIS_POS.has(posRaw) ? { position: posRaw as ChartAxisView['position'] } : {}),
    ...(tickPosRaw && VALID_TICK_POS.has(tickPosRaw) ? { tickLabelPos: tickPosRaw as ChartAxisView['tickLabelPos'] } : {}),
    ...(tickMarkRaw && VALID_TICK_MARK.has(tickMarkRaw) ? { majorTickMark: tickMarkRaw as ChartAxisView['majorTickMark'] } : {}),
    ...(reverse ? { reverse: true } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(majorUnit !== undefined ? { majorUnit } : {}),
    ...(logBase !== undefined && logBase > 1 ? { logBase } : {}),
    ...(formatCode ? { formatCode } : {}),
    ...(sourceLinked !== undefined ? { sourceLinked } : {}),
    gridlines: Boolean(gridEl),
    ...(gridlineStyle ? { gridlineStyle } : {}),
    ...(axisLine ? { axisLine } : {}),
    ...(labelStyle ? { labelStyle } : {}),
    ...(labelRotate !== undefined ? { labelRotate } : {}),
    ...(noMultiLevelLabels !== undefined ? { noMultiLevelLabels } : {}),
  };
}

function readColorStylePalette(pkg: SlidesPackage, chartPart: string, colors: ColorContext): string[] | undefined {
  const relation = pkg.relationships(chartPart).find(item => !item.external && item.type === COLOR_STYLE_REL);
  if (!relation || !pkg.has(relation.target)) return undefined;
  try {
    const doc = pkg.xml(relation.target);
    const resolved: string[] = [];
    for (const child of elements(doc.documentElement)) {
      if (child.namespaceURI !== NS.a || !child.localName.endsWith('Clr')) continue;
      const color = cssColor(resolveColor(child, colors));
      if (color) resolved.push(color);
    }
    return resolved.length ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function chartPalette(pkg: SlidesPackage, chartPart: string, colors: ColorContext): string[] {
  const stylePalette = readColorStylePalette(pkg, chartPart, colors);
  if (stylePalette?.length) return stylePalette;
  const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];
  return accents.map((name, index) => {
    const hex = colors.theme.colors[colors.map[name] ?? name];
    return hex ? `#${hex}` : CHART_DEFAULT_PALETTE[index];
  });
}

function parseCssRgb(color: string | undefined): [number, number, number, number] | undefined {
  if (!color) return undefined;
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    return [
      Number.parseInt(hex[1].slice(0, 2), 16),
      Number.parseInt(hex[1].slice(2, 4), 16),
      Number.parseInt(hex[1].slice(4, 6), 16),
      1,
    ];
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i.exec(color.trim());
  if (rgba) {
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] !== undefined ? Number(rgba[4]) : 1];
  }
  return undefined;
}

function isDarkColor(color: string | undefined): boolean | undefined {
  const rgb = parseCssRgb(color);
  if (!rgb || rgb[3] < 0.5) return undefined;
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return luminance < 0.4;
}

function surfaceIsDark(
  plotBackground: string | undefined,
  chartBackground: string | undefined,
  slideBackground: Fill,
  colors: ColorContext,
): boolean {
  const fromPlot = isDarkColor(plotBackground);
  if (fromPlot !== undefined) return fromPlot;
  const fromChart = isDarkColor(chartBackground);
  if (fromChart !== undefined) return fromChart;
  if (slideBackground.kind === 'solid') {
    const fromSlide = isDarkColor(slideBackground.color);
    if (fromSlide !== undefined) return fromSlide;
  } else if (slideBackground.kind === 'gradient') {
    const first = /#[0-9a-f]{6}|rgba?\([^)]+\)/i.exec(slideBackground.css)?.[0];
    const fromGrad = isDarkColor(first);
    if (fromGrad !== undefined) return fromGrad;
  }
  const themeBg = colors.theme.colors[colors.map.bg1 ?? 'lt1'];
  return isDarkColor(themeBg ? `#${themeBg}` : undefined) ?? false;
}

function readSeries(
  element: Element,
  type: SlideChartPlotType,
  colors: ColorContext,
  fonts: Set<string>,
  date1904: boolean,
  plotLabels: ParsedDataLabels | undefined,
  catAxisFormat?: string,
): { order: number; series: ChartSeriesView } {
  const order = chartNum(element, 'order') ?? chartNum(element, 'idx') ?? 0;
  const shape = readShapeStyle(el(element, 'c:spPr'), colors);
  const markerEl = el(element, 'c:marker');
  const markerShape = readShapeStyle(el(markerEl, 'c:spPr'), colors);
  const seriesLabels = readDataLabels(el(element, 'c:dLbls'), colors, fonts);

  let effectiveLabels: ChartDataLabels | undefined;
  if (seriesLabels) {
    effectiveLabels = seriesLabels.deleted ? undefined : mergeDataLabels(plotLabels?.deleted ? undefined : plotLabels?.labels, seriesLabels.labels);
  } else if (plotLabels && !plotLabels.deleted) {
    effectiveLabels = plotLabels.labels;
  }

  let pointLabels: Record<number, ChartDataLabels | null> | undefined;
  const mergedPoints = { ...(plotLabels?.points ?? {}), ...(seriesLabels?.points ?? {}) };
  if (Object.keys(mergedPoints).length) {
    pointLabels = {};
    for (const [key, value] of Object.entries(mergedPoints)) {
      const idx = Number(key);
      pointLabels[idx] = value === null ? null : mergeDataLabels(effectiveLabels, value) ?? value;
    }
  }

  const pointColors: Record<number, string> = {};
  for (const point of elements(element, 'c:dPt')) {
    const idx = chartNum(point, 'idx');
    const color = readShapeStyle(el(point, 'c:spPr'), colors).fill;
    if (idx !== undefined && Number.isInteger(idx) && color) pointColors[idx] = color;
  }

  const scatter = type === SlideChartPlotType.Scatter || type === SlideChartPlotType.Bubble;
  const valData = readNumericList(el(element, scatter ? 'c:yVal' : 'c:val'));
  const xData = scatter ? readNumericList(el(element, 'c:xVal')) : undefined;
  const sizeData = type === SlideChartPlotType.Bubble ? readNumericList(el(element, 'c:bubbleSize')) : undefined;
  const categories = scatter ? undefined : readCategories(el(element, 'c:cat'), date1904, catAxisFormat);
  const name = readSeriesName(el(element, 'c:tx'));
  const smooth = chartFlag(element, 'smooth');

  return {
    order,
    series: {
      ...(name ? { name } : {}),
      ...(categories ? { categories } : {}),
      values: valData.values,
      ...(valData.formatCode ? { valueFormatCode: valData.formatCode } : {}),
      ...(xData ? { x: xData.values, ...(xData.formatCode ? { xFormatCode: xData.formatCode } : {}) } : {}),
      ...(sizeData ? { sizes: sizeData.values } : {}),
      ...(shape.fill ? { color: shape.fill } : {}),
      ...(shape.noFill ? { noFill: true } : {}),
      ...(shape.line ? { line: shape.line } : {}),
      ...(markerEl ? {
        marker: {
          symbol: chartVal(markerEl, 'symbol') ?? 'auto',
          size: chartNum(markerEl, 'size'),
          ...(markerShape.fill ? { color: markerShape.fill } : {}),
          ...(markerShape.line?.color ? { borderColor: markerShape.line.color } : {}),
        },
      } : {}),
      ...(smooth !== undefined ? { smooth } : {}),
      ...(effectiveLabels ? { labels: effectiveLabels } : {}),
      ...(pointLabels ? { pointLabels } : {}),
      ...(Object.keys(pointColors).length ? { pointColors } : {}),
    },
  };
}

function unwrapChartChildren(parent: Element): Element[] {
  const out: Element[] = [];
  for (const child of elements(parent)) {
    if (child.localName === 'AlternateContent') {
      const inner = elements(named(child, 'Fallback') ?? named(child, 'Choice'));
      out.push(...inner);
    } else {
      out.push(child);
    }
  }
  return out;
}

/**
 * Parse a PowerPoint chart part into a drawable `SlideChartView`.
 * Returns `undefined` when the part is missing, malformed, empty, or uses an unsupported plot type
 * (stock/surface), so the caller falls back to the chart placeholder box.
 */
export function readSlideChart(
  pkg: SlidesPackage,
  chartPart: string,
  colors: ColorContext,
  slideBackground: Fill,
): SlideChartView | undefined {
  if (!pkg.has(chartPart)) return undefined;
  let doc: Document;
  try {
    doc = pkg.xml(chartPart);
  } catch {
    return undefined;
  }
  const space = doc.documentElement;
  if (!space || space.localName !== 'chartSpace') return undefined;
  const chart = el(space, 'c:chart');
  const plotArea = el(chart, 'c:plotArea');
  if (!chart || !plotArea) return undefined;

  const chartColors: ColorContext = {
    theme: colors.theme,
    map: readColorMap(el(space, 'c:clrMapOvr'), colors.map),
  };
  const fonts = new Set<string>();
  const date1904 = chartFlag(space, 'date1904') === true;
  const chartTextStyle = readTextProperties(el(space, 'c:txPr'), chartColors, fonts).style;
  const spaceStyle = readShapeStyle(el(space, 'c:spPr'), chartColors);
  const plotStyle = readShapeStyle(el(plotArea, 'c:spPr'), chartColors);

  const plotChildren = unwrapChartChildren(plotArea);
  const axes = new Map<string, Element>();
  for (const child of plotChildren) {
    if (child.namespaceURI !== NS.c) continue;
    if (['catAx', 'valAx', 'dateAx', 'serAx'].includes(child.localName)) {
      const id = chartVal(child, 'axId');
      if (id) axes.set(id, child);
    }
  }

  // Category axis format code (only when not sourceLinked) so numeric/date category caches format nicely.
  const catAxisElRaw = [...axes.values()].find(axis => axis.localName === 'catAx' || axis.localName === 'dateAx');
  const catAxisNumFmt = el(catAxisElRaw, 'c:numFmt');
  const catAxisFormat = catAxisNumFmt && flag(catAxisNumFmt, 'sourceLinked') === false
    ? (catAxisNumFmt.getAttribute('formatCode') ?? undefined)
    : undefined;

  const plots: ChartPlotView[] = [];
  let primaryValueAxisId: string | undefined;
  let primaryAxisIds: string[] = [];

  for (const child of plotChildren) {
    if (child.namespaceURI !== NS.c) continue;
    if (UNSUPPORTED_PLOTS.has(child.localName)) return undefined;
    const type = PLOT_TYPES[child.localName];
    if (!type) continue;

    const axisIds = elements(child, 'c:axId').map(item => item.getAttribute('val') ?? '').filter(Boolean);
    const valueAxisId = axisIds.find(id => axes.get(id)?.localName === 'valAx') ?? axisIds[1];
    if (primaryValueAxisId === undefined) {
      primaryValueAxisId = valueAxisId;
      primaryAxisIds = axisIds;
    }

    const groupingRaw = chartVal(child, 'grouping');
    const grouping = groupingRaw && VALID_GROUPINGS.has(groupingRaw) ? groupingRaw as SlideChartGrouping : undefined;
    const holeSize = chartNum(child, 'holeSize');
    const firstSliceAngle = chartNum(child, 'firstSliceAng');
    const varyColors = chartFlag(child, 'varyColors');
    const scatterStyle = chartVal(child, 'scatterStyle');
    const radarStyle = chartVal(child, 'radarStyle');
    const gapWidth = chartNum(child, 'gapWidth');
    const overlap = chartNum(child, 'overlap');
    const showMarkers = chartFlag(child, 'marker');
    const plotLabels = readDataLabels(el(child, 'c:dLbls'), chartColors, fonts);

    const series = elements(child, 'c:ser')
      .map(ser => readSeries(ser, type, chartColors, fonts, date1904, plotLabels, catAxisFormat))
      .sort((a, b) => a.order - b.order)
      .map(entry => entry.series);

    plots.push({
      type,
      ...(type === SlideChartPlotType.Bar ? { horizontal: chartVal(child, 'barDir') === 'bar' } : {}),
      ...(grouping ? { grouping } : {}),
      ...(type === SlideChartPlotType.Doughnut ? { holeSize: holeSize ?? 50 } : {}),
      ...(firstSliceAngle !== undefined ? { firstSliceAngle } : {}),
      ...(varyColors !== undefined ? { varyColors } : {}),
      ...(valueAxisId && primaryValueAxisId && valueAxisId !== primaryValueAxisId && axes.has(valueAxisId) ? { secondary: true } : {}),
      ...(scatterStyle ? { scatterStyle } : {}),
      ...(radarStyle ? { radarStyle } : {}),
      ...(gapWidth !== undefined ? { gapWidth } : {}),
      ...(overlap !== undefined ? { overlap } : {}),
      ...(showMarkers !== undefined ? { showMarkers } : {}),
      series,
    });
  }

  if (!plots.length || !plots.some(plot => plot.series.length > 0)) return undefined;

  const isXY = plots[0].type === SlideChartPlotType.Scatter || plots[0].type === SlideChartPlotType.Bubble;
  const categoryAxisEl = isXY ? axes.get(primaryAxisIds[0]) : catAxisElRaw;
  const valAxisEntries = [...axes.entries()].filter(([, axis]) => axis.localName === 'valAx');
  const primaryValEl = isXY
    ? axes.get(primaryAxisIds[1])
    : (valAxisEntries.find(([id]) => id === primaryValueAxisId)?.[1] ?? valAxisEntries[0]?.[1]);
  const secondaryValEl = plots.some(plot => plot.secondary)
    ? valAxisEntries.find(([id]) => id !== primaryValueAxisId)?.[1]
    : undefined;

  const legendEl = el(chart, 'c:legend');
  const legendStyle = legendEl ? readTextProperties(el(legendEl, 'c:txPr'), chartColors, fonts).style : undefined;
  const legend = legendEl ? {
    position: chartVal(legendEl, 'legendPos') ?? 'r',
    ...(chartFlag(legendEl, 'overlay') !== undefined ? { overlay: chartFlag(legendEl, 'overlay') } : {}),
    ...(legendStyle ? { style: legendStyle } : {}),
  } : undefined;

  const titleEl = el(chart, 'c:title');
  const explicitTitle = readTitle(titleEl, chartColors, fonts);
  const autoTitleDeleted = chartFlag(chart, 'autoTitleDeleted') === true;
  const onlySeriesName = plots.length === 1 && plots[0].series.length === 1 ? plots[0].series[0].name : undefined;
  const title = explicitTitle ?? (!autoTitleDeleted && onlySeriesName ? { text: onlySeriesName } : undefined);

  const dispBlanksRaw = chartVal(chart, 'dispBlanksAs');
  const dispBlanksAs = dispBlanksRaw === 'zero' || dispBlanksRaw === 'span' || dispBlanksRaw === 'gap' ? dispBlanksRaw : undefined;

  return {
    ...(title ? { title } : {}),
    palette: chartPalette(pkg, chartPart, chartColors),
    plots,
    ...(legend ? { legend } : {}),
    ...(categoryAxisEl ? { categoryAxis: readAxis(categoryAxisEl, chartColors, fonts) } : {}),
    ...(primaryValEl ? { valueAxis: readAxis(primaryValEl, chartColors, fonts) } : {}),
    ...(secondaryValEl ? { secondaryValueAxis: readAxis(secondaryValEl, chartColors, fonts) } : {}),
    ...(spaceStyle.fill ? { background: spaceStyle.fill } : {}),
    ...(spaceStyle.line ? { border: spaceStyle.line } : {}),
    ...(plotStyle.fill ? { plotBackground: plotStyle.fill } : {}),
    ...(plotStyle.line ? { plotBorder: plotStyle.line } : {}),
    ...(chartTextStyle ? { textStyle: chartTextStyle } : {}),
    darkSurface: surfaceIsDark(plotStyle.fill, spaceStyle.fill, slideBackground, chartColors),
    ...(date1904 ? { date1904: true } : {}),
    ...(dispBlanksAs ? { dispBlanksAs } : {}),
    fonts: [...fonts],
  };
}

// ---- Number formatting --------------------------------------------------------------------------

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function excelSerialToDate(serial: number, date1904: boolean): Date {
  // 1900 system has the Lotus 1-2-3 leap-year bug (1900-02-29 = serial 60), so epoch is 1899-12-30.
  const baseMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const adjusted = !date1904 && serial < 60 ? serial + 1 : serial;
  return new Date(baseMs + Math.round(adjusted * 86400) * 1000);
}

function isDateFormat(section: string): boolean {
  const stripped = section.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped) && !/[0#?]/.test(stripped);
}

function formatDateSection(serial: number, section: string, date1904: boolean): string {
  const date = excelSerialToDate(serial, date1904);
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  const cleaned = section.replace(/\[[^\]]*\]/g, '');
  let out = '';
  let lastToken = '';
  for (let i = 0; i < cleaned.length; ) {
    const ch = cleaned[i];
    if (ch === '"') {
      const end = cleaned.indexOf('"', i + 1);
      if (end < 0) { out += cleaned.slice(i + 1); break; }
      out += cleaned.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < cleaned.length) {
      out += cleaned[i + 1];
      i += 2;
      continue;
    }
    const rest = cleaned.slice(i);
    const token = /^(yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss|s)/i.exec(rest);
    if (token) {
      const raw = token[1].toLowerCase();
      const after = cleaned.slice(i + token[1].length);
      const isMinute = (raw === 'mm' || raw === 'm') && (lastToken === 'h' || /^:?s/i.test(after));
      if (raw === 'yyyy') { out += String(y); lastToken = 'y'; }
      else if (raw === 'yy') { out += String(y % 100).padStart(2, '0'); lastToken = 'y'; }
      else if (raw === 'mmmm') { out += MONTHS_FULL[m - 1]; lastToken = 'M'; }
      else if (raw === 'mmm') { out += MONTHS_SHORT[m - 1]; lastToken = 'M'; }
      else if (isMinute) { out += raw === 'mm' ? String(mm).padStart(2, '0') : String(mm); lastToken = 'm'; }
      else if (raw === 'mm') { out += String(m).padStart(2, '0'); lastToken = 'M'; }
      else if (raw === 'm') { out += String(m); lastToken = 'M'; }
      else if (raw === 'dd') { out += String(d).padStart(2, '0'); lastToken = 'd'; }
      else if (raw === 'd') { out += String(d); lastToken = 'd'; }
      else if (raw === 'hh') { out += String(hh).padStart(2, '0'); lastToken = 'h'; }
      else if (raw === 'h') { out += String(hh); lastToken = 'h'; }
      else if (raw === 'ss') { out += String(ss).padStart(2, '0'); lastToken = 's'; }
      else { out += String(ss); lastToken = 's'; }
      i += token[1].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function splitFormatSections(formatCode: string): string[] {
  const sections: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < formatCode.length; i++) {
    const ch = formatCode[i];
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === '\\' && i + 1 < formatCode.length) { current += ch + formatCode[++i]; }
    else if (ch === ';' && !inQuotes) { sections.push(current); current = ''; }
    else current += ch;
  }
  sections.push(current);
  return sections;
}

function addGrouping(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function extractLiterals(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      const end = raw.indexOf('"', i + 1);
      if (end < 0) break;
      out += raw.slice(i + 1, end);
      i = end;
    } else if (ch === '\\' && i + 1 < raw.length) {
      out += raw[++i];
    } else if (ch === '_' && i + 1 < raw.length) {
      i++; // Excel spacing character: skip next char
    } else if (ch === '*' && i + 1 < raw.length) {
      i++; // Excel fill character: skip next char
    } else if (ch === '[') {
      const end = raw.indexOf(']', i + 1);
      if (end < 0) break;
      const bracket = raw.slice(i + 1, end);
      // Currency token like [$¥-804] or [$€-2]: keep the currency symbol before '-'.
      if (bracket.startsWith('$')) out += bracket.slice(1).split('-')[0];
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Format a numeric chart value using a common OOXML / Excel number format code. */
export function formatChartNumber(value: number, formatCode?: string, date1904 = false): string {
  if (!Number.isFinite(value)) return '';
  if (!formatCode || formatCode === 'General' || formatCode === '@') {
    const rounded = Math.round(value * 1e10) / 1e10;
    return Object.is(rounded, -0) ? '0' : String(rounded);
  }
  const sections = splitFormatSections(formatCode);
  let section = sections[0];
  let implicitNegative = false;
  if (value < 0 && sections.length >= 2 && sections[1]) {
    section = sections[1];
  } else if (value === 0 && sections.length >= 3 && sections[2]) {
    section = sections[2];
  } else if (value < 0) {
    implicitNegative = true;
  }

  if (isDateFormat(section)) return formatDateSection(value, section, date1904);

  // Locate the numeric placeholder core (digits, commas, decimal point, percent) outside quotes/brackets.
  let firstNum = -1;
  let lastNum = -1;
  let inQuotes = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\\' || ch === '_' || ch === '*') { i++; continue; }
    if (ch === '[') {
      const end = section.indexOf(']', i + 1);
      if (end >= 0) i = end;
      continue;
    }
    if ('0#?.,'.includes(ch)) {
      if (firstNum < 0) firstNum = i;
      lastNum = i;
    }
  }
  if (firstNum < 0) return extractLiterals(section);

  const prefix = extractLiterals(section.slice(0, firstNum));
  const core = section.slice(firstNum, lastNum + 1);
  const suffixRaw = section.slice(lastNum + 1);
  const suffix = extractLiterals(suffixRaw);

  // Count unquoted '%' anywhere in section.
  const withoutQuoted = section.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '');
  const percentCount = (withoutQuoted.match(/%/g) ?? []).length;

  // Trailing commas at the end of the numeric core scale by 1000 each (e.g. `#,##0,` or `0.0,,`).
  const trailingCommas = /,+$/.exec(core)?.[0].length ?? 0;
  const trimmedCore = core.slice(0, core.length - trailingCommas);
  const [intTemplate, fracRaw = ''] = trimmedCore.split('.');
  const useGrouping = intTemplate.includes(',');

  let scaled = Math.abs(value);
  if (percentCount > 0) scaled *= 100 ** percentCount;
  if (trailingCommas > 0) scaled /= 1000 ** trailingCommas;

  const minDecimals = (fracRaw.match(/0/g) ?? []).length;
  const maxDecimals = (fracRaw.match(/[0#?]/g) ?? []).length;
  const minIntDigits = (intTemplate.match(/0/g) ?? []).length;

  const fixed = scaled.toFixed(maxDecimals);
  const [rawInt, rawFrac = ''] = fixed.split('.');
  let intStr = rawInt === '0' && minIntDigits === 0 && maxDecimals > 0 ? '' : rawInt.padStart(minIntDigits, '0');
  if (useGrouping && intStr.length > 3) intStr = addGrouping(intStr);

  let fracStr = rawFrac;
  while (fracStr.length > minDecimals && fracStr.endsWith('0')) fracStr = fracStr.slice(0, -1);
  const numberText = fracStr ? `${intStr}.${fracStr}` : intStr;
  const sign = implicitNegative && scaled !== 0 ? '-' : '';
  return `${sign}${prefix}${numberText}${suffix}`;
}
