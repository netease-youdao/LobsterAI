import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import MarkdownContent, {
  convertLatexMathDelimiters,
  getLargeMarkdownPreview,
  isInternalHref,
  normalizeMarkdownLocalFilePath,
  safeUrlTransform,
  shouldUseLargeMarkdownPreview,
} from './MarkdownContent';

const renderMarkdown = (content: string): string =>
  renderToStaticMarkup(React.createElement(MarkdownContent, { content }));

const countKatex = (html: string): number => html.split('class="katex"').length - 1;

const texAnnotation = (tex: string): string => `<annotation encoding="application/x-tex">${tex}</annotation>`;

test('normalizes macOS, Windows drive, and UNC file links for local actions', () => {
  expect(normalizeMarkdownLocalFilePath('file:///Users/test/My%20File.md'))
    .toBe('/Users/test/My File.md');
  expect(normalizeMarkdownLocalFilePath('file:///C:/Users/test/My%20File.md'))
    .toBe('C:/Users/test/My File.md');
  expect(normalizeMarkdownLocalFilePath('file://server/share/My%20File.md'))
    .toBe('//server/share/My File.md');
  expect(normalizeMarkdownLocalFilePath('/Users/test/name with spaces.md'))
    .toBe('/Users/test/name with spaces.md');
});

test('large markdown preview threshold only applies to oversized content', () => {
  expect(shouldUseLargeMarkdownPreview('x'.repeat(8 * 1024))).toBe(false);
  expect(shouldUseLargeMarkdownPreview('x'.repeat(8 * 1024 + 1))).toBe(true);
});

test('large markdown preview keeps the head and latest tail', () => {
  const content = `head-${'x'.repeat(8 * 1024)}-middle-${'y'.repeat(8 * 1024)}-tail`;
  const preview = getLargeMarkdownPreview(content);

  expect(preview.startsWith('head-')).toBe(true);
  expect(preview).toContain('\n...\n');
  expect(preview.endsWith('-tail')).toBe(true);
  expect(preview.length).toBeLessThan(content.length);
});

test('large markdown preview can be disabled for full document renderers', () => {
  const content = `# Full file\n\n${'x'.repeat(8 * 1024 + 1)}`;
  const defaultHtml = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
  const fullHtml = renderToStaticMarkup(React.createElement(MarkdownContent, {
    content,
    enableLargePreview: false,
  }));

  expect(defaultHtml).toMatch(/内容较大|Large content/);
  expect(fullHtml).not.toMatch(/内容较大|Large content/);
  expect(fullHtml).toContain('Full file');
});

test('large markdown preview can be temporarily expanded by a controlled caller', () => {
  const content = `# Search target\n\n${'x'.repeat(8 * 1024 + 1)}\nneedle`;
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, {
    content,
    forceExpanded: true,
  }));

  expect(html).not.toMatch(/内容较大|Large content/);
  expect(html).toContain('needle');
});

test('compact spacing reduces list margins for user message rendering', () => {
  const content = '内容包含：\n\n1. 项目介绍和解决方案\n2. 核心功能';
  const defaultHtml = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
  const compactHtml = renderToStaticMarkup(React.createElement(MarkdownContent, {
    content,
    spacing: 'compact',
  }));

  expect(defaultHtml).toContain('my-3');
  expect(compactHtml).toContain('text-markdown-body-compact');
  expect(compactHtml).toContain('my-1');
});

test('latex display delimiters become $$ blocks', () => {
  const converted = convertLatexMathDelimiters('推导：\n\n\\[\n\\log_a x=m,\\qquad \\log_a y=n\n\\]\n\n结束');
  expect(converted).toContain('$$\n\\log_a x=m,\\qquad \\log_a y=n\n$$');
  expect(converted).not.toContain('\\[');
});

test('latex inline delimiters become single-dollar math', () => {
  expect(convertLatexMathDelimiters('因为 \\(8\\times4=32\\)，而 \\(\\log_2 32=5\\)。'))
    .toBe('因为 $8\\times4=32$，而 $\\log_2 32=5$。');
});

test('latex delimiters inside code are preserved', () => {
  const fenced = '```tex\n\\[x=1\\]\n```';
  expect(convertLatexMathDelimiters(fenced)).toBe(fenced);

  const inlineCode = '用 `\\(x\\)` 表示行内公式，普通的 \\(y\\) 仍会转换。';
  expect(convertLatexMathDelimiters(inlineCode)).toBe('用 `\\(x\\)` 表示行内公式，普通的 $y$ 仍会转换。');
});

