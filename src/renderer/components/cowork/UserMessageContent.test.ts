import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import UserMessageContent from './UserMessageContent';

test('renders numbered user input as plain text instead of a markdown list', () => {
  const content = '内容包括:\n1. 项目\n2. 核心';
  const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content }));

  expect(html).not.toContain('<ol');
  expect(html).toContain('内容包括:');
  expect(html).toContain('1. 项目');
  expect(html).toContain('2. 核心');
});
