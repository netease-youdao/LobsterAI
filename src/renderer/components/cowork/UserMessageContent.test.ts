import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { USER_MESSAGE_TEXT_ATTRIBUTE } from './userMessageCollapse';
import UserMessageContent from './UserMessageContent';

test('renders numbered user input as plain text instead of a markdown list', () => {
  const content = '内容包括:\n1. 项目\n2. 核心';
  const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content }));

  expect(html).not.toContain('<ol');
  expect(html).toContain('内容包括:');
  expect(html).toContain('1. 项目');
  expect(html).toContain('2. 核心');
});

test('flows leading chips into the first line of text, outside conversation search', () => {
  const content = '这个 skill 是干啥的\n第二行';
  const leading = React.createElement('span', { 'data-testid': 'chip' }, 'popo-im');
  const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content, leading }));

  expect(html).toContain(
    `<div ${USER_MESSAGE_TEXT_ATTRIBUTE}="true" class="whitespace-pre-wrap break-words text-foreground/90">`
    + '<span data-cowork-search-exclude="true"><span data-testid="chip">popo-im</span></span>'
    + '这个 skill 是干啥的\n第二行</div>',
  );
});

test('puts leading chips in their own block when the message opens with an image', () => {
  const content = '![shot](https://example.com/a.png)\n看看这张图';
  const leading = React.createElement('span', { 'data-testid': 'chip' }, 'pptx');
  const html = renderToStaticMarkup(React.createElement(UserMessageContent, { content, leading }));

  const chipIndex = html.indexOf('data-testid="chip"');
  expect(html.match(/data-testid="chip"/g)).toHaveLength(1);
  expect(chipIndex).toBeGreaterThan(-1);
  expect(chipIndex).toBeLessThan(html.indexOf('example.com/a.png'));
  expect(html.split(`${USER_MESSAGE_TEXT_ATTRIBUTE}="true"`)).toHaveLength(2);
  expect(html).toContain(`<div ${USER_MESSAGE_TEXT_ATTRIBUTE}="true" class="whitespace-pre-wrap break-words text-foreground/90">看看这张图</div>`);
});
