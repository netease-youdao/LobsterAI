import type { ICellData, IWorkbookData } from '@univerjs/core';

import { categoryLevels, type ResolvedData } from './sheetChartOption';
import { mapFormulaReferences } from './sheetStructure';
import { type ChartAxis, type ChartDataRef, type ChartPlot, ChartPlotType, type ChartSeries, type ChartSpec } from './xlsxCharts';
import { encodeXmlAttribute, encodeXmlText } from './xlsxXml';

/**
 * A chart description written as a DrawingML chart part: charts made in the editor, and charts
 * whose type, title or legend were changed there. Series keep their cell references and carry
 * the current values as caches, which Excel and other readers show until they recalculate.
 */

export const CHART_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const AXIS = { category: 500000001, value: 500000002, secondaryCategory: 500000003, secondaryValue: 500000004 } as const;
const PLOT_ELEMENT: Record<ChartPlotType, string> = {
  [ChartPlotType.Bar]: 'barChart', [ChartPlotType.Line]: 'lineChart', [ChartPlotType.Area]: 'areaChart', [ChartPlotType.Pie]: 'pieChart',
  [ChartPlotType.Doughnut]: 'doughnutChart', [ChartPlotType.Scatter]: 'scatterChart', [ChartPlotType.Radar]: 'radarChart', [ChartPlotType.Bubble]: 'bubbleChart',
};
const LEGEND_POSITIONS = new Set(['r', 'l', 't', 'b', 'tr']);
const LABEL_POSITIONS = new Set(['bestFit', 'b', 'ctr', 'inBase', 'inEnd', 'l', 'outEnd', 'r', 't']);
const MAX_POINTS = 10_000;
const MARKERS = new Set(['circle', 'dash', 'diamond', 'dot', 'none', 'picture', 'plus', 'square', 'star', 'triangle', 'x', 'auto']);

const val = (name: string, value: string | number | boolean) => `<c:${name} val="${typeof value === 'boolean' ? (value ? 1 : 0) : encodeXmlAttribute(String(value))}"/>`;
const hex = (color: string | undefined): string | undefined => {
  const match = color && /^#?([\da-f]{6})$/i.exec(color.trim());
  return match ? match[1].toUpperCase() : undefined;
};
const solid = (color: string | undefined): string => (hex(color) ? `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>` : '');
const isLinePlot = (type: ChartPlotType) => type === ChartPlotType.Line || type === ChartPlotType.Scatter || type === ChartPlotType.Radar;

function rich(text: string, size?: number): string {
  const properties = size ? `<a:pPr><a:defRPr sz="${size}" b="0"/></a:pPr>` : '';
  const paragraphs = text.split(/\r?\n/).map(line => `<a:p>${properties}<a:r><a:rPr lang="en-US"${size ? ` sz="${size}" b="0"` : ''}/><a:t>${encodeXmlText(line)}</a:t></a:r></a:p>`).join('');
  return `<c:tx><c:rich><a:bodyPr/><a:lstStyle/>${paragraphs}</c:rich></c:tx>`;
}

const titleElement = (text: string, size?: number) => `<c:title>${rich(text, size)}<c:overlay val="0"/></c:title>`;

