import type { IWorkbookData } from '@univerjs/core';
import { describe, expect, test } from 'vitest';

import { categoryLevels, chartOption, type ResolvedData } from './sheetChartOption';
import {
  ChartAxisKind, type ChartCell, chartFromRange, ChartKind, chartKind, chartSourceRange, ChartStacking, chartStacking, hasDataLabels, hasGridlines, LegendPosition,
  withAxisTitle, withChartData, withChartKind, withChartTitle, withDataLabels, withGridlines, withLegend, withSeriesColor, withStacking,
} from './sheetChartSpec';
import { ChartPlotType, parseChart } from './xlsxCharts';
import { chartPartXml, snapshotChartReader } from './xlsxChartWriter';
import { XlsxStyles } from './xlsxStyles';

const styles = new XlsxStyles(undefined, undefined, 'en');
// Region / Q1 / Q2 over three rows, on a sheet whose name needs quotes.
const GRID: unknown[][] = [
  ['Region', 'Q1', 'Q2'],
  ['North', 10, 12],
  ['South', 7, 9],
  ['East', 3, 15],
];
const cell = (row: number, column: number): ChartCell => {
  const value = GRID[row]?.[column];
  return { value: value ?? null, text: value === undefined || value === null ? '' : String(value) };
};
const RANGE = { startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 };
const reader = (source: { ref?: string; cache: (string | number | null)[] }): ResolvedData => {
  const match = /!\$([A-Z])\$(\d+)(?::\$([A-Z])\$(\d+))?$/.exec(source.ref ?? '');
  if (!match) return { values: source.cache, text: source.cache.map(value => String(value ?? '')) };
  const [, c1, r1, c2 = c1, r2 = r1] = match;
  const values: (string | number | null)[] = [];
  for (let row = Number(r1) - 1; row <= Number(r2) - 1; row++) {
    for (let column = c1.charCodeAt(0) - 65; column <= c2.charCodeAt(0) - 65; column++) values.push((GRID[row]?.[column] as string | number | undefined) ?? null);
  }
  return { values, text: values.map(value => (value === null ? '' : String(value))) };
};

