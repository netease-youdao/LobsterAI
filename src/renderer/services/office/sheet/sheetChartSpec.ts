import { type CellRange, columnLabel } from './sheetAddress';
import { formulaSheetName, mapFormulaReferences } from './sheetStructure';
import { type ChartDataRef, type ChartPlot, ChartPlotType, type ChartSeries, type ChartSpec } from './xlsxCharts';

/**
 * Charts made in the editor: the chart types offered when inserting or changing a chart, a chart
 * built from a block of cells the way Excel's Insert Chart reads it, and the edits the chart
 * settings make. The result is a chart description like those read from files.
 */

export const ChartKind = {
  Column: 'column', Bar: 'bar', Line: 'line', Area: 'area', Pie: 'pie', Doughnut: 'doughnut', Scatter: 'scatter',
} as const;
export type ChartKind = typeof ChartKind[keyof typeof ChartKind];

export const LegendPosition = { Right: 'r', Bottom: 'b', Top: 't', Left: 'l', None: 'none' } as const;
export type LegendPosition = typeof LegendPosition[keyof typeof LegendPosition];

/** A cell's value and what it shows. */
export interface ChartCell {
  value: unknown;
  text: string;
}

const isNumber = (cell: ChartCell): boolean => typeof cell.value === 'number' && Number.isFinite(cell.value);
const isEmpty = (cell: ChartCell): boolean => cell.value === null || cell.value === undefined || cell.value === '';

function areaReference(sheetName: string, range: CellRange): string {
  const start = `$${columnLabel(range.startColumn)}$${range.startRow + 1}`;
  const end = `$${columnLabel(range.endColumn)}$${range.endRow + 1}`;
  return `${formulaSheetName(sheetName)}!${start === end ? start : `${start}:${end}`}`;
}

const reference = (sheetName: string, range: CellRange): ChartDataRef => ({ ref: areaReference(sheetName, range), cache: [] });

/** The plot a chart type draws its series in. */
function plotOf(kind: ChartKind, series: ChartSeries[]): ChartPlot {
  switch (kind) {
    case ChartKind.Bar: return { type: ChartPlotType.Bar, horizontal: true, grouping: 'clustered', series };
    // Excel's default line chart draws no markers.
    case ChartKind.Line: return { type: ChartPlotType.Line, grouping: 'standard', series: series.map(item => (item.marker ? item : { ...item, marker: { symbol: 'none' } })) };
    case ChartKind.Area: return { type: ChartPlotType.Area, grouping: 'standard', series };
    case ChartKind.Pie: return { type: ChartPlotType.Pie, varyColors: true, series: series.slice(0, 1) };
    case ChartKind.Doughnut: return { type: ChartPlotType.Doughnut, varyColors: true, holeSize: 50, series: series.slice(0, 1) };
    case ChartKind.Scatter: return { type: ChartPlotType.Scatter, scatterStyle: 'lineMarker', series: series.map(item => ({ ...item, noLine: true })) };
    default: return { type: ChartPlotType.Bar, grouping: 'clustered', series };
  }
}

/**
 * A chart of the given type over a block of cells, read as Excel's Insert Chart does: a first row
 * of text holds series names, a first column of text (or an empty corner) holds categories, and
 * series run down the columns unless the block is wider than it is tall. Undefined when the block
 * holds no numbers.
 */
