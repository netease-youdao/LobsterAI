import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import MarkdownContent from './MarkdownContent';

function renderMarkdown(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

test('renders weather ranges with single tilde as plain text across one paragraph', () => {
  const html = renderMarkdown(
    [
      '当前：晴，20°C，体感20°C；湿度46%；西北风约4 km/h。  ',
      '今天（3/25）：11~21°C，白天晴到少云，晚间转晴，整体不太会下雨。  ',
      '明天（3/26）：12~16°C，多云到阴，傍晚到夜间有小雨。  ',
      '后天（3/27）：11~12°C，阴雨为主，体感偏凉。',
    ].join('\n')
  );

  expect(html).toContain('11~21°C');
  expect(html).toContain('12~16°C');
  expect(html).toContain('11~12°C');
  expect(html).not.toContain('<del>');
});

test('keeps double-tilde strikethrough rendering intact', () => {
  const html = renderMarkdown('建议：~~记得带伞~~最好加一件薄外套。');

  expect(html).toContain('<del>记得带伞</del>');
});
