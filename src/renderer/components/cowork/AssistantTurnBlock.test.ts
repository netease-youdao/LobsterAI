import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, test } from 'vitest';

import type { CoworkMessage } from '../../types/cowork';
import AssistantTurnBlock from './AssistantTurnBlock';
import { buildConversationTurns, buildDisplayItems } from './messageDisplayUtils';

const renderTurn = (messages: CoworkMessage[], isStreamingTurn: boolean): string => {
  const store = configureStore({
    reducer: {
      auth: () => ({ creditQuotaSnapshot: null }),
      cowork: () => ({ isStreaming: isStreamingTurn }),
    },
  });
  const turn = buildConversationTurns(buildDisplayItems(messages))[0];
  return renderToStaticMarkup(React.createElement(Provider, {
    store,
    children: React.createElement(AssistantTurnBlock, { turn, isStreamingTurn }),
  }));
};

const toolMessages = (id: string, timestamp: number): CoworkMessage[] => [
  {
    id, type: 'tool_use', content: '', timestamp,
    metadata: { toolName: 'exec', toolInput: { command: 'ls' }, toolUseId: id },
  },
  { id: `${id}-result`, type: 'tool_result', content: 'ok', timestamp: timestamp + 500, metadata: { toolUseId: id } },
];

const process: CoworkMessage[] = [
  { id: 'user-1', type: 'user', content: 'make a deck', timestamp: 1_000 },
  { id: 'think-1', type: 'assistant', content: 'plan', timestamp: 2_000, metadata: { isThinking: true } },
  ...toolMessages('tool-1', 3_000),
  ...toolMessages('tool-2', 5_000),
];

test('a finished turn folds its process behind a duration line that keeps its arrow', () => {
  const html = renderTurn([
    ...process,
    { id: 'answer-1', type: 'assistant', content: 'Done.', timestamp: 55_000 },
  ], false);
  expect(html).toMatch(/耗时 54秒<\/span><svg[^>]*aria-hidden="true"/);
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('运行了 2 个命令');
  expect(html).toContain('Done.');
});

test('a file being written shows its line count but no timer, while a command keeps its timer', () => {
  const startedAt = Date.now() - 10_000;
  const writing = renderTurn([
    ...process,
    {
      id: 'write-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'write', toolInput: {}, toolUseId: 'write-1', isGenerating: true, liveEditDiff: { added: 151, removed: 0 } },
    },
  ], true);
  expect(writing).toContain('正在写入文件');
  expect(writing).toContain('data-diff-stats="151/0"');
  expect(writing).not.toMatch(/ · \d+s/);
  // The write line leads with the app's compose icon (34×34 artboard).
  expect(writing).toMatch(/data-activity-step-kind="edit"[^]*?viewBox="0 0 34 34"/);

  const commanding = renderTurn([
    ...process,
    {
      id: 'exec-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'exec', toolInput: { command: 'npm install' }, toolUseId: 'exec-1' },
    },
  ], true);
  expect(commanding).toMatch(/ · 1\ds/);
});

test('a running turn lists every step of its current run without a duration line', () => {
  const html = renderTurn(process, true);
  expect(html).not.toContain('耗时');
  expect(html).not.toContain('data-activity-run-summary');
  expect(html.match(/data-activity-step-kind="command"/g)).toHaveLength(2);
  // The thought before them has finished, so it no longer takes a line.
  expect(html).not.toContain('深度思考');
});

test('a running turn that keeps calling tools folds its older steps behind one line', () => {
  const html = renderTurn([
    ...process,
    ...[3, 4, 5, 6, 7, 8].flatMap((n) => toolMessages(`tool-${n}`, n * 2_000 + 3_000)),
  ], true);
  expect(html).toContain('显示更早的 3 步');
  expect(html.match(/data-activity-step-kind="command"/g)).toHaveLength(5);
  expect(html).not.toContain('耗时');
});

test('a running turn spends no step line on progress card updates once they finish', () => {
  const planCall: CoworkMessage[] = [
    {
      id: 'plan-1', type: 'tool_use', content: '', timestamp: 7_000,
      metadata: {
        toolName: 'progress_card',
        toolUseId: 'plan-1',
        toolInput: {
          markdown: 'Deck underway',
          plan: [
            { step: 'Research', status: 'completed' },
            { step: 'Draft slides', status: 'in_progress' },
          ],
        },
      },
    },
    { id: 'plan-1-result', type: 'tool_result', content: 'Progress card updated', timestamp: 7_100, metadata: { toolUseId: 'plan-1' } },
  ];
  const running = renderTurn([...process, ...planCall, ...toolMessages('tool-9', 9_000)], true);
  expect(running).not.toContain('更新了任务进度');
  expect(running).not.toContain('progress_card');
  expect(running.match(/data-activity-step-kind="command"/g)).toHaveLength(3);
});
