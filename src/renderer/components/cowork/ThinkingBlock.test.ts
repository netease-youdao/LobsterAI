import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import type { CoworkMessage } from '../../types/cowork';
import { ActivityEntryVariant } from './constants';
import ThinkingBlock from './ThinkingBlock';

const thinkingMessage = (content: string, isStreaming: boolean): CoworkMessage => ({
  id: 'think-1',
  type: 'assistant',
  content,
  timestamp: 0,
  metadata: { isThinking: true, isStreaming },
});

test('a finished thought is a collapsed 深度思考 line with no icon or arrow', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Hidden until expanded', false),
    variant: ActivityEntryVariant.Row,
  }));
  expect(html).toContain('<button');
  expect(html).toContain('深度思考');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-activity-label="settled"');
  expect(html).not.toContain('<svg');
  expect(html).not.toContain('Hidden until expanded');
  expect(html).not.toContain('data-activity-live-detail');
});

test('a thought that is still streaming keeps its name, shimmers, and previews its newest reasoning', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Working through the options', true),
    variant: ActivityEntryVariant.Row,
  }));
  expect(html).toContain('深度思考');
  expect(html).toContain('data-activity-label="live"');
  expect(html).toContain('data-activity-live-detail="reasoning"');
  expect(html).toContain('Working through the options');
});

test('a streaming thought the run no longer treats as live settles its line', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Quiet for a while', true),
    variant: ActivityEntryVariant.Row,
    isLive: false,
  }));
  expect(html).toContain('深度思考');
  expect(html).toContain('data-activity-label="settled"');
  expect(html).not.toContain('Quiet for a while');
});
