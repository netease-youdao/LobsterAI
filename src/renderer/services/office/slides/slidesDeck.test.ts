import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_PARTS } from '../../../../../tests/fixtures/slides';
import { inspectSlidesPackage } from '../../../../main/office/slides/slidesPackage';
import {
  addSlide, deleteSlide, duplicateSlide, layoutAfter, layoutName, layoutOf, layouts, moveSlide, notesOf, notesText, presentationPart, setNotes,
  slideRefs, SlidesEditError, slideSize, SlidesRefusal,
} from './slidesDeck';
import { ContentType, RelType, SlidesPackage } from './slidesPackage';
import { bodyText } from './slidesText';
import { descendants, el, elementsNamed, named } from './slidesXml';

const open = async (overrides?: Parameters<typeof makeSlidesFixture>[0]) => SlidesPackage.open(await makeSlidesFixture(overrides), nodeXmlCodec);
const sectionIds = (pkg: SlidesPackage) => descendants(pkg.xml(presentationPart(pkg)), 'p14:sldId').map(item => Number(item.getAttribute('id')));
const placeholders = (pkg: SlidesPackage, part: string) => elementsNamed(el(pkg.xml(part).documentElement, 'p:cSld', 'p:spTree'), 'sp')
  .map(shape => el(shape, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.getAttribute('type') ?? 'obj');

describe('presentation structure', () => {
  test('reads slides, layouts and the slide size', async () => {
    const pkg = await open();
    expect(slideRefs(pkg).map(ref => [ref.id, ref.part])).toEqual([[256, SLIDES_FIXTURE_PARTS.slide1], [257, SLIDES_FIXTURE_PARTS.slide2]]);
    expect(layouts(pkg).map(layout => layout.name)).toEqual(['标题幻灯片', '标题和内容']);
    expect(slideSize(pkg)).toEqual({ cx: 12192000, cy: 6858000 });
    expect(layoutName(pkg, layoutOf(pkg, SLIDES_FIXTURE_PARTS.slide2)!)).toBe('标题和内容');
    // A title slide is followed by "Title and Content", as in PowerPoint.
    expect(layoutAfter(pkg, SLIDES_FIXTURE_PARTS.slide1)).toBe(SLIDES_FIXTURE_PARTS.contentLayout);
    expect(layoutAfter(pkg, SLIDES_FIXTURE_PARTS.slide2)).toBe(SLIDES_FIXTURE_PARTS.contentLayout);
  });

  test('adds a slide with its layout placeholders, in the section of its neighbor', async () => {
    const pkg = await open();
    const ref = addSlide(pkg, { layout: SLIDES_FIXTURE_PARTS.contentLayout, after: 0, title: '新议题', body: '要点一\n\t细节' });
    expect(ref.index).toBe(1);
    expect(slideRefs(pkg).map(item => item.id)).toEqual([256, ref.id, 257]);
    expect(sectionIds(pkg)).toEqual([256, ref.id, 257]);
    expect(pkg.contentType(ref.part)).toBe(ContentType.Slide);
    expect(layoutOf(pkg, ref.part)).toBe(SLIDES_FIXTURE_PARTS.contentLayout);
    expect(placeholders(pkg, ref.part)).toEqual(['title', 'obj']);
    const [title, body] = elementsNamed(el(pkg.xml(ref.part).documentElement, 'p:cSld', 'p:spTree'), 'sp').map(shape => bodyText(named(shape, 'txBody')));
    expect(title).toEqual([{ text: '新议题', level: 0 }]);
    expect(body).toEqual([{ text: '要点一', level: 0 }, { text: '细节', level: 1 }]);
    expect(inspectSlidesPackage(pkg.toBytes()).readOnly).toEqual([]);
    expect(() => addSlide(pkg, { layout: SLIDES_FIXTURE_PARTS.titleLayout, after: 0, body: 'x', title: 'y' })).not.toThrow();
  });

  test('duplicates a slide with its picture and a copy of its notes', async () => {
    const pkg = await open();
    const copy = duplicateSlide(pkg, 1);
    expect(slideRefs(pkg).map(item => item.id)).toEqual([256, 257, copy.id]);
    expect(sectionIds(pkg)).toEqual([256, 257, copy.id]);
    const relations = pkg.relationships(copy.part);
    expect(relations.find(item => item.type === RelType.Image)?.target).toBe(SLIDES_FIXTURE_PARTS.image);
    expect(relations.find(item => item.id === 'rId2')?.type).toBe(RelType.Image);
    const notes = notesOf(pkg, copy.part)!;
    expect(notes).not.toBe(SLIDES_FIXTURE_PARTS.notes2);
    expect(pkg.relationships(notes).find(item => item.type === RelType.Slide)?.target).toBe(copy.part);
    expect(notesText(pkg, copy.part)).toBe('讲解项目进度');
    expect(pkg.contentType(notes)).toBe(ContentType.NotesSlide);
  });

  test('refuses to copy a slide with a chart', async () => {
    const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RelType.SlideLayout}" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId9" Type="${RelType.Chart}" Target="../charts/chart1.xml"/></Relationships>`;
    const pkg = await open({ 'ppt/slides/_rels/slide1.xml.rels': rels, 'ppt/charts/chart1.xml': '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>' });
    expect(() => duplicateSlide(pkg, 0)).toThrow(SlidesEditError);
    try {
      duplicateSlide(pkg, 0);
    } catch (error) {
      expect((error as SlidesEditError).code).toBe(SlidesRefusal.CopyUnsupported);
    }
  });

  test('deletes a slide with the notes and pictures only it used', async () => {
    const pkg = await open();
    deleteSlide(pkg, 1);
    expect(slideRefs(pkg).map(item => item.id)).toEqual([256]);
    expect(sectionIds(pkg)).toEqual([256]);
    for (const part of [SLIDES_FIXTURE_PARTS.slide2, SLIDES_FIXTURE_PARTS.notes2, SLIDES_FIXTURE_PARTS.image]) expect(pkg.has(part), part).toBe(false);
    expect(pkg.contentType(SLIDES_FIXTURE_PARTS.slide2)).toBe('application/xml');
    expect(pkg.relationships(presentationPart(pkg)).some(item => item.target === SLIDES_FIXTURE_PARTS.slide2)).toBe(false);
    // Shared parts stay.
    expect(pkg.has(SLIDES_FIXTURE_PARTS.contentLayout)).toBe(true);
    expect(inspectSlidesPackage(pkg.toBytes()).readOnly).toEqual([]);
  });

  test('moves a slide and keeps its section in order', async () => {
    const pkg = await open();
    moveSlide(pkg, 1, 0);
    expect(slideRefs(pkg).map(item => item.id)).toEqual([257, 256]);
    expect(sectionIds(pkg)).toEqual([257, 256]);
  });

  test('writes speaker notes, creating them from the notes master', async () => {
    const pkg = await open();
    expect(notesText(pkg, SLIDES_FIXTURE_PARTS.slide1)).toBe('');
    setNotes(pkg, SLIDES_FIXTURE_PARTS.slide1, '开场白\n\t欢迎');
    expect(notesText(pkg, SLIDES_FIXTURE_PARTS.slide1)).toBe('开场白\n\t欢迎');
    const notes = notesOf(pkg, SLIDES_FIXTURE_PARTS.slide1)!;
    expect(pkg.relationships(notes).map(item => item.type).sort()).toEqual([RelType.NotesMaster, RelType.Slide].sort());
    setNotes(pkg, SLIDES_FIXTURE_PARTS.slide2, '新的讲解');
    expect(notesText(pkg, SLIDES_FIXTURE_PARTS.slide2)).toBe('新的讲解');
    expect(inspectSlidesPackage(pkg.toBytes()).readOnly).toEqual([]);
  });
});
