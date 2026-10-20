import path from 'path';
import { describe, expect, test } from 'vitest';

import { deliveredFileDeclarations, deliveredFileLinks, RemoteFileDeliveryKind } from './remoteDeliveredFiles';

const cwd = path.resolve('relative-delivery-workspace');
const name = '工作简报.docx';

describe('relative final-delivery Markdown links', () => {
  test.each([name, `./${name}`, encodeURIComponent(name)])('resolves %s only against an explicit absolute cwd', target => {
    expect(deliveredFileLinks(`[Word](${target})`)).toEqual([]);
    expect(deliveredFileLinks(`[Word](${target})`, 'relative-cwd')).toEqual([]);
    expect(deliveredFileDeclarations(`[Word](${target})`, cwd)).toEqual([
      { filePath: path.join(cwd, name), kind: RemoteFileDeliveryKind.Link },
    ]);
  });

  test('supports angle-bracket paths with spaces, deduplicates and retains absolute compatibility', () => {
    const filePath = path.join(cwd, '工作 简报.docx');
    expect(deliveredFileLinks(`[Word](<./工作 简报.docx>) [same](工作%20简报.docx)`, cwd)).toEqual([filePath]);
    expect(deliveredFileLinks(`[Word](<${filePath}>)`)).toEqual([filePath]);
  });

  test.each([
    'https://example.org/report.docx', 'http://example.org/report.docx', 'mailto:report.docx',
    'data:report.docx', 'custom:report.docx', 'C:report.docx', '//server/share/report.docx',
    '\\\\server\\share\\report.docx', 'file://server/share/report.docx', '#report.docx',
    'dir%2freport.docx', 'dir%5Creport.docx', 'file:///tmp/dir%5creport.docx',
    'report%00.docx', 'report%0a.docx', 'report%7f.docx', 'report%.docx', 'report\u0000.docx',
  ])('rejects nonlocal, ambiguous or encoded-separator target %s', target => {
    expect(deliveredFileLinks(`[Word](${target})`, cwd)).toEqual([]);
  });

  test.each(['relative', '//server/share', '\\\\server\\share'])('rejects ambiguous cwd %s', root => {
    expect(deliveredFileLinks(`[Word](${name})`, root)).toEqual([]);
  });

  test('does not extend literal MEDIA declarations to relative paths', () => {
    expect(deliveredFileDeclarations(`MEDIA: ./${name}`, cwd)).toEqual([]);
    expect(deliveredFileDeclarations(`MEDIA: ${path.join(cwd, name)}`, cwd)).toEqual([
      { filePath: path.join(cwd, name), kind: RemoteFileDeliveryKind.Media },
    ]);
  });

  const link = `[Word](${name})`;
  test.each([
    `<think>${link}</think>`, `<thinking>\n${link}\n</thinking>`, `<think>\n${link}`,
    `<!--${link}-->`, `<!--\n${link}`, `<pre>${link}</pre>`, `<code>${link}</code>`,
    `<blockquote>${link}</blockquote>`, `<blockquote>\n${link}\n</blockquote>`,
    `\`${link}\``, `\`\`\`md\n${link}\n\`\`\``, `~~~md\n${link}\n~~~`,
    `    ${link}`, `\t${link}`, `> ${link}`, `> Quoted example\n${link}`,
  ])('does not authorize hidden or quoted relative links: %s', content => {
    expect(deliveredFileLinks(content, cwd)).toEqual([]);
  });

  test('resumes visible links after hidden regions and quote paragraphs', () => {
    for (const prefix of ['<think>hidden</think>\n', '<!--hidden-->\n', '> quote\n\n']) {
      expect(deliveredFileLinks(`${prefix}${link}`, cwd)).toEqual([path.join(cwd, name)]);
    }
    expect(deliveredFileLinks(`- ${link}`, cwd)).toEqual([path.join(cwd, name)]);
  });

  test('an unsupported visible image does not authorize a hidden normal link to the same target', () => {
    expect(deliveredFileLinks('<think>[hidden](private.md)</think>\n![not-an-image](private.md)', cwd)).toEqual([]);
    expect(deliveredFileLinks('<think>[same](private.md)</think>\n![same](private.md)', cwd)).toEqual([]);
    expect(deliveredFileLinks('![image](./result.png)', cwd)).toEqual([path.join(cwd, 'result.png')]);
  });
});
