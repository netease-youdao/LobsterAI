import { unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_SHAPES } from '../../../../../tests/fixtures/slides';
import { inspectSlidesPackage } from '../../../../main/office/slides/slidesPackage';
import { SlidesEditType } from '../../../../shared/office/slides/slidesAgent';
import { applySlidesEdits, readSlides, slideSelection } from './slidesAgentOperations';
import { SlidesEditError, SlidesRefusal } from './slidesDeck';
import { SlidesPackage } from './slidesPackage';

const open = async () => SlidesPackage.open(await makeSlidesFixture(), nodeXmlCodec);
const edit = (pkg: SlidesPackage, edits: unknown[]) => pkg.transaction(() => applySlidesEdits(pkg, edits)).result;
const shape = (pkg: SlidesPackage, slide: number, id: number) => readSlides(pkg, { slides: String(slide) }).slides[0].shapes.find(item => item.id === String(id))!;
const files = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).filter(([name]) => !name.endsWith('/')));

describe('ppt_read', () => {
  test('lists slides with layouts, notes and shapes in points', async () => {
    const summary = readSlides(await open());
    expect(summary).toMatchObject({ slideCount: 2, slideWidth: 960, slideHeight: 540, layouts: ['标题幻灯片', '标题和内容'] });
    expect(summary.slides[0]).toMatchObject({ slide: 1, layout: '标题幻灯片' });
    const second = summary.slides[1];
    expect(second).toMatchObject({ slide: 2, layout: '标题和内容', notes: '讲解项目进度' });
    expect(second.shapes.map(item => [item.id, item.kind, item.placeholder])).toEqual([
      ['2', 'text', 'title'], ['3', 'text', 'body'], ['4', 'picture', undefined], ['5', 'shape', undefined], ['6', 'table', undefined], ['7', 'text', undefined],
    ]);
    // The title's position is inherited from the master.
    expect(second.shapes[0]).toMatchObject({ text: '项目进展', x: 66, y: 28.75, width: 828 });
    expect(second.shapes[1].text).toBe('完成数据迁移\n\t测试覆盖率 85%\n上线新功能');
    expect(second.shapes[4].table).toEqual([['指标', '数值'], ['用户数', '1200']]);
    expect(slideSelection('2-3,1', 2)).toEqual([0, 1]);
    expect(() => slideSelection('two', 2)).toThrow(SlidesEditError);
  });
});

