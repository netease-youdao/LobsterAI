import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_PARTS, SLIDES_FIXTURE_SHAPES } from '../../../../../tests/fixtures/slides';
import { buildSlideView, fontsOf, type ShapeView, ShapeViewKind } from './slidesModel';
import { SlidesPackage } from './slidesPackage';
import { slideTree } from './slidesShapes';
import { EMU_PER_PX, NS } from './slidesXml';

const open = async () => SlidesPackage.open(await makeSlidesFixture(), nodeXmlCodec);
const own = (shapes: ShapeView[], id: number) => shapes.find(shape => shape.own && shape.id === String(id))!;
const px = (emu: number) => emu / EMU_PER_PX;

describe('slide view', () => {
  test('resolves placeholders, text styles and colors through layout, master and theme', async () => {
    const view = buildSlideView(await open(), SLIDES_FIXTURE_PARTS.slide2);
    expect(view.width).toBe(px(12192000));
    expect(view.background).toEqual({ kind: 'solid', color: '#FFFFFF' });
    // The master's decoration is drawn but not the slide's own.
    const bar = view.shapes.find(shape => shape.name === 'Accent Bar')!;
    expect(bar).toMatchObject({ own: false, fill: { kind: 'solid', color: '#4472C4' } });

    // The layout's title has no position: it comes from the master.
    const title = own(view.shapes, SLIDES_FIXTURE_SHAPES.title);
    expect(title.box).toMatchObject({ x: px(838200), y: px(365125), w: px(10515600) });
    expect(title.text!.paragraphs[0].runs[0].style).toMatchObject({ sizePt: 44, color: '#000000' });
    expect(title.text!.paragraphs[0].runs[0].style.fontFamily).toContain('"Calibri Light"');

    const body = own(view.shapes, SLIDES_FIXTURE_SHAPES.body).text!;
    expect(body.paragraphs.map(paragraph => [paragraph.level, paragraph.bullet?.text])).toEqual([[0, '•'], [1, '•'], [0, '•']]);
    expect(body.paragraphs[1].runs.map(run => [run.text, run.style.sizePt, run.style.bold])).toEqual([['测试覆盖率 ', 24, false], ['85%', 24, true]]);
    expect(body.paragraphs[0].bullet?.fontFamily).toContain('"Arial"');

    const badge = own(view.shapes, SLIDES_FIXTURE_SHAPES.badge);
    expect(badge.geometry.preset).toBe('roundRect');
    expect(badge.fill).toEqual({ kind: 'solid', color: '#ED7D31' });
    expect(badge.text!.paragraphs[0]).toMatchObject({ align: 'center' });
    expect(badge.text!.paragraphs[0].runs[0].style).toMatchObject({ color: '#FFFFFF', bold: true });

    const picture = own(view.shapes, SLIDES_FIXTURE_SHAPES.picture);
    expect(picture).toMatchObject({ kind: ShapeViewKind.Picture, image: { part: SLIDES_FIXTURE_PARTS.image } });

    // The table style's header text wins over the presentation's default text color.
    const table = own(view.shapes, SLIDES_FIXTURE_SHAPES.table).table!;
    expect(table.columns).toEqual([px(2286000), px(2286000)]);
    expect(table.rows[0].cells[0].fill).toEqual({ kind: 'solid', color: '#4472C4' });
    expect(table.rows[0].cells[0].text.paragraphs[0].runs[0].style).toMatchObject({ color: '#FFFFFF', bold: true });
    expect(table.rows[1].cells[1].text.paragraphs[0].runs[0].style.color).toBe('#000000');

    const note = own(view.shapes, SLIDES_FIXTURE_SHAPES.note);
    expect(note.text!.paragraphs[0].runs[0].style).toMatchObject({ sizePt: 14, color: '#7F7F7F' });
    expect(fontsOf(view)).toEqual(expect.arrayContaining(['Calibri Light', 'Calibri']));
  });

  test('takes a title slide\'s centered, bottom-anchored title from its layout', async () => {
    const view = buildSlideView(await open(), SLIDES_FIXTURE_PARTS.slide1);
    const title = view.shapes.find(shape => shape.own && shape.placeholder?.type === 'ctrTitle')!;
    expect(title.box).toMatchObject({ x: px(1524000), y: px(1122363) });
    expect(title.text).toMatchObject({ anchor: 'bottom' });
    expect(title.text!.paragraphs[0]).toMatchObject({ align: 'center' });
    expect(title.text!.paragraphs[0].runs[0].style.sizePt).toBe(60);
    const subtitle = view.shapes.find(shape => shape.own && shape.placeholder?.type === 'subTitle')!;
    expect(subtitle.text!.paragraphs[0].bullet).toBeUndefined();
    expect(subtitle.prompt).toBeUndefined();
  });

  test('gives empty placeholders their prompt and plain shapes an empty text in the style of their theme font', async () => {
    const pkg = await open();
    const doc = pkg.edit(SLIDES_FIXTURE_PARTS.slide1);
    const tree = slideTree(doc);
    const subtitle = tree.getElementsByTagNameNS(NS.a, 't')[1];
    subtitle.textContent = '';
    const shape = nodeXmlCodec.parse(`<p:sp xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:nvSpPr><p:cNvPr id="9" name="Rectangle 8"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      + '<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style></p:sp>').documentElement;
    tree.appendChild(doc.importNode(shape, true));
    const view = buildSlideView(pkg, SLIDES_FIXTURE_PARTS.slide1);
    const emptied = view.shapes.find(item => item.own && item.placeholder?.type === 'subTitle')!;
    expect(emptied.prompt).toEqual({ custom: undefined });
    const plain = own(view.shapes, 9);
    expect(plain.fill).toEqual({ kind: 'solid', color: '#4472C4' });
    expect(plain.line).toMatchObject({ color: '#223962', width: px(12700) });
    expect(plain.text).toMatchObject({ anchor: 'middle' });
    expect(plain.text!.paragraphs[0]).toMatchObject({ align: 'center' });
    expect(plain.text!.paragraphs[0].endStyle.color).toBe('#FFFFFF');
  });
});
