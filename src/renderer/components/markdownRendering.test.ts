import { load } from 'cheerio';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import MarkdownContent from './MarkdownContent';

// Check the Markdown-to-code boundary without mounting CodeMirror in Node.
vi.mock('./CodeBlock', () => ({
  default: ({ inline, children }: { inline?: boolean; children: React.ReactNode }) =>
    React.createElement(inline ? 'code' : 'pre', { 'data-code-preview': true }, children),
}));

function render(content: string) {
  return load(renderToStaticMarkup(React.createElement(MarkdownContent, {
    content, enableLargePreview: false,
  })));
}

describe('Markdown rendering across messages and document previews', () => {
  test.each(['~', '\\~'])('preserves study-plan ranges written with %s', tilde => {
    const $ = render([
      '已按你的真实消化速度重排完毕。这次校准动了三处：',
      '**1. 每个时段的任务量下调约 25%**',
      `这一版每个时段按标称 65${tilde}70min 排，预计用时 85${tilde}90min。`,
      '**2. 倍速预期改了（超时很可能是主因）**',
      '全新概念建议原速听。',
    ].join('\n'));
    expect($('del')).toHaveLength(0);
    expect($('strong')).toHaveLength(2);
    expect($('strong').first().next().is('br')).toBe(true);
    expect($('p br')).toHaveLength(4);
    expect($('p').text()).toContain('65~70min 排，预计用时 85~90min');
  });

  test('retains explicit double-tilde strikethrough and escaped punctuation', () => {
    const $ = render('~~旧计划~~，新计划 65~70min / 85~90min，\\*字面星号\\*，&lt;正文&gt;。');
    expect($('del').text()).toBe('旧计划');
    expect($('em')).toHaveLength(0);
    expect($('p').text()).toContain('*字面星号*，<正文>');
  });

  test('preserves soft and explicit breaks inside lists and quotes without extra breaks', () => {
    const $ = render('- **要点**\n  说明第一行\n  第二行  \n  第三行\\\n  第四行\n\n> 引用第一行\n> 第二行');
    expect($('ul li')).toHaveLength(1);
    expect($('li br')).toHaveLength(4);
    expect($('blockquote br')).toHaveLength(1);
  });

  test('honors GFM table alignment, escaped pipes, ranges, and safe HTML line breaks', () => {
    const $ = render('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a\\|b | 65~70 / 85~90 | 第一行<br>第二行<BR />第三行 |');
    expect($('th').map((_, cell) => $(cell).attr('style')).get()).toEqual([
      'text-align:left', 'text-align:center', 'text-align:right',
    ]);
    expect($('td').first().text()).toBe('a|b');
    expect($('td br')).toHaveLength(2);
    expect($('del')).toHaveLength(0);
  });

  test('does not enable arbitrary HTML or HTML with event attributes', () => {
    const $ = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<br onclick="alert(1)">\n\n[bad](javascript:alert%281%29)');
    expect($('script, img, [onclick], [onerror]')).toHaveLength(0);
    expect($('a').attr('href')).toBe('');
  });

  test('renders details and summary as a collapsible block with Markdown body', () => {
    const $ = render([
      '<details> <summary>证据补充（**原文**与接口）</summary>',
      '',
      '内置文案原文：`/access/invite`',
      '',
      '- 开关 A',
      '- 开关 B',
      '',
      '</details>',
      '',
      '**想用上，按这个顺序试**',
    ].join('\n'));
    expect($('details')).toHaveLength(1);
    expect($('details').attr('open')).toBeUndefined();
    expect($('details > summary').text()).toBe('证据补充（原文与接口）');
    expect($('details > summary strong').text()).toBe('原文');
    expect($('details code').text()).toBe('/access/invite');
    expect($('details li')).toHaveLength(2);
    expect($('details + p strong').text()).toBe('想用上，按这个顺序试');
    expect($.root().text()).not.toMatch(/<\/?(details|summary)/);
  });

  test('parses details content swallowed by an HTML block and keeps trailing text outside', () => {
    const $ = render('<details open>\n<summary>\n标题\n</summary>\n- a\n- b\n</details>\nafter');
    expect($('details').attr('open')).toBeDefined();
    expect($('summary').text()).toBe('标题');
    expect($('details li')).toHaveLength(2);
    expect($('details').next('p').text()).toBe('after');
  });

  test('supports nested, quoted, list, and still-streaming details blocks', () => {
    const $ = render('- 项\n\n  <details>\n  <summary>外层</summary>\n\n  <details><summary>内层</summary>\n\n  内容\n\n> <details><summary>引用</summary>\n>\n> 引用内容');
    expect($('li > details > summary').text()).toBe('外层');
    expect($('li > details details > summary').text()).toBe('内层');
    expect($('li details details p').text()).toBe('内容');
    expect($('blockquote details summary').text()).toBe('引用');
    expect($('blockquote details p').text()).toBe('引用内容');
  });

  test('only enables details and summary tags without arbitrary attributes', () => {
    const $ = render('<details onclick="alert(1)" style="x"><summary onclick="alert(2)"><b>标题</b></summary>\n\n<div onclick="x">正文</div>\n\n</details>\n\n```html\n<details><summary>源码</summary></details>\n```');
    expect($('details')).toHaveLength(1);
    expect($('[onclick], [style], div[onclick]')).toHaveLength(0);
    expect($('summary').text()).toBe('标题');
    expect($('pre').text()).toBe('<details><summary>源码</summary></details>\n');
  });

  test('falls back to a localized summary label when summary is missing', () => {
    const $ = render('<details>\n\n只有正文\n\n</details>');
    expect($('summary').text().trim()).not.toBe('');
    expect($('details p').text()).toBe('只有正文');
  });

  test.each([
    ['fenced', '```tex\n$$a\nb$$\n\\(x\\)\n```', '$$a\nb$$\n\\(x\\)\n'],
    ['tilde fenced', '~~~text\n$$a\nb$$\n~~~', '$$a\nb$$\n'],
    ['indented', '    $$a\n    b$$\n    \\(x\\)', '$$a\nb$$\n\\(x\\)\n'],
    ['quoted fence', '> ```tex\n> $$a\n> b$$\n> \\(x\\)\n> ```', '$$a\nb$$\n\\(x\\)\n'],
    ['list fence', '- 例子\n\n  ```tex\n  $$a\n  b$$\n  \\(x\\)\n  ```', '$$a\nb$$\n\\(x\\)\n'],
  ])('preserves literal math in %s code', (_name, source, expected) => {
    const $ = render(source);
    expect($('[data-code-preview]').text()).toBe(expected);
    expect($('.katex')).toHaveLength(0);
  });

  test('does not rewrite file URLs inside code examples', () => {
    const literal = '[文件](file:///tmp/中文 文件.md)';
    const $ = render('`' + literal + '`\n\n```md\n' + literal + '\n```');
    expect($('code').text()).toBe(literal);
    expect($('pre').text()).toBe(literal + '\n');
  });

  test('uses syntax context for multiline inline code and single-line indented blocks', () => {
    const $ = render('行内 `one\ntwo` 结束\n\n    indented');
    expect($('p code').text()).toBe('one two');
    expect($('pre').text()).toBe('indented\n');
  });

  test('renders math, links, task lists, and trailing reference definitions together', () => {
    const $ = render('\\(x^2\\) 与 $y^2$\n\n\\[\na+b\n\\]\n\n- [x] 完成\n- [ ] 待办\n\n[说明][ref]\n\n[ref]: https://example.com "资料"');
    expect($('.katex')).toHaveLength(3);
    expect($('.katex-display')).toHaveLength(1);
    expect($('input[type="checkbox"]')).toHaveLength(2);
    expect($('input:checked')).toHaveLength(1);
    expect($('a').attr('href')).toBe('https://example.com');
  });
});
