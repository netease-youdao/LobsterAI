import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_PARTS } from '../../../../../tests/fixtures/slides';
import { buildSlideChartOption, renderSlideChartSvg } from './slidesChartRender';
import { formatChartNumber, SlideChartGrouping, SlideChartPlotType } from './slidesCharts';
import { buildSlideView, fontsOf, ShapeViewKind } from './slidesModel';
import { RelType, SlidesPackage } from './slidesPackage';
import { NS } from './slidesXml';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const SLIDE_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
const CHART_NS = `xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"`;
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const COLOR_STYLE_REL = 'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle';

function slideWithChart(chartXml: string, options: { bgHex?: string; extraParts?: Record<string, string>; chartRels?: string } = {}) {
  const bg = options.bgHex
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${options.bgHex}"/></a:solidFill></p:bgPr></p:bg>`
    : '';
  const slideXml = `${DECL}<p:sld ${SLIDE_NS}><p:cSld>${bg}<p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
    + '<p:xfrm><a:off x="548640" y="1371600"/><a:ext cx="5029200" cy="3200400"/></p:xfrm>'
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + `<c:chart xmlns:c="${NS.c}" r:id="rId9"/>`
    + '</a:graphicData></a:graphic></p:graphicFrame>'
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
  const slideRels = `${DECL}<Relationships xmlns="${REL_NS}">`
    + `<Relationship Id="rId1" Type="${RelType.SlideLayout}" Target="../slideLayouts/slideLayout2.xml"/>`
    + `<Relationship Id="rId9" Type="${RelType.Chart}" Target="../charts/chart1.xml"/>`
    + '</Relationships>';
  return makeSlidesFixture({
    [SLIDES_FIXTURE_PARTS.slide1]: slideXml,
    'ppt/slides/_rels/slide1.xml.rels': slideRels,
    'ppt/charts/chart1.xml': chartXml,
    ...(options.chartRels ? { 'ppt/charts/_rels/chart1.xml.rels': options.chartRels } : {}),
    ...(options.extraParts ?? {}),
  });
}

async function openSlideWithChart(chartXml: string, options: Parameters<typeof slideWithChart>[1] = {}) {
  const bytes = await slideWithChart(chartXml, options);
  const pkg = SlidesPackage.open(bytes, nodeXmlCodec);
  return { pkg, view: buildSlideView(pkg, SLIDES_FIXTURE_PARTS.slide1) };
}

describe('formatChartNumber', () => {
  test('formats general, grouped, decimal, percentage, currency, scaled and negative values', () => {
    expect(formatChartNumber(42, 'General')).toBe('42');
    expect(formatChartNumber(-0, 'General')).toBe('0');
    expect(formatChartNumber(1234567, '#,##0')).toBe('1,234,567');
    expect(formatChartNumber(12.345, '0.0')).toBe('12.3');
    expect(formatChartNumber(12.3, '0.00')).toBe('12.30');
    expect(formatChartNumber(0.356, '0%')).toBe('36%');
    expect(formatChartNumber(0.356, '0.0%')).toBe('35.6%');
    expect(formatChartNumber(2500, '$#,##0')).toBe('$2,500');
    expect(formatChartNumber(2500, '[$¥-804]#,##0.0')).toBe('¥2,500.0');
    expect(formatChartNumber(215, '#,##0"万"')).toBe('215万');
    expect(formatChartNumber(1500000, '#,##0,,"M"')).toBe('2M');
    expect(formatChartNumber(1500000, '0.0,,"M"')).toBe('1.5M');
    expect(formatChartNumber(-45, '#,##0;(#,##0);"-"')).toBe('(45)');
    expect(formatChartNumber(0, '#,##0;(#,##0);"-"')).toBe('-');
  });

  test('formats Excel date serial numbers for 1900 and 1904 date systems', () => {
    // 2024-03-15 in 1900 date system is serial 45366
    expect(formatChartNumber(45366, 'yyyy-mm-dd', false)).toBe('2024-03-15');
    expect(formatChartNumber(45366, 'mmm yy', false)).toBe('Mar 24');
    // 1904 date system is 1462 days later (45366 - 1462 = 43904)
    expect(formatChartNumber(43904, 'yyyy-mm-dd', true)).toBe('2024-03-15');
    // Time portion: 0.5208333... is 12:30
    expect(formatChartNumber(45366.5208333333, 'hh:mm', false)).toBe('12:30');
  });
});

describe('slide chart parsing and SVG rendering', () => {
  test('parses and renders a dark-slide PptxGenJS column chart with transparent background and data labels', async () => {
    const chartXml = `${DECL}<c:chartSpace ${CHART_NS}><c:date1904 val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>`
      + '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>累计销量</c:v></c:pt></c:strCache></c:strRef></c:tx>'
      + '<c:spPr><a:solidFill><a:srgbClr val="FFA500"/></a:solidFill></c:spPr>'
      + '<c:dLbls><c:numFmt formatCode="#,##0" sourceLinked="0"/>'
      + '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr></a:p></c:txPr>'
      + '<c:dLblPos val="outEnd"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/></c:dLbls>'
      + '<c:cat><c:multiLvlStrRef><c:f>Sheet1!$A$2:$A$8</c:f><c:multiLvlStrCache><c:ptCount val="7"/><c:lvl>'
      + '<c:pt idx="0"><c:v>2013</c:v></c:pt><c:pt idx="1"><c:v>2015</c:v></c:pt><c:pt idx="2"><c:v>2017</c:v></c:pt>'
      + '<c:pt idx="3"><c:v>2019</c:v></c:pt><c:pt idx="4"><c:v>2021</c:v></c:pt><c:pt idx="5"><c:v>2023</c:v></c:pt><c:pt idx="6"><c:v>2025</c:v></c:pt>'
      + '</c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>'
      + '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$8</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="7"/>'
      + '<c:pt idx="0"><c:v>33</c:v></c:pt><c:pt idx="1"><c:v>45</c:v></c:pt><c:pt idx="2"><c:v>80</c:v></c:pt>'
      + '<c:pt idx="3"><c:v>110</c:v></c:pt><c:pt idx="4"><c:v>150</c:v></c:pt><c:pt idx="5"><c:v>190</c:v></c:pt><c:pt idx="6"><c:v>215</c:v></c:pt>'
      + '</c:numCache></c:numRef></c:val></c:ser>'
      + '<c:gapWidth val="80"/><c:overlap val="0"/><c:axId val="1"/><c:axId val="2"/></c:barChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="low"/>'
      + '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></c:spPr>'
      + '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="999999"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr></a:p></c:txPr>'
      + '<c:crossAx val="2"/><c:noMultiLvlLbl val="1"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/><c:max val="240"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>'
      + '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="222222"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>'
      + '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>'
      + '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1000"><a:solidFill><a:srgbClr val="999999"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr></a:p></c:txPr>'
      + '<c:crossAx val="1"/><c:majorUnit val="60"/></c:valAx>'
      + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea></c:chart>'
      + '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>';

    const { pkg, view } = await openSlideWithChart(chartXml, { bgHex: '111111' });
    const shape = view.shapes.find(item => item.own && item.id === '10')!;
    expect(shape.kind).toBe(ShapeViewKind.Chart);
    expect(shape.chart).toBeDefined();
    expect(shape.chart!.darkSurface).toBe(true);
    expect(shape.chart!.background).toBeUndefined();
    expect(shape.chart!.title).toBeUndefined();
    expect(shape.chart!.plots[0]).toMatchObject({
      type: SlideChartPlotType.Bar,
      horizontal: false,
      grouping: SlideChartGrouping.Clustered,
      gapWidth: 80,
    });
    expect(shape.chart!.plots[0].series[0]).toMatchObject({
      name: '累计销量',
      color: '#FFA500',
      values: [33, 45, 80, 110, 150, 190, 215],
      categories: { labels: ['2013', '2015', '2017', '2019', '2021', '2023', '2025'] },
    });
    expect(shape.chart!.valueAxis).toMatchObject({ min: 0, max: 240, majorUnit: 60, gridlines: true });
    expect(fontsOf(view)).toContain('Arial');

    const svg = renderSlideChartSvg(shape.chart!, shape.box.w, shape.box.h, i => `系列${i + 1}`);
    expect(svg).toBeDefined();
    expect(svg).toContain('<svg ');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('#FFA500');
    // Rendered SVG must be well-formed XML (fontFamily must not break out of style="...").
    expect(nodeXmlCodec.parse(svg!).getElementsByTagName('parsererror').length).toBe(0);
    for (const year of ['2013', '2015', '2017', '2019', '2021', '2023', '2025']) expect(svg).toContain(`>${year}</text>`);
    for (const tick of ['0', '60', '120', '180', '240']) expect(svg).toContain(`>${tick}</text>`);
    for (const val of ['33', '45', '80', '110', '150', '190', '215']) expect(svg).toContain(`>${val}</text>`);

    // Parsing a chart for display must leave the chart part untouched in the package.
    expect(new TextDecoder().decode(pkg.bytes('ppt/charts/chart1.xml'))).toBe(chartXml);
  });

  test('adapts default text and gridline colors for dark vs light slide backgrounds when unspecified', async () => {
    const bareChart = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea></c:chart></c:chartSpace>';

    const dark = await openSlideWithChart(bareChart, { bgHex: '141414' });
    const light = await openSlideWithChart(bareChart, { bgHex: 'FFFFFF' });
    const darkChart = dark.view.shapes.find(item => item.own && item.id === '10')!.chart!;
    const lightChart = light.view.shapes.find(item => item.own && item.id === '10')!.chart!;

    expect(darkChart.darkSurface).toBe(true);
    expect(lightChart.darkSurface).toBe(false);

    const darkOpt = buildSlideChartOption(darkChart, 480, 300, i => `S${i + 1}`) as Record<string, any>;
    const lightOpt = buildSlideChartOption(lightChart, 480, 300, i => `S${i + 1}`) as Record<string, any>;
    expect(darkOpt.backgroundColor).toBe('transparent');
    expect(darkOpt.xAxis.axisLabel.color).toBe('#CCCCCC');
    expect(darkOpt.yAxis.splitLine.lineStyle.color).toContain('255, 255, 255');
    expect(lightOpt.xAxis.axisLabel.color).toBe('#595959');
    expect(lightOpt.yAxis.splitLine.lineStyle.color).toBe('#D9D9D9');
  });

  test('supports pie and doughnut charts with per-point dPt colors and per-point dLbl labels', async () => {
    const pieXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:doughnutChart><c:varyColors val="1"/><c:firstSliceAng val="90"/><c:holeSize val="60"/>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:dPt><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="E63946"/></a:solidFill></c:spPr></c:dPt>'
      + '<c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="457B9D"/></a:solidFill></c:spPr></c:dPt>'
      + '<c:dLbls>'
      + '<c:dLbl><c:idx val="0"/><c:numFmt formatCode="0%" sourceLinked="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:defRPr></a:pPr></a:p></c:txPr><c:showPercent val="1"/><c:showVal val="0"/></c:dLbl>'
      + '<c:dLbl><c:idx val="1"/><c:numFmt formatCode="0%" sourceLinked="0"/><c:showPercent val="1"/><c:showVal val="0"/></c:dLbl>'
      + '</c:dLbls>'
      + '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>PC</c:v></c:pt><c:pt idx="1"><c:v>Console</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>30</c:v></c:pt><c:pt idx="1"><c:v>70</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser></c:doughnutChart></c:plotArea>'
      + '<c:legend><c:legendPos val="r"/></c:legend></c:chart></c:chartSpace>';

    const { view } = await openSlideWithChart(pieXml);
    const chart = view.shapes.find(item => item.own && item.id === '10')!.chart!;
    expect(chart.plots[0]).toMatchObject({ type: SlideChartPlotType.Doughnut, holeSize: 60, firstSliceAngle: 90 });

    const option = buildSlideChartOption(chart, 420, 280, i => `S${i + 1}`) as Record<string, any>;
    expect(option.series[0].type).toBe('pie');
    expect(option.series[0].startAngle).toBe(0);
    expect(option.series[0].radius).toEqual(['42%', '70%']);
    expect(option.series[0].data[0].itemStyle.color).toBe('#E63946');
    expect(option.series[0].data[0].label.show).toBe(true);
    expect(option.series[0].data[0].label.color).toBe('#FFFFFF');

    const svg = renderSlideChartSvg(chart, 420, 280, i => `S${i + 1}`);
    expect(svg).toContain('#E63946');
    expect(svg).toContain('#457B9D');
    expect(svg).toContain('>30%</text>');
    expect(svg).toContain('>70%</text>');
    expect(svg).toContain('>PC</text>');
    expect(svg).toContain('>Console</text>');
  });

  test('supports horizontal percent-stacked bars, combo charts with secondary axis, scatter and radar', async () => {
    const comboXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart>`
      + '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="1600" b="1"><a:solidFill><a:srgbClr val="222222"/></a:solidFill></a:rPr><a:t>Revenue &amp; Margin</a:t></a:r></a:p></c:rich></c:tx></c:title>'
      + '<c:plotArea>'
      + '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Revenue</c:v></c:tx>'
      + '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>150</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>'
      + '<c:lineChart><c:grouping val="standard"/>'
      + '<c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:v>Margin</c:v></c:tx><c:smooth val="1"/>'
      + '<c:spPr><a:ln w="25400"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:prstDash val="dash"/></a:ln></c:spPr>'
      + '<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.32</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser><c:axId val="1"/><c:axId val="3"/></c:lineChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>'
      + '<c:txPr><a:bodyPr rot="2700000"/><a:lstStyle/><a:p/></c:txPr><c:crossAx val="2"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>'
      + '<c:valAx><c:axId val="3"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="r"/><c:numFmt formatCode="0%" sourceLinked="0"/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>';

    const { view } = await openSlideWithChart(comboXml);
    const chart = view.shapes.find(item => item.own && item.id === '10')!.chart!;
    expect(chart.title).toMatchObject({ text: 'Revenue & Margin', style: { sizePt: 16, bold: true, color: '#222222' } });
    expect(chart.plots).toHaveLength(2);
    expect(chart.plots[1].secondary).toBe(true);
    expect(chart.categoryAxis?.labelRotate).toBe(-45);

    const opt = buildSlideChartOption(chart, 500, 320, i => `S${i + 1}`) as Record<string, any>;
    expect(Array.isArray(opt.yAxis)).toBe(true);
    expect(opt.yAxis).toHaveLength(2);
    expect(opt.series[0]).toMatchObject({ type: 'bar', name: 'Revenue' });
    expect(opt.series[1]).toMatchObject({ type: 'line', name: 'Margin', yAxisIndex: 1, smooth: true });
    expect(opt.series[1].lineStyle.type).toBe('dashed');
    expect(opt.series[1].lineStyle.color).toBe('#ED7D31');

    const svg = renderSlideChartSvg(chart, 500, 320, i => `S${i + 1}`);
    expect(svg).toContain('Revenue &amp; Margin');

    // Scatter with noLine suppression (as PptxGenJS emits for lineSize: 0)
    const scatterXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>'
      + '<c:xVal><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numLit></c:xVal>'
      + '<c:yVal><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>25</c:v></c:pt></c:numLit></c:yVal>'
      + '</c:ser><c:axId val="1"/><c:axId val="2"/></c:scatterChart>'
      + '<c:valAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:valAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea></c:chart></c:chartSpace>';
    const scatterView = (await openSlideWithChart(scatterXml)).view;
    const scatterChart = scatterView.shapes.find(item => item.own && item.id === '10')!.chart!;
    const scatterOpt = buildSlideChartOption(scatterChart, 400, 260, i => `S${i + 1}`) as Record<string, any>;
    expect(scatterOpt.series[0].type).toBe('scatter');
    expect(scatterOpt.series[0].data).toEqual([[1, 10], [3, 25]]);
    expect(renderSlideChartSvg(scatterChart, 400, 260, i => `S${i + 1}`)).toContain('<svg ');

    // Filled Radar chart
    const radarXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:radarChart><c:radarStyle val="filled"/><c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:cat><c:strLit><c:ptCount val="3"/><c:pt idx="0"><c:v>Speed</c:v></c:pt><c:pt idx="1"><c:v>Power</c:v></c:pt><c:pt idx="2"><c:v>Range</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="3"/><c:pt idx="0"><c:v>80</c:v></c:pt><c:pt idx="1"><c:v>90</c:v></c:pt><c:pt idx="2"><c:v>70</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser><c:axId val="1"/><c:axId val="2"/></c:radarChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="100"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea></c:chart></c:chartSpace>';
    const radarView = (await openSlideWithChart(radarXml)).view;
    const radarChart = radarView.shapes.find(item => item.own && item.id === '10')!.chart!;
    expect(renderSlideChartSvg(radarChart, 400, 300, i => `S${i + 1}`)).toContain('>Speed</text>');

    // Horizontal percent-stacked bar keeps raw values in showVal labels
    const pctBarXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/><c:dLbls><c:showVal val="1"/></c:dLbls>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>Row 1</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>30</c:v></c:pt></c:numLit></c:val></c:ser>'
      + '<c:ser><c:idx val="1"/><c:order val="1"/>'
      + '<c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>Row 1</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>70</c:v></c:pt></c:numLit></c:val></c:ser>'
      + '<c:axId val="1"/><c:axId val="2"/></c:barChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="2"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea></c:chart></c:chartSpace>';
    const pctView = (await openSlideWithChart(pctBarXml)).view;
    const pctChart = pctView.shapes.find(item => item.own && item.id === '10')!.chart!;
    const pctSvg = renderSlideChartSvg(pctChart, 420, 220, i => `S${i + 1}`);
    expect(pctSvg).toContain('>30</text>');
    expect(pctSvg).toContain('>70</text>');
    expect(pctSvg).toContain('>100%</text>');
  });

  test('reads chartColorStyle palette when present and safely escapes XML text in SVG', async () => {
    const colorsXml = `${DECL}<cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" xmlns:a="${NS.a}" meth="cycle" id="10">`
      + '<a:srgbClr val="112233"/><a:schemeClr val="accent4"/></cs:colorStyle>';
    const chartRels = `${DECL}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${COLOR_STYLE_REL}" Target="colors1.xml"/></Relationships>`;
    const chartXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:autoTitleDeleted val="1"/><c:plotArea>`
      + '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>'
      + '<c:ser><c:idx val="0"/><c:order val="0"/>'
      + '<c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>&lt;script&gt;alert(1)&lt;/script&gt;</c:v></c:pt></c:strLit></c:cat>'
      + '<c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>50</c:v></c:pt></c:numLit></c:val>'
      + '</c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>'
      + '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>'
      + '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/><c:max val="1000000"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorUnit val="0.001"/><c:crossAx val="1"/></c:valAx>'
      + '</c:plotArea></c:chart></c:chartSpace>';

    const { view } = await openSlideWithChart(chartXml, {
      chartRels,
      extraParts: { 'ppt/charts/colors1.xml': colorsXml },
    });
    const chart = view.shapes.find(item => item.own && item.id === '10')!.chart!;
    expect(chart.palette).toEqual(['#112233', '#FFC000']);

    // Guarded majorUnit must not be passed raw when span / majorUnit > 100.
    const opt = buildSlideChartOption(chart, 400, 260, i => `S${i + 1}`) as Record<string, any>;
    expect(opt.yAxis.interval).toBeUndefined();

    const svg = renderSlideChartSvg(chart, 400, 260, i => `S${i + 1}`)!;
    expect(nodeXmlCodec.parse(svg).getElementsByTagName('parsererror').length).toBe(0);
    expect(svg).toContain('#112233');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  test('falls back to Graphic placeholder for unsupported or empty chart parts', async () => {
    const surfaceXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart><c:plotArea><c:surfaceChart/></c:plotArea></c:chart></c:chartSpace>`;
    const surfaceView = (await openSlideWithChart(surfaceXml)).view;
    expect(surfaceView.shapes.find(item => item.own && item.id === '10')).toMatchObject({
      kind: ShapeViewKind.Graphic,
      label: 'chart',
    });

    const emptyXml = `${DECL}<c:chartSpace ${CHART_NS}><c:chart/></c:chartSpace>`;
    const emptyView = (await openSlideWithChart(emptyXml)).view;
    expect(emptyView.shapes.find(item => item.own && item.id === '10')).toMatchObject({
      kind: ShapeViewKind.Graphic,
      label: 'chart',
    });

    // Missing chart relationship target also falls back cleanly.
    const brokenRels = `${DECL}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>`;
    const brokenPkg = SlidesPackage.open(await makeSlidesFixture({
      [SLIDES_FIXTURE_PARTS.slide1]: `${DECL}<p:sld ${SLIDE_NS}><p:cSld><p:spTree>`
        + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        + '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        + '<p:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></p:xfrm>'
        + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="${NS.c}" r:id="rId99"/></a:graphicData></a:graphic></p:graphicFrame>`
        + '</p:spTree></p:cSld></p:sld>',
      'ppt/slides/_rels/slide1.xml.rels': brokenRels,
    }), nodeXmlCodec);
    const brokenView = buildSlideView(brokenPkg, SLIDES_FIXTURE_PARTS.slide1);
    expect(brokenView.shapes.find(item => item.own && item.id === '10')).toMatchObject({
      kind: ShapeViewKind.Graphic,
      label: 'chart',
    });
  });
});
