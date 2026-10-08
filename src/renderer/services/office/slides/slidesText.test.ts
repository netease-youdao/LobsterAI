import { describe, expect, test } from 'vitest';

import { nodeXmlCodec } from '../../../../../tests/fixtures/slides';
import {
  applyEditedParagraphs, bodyText, findInBody, formatRange, linesOf, paragraphsOf, paragraphText, replaceRange, setBodyText,
} from './slidesText';
import { el, elements, NS } from './slidesXml';

const body = (paragraphs: string): Element => nodeXmlCodec.parse(`<p:txBody xmlns:p="${NS.p}" xmlns:a="${NS.a}"><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>`).documentElement;
const serialize = (element: Element) => nodeXmlCodec.serialize(element.ownerDocument!);
const runs = (paragraph: Element) => elements(paragraph, 'a:r').map(run => ({ text: el(run, 'a:t')!.textContent, b: el(run, 'a:rPr')?.getAttribute('b') ?? null }));

const SAMPLE = '<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="2000"/><a:t>第一段</a:t></a:r></a:p>'
  + '<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="zh-CN"/><a:t>测试覆盖率 </a:t></a:r><a:r><a:rPr lang="en-US" b="1"/><a:t>85%</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>';

describe('slide text', () => {
  test('reads paragraphs with levels and writes lines with tabs back', () => {
    const text = body(SAMPLE);
    expect(bodyText(text)).toEqual([{ text: '第一段', level: 0 }, { text: '测试覆盖率 85%', level: 1 }]);
    expect(linesOf('a\n\tb\r\n\t\tc')).toEqual([{ text: 'a', level: 0 }, { text: 'b', level: 1 }, { text: 'c', level: 2 }]);
  });

  test('keeps unchanged paragraphs and gives new ones the properties of their level', () => {
    const text = body(SAMPLE);
    const [first] = paragraphsOf(text);
    setBodyText(text, linesOf('第一段\n\t新的第二级\n新段落'));
    const paragraphs = paragraphsOf(text);
    expect(paragraphs[0]).toBe(first);
    expect(paragraphText(paragraphs[1])).toBe('新的第二级');
    expect(el(paragraphs[1], 'a:pPr')?.getAttribute('lvl')).toBe('1');
    // New text takes the first run's formatting of the paragraph it replaces.
    expect(runs(paragraphs[1])).toEqual([{ text: '新的第二级', b: null }]);
    expect(el(paragraphs[2], 'a:pPr')?.getAttribute('algn')).toBe('ctr');
    expect(el(paragraphs[2], 'a:pPr')?.getAttribute('lvl')).toBeNull();
  });

  test('replaces a phrase across runs with the formatting of its first run', () => {
    const text = body(SAMPLE);
    const match = findInBody(text, '覆盖率 85')!;
    expect(match).toEqual({ paragraph: 1, start: 2, end: 8 });
    replaceRange(paragraphsOf(text)[1], match.start, match.end, '通过率 90');
    expect(paragraphText(paragraphsOf(text)[1])).toBe('测试通过率 90%');
    expect(runs(paragraphsOf(text)[1])).toEqual([{ text: '测试', b: null }, { text: '通过率 90', b: null }, { text: '%', b: '1' }]);
  });

  test('formats part of a paragraph in schema order and clears a color again', () => {
    const text = body(SAMPLE);
    const paragraph = paragraphsOf(text)[0];
    formatRange(paragraph, { bold: true, color: 'C00000', font: '微软雅黑', size: 24 }, 1, 2);
    expect(runs(paragraph)).toEqual([{ text: '第', b: null }, { text: '一', b: '1' }, { text: '段', b: null }]);
    const rPr = el(elements(paragraph, 'a:r')[1], 'a:rPr')!;
    expect(elements(rPr).map(child => child.localName)).toEqual(['solidFill', 'latin', 'ea']);
    expect(rPr.getAttribute('sz')).toBe('2400');
    formatRange(paragraph, { color: null });
    expect(serialize(text)).not.toContain('C00000');
  });

  test('writes text edited in place back without losing run formatting', () => {
    const text = body(SAMPLE);
    const [first, second] = paragraphsOf(text);
    applyEditedParagraphs(text, [
      { source: 0, runs: [{ text: '第一段', run: 0 }] },
      { source: 1, runs: [{ text: '测试覆盖率 ', run: 0 }, { text: '95%', run: 1 }] },
      { source: 1, runs: [{ text: '回车后的新段落', run: 1 }] },
    ]);
    const paragraphs = paragraphsOf(text);
    expect(paragraphs[0]).toBe(first);
    expect(paragraphs[1]).not.toBe(second);
    expect(runs(paragraphs[1])).toEqual([{ text: '测试覆盖率 ', b: null }, { text: '95%', b: '1' }]);
    expect(el(paragraphs[2], 'a:pPr')?.getAttribute('lvl')).toBe('1');
    expect(runs(paragraphs[2])).toEqual([{ text: '回车后的新段落', b: '1' }]);
    // An emptied body keeps one paragraph.
    applyEditedParagraphs(text, []);
    expect(paragraphsOf(text)).toHaveLength(1);
  });
});