export function chartFromRange(kind: ChartKind, sheetName: string, range: CellRange, cell: (row: number, column: number) => ChartCell): ChartSpec | undefined {
  const rows = range.endRow - range.startRow + 1;
  const columns = range.endColumn - range.startColumn + 1;
  const at = (row: number, column: number) => cell(range.startRow + row, range.startColumn + column);
  const corner = at(0, 0);
  const firstRowText = columns > 1 && Array.from({ length: columns - 1 }, (_, index) => at(0, index + 1)).every(item => !isNumber(item));
  const firstColumnText = rows > 1 && Array.from({ length: rows - 1 }, (_, index) => at(index + 1, 0)).every(item => !isNumber(item));
  const headerRow = rows > 1 && (firstRowText || (isEmpty(corner) && firstColumnText));
  const headerColumn = columns > 1 && (firstColumnText || (isEmpty(corner) && firstRowText));
  const dataRows = rows - (headerRow ? 1 : 0);
  const dataColumns = columns - (headerColumn ? 1 : 0);
  if (dataRows < 1 || dataColumns < 1) return undefined;
  const top = range.startRow + (headerRow ? 1 : 0);
  const left = range.startColumn + (headerColumn ? 1 : 0);
  // Only lines with numbers become series: a second column of labels is not data to plot.
  const numbered = (count: number, at: (index: number, step: number) => ChartCell, steps: number) => Array.from({ length: count }, (_, index) => index)
    .filter(index => Array.from({ length: steps }, (_, step) => at(index, step)).some(isNumber));
  const numberedColumns = numbered(dataColumns, (index, step) => cell(top + step, left + index), dataRows);
  if (!numberedColumns.length) return undefined;
  const byColumns = dataRows >= numberedColumns.length;
  const lines = byColumns ? numberedColumns : numbered(dataRows, (index, step) => cell(top + index, left + step), dataColumns);
  // Columns of text right after the category column are its outer levels (Excel's multi-level axis).
  let levels = 0;
  if (byColumns && headerColumn) while (levels < dataColumns && !numberedColumns.includes(levels)) levels++;
  const series: ChartSeries[] = lines.map(index => {
    const values: CellRange = byColumns
      ? { startRow: top, endRow: range.endRow, startColumn: left + index, endColumn: left + index }
      : { startRow: top + index, endRow: top + index, startColumn: left, endColumn: range.endColumn };
    const name: CellRange | undefined = byColumns
      ? (headerRow ? { startRow: range.startRow, endRow: range.startRow, startColumn: left + index, endColumn: left + index } : undefined)
      : (headerColumn ? { startRow: top + index, endRow: top + index, startColumn: range.startColumn, endColumn: range.startColumn } : undefined);
    const categories: CellRange | undefined = byColumns
      ? (headerColumn ? { startRow: top, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.startColumn + (kind === ChartKind.Scatter ? 0 : levels) } : undefined)
      : (headerRow ? { startRow: range.startRow, endRow: range.startRow, startColumn: left, endColumn: range.endColumn } : undefined);
    const item: ChartSeries = { values: reference(sheetName, values) };
    if (name) item.name = reference(sheetName, name);
    if (categories) item[kind === ChartKind.Scatter ? 'x' : 'categories'] = levels && kind !== ChartKind.Scatter ? { ...reference(sheetName, categories), levels: [] } : reference(sheetName, categories);
    return item;
  });
  const round = kind === ChartKind.Pie || kind === ChartKind.Doughnut;
  const single = round || series.length === 1;
  return {
    // As in Excel: a single series is titled with its name, other charts get the "Chart Title" placeholder.
    title: single && series[0].name ? { ref: series[0].name.ref } : {},
    plots: [plotOf(kind, series)],
    // Excel puts the legend below pies and several series, and leaves it off a single series.
    ...(single && !round ? {} : { legend: { position: LegendPosition.Bottom } }),
    ...(round ? {} : { valueAxis: { gridlines: true } }),
  };
}

/** The chart type a chart description is drawn as (its first plot's). */
export function chartKind(spec: ChartSpec): ChartKind | undefined {
  const plot = spec.plots[0];
  if (!plot) return undefined;
  switch (plot.type) {
    case ChartPlotType.Bar: return plot.horizontal ? ChartKind.Bar : ChartKind.Column;
    case ChartPlotType.Line: return ChartKind.Line;
    case ChartPlotType.Area: return ChartKind.Area;
    case ChartPlotType.Pie: return ChartKind.Pie;
    case ChartPlotType.Doughnut: return ChartKind.Doughnut;
    case ChartPlotType.Scatter: return ChartKind.Scatter;
    default: return undefined;
  }
}

/** The chart drawn as another type: all series in one plot of that type, colors and names kept. */
export function withChartKind(spec: ChartSpec, kind: ChartKind): ChartSpec {
  const series = spec.plots.flatMap(plot => plot.series).map(item => {
    const next: ChartSeries = { ...item };
    delete next.noLine;
    delete next.smooth;
    delete next.pointColors;
    // Scatter charts plot x values where the others have categories.
    if (kind === ChartKind.Scatter && !next.x && next.categories) {
      next.x = next.categories;
      delete next.categories;
    } else if (kind !== ChartKind.Scatter && next.x && !next.categories) {
      next.categories = next.x;
      delete next.x;
    }
    return next;
  });
  let next: ChartSpec = { ...spec, plots: [plotOf(kind, series)] };
  // Stacked series stay stacked across column, bar, line and area charts.
  if (canStack(spec) && canStack(next)) next = withStacking(next, chartStacking(spec));
  delete next.secondaryValueAxis;
  if (kind === ChartKind.Pie || kind === ChartKind.Doughnut) {
    delete next.categoryAxis;
    delete next.valueAxis;
    next.legend ??= { position: LegendPosition.Right };
  } else {
    next.valueAxis = { gridlines: true, ...spec.valueAxis };
  }
  return next;
}