/** A reference with its cached values: numbers as a number cache, anything else as text. */
function dataReference(source: ChartDataRef | undefined, read: (source: ChartDataRef) => ResolvedData, numeric: boolean): string {
  if (!source) return '';
  const data = read(source);
  const count = Math.max(data.values.length, data.text.length);
  const numbers = data.values.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null));
  const asNumbers = numeric || (count > 0 && numbers.every((value, index) => value !== null || data.values[index] === null));
  if (!source.ref) {
    // A literal series (no cells behind it).
    const points = asNumbers
      ? numbers.map((value, index) => (value === null ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join('')
      : data.text.map((value, index) => `<c:pt idx="${index}"><c:v>${encodeXmlText(value)}</c:v></c:pt>`).join('');
    return asNumbers
      ? `<c:numLit><c:formatCode>${encodeXmlText(data.formatCode ?? 'General')}</c:formatCode><c:ptCount val="${count}"/>${points}</c:numLit>`
      : `<c:strLit><c:ptCount val="${count}"/>${points}</c:strLit>`;
  }
  const formula = `<c:f>${encodeXmlText(source.ref.replace(/^=/, ''))}</c:f>`;
  if (source.levels && data.levels?.length) {
    // Several columns of labels: Excel's multi-level categories, the level nearest the axis first.
    const level = (labels: string[]) => `<c:lvl>${labels.map((label, index) => (label === '' ? '' : `<c:pt idx="${index}"><c:v>${encodeXmlText(label)}</c:v></c:pt>`)).join('')}</c:lvl>`;
    return `<c:multiLvlStrRef>${formula}<c:multiLvlStrCache><c:ptCount val="${data.text.length}"/>${level(data.text)}${data.levels.map(level).join('')}</c:multiLvlStrCache></c:multiLvlStrRef>`;
  }
  if (asNumbers) {
    const points = numbers.map((value, index) => (value === null ? '' : `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`)).join('');
    return `<c:numRef>${formula}<c:numCache><c:formatCode>${encodeXmlText(data.formatCode ?? 'General')}</c:formatCode><c:ptCount val="${count}"/>${points}</c:numCache></c:numRef>`;
  }
  const points = data.text.map((value, index) => (value === '' ? '' : `<c:pt idx="${index}"><c:v>${encodeXmlText(value)}</c:v></c:pt>`)).join('');
  return `<c:strRef>${formula}<c:strCache><c:ptCount val="${count}"/>${points}</c:strCache></c:strRef>`;
}

/** A series name: its cell as text, or the text itself. */
function seriesName(series: ChartSeries, read: (source: ChartDataRef) => ResolvedData): string {
  if (!series.name) return '';
  const text = read(series.name).text.filter(Boolean).join(' ');
  if (!series.name.ref) return text ? `<c:tx><c:v>${encodeXmlText(text)}</c:v></c:tx>` : '';
  const cache = text ? `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${encodeXmlText(text)}</c:v></c:pt></c:strCache>` : '<c:strCache><c:ptCount val="1"/></c:strCache>';
  return `<c:tx><c:strRef><c:f>${encodeXmlText(series.name.ref.replace(/^=/, ''))}</c:f>${cache}</c:strRef></c:tx>`;
}

function shapeProperties(series: ChartSeries, type: ChartPlotType): string {
  if (isLinePlot(type)) {
    const width = series.lineWidth ? ` w="${Math.round(series.lineWidth * 12700)}"` : ' w="28575"';
    const line = series.noLine ? '<a:ln><a:noFill/></a:ln>' : `<a:ln${width} cap="rnd">${solid(series.lineColor ?? series.color)}<a:round/></a:ln>`;
    return `<c:spPr>${line}</c:spPr>`;
  }
  const fill = series.noFill ? '<a:noFill/>' : solid(series.color);
  const line = series.lineColor ? `<a:ln>${solid(series.lineColor)}</a:ln>` : '';
  return fill || line ? `<c:spPr>${fill}${line}</c:spPr>` : '';
}

function marker(series: ChartSeries): string {
  const symbol = series.marker?.symbol;
  if (!series.marker || !symbol || !MARKERS.has(symbol) || symbol === 'auto') return '';
  if (symbol === 'none') return '<c:marker><c:symbol val="none"/></c:marker>';
  const fill = series.marker.color ? `<c:spPr>${solid(series.marker.color)}<a:ln>${solid(series.marker.color)}</a:ln></c:spPr>` : '';
  return `<c:marker>${val('symbol', symbol)}${series.marker.size ? val('size', Math.min(72, Math.max(2, Math.round(series.marker.size)))) : ''}${fill}</c:marker>`;
}

function pointColors(series: ChartSeries, type: ChartPlotType): string {
  return Object.entries(series.pointColors ?? {}).map(([index, color]) => {
    if (!hex(color)) return '';
    const bubble = type === ChartPlotType.Bubble ? '<c:invertIfNegative val="0"/>' : '';
    const invert = type === ChartPlotType.Bar ? '<c:invertIfNegative val="0"/>' : '';
    return `<c:dPt><c:idx val="${Number(index)}"/>${invert || bubble}<c:bubble3D val="0"/><c:spPr>${solid(color)}</c:spPr></c:dPt>`;
  }).join('');
}

function dataLabels(series: ChartSeries, type: ChartPlotType): string {
  const labels = series.labels;
  if (!labels || !(labels.value || labels.percent || labels.category || labels.series)) return '';
  const position = labels.position && LABEL_POSITIONS.has(labels.position) ? val('dLblPos', labels.position) : '';
  return `<c:dLbls>${position}${val('showLegendKey', false)}${val('showVal', Boolean(labels.value))}${val('showCatName', Boolean(labels.category))}`
    + `${val('showSerName', Boolean(labels.series))}${val('showPercent', Boolean(labels.percent) && (type === ChartPlotType.Pie || type === ChartPlotType.Doughnut))}${val('showBubbleSize', false)}</c:dLbls>`;
}

function seriesElement(series: ChartSeries, index: number, plot: ChartPlot, read: (source: ChartDataRef) => ResolvedData): string {
  const type = plot.type;
  const head = `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${seriesName(series, read)}${shapeProperties(series, type)}`;
  const tail = '</c:ser>';
  switch (type) {
    case ChartPlotType.Bar:
      return `${head}<c:invertIfNegative val="0"/>${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.categories ? `<c:cat>${dataReference(series.categories, read, false)}</c:cat>` : ''}<c:val>${dataReference(series.values, read, true)}</c:val>${tail}`;
    case ChartPlotType.Line:
    case ChartPlotType.Radar:
      return `${head}${marker(series)}${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.categories ? `<c:cat>${dataReference(series.categories, read, false)}</c:cat>` : ''}<c:val>${dataReference(series.values, read, true)}</c:val>`
        + `${type === ChartPlotType.Line ? val('smooth', Boolean(series.smooth)) : ''}${tail}`;
    case ChartPlotType.Area:
      return `${head}${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.categories ? `<c:cat>${dataReference(series.categories, read, false)}</c:cat>` : ''}<c:val>${dataReference(series.values, read, true)}</c:val>${tail}`;
    case ChartPlotType.Pie:
    case ChartPlotType.Doughnut:
      return `${head}${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.categories ? `<c:cat>${dataReference(series.categories, read, false)}</c:cat>` : ''}<c:val>${dataReference(series.values, read, true)}</c:val>${tail}`;
    case ChartPlotType.Scatter:
      return `${head}${marker(series)}${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.x ?? series.categories ? `<c:xVal>${dataReference(series.x ?? series.categories, read, false)}</c:xVal>` : ''}<c:yVal>${dataReference(series.values, read, true)}</c:yVal>`
        + `${val('smooth', Boolean(series.smooth))}${tail}`;
    case ChartPlotType.Bubble:
      return `${head}<c:invertIfNegative val="0"/>${pointColors(series, type)}${dataLabels(series, type)}`
        + `${series.x ?? series.categories ? `<c:xVal>${dataReference(series.x ?? series.categories, read, false)}</c:xVal>` : ''}<c:yVal>${dataReference(series.values, read, true)}</c:yVal>`
        + `<c:bubbleSize>${dataReference(series.sizes ?? series.values, read, true)}</c:bubbleSize><c:bubble3D val="0"/>${tail}`;
    default:
      return '';
  }
}

function plotElement(plot: ChartPlot, first: number, read: (source: ChartDataRef) => ResolvedData): string {
  const name = PLOT_ELEMENT[plot.type];
  const series = plot.series.map((item, index) => seriesElement(item, first + index, plot, read)).join('');
  const axes = plot.secondary ? `<c:axId val="${AXIS.secondaryCategory}"/><c:axId val="${AXIS.secondaryValue}"/>` : `<c:axId val="${AXIS.category}"/><c:axId val="${AXIS.value}"/>`;
  const varyColors = val('varyColors', Boolean(plot.varyColors));
  switch (plot.type) {
    case ChartPlotType.Bar: {
      const grouping = plot.grouping && plot.grouping !== 'standard' ? plot.grouping : 'clustered';
      const stacked = grouping === 'stacked' || grouping === 'percentStacked';
      return `<c:${name}>${val('barDir', plot.horizontal ? 'bar' : 'col')}${val('grouping', grouping)}${varyColors}${series}`
        + `${val('gapWidth', plot.gapWidth ?? 150)}${plot.overlap !== undefined || stacked ? val('overlap', plot.overlap ?? 100) : ''}${axes}</c:${name}>`;
    }
    case ChartPlotType.Line:
      return `<c:${name}>${val('grouping', plot.grouping && plot.grouping !== 'clustered' ? plot.grouping : 'standard')}${varyColors}${series}${val('marker', true)}${axes}</c:${name}>`;
    case ChartPlotType.Area:
      return `<c:${name}>${val('grouping', plot.grouping && plot.grouping !== 'clustered' ? plot.grouping : 'standard')}${varyColors}${series}${axes}</c:${name}>`;
    case ChartPlotType.Pie:
      return `<c:${name}>${val('varyColors', plot.varyColors ?? true)}${series}${val('firstSliceAng', plot.firstSliceAngle ?? 0)}</c:${name}>`;
    case ChartPlotType.Doughnut:
      return `<c:${name}>${val('varyColors', plot.varyColors ?? true)}${series}${val('firstSliceAng', plot.firstSliceAngle ?? 0)}${val('holeSize', Math.min(90, Math.max(10, plot.holeSize ?? 50)))}</c:${name}>`;
    case ChartPlotType.Scatter:
      return `<c:${name}>${val('scatterStyle', plot.scatterStyle ?? 'lineMarker')}${varyColors}${series}${axes}</c:${name}>`;
    case ChartPlotType.Radar:
      return `<c:${name}>${val('radarStyle', plot.radarStyle ?? 'marker')}${varyColors}${series}${axes}</c:${name}>`;
    case ChartPlotType.Bubble:
      return `<c:${name}>${varyColors}${series}${val('bubbleScale', 100)}${val('showNegBubbles', false)}${axes}</c:${name}>`;
    default:
      return '';
  }
}

function axisElement(kind: 'catAx' | 'valAx', id: number, cross: number, position: string, axis: ChartAxis | undefined, options: { gridlines: boolean; crossesMax?: boolean; between?: boolean }): string {
  const scaling = `<c:scaling>${val('orientation', axis?.reverse ? 'maxMin' : 'minMax')}${kind === 'valAx' && axis?.max !== undefined ? val('max', axis.max) : ''}${kind === 'valAx' && axis?.min !== undefined ? val('min', axis.min) : ''}</c:scaling>`;
  const title = axis?.title ? titleElement(axis.title, 1000) : '';
  const format = `<c:numFmt formatCode="${encodeXmlAttribute(axis?.formatCode ?? 'General')}" sourceLinked="${axis?.formatCode ? 0 : 1}"/>`;
  const gridlines = (axis?.gridlines ?? options.gridlines) ? '<c:majorGridlines><c:spPr><a:ln w="9525">' + solid('#D9D9D9') + '</a:ln></c:spPr></c:majorGridlines>' : '';
  const common = `<c:axId val="${id}"/>${scaling}${val('delete', Boolean(axis?.deleted))}${val('axPos', position)}${gridlines}${title}${format}`
    + `${val('majorTickMark', 'none')}${val('minorTickMark', 'none')}${val('tickLblPos', 'nextTo')}<c:crossAx val="${cross}"/>${options.crossesMax ? val('crosses', 'max') : val('crosses', 'autoZero')}`;
  if (kind === 'catAx') return `<c:catAx>${common}${val('auto', true)}${val('lblAlgn', 'ctr')}${val('lblOffset', 100)}${val('noMultiLvlLbl', false)}</c:catAx>`;
  return `<c:valAx>${common}${val('crossBetween', options.between ? 'between' : 'midCat')}${axis?.majorUnit ? val('majorUnit', axis.majorUnit) : ''}</c:valAx>`;
}

function axes(spec: ChartSpec): string {
  const plots = spec.plots;
  const primary = plots.find(plot => !plot.secondary) ?? plots[0];
  if (!primary || primary.type === ChartPlotType.Pie || primary.type === ChartPlotType.Doughnut) return '';
  const xy = primary.type === ChartPlotType.Scatter || primary.type === ChartPlotType.Bubble;
  const horizontal = primary.type === ChartPlotType.Bar && primary.horizontal;
  const between = primary.type === ChartPlotType.Bar;
  const categoryPosition = horizontal ? 'l' : 'b';
  const valuePosition = horizontal ? 'b' : 'l';
  let markup = xy
    ? axisElement('valAx', AXIS.category, AXIS.value, 'b', spec.categoryAxis, { gridlines: false }) + axisElement('valAx', AXIS.value, AXIS.category, 'l', spec.valueAxis, { gridlines: true })
    : axisElement('catAx', AXIS.category, AXIS.value, categoryPosition, spec.categoryAxis, { gridlines: false }) + axisElement('valAx', AXIS.value, AXIS.category, valuePosition, spec.valueAxis, { gridlines: true, between });
  if (plots.some(plot => plot.secondary)) {
    markup += axisElement('catAx', AXIS.secondaryCategory, AXIS.secondaryValue, categoryPosition, { deleted: true }, { gridlines: false })
      + axisElement('valAx', AXIS.secondaryValue, AXIS.secondaryCategory, horizontal ? 't' : 'r', spec.secondaryValueAxis, { gridlines: false, crossesMax: true, between });
  }
  return markup;
}

/**
 * The chart part for a chart description. `read` gives a series source's current values; a title
 * that is the only series' name is left to Excel's automatic title.
 */
export function chartPartXml(spec: ChartSpec, read: (source: ChartDataRef) => ResolvedData): string {
  const plots = spec.plots.filter(plot => PLOT_ELEMENT[plot.type]);
  const onlySeries = plots.length === 1 && plots[0].series.length === 1 ? plots[0].series[0] : undefined;
  const automatic = Boolean(spec.title?.ref && onlySeries?.name?.ref && spec.title.ref === onlySeries.name.ref)
    || Boolean(spec.title && spec.title.text === undefined && spec.title.ref === undefined);
  let title = '';
  if (spec.title && !automatic) {
    const text = spec.title.ref ? read({ ref: spec.title.ref, cache: [spec.title.text ?? ''] }).text.join(' ') : spec.title.text ?? '';
    title = text ? titleElement(text, 1400) : '';
  }
  let first = 0;
  const plotMarkup = plots.map(plot => {
    const markup = plotElement(plot, first, read);
    first += plot.series.length;
    return markup;
  }).join('');
  const legend = spec.legend && LEGEND_POSITIONS.has(spec.legend.position) ? `<c:legend>${val('legendPos', spec.legend.position)}<c:overlay val="0"/></c:legend>` : '';
  const plotBackground = hex(spec.plotBackground) ? `<c:spPr>${solid(spec.plotBackground)}</c:spPr>` : '';
  const background = hex(spec.background) ? `<c:spPr>${solid(spec.background)}<a:ln><a:noFill/></a:ln></c:spPr>` : '';
  // An automatic title is a title element without text, as Excel writes it.
  if (automatic) title = '<c:title><c:overlay val="0"/></c:title>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="${DRAWING_NS}" xmlns:r="${RELATIONSHIPS_NS}">`
    + `${val('roundedCorners', false)}<c:chart>${title}${val('autoTitleDeleted', !title)}`
    + `<c:plotArea><c:layout/>${plotMarkup}${axes({ ...spec, plots })}${plotBackground}</c:plotArea>${legend}`
    + `${val('plotVisOnly', true)}${val('dispBlanksAs', 'gap')}</c:chart>${background}</c:chartSpace>`;
}

/**
 * Reads a series source from a workbook snapshot (the export has no grid): numbers stay numbers,
 * everything else becomes text. Sources whose cells cannot be read fall back to their cache.
 */
export function snapshotChartReader(snapshot: IWorkbookData): (source: ChartDataRef) => ResolvedData {
  const sheetIds = new Map(Object.values(snapshot.sheets).map(sheet => [String(sheet.name).toLowerCase(), sheet.id!]));
  return source => {
    const fallback: ResolvedData = { values: source.cache, text: source.cache.map(value => (value === null || value === undefined ? '' : String(value))), ...(source.formatCode ? { formatCode: source.formatCode } : {}) };
    if (!source.ref) return fallback;
    const values: (string | number | null)[] = [];
    let readable = true;
    let width = 0;
    mapFormulaReferences(source.ref.replace(/^=/, ''), token => {
      const sheetId = token.sheets.length === 1 ? sheetIds.get(token.sheets[0].toLowerCase()) : undefined;
      const area = token.reference;
      const cells = sheetId ? snapshot.sheets[sheetId]?.cellData as Record<number, Record<number, ICellData | null>> | undefined : undefined;
      if (!sheetId || token.external || !area || (area.kind !== 'cell' && area.kind !== 'area')) {
        readable = false;
        return token.text;
      }
      const start = area.kind === 'cell' ? area.cell : area.start;
      const end = area.kind === 'cell' ? area.cell : area.end;
      width = end.column - start.column + 1;
      for (let row = start.row; row <= end.row && values.length < MAX_POINTS; row++) {
        for (let column = start.column; column <= end.column && values.length < MAX_POINTS; column++) {
          const cell = cells?.[row]?.[column];
          const value = cell?.v;
          const rich = cell?.p?.body?.dataStream?.replace(/\r?\n$/, '');
          values.push(typeof value === 'number' ? value : rich || (value === undefined || value === null || value === '' ? null : String(value)));
        }
      }
      return token.text;
    });
    if (!readable) return fallback;
    const text = values.map(value => (value === null ? '' : String(value)));
    // Multi-level categories: the block of labels as Excel splits it into levels.
    if (source.levels && width > 1 && text.length > width) {
      const matrix = Array.from({ length: Math.ceil(text.length / width) }, (_, row) => text.slice(row * width, (row + 1) * width));
      const split = categoryLevels(matrix);
      return { values: split.text, text: split.text, ...(split.levels.length ? { levels: split.levels } : {}) };
    }
    return { values, text, ...(source.formatCode ? { formatCode: source.formatCode } : {}) };
  };
}
