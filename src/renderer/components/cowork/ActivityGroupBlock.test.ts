import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import ActivityGroupBlock from './ActivityGroupBlock';
import type { ActivityChunkEntry, ConsolidatedItem } from './messageDisplayUtils';

const toolEntry = (index: number, toolName: string, settled = true): ActivityChunkEntry => ({
  index,
  item: {
    type: 'tool_group',
    group: {
      type: 'tool_group',
      toolUse: { id: `tool-${index}`, type: 'tool_use', content: '', timestamp: 0, metadata: { toolName } },
      toolResult: settled
        ? { id: `tool-${index}-result`, type: 'tool_result', content: 'ok', timestamp: 0 }
        : null,
    },
  } satisfies ConsolidatedItem,
});

const thinkingEntry = (index: number): ActivityChunkEntry => ({
  index,
  item: {
    type: 'assistant',
    message: { id: `think-${index}`, type: 'assistant', content: 'hmm', timestamp: 0, metadata: { isThinking: true } },
  },
});

const renderRun = (
  entries: ActivityChunkEntry[],
  props: { isLiveRun?: boolean; isTailStalled?: boolean } = {},
): string => renderToStaticMarkup(React.createElement(ActivityGroupBlock, {
  entries,
  ...props,
  renderEntry: (entry: ActivityChunkEntry, isLive: boolean) => React.createElement('div', {
    'data-step': entry.index,
    'data-live': String(isLive),
  }),
}));

const renderedSteps = (html: string): number[] => (
  [...html.matchAll(/data-step="(\d+)"/g)].map((match) => Number(match[1]))
);

test('a finished run folds into one collapsed summary line without an arrow', () => {
  const html = renderRun([
    thinkingEntry(0),
    toolEntry(1, 'read'),
    toolEntry(2, 'exec'),
    toolEntry(3, 'exec'),
  ]);
  expect(html).toContain('运行了 2 个命令、读取了 1 个文件');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('data-activity-step-kind="command"');
  expect(html).not.toContain('rotate-90');
  expect(renderedSteps(html)).toEqual([]);
});

test('a finished lone step keeps its own line instead of a summary', () => {
  const html = renderRun([toolEntry(4, 'exec')]);
  expect(html).not.toContain('data-activity-run-summary');
  expect(renderedSteps(html)).toEqual([4]);
});

test('a short live run lists every step on its own line', () => {
  const html = renderRun([
    thinkingEntry(0),
    toolEntry(1, 'read'),
    toolEntry(2, 'exec'),
    toolEntry(3, 'exec', false),
  ], { isLiveRun: true });
  expect(html).not.toContain('data-activity-run-summary');
  expect(renderedSteps(html)).toEqual([0, 1, 2, 3]);
  expect(html).toContain('data-step="3" data-live="true"');
  expect(html).toContain('data-step="2" data-live="false"');
});

test('a long live run still lists every step, so the whole process stays in view', () => {
  const html = renderRun([
    thinkingEntry(0),
    toolEntry(1, 'read'),
    toolEntry(2, 'exec'),
    thinkingEntry(3),
    toolEntry(4, 'exec'),
    toolEntry(5, 'exec'),
    thinkingEntry(6),
    toolEntry(7, 'exec', false),
  ], { isLiveRun: true });
  expect(html).not.toContain('data-activity-run-summary');
  expect(renderedSteps(html)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(html).toContain('data-step="7" data-live="true"');
});

test('the tail step stops reading as live once its streaming text stalls', () => {
  const streamingThought: ActivityChunkEntry = {
    index: 1,
    item: {
      type: 'assistant',
      message: {
        id: 'think-1', type: 'assistant', content: 'still…', timestamp: 0,
        metadata: { isThinking: true, isStreaming: true },
      },
    },
  };
  expect(renderRun([toolEntry(0, 'exec'), streamingThought], { isLiveRun: true }))
    .toContain('data-step="1" data-live="true"');
  expect(renderRun([toolEntry(0, 'exec'), streamingThought], { isLiveRun: true, isTailStalled: true }))
    .toContain('data-step="1" data-live="false"');
});