describe('ppt_edit', () => {
  test('changes text, formatting, tables and positions in one call', async () => {
    const pkg = await open();
    const result = edit(pkg, [
      { type: SlidesEditType.SetText, slide: 2, shape: SLIDES_FIXTURE_SHAPES.body, text: '完成数据迁移\n\t测试覆盖率 92%\n\t性能提升 30%' },
      { type: SlidesEditType.ReplaceText, find: '季度汇报', replace: '三季度汇报' },
      { type: SlidesEditType.FormatText, slide: 2, shape: '3', find: '92%', color: '#C00000', bold: true },
      { type: SlidesEditType.FormatParagraph, slide: 2, shape: 2, alignment: 'center' },
      { type: SlidesEditType.SetTableCell, slide: 2, shape: SLIDES_FIXTURE_SHAPES.table, row: 2, column: 2, text: '1350' },
      { type: SlidesEditType.SetBounds, slide: 2, shape: SLIDES_FIXTURE_SHAPES.picture, x: 500, width: 200 },
      { type: SlidesEditType.AddTextBox, slide: 1, text: '机密', x: 20, y: 20, width: 100, size: 12, color: '#FF0000' },
    ]);
    expect(result.applied).toBe(7);
    expect(result.changed).toEqual([
      { slide: 2, shape: '3' }, { slide: 1, shape: '2' }, { slide: 2, shape: '2' }, { slide: 2, shape: '6' }, { slide: 2, shape: '4' }, { slide: 1, shape: '4' },
    ]);
    expect(result.focus).toEqual({ slide: 1, shape: '4' });
    expect(shape(pkg, 2, 3).text).toBe('完成数据迁移\n\t测试覆盖率 92%\n\t性能提升 30%');
    expect(shape(pkg, 1, 2).text).toBe('三季度汇报');
    expect(shape(pkg, 2, 6).table![1][1]).toBe('1350');
    expect(shape(pkg, 2, 4)).toMatchObject({ x: 500, width: 200, y: 143.75 });
    expect(shape(pkg, 1, 4)).toMatchObject({ kind: 'text', text: '机密', x: 20, y: 20, width: 100 });
    const slide2 = nodeXmlCodec.serialize(pkg.xml('ppt/slides/slide2.xml'));
    expect(slide2).toContain('<a:srgbClr val="C00000"/>');
    expect(slide2).toContain('algn="ctr"');
    expect(inspectSlidesPackage(pkg.toBytes()).readOnly).toEqual([]);
  });

  test('adds, duplicates, moves and deletes slides and writes notes', async () => {
    const pkg = await open();
    const result = edit(pkg, [
      { type: SlidesEditType.AddSlide, after: 2, layout: '标题和内容', title: '下一步', body: '扩大试点\n\t两个城市' },
      { type: SlidesEditType.DuplicateSlide, slide: 2 },
      { type: SlidesEditType.MoveSlide, slide: 4, position: 1 },
      { type: SlidesEditType.SetNotes, slide: 1, text: '先讲结论' },
      { type: SlidesEditType.DeleteSlide, slide: 3 },
    ]);
    const summary = readSlides(pkg);
    expect(summary.slides.map(slide => slide.shapes[0]?.text)).toEqual(['下一步', '季度汇报', '项目进展']);
    expect(summary.slides[0].notes).toBe('先讲结论');
    expect(summary.slides[0].shapes[1].text).toBe('扩大试点\n\t两个城市');
    expect(result.changed.map(item => item.slide)).toEqual([1, 3, 1].filter((slide, index, all) => all.indexOf(slide) === index));
    expect(inspectSlidesPackage(pkg.toBytes()).readOnly).toEqual([]);
  });

  test('applies nothing when one edit is refused', async () => {
    const pkg = await open();
    const before = files(pkg.toBytes());
    let refusal: unknown;
    try {
      edit(pkg, [
        { type: SlidesEditType.SetText, slide: 2, shape: SLIDES_FIXTURE_SHAPES.title, text: '改掉的标题' },
        { type: SlidesEditType.DeleteShape, slide: 2, shape: SLIDES_FIXTURE_SHAPES.badge },
      ]);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SlidesEditError);
    expect((refusal as SlidesEditError).message).toMatch(/^Edit 2 \(delete_shape\): This shape is animated/);
    expect((refusal as SlidesEditError).code).toBe(SlidesRefusal.Animated);
    const after = files(pkg.toBytes());
    for (const [name, content] of Object.entries(before)) expect(Buffer.from(after[name]).equals(Buffer.from(content)), name).toBe(true);
  });

  test('explains invalid edits', async () => {
    const pkg = await open();
    const refused = (edits: unknown) => {
      try {
        pkg.transaction(() => applySlidesEdits(pkg, edits));
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    expect(refused([])).toBe('"edits" must be a non-empty list.');
    expect(refused([{ type: 'set_text', slide: 9, shape: 2, text: 'x' }])).toBe('Edit 1 (set_text): There is no slide 9; the presentation has 2.');
    expect(refused([{ type: 'set_text', slide: 2, shape: 99, text: 'x' }])).toMatch(/There is no shape 99/);
    expect(refused([{ type: 'format_text', slide: 2, shape: 3, color: 'red' }])).toMatch(/"color" must look like #C00000/);
    expect(refused([{ type: 'replace_text', find: '不存在的词', replace: 'x' }])).toMatch(/was not found/);
    expect(refused([{ type: 'add_slide', layout: '不存在' }])).toMatch(/There is no layout "不存在"; the layouts are: 标题幻灯片, 标题和内容/);
    expect(refused([{ type: 'set_table_cell', slide: 2, shape: 3, row: 1, column: 1, text: 'x' }])).toMatch(/not a table/);
    expect(refused([{ type: 'unknown' }])).toMatch(/Unknown edit type "unknown"/);
  });
});
