import type { XlsxStyles } from './xlsxStyles';
import { decodeXml, firstXmlElement, xmlAttribute, type XmlElement, xmlElements } from './xlsxXml';

/**
 * Excel chart parts (DrawingML charts) read into a plain, serializable description the editor
 * renders itself. Series keep their cell references, so the chart follows the cells it plots.
 */

export const ChartPlotType = {
  Bar: 'bar', Line: 'line', Area: 'area', Pie: 'pie', Doughnut: 'doughnut', Scatter: 'scatter', Radar: 'radar', Bubble: 'bubble',
} as const;
export type ChartPlotType = typeof ChartPlotType[keyof typeof ChartPlotType];

export interface ChartDataRef {
  /** Sheet-qualified reference (`Sheet1!$B$2:$B$9`), as written in the chart part. */
  ref?: string;
  /** The values Excel cached with the chart, used when the reference cannot be read. */
  cache: (string | number | null)[];
  formatCode?: string;
  /**
   * Set for multi-level categories (Excel's `multiLvlStrRef`, several columns of labels): the outer
   * levels' cached labels, next to the axis first, each only where a group starts. `cache` holds
   * the level nearest the axis.
   */
  levels?: (string | null)[][];
}

export interface ChartSeries {
  name?: ChartDataRef;
  categories?: ChartDataRef;
  values: ChartDataRef;
  /** Scatter and bubble charts plot x values instead of categories. */
  x?: ChartDataRef;
  sizes?: ChartDataRef;
  color?: string;
  lineColor?: string;
  lineWidth?: number;
  noLine?: boolean;
  noFill?: boolean;
  marker?: { symbol: string; size?: number; color?: string };
  smooth?: boolean;
  labels?: { value?: boolean; percent?: boolean; category?: boolean; series?: boolean; position?: string };
  pointColors?: Record<number, string>;
}

export interface ChartPlot {
  type: ChartPlotType;
  horizontal?: boolean;
  grouping?: 'clustered' | 'stacked' | 'percentStacked' | 'standard';
  holeSize?: number;
  firstSliceAngle?: number;
  varyColors?: boolean;
  secondary?: boolean;
  scatterStyle?: string;
  radarStyle?: string;
  gapWidth?: number;
  overlap?: number;
  series: ChartSeries[];
}

export interface ChartAxis {
  title?: string;
  deleted?: boolean;
  reverse?: boolean;
  min?: number;
  max?: number;
  majorUnit?: number;
  formatCode?: string;
  gridlines?: boolean;
}

export interface ChartSpec {
  title?: { text?: string; ref?: string };
  /** The workbook theme's accent colors, the default series colors. */
  palette?: string[];
  plots: ChartPlot[];
  legend?: { position: string };
  categoryAxis?: ChartAxis;
  valueAxis?: ChartAxis;
  secondaryValueAxis?: ChartAxis;
  background?: string;
  plotBackground?: string;
  /** Set when the chart cannot be drawn here (Excel 2016 chart types, 3-D surfaces …). */
  unsupported?: string;
}

const PLOT_TYPES: Record<string, ChartPlotType> = {
  barChart: ChartPlotType.Bar, bar3DChart: ChartPlotType.Bar, lineChart: ChartPlotType.Line, line3DChart: ChartPlotType.Line,
  areaChart: ChartPlotType.Area, area3DChart: ChartPlotType.Area, pieChart: ChartPlotType.Pie, pie3DChart: ChartPlotType.Pie,
  ofPieChart: ChartPlotType.Pie, doughnutChart: ChartPlotType.Doughnut, scatterChart: ChartPlotType.Scatter,
  radarChart: ChartPlotType.Radar, bubbleChart: ChartPlotType.Bubble,
};
const UNSUPPORTED_PLOTS = ['stockChart', 'surfaceChart', 'surface3DChart'];