export function withChartTitle(spec: ChartSpec, text: string): ChartSpec {
  const next = { ...spec };
  if (text.trim()) next.title = { text: text.trim() };
  else delete next.title;
  return next;
}

export function withLegend(spec: ChartSpec, position: LegendPosition): ChartSpec {
  const next = { ...spec };
  if (position === LegendPosition.None) delete next.legend;
  else next.legend = { position };
  return next;
}

/** The legend position a chart description has, as the settings offer it. */
export const legendPosition = (spec: ChartSpec): LegendPosition => {
  const position = spec.legend?.position;
  return (Object.values(LegendPosition) as string[]).includes(position ?? '') ? position as LegendPosition : spec.legend ? LegendPosition.Right : LegendPosition.None;
};

/**
 * Where a chart made in the editor stands in the row and column edit log: its references were
 * written after that many edits, so only later ones move them.
 */
export interface ChartOrigin {
  edits: number;
}

/** The data a chart floating over the grid carries: its description and, for charts made here, its origin. */
export interface SheetChartData {
  spec: ChartSpec;
  origin?: ChartOrigin;
}

const mapSource = (source: ChartDataRef | undefined, map: (reference: string) => string): ChartDataRef | undefined => (source?.ref ? { ...source, ref: map(source.ref) } : source);

/** Every cell reference of a chart description passed through `map`. */
export function mapChartReferences(spec: ChartSpec, map: (reference: string) => string): ChartSpec {
  const series = (item: ChartSeries): ChartSeries => {
    const next: ChartSeries = { ...item, values: mapSource(item.values, map)! };
    for (const key of ['name', 'categories', 'x', 'sizes'] as const) if (item[key]) next[key] = mapSource(item[key], map);
    return next;
  };
  return {
    ...spec,
    ...(spec.title?.ref ? { title: { ...spec.title, ref: map(spec.title.ref) } } : {}),
    plots: spec.plots.map(plot => ({ ...plot, series: plot.series.map(series) })),
  };
}

/**
 * The block of cells a chart reads (its series' names, categories and values) as one range on one
 * sheet, the way Excel's Select Data shows it; undefined when the series come from several sheets
 * or from something other than cells. `resolve` moves a reference to the current cells.
 */
export function chartSourceRange(spec: ChartSpec, resolve: (reference: string) => string = reference => reference): { sheet: string; range: CellRange } | undefined {
  let sheet: string | undefined;
  let range: CellRange | undefined;
  let readable = true;
  const add = (reference: string | undefined) => {
    if (!reference) return;
    mapFormulaReferences(resolve(reference), token => {
      const name = token.sheets[0];
      const area = token.reference;
      const box = area?.kind === 'cell' ? { startRow: area.cell.row, endRow: area.cell.row, startColumn: area.cell.column, endColumn: area.cell.column }
        : area?.kind === 'area' ? { startRow: area.start.row, endRow: area.end.row, startColumn: area.start.column, endColumn: area.end.column } : undefined;
      if (!name || token.sheets.length > 1 || token.external || !box || (sheet !== undefined && sheet.toLowerCase() !== name.toLowerCase())) {
        readable = false;
        return token.text;
      }
      sheet ??= name;
      range = range
        ? { startRow: Math.min(range.startRow, box.startRow), endRow: Math.max(range.endRow, box.endRow), startColumn: Math.min(range.startColumn, box.startColumn), endColumn: Math.max(range.endColumn, box.endColumn) }
        : box;
      return token.text;
    });
  };
  for (const series of chartSeriesList(spec)) for (const source of [series.name, series.categories, series.x, series.values]) add(source?.ref);
  return readable && sheet && range ? { sheet, range } : undefined;
}

/**
 * A chart over other cells, as Excel's Select Data changes it: the series `fresh` read from the new
 * block (built for the chart's type) keep the chart's own settings — stacking, colors, labels,
 * markers, legend, axes — and an automatic title follows the new data.
 */
export function withChartData(spec: ChartSpec, fresh: ChartSpec): ChartSpec {
  const plot = spec.plots[0];
  const next = fresh.plots[0];
  if (!plot || !next || spec.plots.length !== 1) return spec;
  const labels = plot.series.length && plot.series.every(series => series.labels) ? plot.series[0].labels : undefined;
  const series = next.series.map((item, index) => {
    const own = plot.series[index];
    if (!own) return labels ? { ...item, labels } : item;
    const { values: _values, name: _name, categories: _categories, x: _x, sizes: _sizes, pointColors: _points, ...settings } = own;
    return { ...item, ...settings, values: item.values, ...(item.name ? { name: item.name } : {}) };
  });
  const automatic = spec.title && spec.title.text === undefined && (spec.title.ref === undefined || spec.title.ref === plot.series[0]?.name?.ref);
  const result: ChartSpec = { ...spec, plots: [{ ...plot, series }] };
  if (automatic) {
    if (fresh.title) result.title = fresh.title;
    else delete result.title;
  }
  return result;
}

