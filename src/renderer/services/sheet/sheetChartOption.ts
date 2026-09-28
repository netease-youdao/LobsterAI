import { numfmt } from '@univerjs/core';
import type { EChartsOption, SeriesOption } from 'echarts';

import { type ChartAxis, type ChartDataRef, type ChartPlot, ChartPlotType, type ChartSeries, type ChartSpec } from './xlsxCharts';

/**
 * Turns an Excel chart description and the current cell values into an ECharts option styled
 * like Excel's default chart look: light gray gridlines, 9 pt labels, 14 pt title.
 */

export interface ResolvedData {
  values: (string | number | null)[];
  /** What the cells show (formatted), for categories and names. */
  text: string[];
  formatCode?: string;
}

/** Reads a series source from the workbook, or its cache when the cells cannot be read. */
export type ChartDataReader = (source: ChartDataRef | undefined) => ResolvedData;

const TEXT = '#595959';
const LINE = '#D9D9D9';
const FONT = 'Calibri, "Microsoft YaHei", "PingFang SC", sans-serif';
/** The Office theme's accent colors, for charts without a palette of their own. */
export const DEFAULT_PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];

function formatted(value: number, formatCode: string | undefined): string {
  if (!formatCode || formatCode === 'General') return String(Math.round(value * 1e10) / 1e10);
  try {
    return numfmt.format(formatCode, value);
  } catch {
    return String(value);
  }
}

const numberOf = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

