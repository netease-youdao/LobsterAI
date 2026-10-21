import { createServerAutomationHost } from '@docx-editor.dev/core/automation';
import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';

import { makeWordFixture } from '../../../../../tests/fixtures/word';
import { WordEditType } from '../../../../shared/office/word/wordAgent';
import { applyWordEdits, readWordDocument, WordAgentError } from './wordAgentOperations';

async function openHost(text?: string) {
  const opened = createServerAutomationHost(await makeWordFixture(text));
  if (!opened.ok) throw new Error(opened.reason);
  return opened.host;
}

async function documentXml(host: Awaited<ReturnType<typeof openHost>>): Promise<string> {
  const saved = host.save();
  if (!saved.ok) throw new Error('save failed');
  return (await JSZip.loadAsync(saved.bytes)).file('word/document.xml')!.async('string');
}

describe('Word agent operations', () => {
  test('reads paragraphs with stable ids, styles and table cells', async () => {
    const host = await openHost();
    const read = readWordDocument(host);
    expect(read.total).toBe(6);
    expect(read.paragraphs[0]).toMatchObject({ index: 0, style: 'Heading 1', text: '中文文档测试 / Word editing' });
    expect(read.paragraphs.every(paragraph => /^[0-9A-F]{8}$/.test(paragraph.id))).toBe(true);
    expect(read.paragraphs.find(paragraph => paragraph.text === '数量 42')?.table).toEqual({ table: 0, row: 0, cell: 1 });
    expect(readWordDocument(host, { offset: 4, limit: 1 }).paragraphs.map(paragraph => paragraph.text)).toEqual(['数量 42']);
  });

  test('applies a mixed call in order and keeps untouched formatting', async () => {
    const host = await openHost();
    const [title, body] = readWordDocument(host).paragraphs;
    const result = applyWordEdits(host, {
      expectedRevision: 0,
      edits: [
        { type: WordEditType.ReplaceText, paragraph: body.id, find: '第一段正文', replace: '第一段（AI 修改）' },
        { type: WordEditType.FormatText, paragraph: body.id, find: 'Hello', bold: true, color: '#C00000' },
        { type: WordEditType.InsertParagraph, anchor: title.id, position: 'after', text: '摘要第一行\n摘要第二行' },
        { type: WordEditType.FormatParagraph, paragraph: title.id, alignment: 'center' },
      ],
    });
    expect(result.revision).toBeGreaterThan(0);
    const read = readWordDocument(host);
    expect(read.paragraphs.slice(0, 4).map(paragraph => [paragraph.style, paragraph.text])).toEqual([
      ['Heading 1', '中文文档测试 / Word editing'],
      ['Normal', '摘要第一行'],
      ['Normal', '摘要第二行'],
      ['Normal', '第一段（AI 修改），可以直接编辑。Hello Word.'],
    ]);
    const xml = await documentXml(host);
    expect(xml).toMatch(/<w:b\/><w:color w:val="C00000"\/>(?:<w:sz[^>]*\/>)*(?:<w:szCs[^>]*\/>)*<\/w:rPr><w:t>Hello<\/w:t>/);
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('r:embed="rId4"');
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual(expect.arrayContaining(['摘要第一行', '摘要第二行']));
  });

  test('refuses the whole call when one edit cannot apply', async () => {
    const host = await openHost();
    const [title, body] = readWordDocument(host).paragraphs;
    expect(() => applyWordEdits(host, { edits: [
      { type: WordEditType.SetText, paragraph: title.id, text: '不应写入' },
      { type: WordEditType.ReplaceText, paragraph: body.id, find: '不存在的文字', replace: 'x' },
    ] })).toThrow(/Edit #2: "不存在的文字" was not found/);
    expect(host.revision()).toBe(0);
    expect(readWordDocument(host).paragraphs[0].text).toBe('中文文档测试 / Word editing');
  });

  test('asks the agent to read again when the user edited meanwhile', async () => {
    const host = await openHost();
    const [title] = readWordDocument(host).paragraphs;
    applyWordEdits(host, { edits: [{ type: WordEditType.SetText, paragraph: title.id, text: '用户改过' }] });
    expect(() => applyWordEdits(host, { expectedRevision: 0, edits: [{ type: WordEditType.SetText, paragraph: title.id, text: 'AI' }] }))
      .toThrow(WordAgentError);
    expect(readWordDocument(host).paragraphs[0].text).toBe('用户改过');
  });

  test('ambiguous phrases need an occurrence', async () => {
    const host = await openHost('重复 重复');
    const [title] = readWordDocument(host).paragraphs;
    expect(() => applyWordEdits(host, { edits: [{ type: WordEditType.ReplaceText, paragraph: title.id, find: '重复', replace: '唯一' }] }))
      .toThrow(/occurs 2 times/);
    applyWordEdits(host, { edits: [{ type: WordEditType.ReplaceText, paragraph: title.id, find: '重复', replace: '唯一', occurrence: 2 }] });
    expect(readWordDocument(host).paragraphs[0].text).toBe('重复 唯一');
  });

  test('inserts a table and deletes its anchor paragraph in one call', async () => {
    const host = await openHost();
    const paragraphs = readWordDocument(host).paragraphs;
    applyWordEdits(host, { edits: [
      { type: WordEditType.InsertTable, anchor: paragraphs[1].id, position: 'after', rows: [['指标', '数值'], ['收入', '42']] },
      { type: WordEditType.DeleteParagraph, paragraph: paragraphs[1].id },
    ] });
    const read = readWordDocument(host);
    expect(read.paragraphs.some(paragraph => paragraph.text.startsWith('第一段正文'))).toBe(false);
    expect(read.paragraphs.filter(paragraph => paragraph.table?.table === 0).map(paragraph => paragraph.text)).toEqual(['指标', '数值', '收入', '42']);
  });

  test('reports an unknown style without losing the inserted text', async () => {
    const host = await openHost();
    const [title] = readWordDocument(host).paragraphs;
    const result = applyWordEdits(host, { edits: [{ type: WordEditType.InsertParagraph, anchor: title.id, text: '新段落', style: '不存在的样式' }] });
    expect(result.warnings[0]).toMatch(/"不存在的样式" could not be applied/);
    expect(readWordDocument(host).paragraphs[1].text).toBe('新段落');
  });
});