const TAG = /<(\/?)(?:[\w.-]+:)?([\w.-]+)(?:[^"'>]|"[^"]*"|'[^']*')*?(\/?)>/g;

/** The first element named `local` directly inside `element`; chart parts reuse names at every depth. */
function child(element: XmlElement | undefined, local: string): XmlElement | undefined {
  const inner = element?.inner;
  if (inner === undefined) return undefined;
  const tag = new RegExp(TAG.source, 'g');
  let depth = 0;
  for (let match = tag.exec(inner); match; match = tag.exec(inner)) {
    const [, closing, name, selfClosing] = match;
    if (closing) {
      depth--;
      continue;
    }
    if (depth === 0 && name === local) return firstXmlElement(inner, local, match.index);
    if (!selfClosing) depth++;
  }
  return undefined;
}
const value = (element: XmlElement | undefined, local: string): string | undefined => {
  const found = child(element, local);
  return found ? xmlAttribute(found.open, 'val') : undefined;
};
const flag = (element: XmlElement | undefined, local: string, fallback = false): boolean => {
  const raw = value(element, local);
  return raw === undefined ? (child(element, local) ? true : fallback) : raw === '1' || raw === 'true';
};

function applyTransforms(hex: string, element: XmlElement): string {
  const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const amount = (local: string) => {
    const found = element.inner !== undefined ? firstXmlElement(element.inner, local) : undefined;
    return found ? Number(xmlAttribute(found.open, 'val') ?? 100000) / 100000 : undefined;
  };
  const lumMod = amount('lumMod');
  const lumOff = amount('lumOff');
  const tint = amount('tint');
  const shade = amount('shade');
  if (lumMod !== undefined) l *= lumMod;
  if (lumOff !== undefined) l += lumOff;
  if (tint !== undefined) l = l * tint + (1 - tint);
  if (shade !== undefined) l *= shade;
  l = Math.min(1, Math.max(0, l));
  const hue = (p: number, q: number, t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let rgb: number[];
  if (s === 0) rgb = [l, l, l];
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** The color of a DrawingML fill or line (`solidFill`, `srgbClr`, `schemeClr` …), as #RRGGBB. */
export function drawingColor(element: XmlElement | undefined, styles: XlsxStyles): string | undefined {
  if (element?.inner === undefined) return undefined;
  for (const local of ['srgbClr', 'schemeClr', 'sysClr', 'prstClr']) {
    const color = firstXmlElement(element.inner, local);
    if (!color) continue;
    const raw = local === 'srgbClr' ? xmlAttribute(color.open, 'val')
      : local === 'schemeClr' ? styles.themeColor(xmlAttribute(color.open, 'val') ?? '')
        : local === 'sysClr' ? xmlAttribute(color.open, 'lastClr') ?? (xmlAttribute(color.open, 'val') === 'window' ? 'FFFFFF' : '000000')
          : ({ black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00FF00', blue: '0000FF', yellow: 'FFFF00' } as Record<string, string>)[xmlAttribute(color.open, 'val') ?? ''];
    if (!raw || !/^[\da-f]{6}$/i.test(raw)) return undefined;
    return `#${applyTransforms(raw, color)}`;
  }
  return undefined;
}

function shapeColors(shape: XmlElement | undefined, styles: XlsxStyles): { fill?: string; noFill?: boolean; line?: string; noLine?: boolean; lineWidth?: number } {
  if (!shape) return {};
  const fill = child(shape, 'solidFill') ?? child(shape, 'gradFill');
  const line = child(shape, 'ln');
  const lineFill = child(line, 'solidFill');
  const width = line ? Number(xmlAttribute(line.open, 'w')) : Number.NaN;
  return {
    fill: fill ? drawingColor(fill, styles) : undefined,
    noFill: Boolean(child(shape, 'noFill')),
    line: lineFill ? drawingColor(lineFill, styles) : undefined,
    noLine: Boolean(child(line, 'noFill')),
    lineWidth: Number.isFinite(width) ? width / 12700 : undefined,
  };
}

function cacheOf(reference: XmlElement | undefined): { cache: (string | number | null)[]; formatCode?: string } {
  const cache = child(reference, 'numCache') ?? child(reference, 'strCache');
  if (!cache?.inner) return { cache: [] };
  const count = Number(value(cache, 'ptCount') ?? 0);
  const numeric = cache.name.endsWith('numCache');
  const values: (string | number | null)[] = Array.from({ length: Number.isFinite(count) ? count : 0 }, () => null);
  for (const point of xmlElements(cache.inner, 'pt')) {
    const index = Number(xmlAttribute(point.open, 'idx'));
    const text = decodeXml(child(point, 'v')?.inner ?? '');
    if (!Number.isInteger(index)) continue;
    values[index] = numeric ? (Number.isFinite(Number(text)) ? Number(text) : null) : text;
  }
  const format = child(cache, 'formatCode');
  return { cache: values, ...(format?.inner ? { formatCode: decodeXml(format.inner) } : {}) };
}

/** The cached labels of multi-level categories: `c:lvl` elements, the level nearest the axis first. */
function levelsOf(reference: XmlElement): { cache: (string | null)[]; levels: (string | null)[][] } {
  const cache = child(reference, 'multiLvlStrCache');
  if (!cache?.inner) return { cache: [], levels: [] };
  const count = Number(value(cache, 'ptCount') ?? 0);
  const levels = [...xmlElements(cache.inner, 'lvl')].map(level => {
    const labels: (string | null)[] = Array.from({ length: Number.isFinite(count) ? count : 0 }, () => null);
    for (const point of xmlElements(level.inner ?? '', 'pt')) {
      const index = Number(xmlAttribute(point.open, 'idx'));
      if (Number.isInteger(index) && index >= 0 && index < labels.length) labels[index] = decodeXml(child(point, 'v')?.inner ?? '');
    }
    return labels;
  });
  return { cache: levels[0] ?? [], levels: levels.slice(1) };
}

/**
 * Categories whose reference spans several columns and rows are multi-level however the part
 * writes them (other tools use `numRef` or `strRef`), as Excel reads them.
 */
function multiLevelBlock(source: ChartDataRef | undefined): ChartDataRef | undefined {
  if (!source?.ref || source.levels) return source;
  const area = /!\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(source.ref.trim());
  return area && area[1].toUpperCase() !== area[3].toUpperCase() && area[2] !== area[4] ? { ...source, levels: [] } : source;
}

/** A series source: `c:tx`, `c:cat`, `c:val`, `c:xVal`, `c:yVal` or `c:bubbleSize`. */
function dataRef(element: XmlElement | undefined): ChartDataRef | undefined {
  if (!element?.inner) return undefined;
  const multiLevel = child(element, 'multiLvlStrRef');
  if (multiLevel) {
    const formula = child(multiLevel, 'f');
    return { ...(formula?.inner ? { ref: decodeXml(formula.inner) } : {}), ...levelsOf(multiLevel) };
  }
  const reference = child(element, 'numRef') ?? child(element, 'strRef');
  if (reference) {
    const formula = child(reference, 'f');
    return { ...(formula?.inner ? { ref: decodeXml(formula.inner) } : {}), ...cacheOf(reference) };
  }
  const literal = child(element, 'numLit') ?? child(element, 'strLit');
  if (literal) {
    const { cache, formatCode } = cacheOf({ ...literal, name: literal.name.endsWith('numLit') ? 'numCache' : 'strCache' } as XmlElement);
    return { cache, ...(formatCode ? { formatCode } : {}) };
  }
  const text = child(element, 'v');
  return text?.inner !== undefined ? { cache: [decodeXml(text.inner)] } : undefined;
}

function richText(element: XmlElement | undefined): string | undefined {
  if (!element?.inner) return undefined;
  const parts = [...xmlElements(element.inner, 't')].map(item => decodeXml(item.inner ?? ''));
  return parts.length ? parts.join('') : undefined;
}

function titleOf(element: XmlElement | undefined): { text?: string; ref?: string } | undefined {
  if (!element) return undefined;
  const text = child(element, 'tx');
  // A title without text of its own is Excel's automatic title.
  if (!text) return undefined;
  const reference = child(text, 'strRef');
  if (reference) return { ref: decodeXml(child(reference, 'f')?.inner ?? ''), text: String(cacheOf(reference).cache[0] ?? '') };
  const rich = richText(child(text, 'rich'));
  return { text: rich ?? '' };
}

function axisOf(axis: XmlElement | undefined): ChartAxis | undefined {
  if (!axis) return undefined;
  const scaling = child(axis, 'scaling');
  const number = (local: string) => {
    const raw = value(scaling, local);
    return raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };
  const format = child(axis, 'numFmt');
  const unit = value(axis, 'majorUnit');
  return {
    title: titleOf(child(axis, 'title'))?.text,
    deleted: flag(axis, 'delete'),
    reverse: value(scaling, 'orientation') === 'maxMin',
    min: number('min'),
    max: number('max'),
    ...(unit !== undefined && Number.isFinite(Number(unit)) ? { majorUnit: Number(unit) } : {}),
    ...(format && xmlAttribute(format.open, 'sourceLinked') !== '1' ? { formatCode: xmlAttribute(format.open, 'formatCode') } : {}),
    gridlines: Boolean(child(axis, 'majorGridlines')),
  };
}

function seriesOf(element: XmlElement, type: ChartPlotType, styles: XlsxStyles): ChartSeries {
  const shape = shapeColors(child(element, 'spPr'), styles);
  const markerElement = child(element, 'marker');
  const markerShape = shapeColors(child(markerElement, 'spPr'), styles);
  const labels = child(element, 'dLbls');
  const pointColors: Record<number, string> = {};
  for (const point of element.inner ? xmlElements(element.inner, 'dPt') : []) {
    const index = Number(value(point, 'idx'));
    const color = shapeColors(child(point, 'spPr'), styles).fill;
    if (Number.isInteger(index) && color) pointColors[index] = color;
  }
  const scatter = type === ChartPlotType.Scatter || type === ChartPlotType.Bubble;
  const values = dataRef(child(element, scatter ? 'yVal' : 'val')) ?? { cache: [] };
  return {
    name: dataRef(child(element, 'tx')),
    ...(scatter ? { x: dataRef(child(element, 'xVal')) } : { categories: multiLevelBlock(dataRef(child(element, 'cat'))) }),
    values,
    ...(type === ChartPlotType.Bubble ? { sizes: dataRef(child(element, 'bubbleSize')) } : {}),
    ...(shape.fill ? { color: shape.fill } : {}),
    ...(shape.noFill ? { noFill: true } : {}),
    ...(shape.line ? { lineColor: shape.line } : {}),
    ...(shape.noLine ? { noLine: true } : {}),
    ...(shape.lineWidth ? { lineWidth: shape.lineWidth } : {}),
    ...(markerElement ? { marker: { symbol: value(markerElement, 'symbol') ?? 'auto', size: Number(value(markerElement, 'size') ?? 5), ...(markerShape.fill ? { color: markerShape.fill } : {}) } } : {}),
    ...(flag(element, 'smooth') ? { smooth: true } : {}),
    ...(labels && !flag(labels, 'delete') ? {
      labels: {
        value: flag(labels, 'showVal'), percent: flag(labels, 'showPercent'), category: flag(labels, 'showCatName'), series: flag(labels, 'showSerName'),
        ...(value(labels, 'dLblPos') ? { position: value(labels, 'dLblPos') } : {}),
      },
    } : {}),
    ...(Object.keys(pointColors).length ? { pointColors } : {}),
  };
}

/** Parse a chart part. Charts that cannot be drawn come back marked `unsupported`. */
/** The workbook theme's accent colors: Excel's default series colors. */
export function chartPalette(styles: XlsxStyles): string[] {
  return ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map(name => `#${styles.themeColor(name) ?? '4472C4'}`);
}

export function parseChart(xml: string, styles: XlsxStyles): ChartSpec {
  const chart = firstXmlElement(xml, 'chart');
  const plotArea = child(chart, 'plotArea');
  if (!chart || !plotArea?.inner) return { plots: [], unsupported: 'empty' };
  const axes = new Map<string, XmlElement>();
  for (const local of ['catAx', 'valAx', 'dateAx', 'serAx']) {
    for (const axis of xmlElements(plotArea.inner, local)) {
      const id = value(axis, 'axId');
      if (id) axes.set(id, axis);
    }
  }
  const plots: ChartPlot[] = [];
  let unsupported: string | undefined;
  let primaryValueAxis: string | undefined;
  let primaryAxes: string[] = [];
  for (const [local, type] of Object.entries(PLOT_TYPES)) {
    for (const plot of xmlElements(plotArea.inner, local)) {
      const axisIds = plot.inner ? [...xmlElements(plot.inner, 'axId')].map(axis => xmlAttribute(axis.open, 'val') ?? '') : [];
      const valueAxisId = axisIds.find(id => axes.get(id)?.name.endsWith('valAx') && !axes.get(id)?.name.endsWith('catAx')) ?? axisIds[1];
      if (primaryValueAxis === undefined) {
        primaryValueAxis = valueAxisId;
        primaryAxes = axisIds;
      }
      const grouping = value(plot, 'grouping') as ChartPlot['grouping'];
      const hole = Number(value(plot, 'holeSize'));
      plots.push({
        type,
        ...(type === ChartPlotType.Bar ? { horizontal: value(plot, 'barDir') === 'bar' } : {}),
        ...(grouping ? { grouping } : {}),
        ...(type === ChartPlotType.Doughnut ? { holeSize: Number.isFinite(hole) ? hole : 50 } : {}),
        ...(value(plot, 'firstSliceAng') ? { firstSliceAngle: Number(value(plot, 'firstSliceAng')) } : {}),
        ...(flag(plot, 'varyColors') ? { varyColors: true } : {}),
        ...(valueAxisId && primaryValueAxis && valueAxisId !== primaryValueAxis ? { secondary: true } : {}),
        ...(value(plot, 'scatterStyle') ? { scatterStyle: value(plot, 'scatterStyle') } : {}),
        ...(value(plot, 'radarStyle') ? { radarStyle: value(plot, 'radarStyle') } : {}),
        ...(value(plot, 'gapWidth') ? { gapWidth: Number(value(plot, 'gapWidth')) } : {}),
        ...(value(plot, 'overlap') ? { overlap: Number(value(plot, 'overlap')) } : {}),
        series: plot.inner ? [...xmlElements(plot.inner, 'ser')].map(series => seriesOf(series, type, styles)) : [],
      });
    }
  }
  for (const local of UNSUPPORTED_PLOTS) if (firstXmlElement(plotArea.inner, local)) unsupported = local;
  if (!plots.length && !unsupported) unsupported = 'empty';
  const xy = plots[0]?.type === ChartPlotType.Scatter || plots[0]?.type === ChartPlotType.Bubble;
  // Scatter and bubble charts have two value axes: x first, then y.
  const categoryAxis = xy ? axes.get(primaryAxes[0]) : [...axes.values()].find(axis => axis.name.endsWith('catAx') || axis.name.endsWith('dateAx'));
  const valueAxes = [...axes.entries()].filter(([, axis]) => axis.name.endsWith('valAx'));
  const primary = xy ? axes.get(primaryAxes[1]) : valueAxes.find(([id]) => id === primaryValueAxis)?.[1] ?? valueAxes[0]?.[1];
  const secondary = valueAxes.find(([id]) => id !== primaryValueAxis && plots.some(plot => plot.secondary))?.[1];
  const legend = child(chart, 'legend');
  const autoDeleted = flag(chart, 'autoTitleDeleted');
  const titleElement = child(chart, 'title');
  const title = titleOf(titleElement);
  const space = firstXmlElement(xml, 'chartSpace');
  // Without title text of its own, a one-series chart shows the series name, as in Excel, and a
  // title element of any other chart is the "Chart Title" placeholder (an empty title here).
  const onlyName = plots.length === 1 && plots[0].series.length === 1 ? plots[0].series[0].name : undefined;
  const automaticTitle = titleElement || !autoDeleted
    ? (onlyName ? { ref: onlyName.ref, text: String(onlyName.cache[0] ?? '') } : titleElement ? {} : undefined)
    : undefined;
  return {
    palette: chartPalette(styles),
    ...(title ? { title } : automaticTitle ? { title: automaticTitle } : {}),
    plots,
    ...(legend ? { legend: { position: value(legend, 'legendPos') ?? 'r' } } : {}),
    ...(categoryAxis ? { categoryAxis: axisOf(categoryAxis) } : {}),
    ...(primary ? { valueAxis: axisOf(primary) } : {}),
    ...(secondary ? { secondaryValueAxis: axisOf(secondary) } : {}),
    ...(space && child(space, 'spPr') ? { background: shapeColors(child(space, 'spPr'), styles).fill } : {}),
    ...(child(plotArea, 'spPr') ? { plotBackground: shapeColors(child(plotArea, 'spPr'), styles).fill } : {}),
    ...(unsupported ? { unsupported } : {}),
  };
}