/** Excel's series colors: the theme accents, then darker and lighter variants of them. */
export function seriesColor(palette: string[], index: number): string {
  const base = palette[index % palette.length] ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
  const round = Math.floor(index / palette.length);
  if (!round) return base;
  const factor = round % 2 === 1 ? 0.6 : 1.4;
  const channels = [1, 3, 5].map(offset => Number.parseInt(base.slice(offset, offset + 2), 16));
  const adjusted = channels.map(channel => Math.max(0, Math.min(255, Math.round(factor < 1 ? channel * factor : channel + (255 - channel) * (factor - 1)))));
  return `#${adjusted.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** Series without a name are called "Series1" (localized by the caller), as in Excel. */
export interface ChartOptionContext {
  read: ChartDataReader;
  seriesName: (index: number) => string;
  /** What an empty title shows ("Chart Title"). */
  placeholderTitle?: string;
}

function nameOf(series: ChartSeries, context: ChartOptionContext, index: number): string {
  const name = context.read(series.name);
  return name.text.filter(Boolean).join(' ') || context.seriesName(index);
}

function axisOption(axis: ChartAxis | undefined, kind: 'category' | 'value', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: kind,
    show: !axis?.deleted,
    inverse: Boolean(axis?.reverse),
    ...(axis?.title ? { name: axis.title, nameLocation: 'middle', nameGap: kind === 'category' ? 28 : 40, nameTextStyle: { color: TEXT, fontSize: 12 } } : {}),
    axisLine: { show: kind === 'category', lineStyle: { color: LINE } },
    axisTick: { show: false },
    axisLabel: {
      color: TEXT, fontSize: 12, hideOverlap: true,
      ...(kind === 'value' ? { formatter: (value: number) => formatted(value, axis?.formatCode) } : {}),
    },
    splitLine: { show: kind === 'value' ? axis?.gridlines !== false : Boolean(axis?.gridlines), lineStyle: { color: LINE } },
    ...(kind === 'value' && axis?.min !== undefined ? { min: axis.min } : {}),
    ...(kind === 'value' && axis?.max !== undefined ? { max: axis.max } : {}),
    ...(kind === 'value' && axis?.majorUnit ? { interval: axis.majorUnit } : {}),
    ...extra,
  };
}

function labelOption(series: ChartSeries, formatCode: string | undefined, plot: ChartPlot): Record<string, unknown> | undefined {
  const labels = series.labels;
  if (!labels || (!labels.value && !labels.percent && !labels.category && !labels.series)) return undefined;
  const pie = plot.type === ChartPlotType.Pie || plot.type === ChartPlotType.Doughnut;
  const position = labels.position === 'inEnd' || labels.position === 'ctr' || labels.position === 'inBase' ? 'inside'
    : pie ? (labels.position === 'outEnd' || labels.position === 'bestFit' ? 'outside' : 'inside') : 'top';
  return {
    show: true, position, color: position === 'inside' && pie ? '#FFFFFF' : TEXT, fontSize: 11,
    formatter: (params: { value: unknown; percent?: number; name?: string; seriesName?: string }) => {
      const parts: string[] = [];
      if (labels.series && params.seriesName) parts.push(params.seriesName);
      if (labels.category && params.name) parts.push(params.name);
      const raw = Array.isArray(params.value) ? params.value[params.value.length - 1] : params.value;
      if (labels.value && typeof raw === 'number') parts.push(formatted(raw, formatCode));
      if (labels.percent && typeof params.percent === 'number') parts.push(`${Math.round(params.percent)}%`);
      return parts.join(', ');
    },
  };
}

function legendOption(spec: ChartSpec, hasTitle: boolean): Record<string, unknown> | undefined {
  if (!spec.legend) return undefined;
  const base = { textStyle: { color: TEXT, fontSize: 12 }, itemWidth: 10, itemHeight: 10, type: 'scroll' };
  switch (spec.legend.position) {
    case 'r': return { ...base, orient: 'vertical', right: 8, top: 'middle' };
    case 'l': return { ...base, orient: 'vertical', left: 8, top: 'middle' };
    case 't': return { ...base, orient: 'horizontal', top: hasTitle ? 34 : 8, left: 'center' };
    case 'tr': return { ...base, orient: 'vertical', right: 8, top: 8 };
    default: return { ...base, orient: 'horizontal', bottom: 6, left: 'center' };
  }
}

/** Which sides of the plot carry an axis title, which the grid makes room for. */
interface TitledSides { bottom?: boolean; left?: boolean; right?: boolean }
const AXIS_TITLE_SPACE = 22;

/** About how wide a label draws at 12 px: CJK characters take twice a digit's width. */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e80 ? 12 : 7;
  return width;
}

/** How wide a value axis's labels draw: its round top tick, as the data's largest value suggests. */
function valueLabelWidth(values: (number | null)[], formatCode: string | undefined, percent: boolean): number {
  if (percent) return textWidth('100%');
  const numbers = values.filter((value): value is number => value !== null);
  const largest = Math.max(0, ...numbers.map(Math.abs));
  const top = largest > 0 ? 10 ** Math.ceil(Math.log10(largest)) : 1;
  return Math.max(textWidth(formatted(top, formatCode)), numbers.some(value => value < 0) ? textWidth(formatted(-top, formatCode)) : 0);
}

function gridOption(spec: ChartSpec, hasTitle: boolean, titled: TitledSides = {}): Record<string, unknown> {
  const position = spec.legend?.position;
  return {
    containLabel: true,
    top: (hasTitle ? 40 : 14) + (position === 't' ? 24 : 0),
    bottom: (position === 'b' || !position ? (spec.legend ? 34 : 12) : 12) + (titled.bottom ? AXIS_TITLE_SPACE : 0),
    left: (position === 'l' ? 90 : 12) + (titled.left ? AXIS_TITLE_SPACE : 0),
    right: (position === 'r' || position === 'tr' ? 110 : 16) + (titled.right ? AXIS_TITLE_SPACE : 0),
  };
}

/** An ECharts option for an Excel chart, or undefined when the chart cannot be drawn. */
export function chartOption(spec: ChartSpec, context: ChartOptionContext): EChartsOption | undefined {
  if (spec.unsupported || !spec.plots.length) return undefined;
  const { read } = context;
  const palette = spec.palette?.length ? spec.palette : DEFAULT_PALETTE;
  const titleText = spec.title ? (spec.title.ref ? read({ ref: spec.title.ref, cache: [spec.title.text ?? ''] }).text.join(' ') : spec.title.text ?? context.placeholderTitle) : undefined;
  const hasTitle = Boolean(titleText);
  const base: EChartsOption = {
    animation: false,
    backgroundColor: spec.background ?? '#FFFFFF',
    textStyle: { fontFamily: FONT },
    ...(hasTitle ? { title: { text: titleText, left: 'center', top: 8, textStyle: { color: TEXT, fontSize: 18, fontWeight: 'normal' } } } : {}),
    ...(spec.legend ? { legend: legendOption(spec, hasTitle) } : {}),
    tooltip: { confine: true },
  };
  const first = spec.plots[0];
  let seriesIndex = 0;

  if (first.type === ChartPlotType.Pie || first.type === ChartPlotType.Doughnut) {
    const series = first.series[0];
    if (!series) return undefined;
    const values = read(series.values);
    const categories = read(series.categories);
    const doughnut = first.type === ChartPlotType.Doughnut;
    const data = values.values.map((value, index) => ({
      name: categories.text[index] ?? String(index + 1),
      value: numberOf(value) ?? 0,
      itemStyle: { color: series.pointColors?.[index] ?? seriesColor(palette, index), borderColor: '#FFFFFF', borderWidth: 1 },
    }));
    return {
      ...base,
      tooltip: { trigger: 'item', confine: true },
      series: [{
        type: 'pie', name: nameOf(series, context, 0), data,
        radius: doughnut ? [`${Math.max(10, Math.min(90, first.holeSize ?? 50)) * 0.7}%`, '70%'] : '70%',
        center: ['50%', hasTitle ? '56%' : '52%'],
        startAngle: 90 - (first.firstSliceAngle ?? 0),
        clockwise: true,
        label: labelOption(series, values.formatCode, first) ?? { show: false },
        labelLine: { show: Boolean(series.labels?.position === 'outEnd' || series.labels?.position === 'bestFit') },
      }],
    };
  }

  if (first.type === ChartPlotType.Radar) {
    const categories = read(first.series[0]?.categories);
    const all = first.series.map(series => read(series.values).values.map(numberOf));
    const max = Math.max(1, ...all.flat().filter((value): value is number => value !== null));
    return {
      ...base,
      radar: { indicator: categories.text.map(name => ({ name, max })), axisName: { color: TEXT }, splitLine: { lineStyle: { color: LINE } }, splitArea: { show: false } },
      series: [{
        type: 'radar',
        data: first.series.map((series, index) => {
          const color = series.lineColor ?? series.color ?? seriesColor(palette, index);
          return { name: nameOf(series, context, index), value: all[index].map(value => value ?? 0), lineStyle: { color }, itemStyle: { color }, ...(first.radarStyle === 'filled' ? { areaStyle: { color, opacity: 0.4 } } : {}) };
        }),
      }],
    };
  }

  if (first.type === ChartPlotType.Scatter || first.type === ChartPlotType.Bubble) {
    const series: SeriesOption[] = [];
    for (const plot of spec.plots) {
      for (const item of plot.series) {
        const color = item.marker?.color ?? item.color ?? seriesColor(palette, seriesIndex);
        const ys = read(item.values).values.map(numberOf);
        const xs = item.x ? read(item.x).values.map(numberOf) : ys.map((_value, index) => index + 1);
        const sizes = item.sizes ? read(item.sizes).values.map(numberOf) : [];
        const largest = Math.max(1, ...sizes.filter((value): value is number => value !== null));
        const data = ys.map((y, index) => (y === null || xs[index] === null ? null : plot.type === ChartPlotType.Bubble ? [xs[index]!, y, sizes[index] ?? 0] : [xs[index]!, y]))
          .filter((point): point is number[] => point !== null);
        const showLine = plot.type === ChartPlotType.Scatter && !item.noLine && (plot.scatterStyle ?? '').includes('line') && item.lineColor !== undefined;
        series.push({
          type: showLine ? 'line' : 'scatter',
          name: nameOf(item, context, seriesIndex),
          data,
          itemStyle: { color },
          ...(plot.type === ChartPlotType.Bubble ? { symbolSize: (value: number[]) => 8 + 40 * Math.sqrt(Math.max(0, value[2] ?? 0) / largest) } : { symbolSize: item.marker?.size ? item.marker.size * 1.4 : 7 }),
          ...(showLine ? { lineStyle: { color: item.lineColor ?? color, width: item.lineWidth ?? 2 }, smooth: Boolean(item.smooth) } : {}),
          label: labelOption(item, read(item.values).formatCode, plot) ?? { show: false },
        } as SeriesOption);
        seriesIndex++;
      }
    }
    return {
      ...base,
      tooltip: { trigger: 'item', confine: true },
      grid: gridOption(spec, hasTitle, { bottom: Boolean(spec.categoryAxis?.title), left: Boolean(spec.valueAxis?.title) }),
      xAxis: axisOption(spec.categoryAxis, 'value', { splitLine: { show: Boolean(spec.categoryAxis?.gridlines), lineStyle: { color: LINE } }, axisLine: { show: true, lineStyle: { color: LINE } } }),
      yAxis: axisOption(spec.valueAxis, 'value', { nameGap: valueLabelWidth(series.flatMap(item => (item.data as number[][]).map(point => point[1])), spec.valueAxis?.formatCode, false) + 16 }),
      series,
    };
  }

  // Bar, line and area plots share a category axis; a combo chart may add a secondary value axis.
  const horizontal = spec.plots.some(plot => plot.type === ChartPlotType.Bar && plot.horizontal);
  const categorySource = spec.plots.flatMap(plot => plot.series).find(series => series.categories)?.categories;
  const categories = read(categorySource);
  const length = Math.max(categories.text.length, ...spec.plots.flatMap(plot => plot.series).map(series => read(series.values).values.length));
  const categoryNames = Array.from({ length }, (_unused, index) => categories.text[index] ?? String(index + 1));
  const series: SeriesOption[] = [];
  let percent = false;
  spec.plots.forEach((plot, plotIndex) => {
    const stacked = plot.grouping === 'stacked' || plot.grouping === 'percentStacked';
    const allValues = plot.series.map(item => read(item.values).values.map(numberOf));
    const totals = categoryNames.map((_name, index) => allValues.reduce((sum, values) => sum + Math.abs(values[index] ?? 0), 0));
    if (plot.grouping === 'percentStacked') percent = true;
    plot.series.forEach((item, index) => {
      const values = allValues[index];
      const data = values.map((value, point) => (plot.grouping === 'percentStacked' && value !== null ? (totals[point] ? (value / totals[point]) * 100 : 0) : value));
      const color = item.color ?? item.lineColor ?? seriesColor(palette, seriesIndex);
      const formatCode = read(item.values).formatCode;
      const common = {
        name: nameOf(item, context, seriesIndex),
        data,
        ...(plot.secondary ? { yAxisIndex: horizontal ? undefined : 1, xAxisIndex: horizontal ? 1 : undefined } : {}),
        ...(stacked ? { stack: `plot-${plotIndex}` } : {}),
        label: labelOption(item, formatCode, plot),
      };
      if (plot.type === ChartPlotType.Bar) {
        const colors = item.pointColors;
        series.push({
          ...common, type: 'bar',
          itemStyle: { color },
          ...(colors ? { data: data.map((value, point) => (colors[point] ? { value, itemStyle: { color: colors[point] } } : value)) } : {}),
          barGap: `${-(plot.overlap ?? (stacked ? 100 : 0))}%`,
          barCategoryGap: `${Math.round((100 * (plot.gapWidth ?? 150)) / ((plot.gapWidth ?? 150) + 100 * Math.max(1, stacked ? 1 : plot.series.length)))}%`,
        } as SeriesOption);
      } else {
        const lineColor = item.lineColor ?? color;
        series.push({
          ...common, type: 'line',
          smooth: Boolean(item.smooth),
          connectNulls: false,
          showSymbol: plot.type === ChartPlotType.Line && item.marker?.symbol !== 'none',
          symbol: item.marker?.symbol === 'none' ? 'none' : item.marker?.symbol === 'square' ? 'rect' : item.marker?.symbol === 'triangle' ? 'triangle' : item.marker?.symbol === 'diamond' ? 'diamond' : 'circle',
          symbolSize: item.marker?.size ? item.marker.size * 1.2 : 6,
          itemStyle: { color: item.marker?.color ?? lineColor },
          lineStyle: { color: lineColor, width: item.noLine ? 0 : item.lineWidth ?? 2.25 },
          ...(plot.type === ChartPlotType.Area ? { areaStyle: { color, opacity: stacked ? 1 : 0.85 }, lineStyle: { width: 0 }, showSymbol: false } : {}),
        } as SeriesOption);
      }
      seriesIndex++;
    });
  });
  // A title beside an axis sits clear of its labels.
  const primaryValues = series.filter(item => !(item as { yAxisIndex?: number; xAxisIndex?: number }).yAxisIndex && !(item as { xAxisIndex?: number }).xAxisIndex)
    .flatMap(item => ((item.data ?? []) as unknown[]).map(point => (typeof point === 'number' ? point : numberOf((point as { value?: number } | null)?.value ?? null))));
  const sideGap = horizontal ? Math.max(0, ...categoryNames.map(textWidth)) + 16 : valueLabelWidth(primaryValues, spec.valueAxis?.formatCode, percent) + 16;
  const valueAxis = axisOption(spec.valueAxis, 'value', {
    ...(percent ? { max: 100, axisLabel: { color: TEXT, fontSize: 12, formatter: (value: number) => `${value}%` } } : {}),
    ...(horizontal ? {} : { nameGap: sideGap }),
  });
  const secondary = spec.plots.some(plot => plot.secondary) ? axisOption(spec.secondaryValueAxis, 'value', { splitLine: { show: false } }) : undefined;
  const categoryAxis = axisOption(spec.categoryAxis, 'category', { data: categoryNames, boundaryGap: spec.plots.some(plot => plot.type === ChartPlotType.Bar), ...(horizontal ? { nameGap: sideGap } : {}) });
  const [bottomAxis, leftAxis] = horizontal ? [spec.valueAxis, spec.categoryAxis] : [spec.categoryAxis, spec.valueAxis];
  return {
    ...base,
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: spec.plots.some(plot => plot.type === ChartPlotType.Bar) ? 'shadow' : 'line' } },
    grid: gridOption(spec, hasTitle, { bottom: Boolean(bottomAxis?.title), left: Boolean(leftAxis?.title), right: Boolean(secondary && !horizontal && spec.secondaryValueAxis?.title) }),
    ...(horizontal
      ? { yAxis: categoryAxis, xAxis: secondary ? [valueAxis, secondary] : valueAxis }
      : { xAxis: categoryAxis, yAxis: secondary ? [valueAxis, secondary] : valueAxis }),
    series,
  } as EChartsOption;
}