/** How a column, bar, line or area chart puts its series: side by side, stacked, or stacked to 100%. */
export const ChartStacking = { Standard: 'standard', Stacked: 'stacked', Percent: 'percentStacked' } as const;
export type ChartStacking = typeof ChartStacking[keyof typeof ChartStacking];

const STACKABLE = new Set<ChartPlotType>([ChartPlotType.Bar, ChartPlotType.Line, ChartPlotType.Area]);

/** Whether a chart's series can be stacked (column, bar, line and area charts). */
export const canStack = (spec: ChartSpec): boolean => Boolean(spec.plots[0] && STACKABLE.has(spec.plots[0].type));

export function chartStacking(spec: ChartSpec): ChartStacking {
  const grouping = spec.plots[0]?.grouping;
  return grouping === 'stacked' ? ChartStacking.Stacked : grouping === 'percentStacked' ? ChartStacking.Percent : ChartStacking.Standard;
}

export function withStacking(spec: ChartSpec, stacking: ChartStacking): ChartSpec {
  return {
    ...spec,
    plots: spec.plots.map(plot => {
      if (!STACKABLE.has(plot.type)) return plot;
      // Excel calls side-by-side bars "clustered"; lines and areas "standard".
      const grouping = stacking === ChartStacking.Standard ? (plot.type === ChartPlotType.Bar ? 'clustered' : 'standard') : stacking;
      const next: ChartPlot = { ...plot, grouping };
      if (plot.type === ChartPlotType.Bar) {
        if (stacking === ChartStacking.Standard) delete next.overlap;
        else next.overlap = 100;
      }
      return next;
    }),
  };
}

/** Whether the chart shows each point's value. */
export const hasDataLabels = (spec: ChartSpec): boolean => spec.plots.some(plot => plot.series.some(series => series.labels?.value || series.labels?.percent));

export function withDataLabels(spec: ChartSpec, shown: boolean): ChartSpec {
  return {
    ...spec,
    plots: spec.plots.map(plot => ({
      ...plot,
      series: plot.series.map(series => {
        const next = { ...series };
        if (shown) next.labels = { ...series.labels, value: true };
        else delete next.labels;
        return next;
      }),
    })),
  };
}

/** Whether the value axis draws its major gridlines (charts without axes have none). */
export const hasGridlines = (spec: ChartSpec): boolean => spec.valueAxis?.gridlines ?? false;

export function withGridlines(spec: ChartSpec, shown: boolean): ChartSpec {
  return { ...spec, valueAxis: { ...spec.valueAxis, gridlines: shown } };
}

export const ChartAxisKind = { Category: 'category', Value: 'value' } as const;
export type ChartAxisKind = typeof ChartAxisKind[keyof typeof ChartAxisKind];

/** Whether a chart has axes to title (pies and doughnuts have none). */
export const hasAxes = (spec: ChartSpec): boolean => Boolean(spec.plots[0]) && spec.plots[0].type !== ChartPlotType.Pie && spec.plots[0].type !== ChartPlotType.Doughnut;

export const axisTitle = (spec: ChartSpec, axis: ChartAxisKind): string => (axis === ChartAxisKind.Category ? spec.categoryAxis?.title : spec.valueAxis?.title) ?? '';

export function withAxisTitle(spec: ChartSpec, axis: ChartAxisKind, text: string): ChartSpec {
  const key = axis === ChartAxisKind.Category ? 'categoryAxis' : 'valueAxis';
  const next: ChartSpec = { ...spec, [key]: { ...spec[key] } };
  if (text.trim()) next[key]!.title = text.trim();
  else delete next[key]!.title;
  return next;
}

/** Whether series have a color of their own to set (pies and doughnuts color each slice). */
export const hasSeriesColors = (spec: ChartSpec): boolean => hasAxes(spec);

/** The chart's series in order across its plots. */
export const chartSeriesList = (spec: ChartSpec): ChartSeries[] => spec.plots.flatMap(plot => plot.series);

export function withSeriesColor(spec: ChartSpec, index: number, color: string): ChartSpec {
  let at = 0;
  return {
    ...spec,
    plots: spec.plots.map(plot => ({
      ...plot,
      series: plot.series.map(series => {
        if (at++ !== index) return series;
        const next: ChartSeries = { ...series, color };
        // Lines and markers take the series color too.
        if (next.lineColor) next.lineColor = color;
        if (next.marker?.color) next.marker = { ...next.marker, color };
        return next;
      }),
    })),
  };
}
