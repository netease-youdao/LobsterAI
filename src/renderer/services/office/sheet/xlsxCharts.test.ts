import { describe, expect, test } from 'vitest';

import { chartOption, type ResolvedData } from './sheetChartOption';
import { ChartPlotType, parseChart } from './xlsxCharts';
import { XlsxStyles } from './xlsxStyles';

const styles = new XlsxStyles(undefined, undefined, 'en');

const chartPart = (plotArea: string, extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<c:chart>${extra}<c:plotArea><c:layout/>${plotArea}<c:spPr><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill></c:spPr></c:plotArea>
<c:legend><c:legendPos val="b"/></c:legend></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></c:spPr>
</c:chartSpace>`;

const series = (index: number, name: string, values: string, color?: string, point = true) => `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>
<c:tx><c:strRef><c:f>Sales!$${name}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${name === 'B' ? 'Revenue' : 'Cost'}</c:v></c:pt></c:strCache></c:strRef></c:tx>
${color ? `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>` : ''}
${point ? '<c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></c:spPr></c:dPt>' : ''}
<c:cat><c:strRef><c:f>Sales!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>${values}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`;

const axes = `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>
<c:title><c:tx><c:rich><a:p><a:r><a:t>Quarter</a:t></a:r></a:p></c:rich></c:tx></c:title><c:crossAx val="2"/></c:catAx>
<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="50"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>
<c:numFmt formatCode="0.0" sourceLinked="0"/><c:crossAx val="1"/></c:valAx>`;

const cacheReader = (source: { ref?: string; cache: (string | number | null)[]; formatCode?: string } | undefined): ResolvedData => ({
  values: source?.cache ?? [],
  text: (source?.cache ?? []).map(value => (value === null ? '' : String(value))),
  ...(source?.formatCode ? { formatCode: source.formatCode } : {}),
});

describe('chart parts', () => {
  test('reads series, colors and axes from their own elements only', () => {
    const spec = parseChart(chartPart(`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>
${series(0, 'B', 'Sales!$B$2:$B$3', 'C00000')}${series(1, 'C', 'Sales!$C$2:$C$3')}<c:gapWidth val="219"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${axes}`), styles);
    expect(spec.unsupported).toBeUndefined();
    expect(spec.plots).toHaveLength(1);
    const [plot] = spec.plots;
    expect(plot).toMatchObject({ type: ChartPlotType.Bar, horizontal: false, grouping: 'clustered', gapWidth: 219 });
    expect(plot.series[0]).toMatchObject({ color: '#C00000', values: { ref: 'Sales!$B$2:$B$3', cache: [10, 20] }, categories: { ref: 'Sales!$A$2:$A$3', cache: ['Q1', 'Q2'] } });
    // A data point's own fill is not the series fill.
    expect(plot.series[1].color).toBeUndefined();
    expect(plot.series[1].pointColors).toEqual({ 1: '#00FF00' });
    // The axis title is not the chart title, and the plot area's fill is not the chart's.
    expect(spec.title).toBeUndefined();
    expect(spec.categoryAxis?.title).toBe('Quarter');
    expect(spec.valueAxis).toMatchObject({ max: 50, formatCode: '0.0', gridlines: true });
    expect(spec.background).toBe('#FFFFFF');
    expect(spec.plotBackground).toBe('#F2F2F2');
    expect(spec.legend).toEqual({ position: 'b' });
  });

  test('titles one-series charts with the series name unless the title was deleted', () => {
    const plot = `<c:lineChart><c:grouping val="standard"/>${series(0, 'B', 'Sales!$B$2:$B$3')}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${axes}`;
    expect(parseChart(chartPart(plot), styles).title).toEqual({ ref: 'Sales!$B$1', text: 'Revenue' });
    expect(parseChart(chartPart(plot, '<c:autoTitleDeleted val="1"/>'), styles).title).toBeUndefined();
  });

  test('marks chart kinds it cannot draw', () => {
    expect(parseChart(chartPart('<c:surfaceChart><c:axId val="1"/></c:surfaceChart>'), styles).unsupported).toBe('surfaceChart');
    expect(parseChart('<c:chartSpace xmlns:c="x"><c:chart/></c:chartSpace>', styles).unsupported).toBe('empty');
  });
});

describe('chart options', () => {
  test('plots bar charts from the cells with Excel-like defaults', () => {
    const spec = parseChart(chartPart(`<c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/>${series(0, 'B', 'Sales!$B$2:$B$3', undefined, false)}${series(1, 'C', 'Sales!$C$2:$C$3')}
<c:overlap val="100"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${axes}`), styles);
    const option = chartOption(spec, {
      read: source => (source?.ref === 'Sales!$B$2:$B$3' ? { values: [5, 7], text: ['5', '7'] } : cacheReader(source)),
      seriesName: index => `Series${index + 1}`,
    }) as Record<string, any>;
    expect(option.yAxis).toMatchObject({ type: 'category', data: ['Q1', 'Q2'] });
    expect(option.xAxis).toMatchObject({ type: 'value', max: 50 });
    expect(option.series.map((item: { name: string }) => item.name)).toEqual(['Revenue', 'Cost']);
    expect(option.series[0]).toMatchObject({ type: 'bar', stack: 'plot-0', data: [5, 7] });
    expect(option.series[1].data).toEqual([10, { value: 20, itemStyle: { color: '#00FF00' } }]);
    expect(option.legend).toMatchObject({ bottom: 6 });
  });

  test('plots pies with one slice per category and names unnamed series', () => {
    const spec = parseChart(chartPart(`<c:pieChart><c:varyColors val="1"/>${series(0, 'B', 'Sales!$B$2:$B$3')}<c:firstSliceAng val="0"/></c:pieChart>`), styles);
    spec.plots[0].series[0].name = undefined;
    const option = chartOption(spec, { read: cacheReader, seriesName: index => `S${index + 1}` }) as Record<string, any>;
    expect(option.series[0]).toMatchObject({ type: 'pie', name: 'S1' });
    expect(option.series[0].data.map((item: { name: string; value: number }) => [item.name, item.value])).toEqual([['Q1', 10], ['Q2', 20]]);
    expect(option.series[0].data[1].itemStyle.color).toBe('#00FF00');
  });

  test('draws nothing for unsupported charts', () => {
    expect(chartOption({ plots: [], unsupported: 'chartEx' }, { read: cacheReader, seriesName: String })).toBeUndefined();
  });
});
