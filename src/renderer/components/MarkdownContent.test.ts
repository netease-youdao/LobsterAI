import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import MarkdownContent, {
  getLargeMarkdownPreview,
  isInternalHref,
  safeUrlTransform,
  shouldUseLargeMarkdownPreview,
} from './MarkdownContent';

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

test('kit links are treated as safe internal links', () => {
  expect(safeUrlTransform('kit://design@lobsterai-kits')).toBe('kit://design@lobsterai-kits');
  expect(isInternalHref('kit://design@lobsterai-kits')).toBe(true);
});

test('unsafe markdown protocols are still stripped', () => {
  expect(safeUrlTransform('javascript:alert(1)')).toBe('');
});
