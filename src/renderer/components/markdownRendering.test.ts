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