describe('charts made in the editor', () => {
  test('a block with a header row and a category column becomes one series per column', () => {
    const spec = chartFromRange(ChartKind.Column, 'Q1 Sales', RANGE, cell)!;
    expect(spec.plots).toEqual([{
      type: ChartPlotType.Bar, grouping: 'clustered', series: [
        { name: { ref: "'Q1 Sales'!$B$1", cache: [] }, values: { ref: "'Q1 Sales'!$B$2:$B$4", cache: [] }, categories: { ref: "'Q1 Sales'!$A$2:$A$4", cache: [] } },
        { name: { ref: "'Q1 Sales'!$C$1", cache: [] }, values: { ref: "'Q1 Sales'!$C$2:$C$4", cache: [] }, categories: { ref: "'Q1 Sales'!$A$2:$A$4", cache: [] } },
      ],
    }]);
    // Excel 2013 and later: the legend below, and the "Chart Title" placeholder over several series.
    expect(spec.legend).toEqual({ position: LegendPosition.Bottom });
    expect(spec.title).toEqual({});
    const xml = chartPartXml(spec, reader);
    expect(xml).toContain('<c:title><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>');
    expect(parseChart(xml, styles).title).toEqual({});
    // A second column of labels is not plotted.
    const labelled = chartFromRange(ChartKind.Column, 'S', RANGE, (row, column) => (column === 1 ? { value: `x${row}`, text: `x${row}` } : cell(row, column)))!;
    expect(labelled.plots[0].series.map(series => series.values.ref)).toEqual(['S!$C$2:$C$4']);
    // Text alone makes no chart.
    expect(chartFromRange(ChartKind.Column, 'S', { startRow: 0, endRow: 3, startColumn: 0, endColumn: 0 }, cell)).toBeUndefined();
  });

  test('a single series is titled with its name and has no legend; pies keep one series', () => {
    const single = chartFromRange(ChartKind.Line, 'S', { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }, cell)!;
    expect(single.title).toEqual({ ref: 'S!$B$1' });
    expect(single.legend).toBeUndefined();
    const pie = chartFromRange(ChartKind.Pie, 'S', RANGE, cell)!;
    expect(pie.plots[0].series).toHaveLength(1);
    expect(pie.legend).toEqual({ position: LegendPosition.Bottom });
    expect(pie.title).toEqual({ ref: 'S!$B$1' });
  });

  test('written chart parts read back as the same chart', () => {
    for (const kind of Object.values(ChartKind)) {
      const spec = withLegend(withChartTitle(chartFromRange(kind, 'Data', RANGE, cell)!, 'Sales'), LegendPosition.Bottom);
      const parsed = parseChart(chartPartXml(spec, reader), styles);
      expect(parsed.unsupported).toBeUndefined();
      expect(chartKind(parsed)).toBe(kind);
      expect(parsed.title).toEqual({ text: 'Sales' });
      expect(parsed.legend).toEqual({ position: 'b' });
      const series = parsed.plots[0].series;
      expect(series[0].values).toMatchObject({ ref: 'Data!$B$2:$B$4', cache: [10, 7, 3] });
      expect(series[0].name).toMatchObject({ ref: 'Data!$B$1', cache: ['Q1'] });
      const categories = kind === ChartKind.Scatter ? series[0].x : series[0].categories;
      expect(categories).toMatchObject({ ref: 'Data!$A$2:$A$4', cache: ['North', 'South', 'East'] });
    }
  });

  test('changing the type keeps series; the automatic title stays automatic', () => {
    const line = chartFromRange(ChartKind.Line, 'Data', { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }, cell)!;
    const bars = withChartKind(line, ChartKind.Bar);
    expect(chartKind(bars)).toBe(ChartKind.Bar);
    expect(bars.plots[0].series[0].values.ref).toBe('Data!$B$2:$B$4');
    const xml = chartPartXml(bars, reader);
    expect(xml).toContain('<c:title><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>');
    // Excel titles a one-series chart with the series name.
    expect(parseChart(xml, styles).title).toMatchObject({ ref: 'Data!$B$1' });
    // Clearing the title deletes it, as in Excel.
    expect(chartPartXml(withChartTitle(bars, ''), reader)).toContain('<c:autoTitleDeleted val="1"/>');
    const scatter = withChartKind(bars, ChartKind.Scatter);
    expect(scatter.plots[0].series[0].x?.ref).toBe('Data!$A$2:$A$4');
    expect(withChartKind(scatter, ChartKind.Area).plots[0].series[0].categories?.ref).toBe('Data!$A$2:$A$4');
  });

  test('a chart shows the block it reads and charts another block with its settings kept', () => {
    const spec = chartFromRange(ChartKind.Column, 'Q1 Sales', RANGE, cell)!;
    expect(chartSourceRange(spec)).toEqual({ sheet: 'Q1 Sales', range: RANGE });
    let styled = withStacking(withDataLabels(withSeriesColor(spec, 0, '#C00000'), true), ChartStacking.Stacked);
    styled = withLegend(styled, LegendPosition.Right);
    // Only Q1 now: one series keeps the first series' color, the labels, stacking and legend; the
    // automatic title follows the data.
    const narrowed = withChartData(styled, chartFromRange(ChartKind.Column, 'Q1 Sales', { ...RANGE, endColumn: 1 }, cell)!);
    expect(narrowed.plots[0].series).toHaveLength(1);
    expect(narrowed.plots[0].series[0]).toMatchObject({ color: '#C00000', labels: { value: true }, values: { ref: "'Q1 Sales'!$B$2:$B$4" } });
    expect(chartStacking(narrowed)).toBe(ChartStacking.Stacked);
    expect(narrowed.legend).toEqual({ position: LegendPosition.Right });
    expect(narrowed.title).toEqual({ ref: "'Q1 Sales'!$B$1" });
    // A title of its own stays.
    expect(withChartData(withChartTitle(styled, 'Sales'), chartFromRange(ChartKind.Column, 'Q1 Sales', { ...RANGE, endColumn: 1 }, cell)!).title).toEqual({ text: 'Sales' });
    // Series on two sheets have no single block.
    expect(chartSourceRange({ ...spec, plots: [{ ...spec.plots[0], series: [spec.plots[0].series[0], { values: { ref: 'Other!$B$2:$B$4', cache: [] } }] }] })).toBeUndefined();
  });

  test('chart settings survive writing: stacking, data labels, gridlines, axis titles and series colors', () => {
    let spec = chartFromRange(ChartKind.Column, 'Data', RANGE, cell)!;
    spec = withStacking(spec, ChartStacking.Percent);
    spec = withDataLabels(spec, true);
    spec = withGridlines(spec, false);
    spec = withAxisTitle(withAxisTitle(spec, ChartAxisKind.Category, 'Region'), ChartAxisKind.Value, 'Units');
    spec = withSeriesColor(spec, 1, '#C00000');
    const parsed = parseChart(chartPartXml(spec, reader), styles);
    expect(chartStacking(parsed)).toBe(ChartStacking.Percent);
    expect(parsed.plots[0].overlap).toBe(100);
    expect(hasDataLabels(parsed)).toBe(true);
    expect(hasGridlines(parsed)).toBe(false);
    expect(parsed.categoryAxis?.title).toBe('Region');
    expect(parsed.valueAxis?.title).toBe('Units');
    expect(parsed.plots[0].series[1].color).toBe('#C00000');
    // Stacking carries over to area charts and goes back to side by side.
    const area = withChartKind(parsed, ChartKind.Area);
    expect(chartStacking(area)).toBe(ChartStacking.Percent);
    expect(chartStacking(withStacking(area, ChartStacking.Standard))).toBe(ChartStacking.Standard);
    expect(withStacking(parsed, ChartStacking.Standard).plots[0]).toMatchObject({ grouping: 'clustered' });
    expect(withStacking(parsed, ChartStacking.Standard).plots[0].overlap).toBeUndefined();
  });

  test('two columns of labels make a two-level category axis, written and drawn as Excel does', () => {
    // Region / product / units, the region only where a group starts (merged-looking cells).
    const rows: unknown[][] = [['区域', '产品', '销量'], ['华东', '笔记本', 120], [null, '显示器', 95], ['华南', '键盘', 300], [null, '鼠标', 410]];
    const cellData = Object.fromEntries(rows.map((row, r) => [r, Object.fromEntries(row.map((value, c) => [c, value === null ? null : { v: value as string | number }]))]));
    const snapshot = { id: 'book', sheetOrder: ['s1'], sheets: { s1: { id: 's1', name: 'Data', cellData } } } as unknown as IWorkbookData;
    const spec = chartFromRange(ChartKind.Column, 'Data', { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 }, (row, column) => {
      const value = rows[row]?.[column] ?? null;
      return { value, text: value === null ? '' : String(value) };
    })!;
    expect(spec.plots[0].series).toHaveLength(1);
    expect(spec.plots[0].series[0].categories).toEqual({ ref: 'Data!$A$2:$B$5', cache: [], levels: [] });
    const xml = chartPartXml(spec, snapshotChartReader(snapshot));
    expect(xml).toContain('<c:cat><c:multiLvlStrRef><c:f>Data!$A$2:$B$5</c:f><c:multiLvlStrCache><c:ptCount val="4"/>'
      + '<c:lvl><c:pt idx="0"><c:v>笔记本</c:v></c:pt><c:pt idx="1"><c:v>显示器</c:v></c:pt><c:pt idx="2"><c:v>键盘</c:v></c:pt><c:pt idx="3"><c:v>鼠标</c:v></c:pt></c:lvl>'
      + '<c:lvl><c:pt idx="0"><c:v>华东</c:v></c:pt><c:pt idx="2"><c:v>华南</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>');
    const parsed = parseChart(xml, styles);
    const categories = parsed.plots[0].series[0].categories!;
    expect(categories).toMatchObject({ ref: 'Data!$A$2:$B$5', cache: ['笔记本', '显示器', '键盘', '鼠标'], levels: [['华东', null, '华南', null]] });
    // Drawn: the labels nearest the axis, and the regions under the middle of their groups.
    const read = (source: { ref?: string; cache: (string | number | null)[]; levels?: (string | null)[][] } | undefined): ResolvedData => {
      if (!source) return { values: [], text: [] };
      if (source.levels) return { values: source.cache, text: source.cache.map(value => String(value ?? '')), levels: source.levels.map(level => level.map(label => label ?? '')) };
      return { values: source.cache, text: source.cache.map(value => String(value ?? '')) };
    };
    const option = chartOption(parsed, { read, seriesName: index => `S${index + 1}` }) as { xAxis: { data: string[]; offset?: number }[] };
    expect(option.xAxis).toHaveLength(2);
    expect(option.xAxis[0].data).toEqual(['笔记本', '显示器', '键盘', '鼠标']);
    expect(option.xAxis[1]).toMatchObject({ data: ['华东', '', '华南', ''], offset: 22 });
    // Labels laid out across the top instead (series in rows): levels run down the rows.
    expect(categoryLevels([['华东', '', '华南'], ['笔记本', '显示器', '键盘']])).toEqual({ text: ['笔记本', '显示器', '键盘'], levels: [['华东', '', '华南']] });
    // Other tools write a block of labels as a plain reference; Excel still reads it as levels.
    const plain = xml.replace(/<c:multiLvlStrRef>.*<\/c:multiLvlStrRef>/, "<c:numRef><c:f>'Data'!$A$2:$B$5</c:f></c:numRef>");
    expect(parseChart(plain, styles).plots[0].series[0].categories).toEqual({ ref: "'Data'!$A$2:$B$5", cache: [], levels: [] });
  });
});