test('latex delimiters inside multi-backtick inline code are preserved', () => {
  const content = '用 ``literal ` tick \\(x\\)`` 表示代码，普通的 \\(y\\) 仍会转换。';

  expect(convertLatexMathDelimiters(content))
    .toBe('用 ``literal ` tick \\(x\\)`` 表示代码，普通的 $y$ 仍会转换。');
});

test('latex delimiters inside longer fenced code are preserved', () => {
  const content = [
    '````markdown',
    '```tex',
    '\\(x\\)',
    '```',
    '\\[y=1\\]',
    '````',
    '普通的 \\(z\\) 仍会转换。',
  ].join('\n');

  expect(convertLatexMathDelimiters(content)).toBe([
    '````markdown',
    '```tex',
    '\\(x\\)',
    '```',
    '\\[y=1\\]',
    '````',
    '普通的 $z$ 仍会转换。',
  ].join('\n'));
});

test('latex delimiters inside longer tilde fences are preserved', () => {
  const content = [
    '~~~~text',
    '~~~',
    '\\(x\\)',
    '~~~',
    '~~~~',
    '\\(y\\)',
  ].join('\n');

  expect(convertLatexMathDelimiters(content)).toBe([
    '~~~~text',
    '~~~',
    '\\(x\\)',
    '~~~',
    '~~~~',
    '$y$',
  ].join('\n'));
});

test('latex line breaks with spacing are not treated as display math', () => {
  const content = '$$\na \\\\[4pt] b\n$$';
  expect(convertLatexMathDelimiters(content)).toBe(content);
});

test('latex math renders through katex in markdown output', () => {
  const content = [
    '这张图是在解释**对数的乘法公式**：',
    '',
    '\\[',
    '\\log_a(xy)=\\log_a x+\\log_a y',
    '\\]',
    '',
    '注意条件：\\(a>0\\)、\\(a\\neq1\\)。',
  ].join('\n');
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));

  expect(html).toContain('katex-display');
  expect(html).toContain('class="katex"');
  expect(html).not.toContain('\\[');
});

test.each([
  ['2. 一眼看懂 —— 日期、价格 $3/$15、200K 上下文、全平台', '一眼看懂 —— 日期、价格 $3/$15、200K 上下文、全平台'],
  ['价格 $3/$15', '价格 $3/$15'],
  ['$3–$15', '$3–$15'],
  ['$5 and $10', '$5 and $10'],
])('currency dollars render as plain text: %s', (content, text) => {
  const html = renderMarkdown(content);

  expect(html).not.toContain('class="katex"');
  expect(html).toContain(text);
});

test.each([
  ['$x^2$', 'x^2'],
  ['$E=mc^2$', 'E=mc^2'],
  ['$\\frac{a}{b}$', '\\frac{a}{b}'],
])('single-dollar inline math still renders next to currency: %s', (math, tex) => {
  const html = renderMarkdown(`其中 ${math} 成立，价格 $3/$15。`);

  expect(countKatex(html)).toBe(1);
  expect(html).toContain(texAnnotation(tex));
  expect(html).toContain('价格 $3/$15。');
});

test('a currency dollar does not pair with the opening dollar of a later formula', () => {
  const html = renderMarkdown('It costs $5, where $x$ is the count.');

  expect(countKatex(html)).toBe(1);
  expect(html).toContain('It costs $5, where ');
  expect(html).toContain(texAnnotation('x'));
});

test('display and double-dollar math still render next to currency', () => {
  const html = renderMarkdown(['价格 $5 and $10', '', '$$', 'E=mc^2', '$$', '', '行内 $$a+b$$ 公式'].join('\n'));

  expect(html).toContain('katex-display');
  expect(countKatex(html)).toBe(2);
  expect(html).toContain(texAnnotation('E=mc^2'));
  expect(html).toContain(texAnnotation('a+b'));
  expect(html).toContain('价格 $5 and $10');
});

test.each(['$ x$', '$x $', '$x$1'])('single-dollar math follows Pandoc delimiter rules: %s', content => {
  const html = renderMarkdown(content);

  expect(html).not.toContain('class="katex"');
  expect(html).toContain(content);
});

test('kit links are treated as safe internal links', () => {
  expect(safeUrlTransform('kit://design@lobsterai-kits')).toBe('kit://design@lobsterai-kits');
  expect(isInternalHref('kit://design@lobsterai-kits')).toBe(true);
});

test('unsafe markdown protocols are still stripped', () => {
  expect(safeUrlTransform('javascript:alert(1)')).toBe('');
});
