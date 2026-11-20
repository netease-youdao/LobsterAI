import type { EChartsOption, SeriesOption } from 'echarts';
import { BarChart, LineChart, PieChart, RadarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TitleComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

import {
  CHART_DEFAULT_PALETTE,
  CHART_FALLBACK_FONTS,
  type ChartAxisView,
  type ChartDataLabels,
  type ChartPlotView,
  formatChartNumber,
  hasVisibleChartLabel,
  SlideChartGrouping,
  SlideChartPlotType,
  type SlideChartView,
} from './slidesCharts';

/**
 * Turns a parsed `SlideChartView` into an ECharts option and synchronously renders it to a
 * self-contained vector SVG string using ECharts's SSR SVG renderer. Both the main stage and the
 * thumbnails use the resulting SVG, staying crisp at every zoom level with no DOM lifecycle leaks.
 */

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  SVGRenderer,
]);

const PX_PER_PT = 96 / 72;
const AXIS_TITLE_SPACE = 22;
const MAX_INTERVAL_TICKS = 100;

const ptToPx = (pt: number): number => Math.round(pt * PX_PER_PT * 100) / 100;

function seriesColor(palette: string[], index: number): string {
  const base = palette[index % palette.length] ?? CHART_DEFAULT_PALETTE[index % CHART_DEFAULT_PALETTE.length];
  const round = Math.floor(index / palette.length);
  if (!round || !/^#[0-9a-f]{6}$/i.test(base)) return base;
  const factor = round % 2 === 1 ? 0.65 : 1.35;
  const channels = [1, 3, 5].map(offset => Number.parseInt(base.slice(offset, offset + 2), 16));
  const adjusted = channels.map(channel => Math.max(0, Math.min(255, Math.round(factor < 1 ? channel * factor : channel + (255 - channel) * (factor - 1)))));
  return `#${adjusted.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function dashType(dash: string | undefined): 'solid' | 'dashed' | 'dotted' {
  if (!dash || dash === 'solid') return 'solid';
  if (dash.toLowerCase().includes('dot') && !dash.toLowerCase().includes('dash')) return 'dotted';
  return 'dashed';
}

function markerSymbol(symbol: string | undefined): string {
  switch (symbol) {
    case 'none': return 'none';
    case 'square': return 'rect';
    case 'triangle': return 'triangle';
    case 'diamond': return 'diamond';
    default: return 'circle';
  }
}

function textWidth(text: string, fontSizePx = 12): number {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) > 0x2e80 ? fontSizePx : fontSizePx * 0.6;
  return width;
}

function valueLabelWidth(
  values: (number | null)[],
  formatCode: string | undefined,
  percent: boolean,
  date1904: boolean,
  fontSizePx: number,
  axis?: ChartAxisView,
): number {
  if (percent) return textWidth('100%', fontSizePx);
  const numbers = values.filter((value): value is number => value !== null);
  const maxVal = axis?.max ?? Math.max(0, ...numbers.map(Math.abs));
  const minVal = axis?.min ?? Math.min(0, ...numbers);
  const top = maxVal > 0 ? 10 ** Math.ceil(Math.log10(maxVal)) : 1;
  const topWidth = textWidth(formatChartNumber(axis?.max ?? top, formatCode, date1904), fontSizePx);
  const negWidth = minVal < 0 ? textWidth(formatChartNumber(axis?.min ?? -top, formatCode, date1904), fontSizePx) : 0;
  return Math.max(topWidth, negWidth);
}

interface Defaults {
  text: string;
  gridline: string;
  axisLine: string;
  fontFamily: string;
  fontSizePx: number;
}

function chartDefaults(spec: SlideChartView): Defaults {
  return {
    text: spec.textStyle?.color ?? (spec.darkSurface ? '#CCCCCC' : '#595959'),
    gridline: spec.darkSurface ? 'rgba(255, 255, 255, 0.14)' : '#D9D9D9',
    axisLine: spec.darkSurface ? 'rgba(255, 255, 255, 0.25)' : '#D9D9D9',
    fontFamily: spec.textStyle?.fontFamily ?? CHART_FALLBACK_FONTS,
    fontSizePx: ptToPx(spec.textStyle?.sizePt ?? 9),
  };
}

function resolveLabelPosition(labels: ChartDataLabels, plot: ChartPlotView, negative = false): string {
  const pos = labels.position;
  if (plot.type === SlideChartPlotType.Pie || plot.type === SlideChartPlotType.Doughnut) {
    if (pos === 'outEnd') return 'outside';
    if (pos === 'inEnd' || pos === 'inBase' || pos === 'ctr') return 'inside';
    return labels.category ? 'outside' : 'inside';
  }
  if (plot.type === SlideChartPlotType.Bar) {
    const stacked = plot.grouping === SlideChartGrouping.Stacked || plot.grouping === SlideChartGrouping.PercentStacked;
    const effective = pos ?? (stacked ? 'ctr' : 'outEnd');
    if (plot.horizontal) {
      if (effective === 'inEnd') return 'insideRight';
      if (effective === 'inBase') return 'insideLeft';
      if (effective === 'ctr') return 'inside';
      return negative ? 'left' : 'right';
    }
    if (effective === 'inEnd') return 'insideTop';
    if (effective === 'inBase') return 'insideBottom';
    if (effective === 'ctr') return 'inside';
    return negative ? 'bottom' : 'top';
  }
  switch (pos) {
    case 'b': return 'bottom';
    case 'l': return 'left';
    case 'r': return 'right';
    case 'ctr': return 'inside';
    default: return 'top';
  }
}

function buildLabelConfig(
  labels: ChartDataLabels | undefined | null,
  plot: ChartPlotView,
  defaults: Defaults,
  fallbackFormat: string | undefined,
  date1904: boolean,
  rawValues?: (number | null)[],
  negative = false,
): Record<string, unknown> | undefined {
  if (!hasVisibleChartLabel(labels)) return undefined;
  const position = resolveLabelPosition(labels, plot, negative);
  const inside = position === 'inside' || position.startsWith('inside');
  const color = labels.style?.color ?? (inside ? '#FFFFFF' : defaults.text);
  const fontSize = ptToPx(labels.style?.sizePt ?? 9);
  const fontWeight = labels.style?.bold ? 'bold' : 'normal';
  const fontFamily = labels.style?.fontFamily ?? defaults.fontFamily;
  const formatCode = labels.formatCode && labels.sourceLinked === false ? labels.formatCode : fallbackFormat;
  const separator = labels.separator ?? ', ';

  return {
    show: true,
    position,
    color,
    fontSize,
    fontWeight,
    fontFamily,
    formatter: (params: { value: unknown; percent?: number; name?: string; seriesName?: string; dataIndex?: number }) => {
      const parts: string[] = [];
      if (labels.series && params.seriesName) parts.push(params.seriesName);
      if (labels.category && params.name) parts.push(params.name);
      const rawFromSeries = rawValues && params.dataIndex !== undefined ? rawValues[params.dataIndex] : undefined;
      const raw = rawFromSeries !== undefined
        ? rawFromSeries
        : Array.isArray(params.value)
          ? params.value[1]
          : params.value;
      if (labels.value && typeof raw === 'number') parts.push(formatChartNumber(raw, formatCode, date1904));
      if (labels.percent && typeof params.percent === 'number') {
        const pctFormat = formatCode && formatCode.includes('%') ? formatCode : '0%';
        parts.push(formatChartNumber(params.percent / 100, pctFormat, date1904));
      }
      if (labels.bubbleSize && Array.isArray(params.value) && typeof params.value[2] === 'number') {
        parts.push(formatChartNumber(params.value[2], formatCode, date1904));
      }
      return parts.join(separator);
    },
  };
}

function buildLegendOption(spec: SlideChartView, defaults: Defaults, hasTitle: boolean, titleHeight: number): Record<string, unknown> | undefined {
  if (!spec.legend) return undefined;
  const fontSize = ptToPx(spec.legend.style?.sizePt ?? 9);
  const base = {
    type: 'plain',
    textStyle: {
      color: spec.legend.style?.color ?? defaults.text,
      fontSize,
      fontWeight: spec.legend.style?.bold ? 'bold' : 'normal',
      fontFamily: spec.legend.style?.fontFamily ?? defaults.fontFamily,
    },
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 12,
  };
  switch (spec.legend.position) {
    case 'r': return { ...base, orient: 'vertical', right: 8, top: 'middle' };
    case 'l': return { ...base, orient: 'vertical', left: 8, top: 'middle' };
    case 't': return { ...base, orient: 'horizontal', top: hasTitle ? titleHeight + 12 : 6, left: 'center' };
    case 'tr': return { ...base, orient: 'vertical', right: 8, top: hasTitle ? titleHeight + 12 : 8 };
    default: return { ...base, orient: 'horizontal', bottom: 4, left: 'center' };
  }
}

function buildAxisOption(
  axis: ChartAxisView | undefined,
  kind: 'category' | 'value',
  defaults: Defaults,
  date1904: boolean,
  seriesFormatCode: string | undefined,
  extra: Record<string, unknown> = {},
  dataSpan?: number,
): Record<string, unknown> {
  const show = !axis?.deleted;
  const labelColor = axis?.labelStyle?.color ?? defaults.text;
  const labelFontSize = ptToPx(axis?.labelStyle?.sizePt ?? 9);
  const labelFontFamily = axis?.labelStyle?.fontFamily ?? defaults.fontFamily;
  const labelBold = axis?.labelStyle?.bold ? 'bold' : 'normal';
  const formatCode = axis?.formatCode && axis.sourceLinked === false ? axis.formatCode : (seriesFormatCode ?? axis?.formatCode);

  const showAxisLine = axis?.axisLine?.none
    ? false
    : axis?.axisLine?.color
      ? true
      : kind === 'category';
  const axisLineColor = axis?.axisLine?.color ?? defaults.axisLine;
  const axisLineWidth = ptToPx(axis?.axisLine?.widthPt ?? 0.75);

  const showGridlines = axis
    ? Boolean(axis.gridlines) && !axis.gridlineStyle?.none
    : kind === 'value';
  const gridColor = axis?.gridlineStyle?.color ?? defaults.gridline;
  const gridWidth = ptToPx(axis?.gridlineStyle?.widthPt ?? 0.75);

  const posMap: Record<string, string> = { b: 'bottom', t: 'top', l: 'left', r: 'right' };
  const useLog = kind === 'value' && axis?.logBase !== undefined && axis.logBase > 1;
  const safeInterval = kind === 'value' && axis?.majorUnit && axis.majorUnit > 0
    && (!dataSpan || dataSpan / axis.majorUnit <= MAX_INTERVAL_TICKS)
    ? axis.majorUnit
    : undefined;

  return {
    type: useLog ? 'log' : kind,
    ...(useLog ? { logBase: axis!.logBase } : {}),
    show,
    inverse: Boolean(axis?.reverse),
    ...(axis?.position && posMap[axis.position] ? { position: posMap[axis.position] } : {}),
    ...(axis?.title ? {
      name: axis.title.text,
      nameLocation: 'middle',
      nameGap: kind === 'category' ? 28 : 40,
      nameTextStyle: {
        color: axis.title.style?.color ?? defaults.text,
        fontSize: ptToPx(axis.title.style?.sizePt ?? 10),
        fontWeight: axis.title.style?.bold ? 'bold' : 'normal',
        fontFamily: axis.title.style?.fontFamily ?? defaults.fontFamily,
      },
    } : {}),
    axisLine: {
      show: showAxisLine,
      lineStyle: { color: axisLineColor, width: axisLineWidth, type: dashType(axis?.axisLine?.dash) },
    },
    axisTick: { show: false },
    axisLabel: {
      show: axis?.tickLabelPos !== 'none',
      color: labelColor,
      fontSize: labelFontSize,
      fontWeight: labelBold,
      fontFamily: labelFontFamily,
      hideOverlap: true,
      ...(axis?.labelRotate ? { rotate: axis.labelRotate } : {}),
      ...(kind === 'value' ? { formatter: (value: number) => formatChartNumber(value, formatCode, date1904) } : {}),
    },
    splitLine: {
      show: showGridlines,
      lineStyle: { color: gridColor, width: gridWidth, type: dashType(axis?.gridlineStyle?.dash) },
    },
    ...(kind === 'value' && axis?.min !== undefined ? { min: axis.min } : {}),
    ...(kind === 'value' && axis?.max !== undefined ? { max: axis.max } : {}),
    ...(safeInterval !== undefined ? { interval: safeInterval } : {}),
    ...extra,
  };
}

function outerCategoryAxis(
  labels: string[],
  length: number,
  level: number,
  horizontal: boolean,
  innerWidth: number,
  inverse: boolean,
  defaults: Defaults,
): Record<string, unknown> {
  const starts: number[] = [];
  for (let index = 0; index < length; index++) if (index === 0 || (labels[index] ?? '') !== '') starts.push(index);
  const data = Array.from({ length }, () => '');
  starts.forEach((start, group) => {
    data[Math.floor((start + (starts[group + 1] ?? length) - 1) / 2)] = labels[start] ?? '';
  });
  const separators = new Set(starts);
  const width = Math.max(0, ...data.map(item => textWidth(item, defaults.fontSizePx)));
  return {
    type: 'category',
    data,
    boundaryGap: true,
    inverse,
    position: horizontal ? 'left' : 'bottom',
    offset: horizontal ? innerWidth + 14 + level * (width + 14) : 22 * (level + 1),
    axisLine: { show: false },
    axisTick: { show: true, length: horizontal ? width + 12 : 20, interval: (index: number) => separators.has(index), lineStyle: { color: defaults.axisLine } },
    axisLabel: { interval: 0, color: defaults.text, fontSize: defaults.fontSizePx, fontFamily: defaults.fontFamily },
    splitLine: { show: false },
  };
}

interface TitledSides {
  bottom?: boolean;
  left?: boolean;
  right?: boolean;
}

function gridOption(
  spec: SlideChartView,
  hasTitle: boolean,
  titleHeight: number,
  hasTopLabels: boolean,
  titled: TitledSides = {},
): Record<string, unknown> {
  const legendPos = spec.legend && !spec.legend.overlay ? spec.legend.position : undefined;
  const topTitle = hasTitle && !spec.title?.overlay ? titleHeight + 16 : 0;
  const topBase = Math.max(topTitle, hasTopLabels ? 24 : 12);
  const top = topBase + (legendPos === 't' ? 26 : 0);
  const bottom = (legendPos === 'b' ? 34 : 10) + (titled.bottom ? AXIS_TITLE_SPACE : 0);
  const left = (legendPos === 'l' ? 96 : 10) + (titled.left ? AXIS_TITLE_SPACE : 0);
  const right = (legendPos === 'r' || legendPos === 'tr' ? 110 : 14) + (titled.right ? AXIS_TITLE_SPACE : 0);
  const showFrame = Boolean(spec.plotBackground || (spec.plotBorder?.color && !spec.plotBorder.none));
  return {
    containLabel: true,
    top,
    bottom,
    left,
    right,
    ...(showFrame ? {
      show: true,
      backgroundColor: spec.plotBackground ?? 'transparent',
      borderColor: spec.plotBorder?.none ? 'transparent' : (spec.plotBorder?.color ?? 'transparent'),
      borderWidth: spec.plotBorder?.none || !spec.plotBorder?.color ? 0 : ptToPx(spec.plotBorder.widthPt ?? 0.75),
    } : {}),
  };
}

/** Build an ECharts option for a PowerPoint chart, or undefined when it cannot be drawn. */
export function buildSlideChartOption(
  spec: SlideChartView,
  width: number,
  height: number,
  seriesName: (index: number) => string,
): EChartsOption | undefined {
  if (!spec.plots.length || width < 8 || height < 8) return undefined;
  const defaults = chartDefaults(spec);
  const palette = spec.palette.length ? spec.palette : CHART_DEFAULT_PALETTE;
  const date1904 = Boolean(spec.date1904);
  const titleFontSize = ptToPx(spec.title?.style?.sizePt ?? 14);
  const hasTitle = Boolean(spec.title?.text);
  const titleLines = hasTitle ? spec.title!.text.split('\n').length : 0;
  const titleHeight = hasTitle ? Math.ceil(titleFontSize * 1.3 * titleLines) : 0;

  const base: EChartsOption = {
    animation: false,
    backgroundColor: spec.background ?? 'transparent',
    textStyle: { fontFamily: defaults.fontFamily },
    ...(hasTitle ? {
      title: {
        text: spec.title!.text,
        left: 'center',
        top: 6,
        textStyle: {
          color: spec.title!.style?.color ?? defaults.text,
          fontSize: titleFontSize,
          fontWeight: spec.title!.style?.bold ? 'bold' : 'normal',
          fontFamily: spec.title!.style?.fontFamily ?? defaults.fontFamily,
          width: Math.max(40, width - 24),
          overflow: 'truncate',
        },
      },
    } : {}),
    ...(spec.legend ? { legend: buildLegendOption(spec, defaults, hasTitle, titleHeight) } : {}),
  };

  const first = spec.plots[0];
  let seriesIndex = 0;

  // ---- Pie & Doughnut -------------------------------------------------------------------------
  if (first.type === SlideChartPlotType.Pie || first.type === SlideChartPlotType.Doughnut) {
    const series = first.series[0];
    if (!series) return undefined;
    const doughnut = first.type === SlideChartPlotType.Doughnut;
    const categories = series.categories?.labels ?? [];
    const seriesLabel = buildLabelConfig(series.labels, first, defaults, series.valueFormatCode, date1904);
    let anyOutside = seriesLabel?.position === 'outside';

    const data = series.values.map((value, index) => {
      const pointSpec = series.pointLabels && Object.prototype.hasOwnProperty.call(series.pointLabels, index)
        ? series.pointLabels[index]
        : undefined;
      const pointLabel = pointSpec === null
        ? { show: false }
        : pointSpec !== undefined
          ? buildLabelConfig(pointSpec, first, defaults, series.valueFormatCode, date1904)
          : undefined;
      if (pointLabel && (pointLabel as { position?: string }).position === 'outside') anyOutside = true;
      const sliceBorderColor = series.line?.none ? 'transparent' : series.line?.color;
      const sliceBorderWidth = series.line?.none ? 0 : (series.line?.color ? ptToPx(series.line.widthPt ?? 0.75) : 0);
      return {
        name: categories[index] || String(index + 1),
        value: Math.max(0, value ?? 0),
        itemStyle: {
          color: series.pointColors?.[index] ?? seriesColor(palette, index),
          ...(sliceBorderColor ? { borderColor: sliceBorderColor, borderWidth: sliceBorderWidth } : {}),
        },
        ...(pointLabel ? { label: pointLabel, labelLine: { show: (pointLabel as { position?: string }).position === 'outside' } } : {}),
      };
    });

    const legendPos = spec.legend && !spec.legend.overlay ? spec.legend.position : undefined;
    const cx = legendPos === 'r' || legendPos === 'tr' ? '40%' : legendPos === 'l' ? '60%' : '50%';
    const cy = legendPos === 'b'
      ? (hasTitle ? '50%' : '45%')
      : legendPos === 't'
        ? (hasTitle ? '60%' : '55%')
        : (hasTitle ? '55%' : '50%');
    const outerPct = anyOutside ? 56 : 70;
    const hole = Math.max(10, Math.min(90, first.holeSize ?? 50));

    return {
      ...base,
      series: [{
        type: 'pie',
        silent: true,
        name: series.name || seriesName(0),
        data,
        radius: doughnut ? [`${Math.round((outerPct * hole) / 100)}%`, `${outerPct}%`] : `${outerPct}%`,
        center: [cx, cy],
        startAngle: 90 - (first.firstSliceAngle ?? 0),
        clockwise: true,
        label: seriesLabel ?? { show: false },
        labelLine: { show: anyOutside },
      }],
    };
  }

  // ---- Radar ----------------------------------------------------------------------------------
  if (first.type === SlideChartPlotType.Radar) {
    const categories = first.series[0]?.categories?.labels ?? [];
    const count = Math.max(categories.length, ...first.series.map(item => item.values.length));
    if (!count) return undefined;
    const allNums = first.series.flatMap(item => item.values.filter((v): v is number => v !== null));
    const maxVal = spec.valueAxis?.max ?? Math.max(1, ...allNums);
    const legendPos = spec.legend && !spec.legend.overlay ? spec.legend.position : undefined;
    const cy = legendPos === 'b' ? '46%' : hasTitle ? '55%' : '50%';
    return {
      ...base,
      radar: {
        center: ['50%', cy],
        radius: '62%',
        indicator: Array.from({ length: count }, (_, index) => ({
          name: categories[index] || String(index + 1),
          max: maxVal,
        })),
        axisName: {
          color: spec.categoryAxis?.labelStyle?.color ?? defaults.text,
          fontSize: ptToPx(spec.categoryAxis?.labelStyle?.sizePt ?? 9),
          fontFamily: spec.categoryAxis?.labelStyle?.fontFamily ?? defaults.fontFamily,
        },
        axisLine: { lineStyle: { color: spec.valueAxis?.gridlineStyle?.color ?? defaults.gridline } },
        splitLine: { lineStyle: { color: spec.valueAxis?.gridlineStyle?.color ?? defaults.gridline } },
        splitArea: { show: false },
      },
      series: [{
        type: 'radar',
        silent: true,
        data: first.series.map((item, index) => {
          const color = item.line?.color ?? item.color ?? seriesColor(palette, index);
          return {
            name: item.name || seriesName(index),
            value: Array.from({ length: count }, (_, point) => item.values[point] ?? 0),
            lineStyle: { color, width: ptToPx(item.line?.widthPt ?? 1.5) },
            itemStyle: { color },
            ...(first.radarStyle === 'filled' ? { areaStyle: { color, opacity: 0.35 } } : {}),
          };
        }),
      }],
    };
  }

  // ---- Scatter & Bubble -----------------------------------------------------------------------
  if (first.type === SlideChartPlotType.Scatter || first.type === SlideChartPlotType.Bubble) {
    const series: SeriesOption[] = [];
    const allX: number[] = [];
    const allY: number[] = [];
    for (const plot of spec.plots) {
      for (const item of plot.series) {
        const color = item.marker?.color ?? item.color ?? item.line?.color ?? seriesColor(palette, seriesIndex);
        const xs = item.x ?? item.values.map((_, index) => index + 1);
        const ys = item.values;
        const sizes = item.sizes ?? [];
        const largest = Math.max(1, ...sizes.filter((value): value is number => value !== null));
        const data = ys
          .map((y, index) => {
            const x = xs[index];
            if (y === null || x === null || x === undefined) return null;
            allX.push(x);
            allY.push(y);
            return plot.type === SlideChartPlotType.Bubble ? [x, y, sizes[index] ?? 0] : [x, y];
          })
          .filter((point): point is number[] => point !== null);
        const style = plot.scatterStyle ?? '';
        const hasLine = plot.type === SlideChartPlotType.Scatter && !item.line?.none
          && (style === 'line' || style === 'lineMarker' || style === 'smooth' || style === 'smoothMarker');
        const hasMarker = item.marker?.symbol !== 'none' && style !== 'line' && style !== 'smooth';
        const isSmooth = Boolean(item.smooth) || style === 'smooth' || style === 'smoothMarker';
        const lineColor = item.line?.color ?? color;
        series.push({
          type: hasLine ? 'line' : 'scatter',
          silent: true,
          name: item.name || seriesName(seriesIndex),
          data,
          itemStyle: { color },
          ...(plot.type === SlideChartPlotType.Bubble
            ? { symbolSize: (value: number[]) => 8 + 38 * Math.sqrt(Math.max(0, value[2] ?? 0) / largest) }
            : {
              showSymbol: hasMarker,
              symbol: markerSymbol(item.marker?.symbol),
              symbolSize: item.marker?.size ? item.marker.size * 1.4 : 7,
            }),
          ...(hasLine ? {
            lineStyle: { color: lineColor, width: ptToPx(item.line?.widthPt ?? 1.75), type: dashType(item.line?.dash) },
            smooth: isSmooth,
          } : {}),
          label: buildLabelConfig(item.labels, plot, defaults, item.valueFormatCode, date1904) ?? { show: false },
        } as SeriesOption);
        seriesIndex++;
      }
    }
    const xSpan = allX.length ? (spec.categoryAxis?.max ?? Math.max(...allX)) - (spec.categoryAxis?.min ?? Math.min(...allX)) : undefined;
    const ySpan = allY.length ? (spec.valueAxis?.max ?? Math.max(...allY)) - (spec.valueAxis?.min ?? Math.min(...allY)) : undefined;
    const yFontSize = ptToPx(spec.valueAxis?.labelStyle?.sizePt ?? 9);
    const yNameGap = valueLabelWidth(allY, spec.valueAxis?.formatCode, false, date1904, yFontSize, spec.valueAxis) + 16;
    const xFormat = spec.plots[0].series[0]?.xFormatCode;
    const yFormat = spec.plots[0].series[0]?.valueFormatCode;
    return {
      ...base,
      grid: gridOption(spec, hasTitle, titleHeight, false, {
        bottom: Boolean(spec.categoryAxis?.title),
        left: Boolean(spec.valueAxis?.title),
      }),
      xAxis: buildAxisOption(spec.categoryAxis, 'value', defaults, date1904, xFormat, {
        axisLine: {
          show: !spec.categoryAxis?.axisLine?.none,
          lineStyle: { color: spec.categoryAxis?.axisLine?.color ?? defaults.axisLine },
        },
      }, xSpan),
      yAxis: buildAxisOption(spec.valueAxis, 'value', defaults, date1904, yFormat, { nameGap: yNameGap }, ySpan),
      series,
    };
  }

  // ---- Bar / Column / Line / Area / Combo -----------------------------------------------------
  const horizontal = spec.plots.some(plot => plot.type === SlideChartPlotType.Bar && plot.horizontal);
  const categoryData = spec.plots.flatMap(plot => plot.series).find(item => item.categories)?.categories;
  const rawCategories = categoryData?.labels ?? [];
  const length = Math.max(rawCategories.length, ...spec.plots.flatMap(plot => plot.series).map(item => item.values.length));
  if (!length) return undefined;
  const categoryNames = Array.from({ length }, (_, index) => rawCategories[index] ?? String(index + 1));

  const series: SeriesOption[] = [];
  let percentStacked = false;
  let hasTopLabels = false;
  let hasNegativeValues = false;
  const primaryValues: (number | null)[] = [];
  const secondaryValues: (number | null)[] = [];

  spec.plots.forEach((plot, plotIndex) => {
    const stacked = plot.grouping === SlideChartGrouping.Stacked || plot.grouping === SlideChartGrouping.PercentStacked;
    const isPercent = plot.grouping === SlideChartGrouping.PercentStacked;
    if (isPercent) percentStacked = true;
    const rawLists = plot.series.map(item => (
      spec.dispBlanksAs === 'zero'
        ? item.values.map(v => v ?? 0)
        : item.values
    ));
    const totals = categoryNames.map((_, index) => rawLists.reduce((sum, list) => sum + Math.abs(list[index] ?? 0), 0));
    const varyByPoint = Boolean(plot.varyColors && plot.series.length === 1);

    plot.series.forEach((item, index) => {
      const raw = rawLists[index];
      const plotted = raw.map((value, point) => {
        if (value === null) return null;
        if (value < 0) hasNegativeValues = true;
        return isPercent ? (totals[point] ? (value / totals[point]) * 100 : 0) : value;
      });
      if (plot.secondary) secondaryValues.push(...plotted);
      else primaryValues.push(...plotted);

      const color = item.color ?? item.line?.color ?? seriesColor(palette, seriesIndex);
      const seriesLabel = buildLabelConfig(item.labels, plot, defaults, item.valueFormatCode, date1904, isPercent ? raw : undefined);
      if (seriesLabel?.position === 'top') hasTopLabels = true;
      if (!hasTopLabels && item.pointLabels) {
        for (const pointSpec of Object.values(item.pointLabels)) {
          if (hasVisibleChartLabel(pointSpec) && resolveLabelPosition(pointSpec, plot) === 'top') {
            hasTopLabels = true;
            break;
          }
        }
      }

      const common = {
        name: item.name || seriesName(seriesIndex),
        silent: true,
        ...(plot.secondary ? { yAxisIndex: horizontal ? undefined : 1, xAxisIndex: horizontal ? 1 : undefined } : {}),
        ...(stacked ? { stack: `plot-${plotIndex}` } : {}),
        ...(seriesLabel ? { label: seriesLabel } : {}),
      };

      if (plot.type === SlideChartPlotType.Bar) {
        const barCount = stacked ? 1 : plot.series.length;
        const overlapVal = plot.overlap ?? (stacked ? 100 : 0);
        const clusterUnits = stacked ? 1 : Math.max(1, barCount - (barCount - 1) * (overlapVal / 100));
        const gapUnits = (plot.gapWidth ?? 150) / 100;
        const barCategoryGap = `${Math.round((100 * gapUnits) / (clusterUnits + gapUnits))}%`;

        const borderColor = item.line?.none ? undefined : item.line?.color;
        const borderWidth = borderColor ? ptToPx(item.line?.widthPt ?? 0.75) : 0;

        const barData = plotted.map((value, point) => {
          const pointColor = item.pointColors?.[point] ?? (varyByPoint && !item.color ? seriesColor(palette, point) : undefined);
          const pointLabelSpec = item.pointLabels && Object.prototype.hasOwnProperty.call(item.pointLabels, point)
            ? item.pointLabels[point]
            : undefined;
          const isNegOutEnd = value !== null && value < 0 && hasVisibleChartLabel(item.labels) && (!item.labels.position || item.labels.position === 'outEnd');
          const pointLabel = pointLabelSpec === null
            ? { show: false }
            : pointLabelSpec !== undefined
              ? buildLabelConfig(pointLabelSpec, plot, defaults, item.valueFormatCode, date1904, isPercent ? raw : undefined, (value ?? 0) < 0)
              : isNegOutEnd
                ? buildLabelConfig(item.labels, plot, defaults, item.valueFormatCode, date1904, isPercent ? raw : undefined, true)
                : undefined;
          if (!pointColor && !pointLabel) return value;
          return {
            value,
            ...(pointColor ? { itemStyle: { color: pointColor } } : {}),
            ...(pointLabel ? { label: pointLabel } : {}),
          };
        });

        series.push({
          ...common,
          type: 'bar',
          data: barData,
          itemStyle: {
            color: item.noFill ? 'transparent' : color,
            ...(borderColor ? { borderColor, borderWidth } : {}),
          },
          barGap: `${-overlapVal}%`,
          barCategoryGap,
        } as SeriesOption);
      } else {
        const lineColor = item.line?.color ?? color;
        const isArea = plot.type === SlideChartPlotType.Area;
        const showSymbol = !isArea && (
          item.marker
            ? item.marker.symbol !== 'none'
            : plot.showMarkers !== false
        );
        const lineData = item.pointLabels
          ? plotted.map((value, point) => {
            const pointLabelSpec = Object.prototype.hasOwnProperty.call(item.pointLabels!, point) ? item.pointLabels![point] : undefined;
            if (pointLabelSpec === undefined) return value;
            return {
              value,
              label: pointLabelSpec === null
                ? { show: false }
                : buildLabelConfig(pointLabelSpec, plot, defaults, item.valueFormatCode, date1904, isPercent ? raw : undefined),
            };
          })
          : plotted;

        series.push({
          ...common,
          type: 'line',
          data: lineData,
          smooth: Boolean(item.smooth),
          connectNulls: spec.dispBlanksAs === 'span',
          showSymbol,
          symbol: markerSymbol(item.marker?.symbol),
          symbolSize: item.marker?.size ? item.marker.size * 1.2 : 6,
          itemStyle: {
            color: item.marker?.color ?? lineColor,
            ...(item.marker?.borderColor ? { borderColor: item.marker.borderColor, borderWidth: 1 } : {}),
          },
          lineStyle: {
            color: lineColor,
            width: item.line?.none ? 0 : ptToPx(item.line?.widthPt ?? 1.75),
            type: dashType(item.line?.dash),
          },
          ...(isArea ? {
            areaStyle: { color: item.noFill ? 'transparent' : color, opacity: stacked ? 0.92 : 0.78 },
            lineStyle: { color: lineColor, width: item.line?.none ? 0 : ptToPx(item.line?.widthPt ?? 1) },
            showSymbol: false,
          } : {}),
        } as SeriesOption);
      }
      seriesIndex++;
    });
  });

  const primarySeriesFormat = spec.plots.find(p => !p.secondary)?.series[0]?.valueFormatCode;
  const secondarySeriesFormat = spec.plots.find(p => p.secondary)?.series[0]?.valueFormatCode;
  const valFontSize = ptToPx(spec.valueAxis?.labelStyle?.sizePt ?? 9);
  const catFontSize = ptToPx(spec.categoryAxis?.labelStyle?.sizePt ?? 9);
  const primaryNums = primaryValues.filter((v): v is number => v !== null);
  const primarySpan = primaryNums.length
    ? (spec.valueAxis?.max ?? Math.max(0, ...primaryNums)) - (spec.valueAxis?.min ?? Math.min(0, ...primaryNums))
    : undefined;
  const secondaryNums = secondaryValues.filter((v): v is number => v !== null);
  const secondarySpan = secondaryNums.length
    ? (spec.secondaryValueAxis?.max ?? Math.max(0, ...secondaryNums)) - (spec.secondaryValueAxis?.min ?? Math.min(0, ...secondaryNums))
    : undefined;

  const sideGap = horizontal
    ? Math.max(0, ...categoryNames.map(name => textWidth(name, catFontSize))) + 14
    : valueLabelWidth(primaryValues, spec.valueAxis?.formatCode ?? primarySeriesFormat, percentStacked, date1904, valFontSize, spec.valueAxis) + 14;

  const valueAxis = buildAxisOption(spec.valueAxis, 'value', defaults, date1904, primarySeriesFormat, {
    ...(percentStacked ? {
      max: spec.valueAxis?.max ?? 100,
      axisLabel: {
        show: spec.valueAxis?.tickLabelPos !== 'none',
        color: spec.valueAxis?.labelStyle?.color ?? defaults.text,
        fontSize: valFontSize,
        fontFamily: spec.valueAxis?.labelStyle?.fontFamily ?? defaults.fontFamily,
        formatter: (value: number) => `${value}%`,
      },
    } : {}),
    ...(horizontal ? {} : { nameGap: sideGap }),
  }, primarySpan);

  const hasSecondary = spec.plots.some(plot => plot.secondary);
  const secondaryAxis = hasSecondary
    ? buildAxisOption(spec.secondaryValueAxis, 'value', defaults, date1904, secondarySeriesFormat, {
      position: horizontal ? 'top' : 'right',
      splitLine: { show: false },
    }, secondarySpan)
    : undefined;

  const keepAxisAtBottom = hasNegativeValues && spec.categoryAxis?.tickLabelPos === 'low';
  const categoryAxis = buildAxisOption(spec.categoryAxis, 'category', defaults, date1904, undefined, {
    data: categoryNames,
    boundaryGap: spec.plots.some(plot => plot.type === SlideChartPlotType.Bar),
    ...(keepAxisAtBottom ? {
      axisLine: {
        show: !spec.categoryAxis?.axisLine?.none,
        onZero: false,
        lineStyle: {
          color: spec.categoryAxis?.axisLine?.color ?? defaults.axisLine,
          width: ptToPx(spec.categoryAxis?.axisLine?.widthPt ?? 0.75),
        },
      },
    } : {}),
    ...(horizontal ? { nameGap: sideGap } : {}),
  });

  const innerWidth = Math.max(0, ...categoryNames.map(name => textWidth(name, catFontSize)));
  const outerLevels = spec.categoryAxis?.noMultiLevelLabels ? [] : (categoryData?.levels ?? []);
  const outerAxes = outerLevels.map((labels, level) => outerCategoryAxis(
    labels,
    length,
    level,
    horizontal,
    innerWidth,
    Boolean(spec.categoryAxis?.reverse),
    defaults,
  ));
  const categoryAxes = outerAxes.length ? [categoryAxis, ...outerAxes] : categoryAxis;

  const [bottomAxis, leftAxis] = horizontal ? [spec.valueAxis, spec.categoryAxis] : [spec.categoryAxis, spec.valueAxis];

  return {
    ...base,
    grid: gridOption(spec, hasTitle, titleHeight, hasTopLabels, {
      bottom: Boolean(bottomAxis?.title),
      left: Boolean(leftAxis?.title),
      right: Boolean(secondaryAxis && !horizontal && spec.secondaryValueAxis?.title),
    }),
    ...(horizontal
      ? { yAxis: categoryAxes, xAxis: secondaryAxis ? [valueAxis, secondaryAxis] : valueAxis }
      : { xAxis: categoryAxes, yAxis: secondaryAxis ? [valueAxis, secondaryAxis] : valueAxis }),
    series,
  } as EChartsOption;
}

/**
 * Render a parsed `SlideChartView` synchronously to a standalone SVG string at the given box size.
 * Returns `undefined` when the chart cannot be rendered (the caller falls back to a placeholder).
 */
export function renderSlideChartSvg(
  spec: SlideChartView,
  width: number,
  height: number,
  seriesName: (index: number) => string,
): string | undefined {
  const safeWidth = Math.round(width);
  const safeHeight = Math.round(height);
  if (safeWidth < 8 || safeHeight < 8) return undefined;
  const option = buildSlideChartOption(spec, safeWidth, safeHeight, seriesName);
  if (!option) return undefined;
  let instance: echarts.ECharts | undefined;
  try {
    instance = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: safeWidth, height: safeHeight });
    instance.setOption(option);
    return instance.renderToSVGString();
  } catch (error) {
    console.warn('[SlidesChart] Could not render a chart:', error);
    return undefined;
  } finally {
    instance?.dispose();
  }
}
