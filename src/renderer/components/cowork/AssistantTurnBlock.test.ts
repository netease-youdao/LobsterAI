import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, test } from 'vitest';

import { buildCoworkTurnUsage, CoworkTurnUsageStatus } from '../../../shared/cowork/llmTurnUsage';
import type { CoworkMessage } from '../../types/cowork';
import AssistantTurnBlock from './AssistantTurnBlock';
import ConversationTurnsView from './ConversationTurnsView';
import { buildConversationTurns, buildDisplayItems } from './messageDisplayUtils';

const renderTurn = (
  messages: CoworkMessage[],
  isStreamingTurn: boolean,
  showActivityIndicator = false,
): string => {
  const store = configureStore({
    reducer: {
      auth: () => ({ creditQuotaSnapshot: null }),
      enterpriseAccount: () => ({ context: null }),
      cowork: () => ({ isStreaming: isStreamingTurn }),
    },
  });
  const turn = buildConversationTurns(buildDisplayItems(messages))[0];
  return renderToStaticMarkup(React.createElement(Provider, {
    store,
    children: React.createElement(AssistantTurnBlock, { turn, isStreamingTurn, showActivityIndicator }),
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

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const usage = buildCoworkTurnUsage({ traceId, requestCount: 3, creditsUsed: 12.5 }, { traceId, now: 60_000 })!;
const userWithUsage: CoworkMessage = { ...process[0], metadata: { turnUsage: usage } };

test.each([
  { name: 'before any assistant output', items: [] },
  { name: 'during thinking', items: [process[1]] },
  { name: 'during a tool call after earlier text', items: [
    { id: 'progress', type: 'assistant' as const, content: 'Working on it.', timestamp: 2_000 },
    ...toolMessages('stopped-tool', 3_000).slice(0, 1),
  ] },
])('shows stopped turn usage once $name', ({ items }) => {
  const html = renderTurn([userWithUsage, ...items], false);
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
});

test('keeps a single usage chip with the final reply, including a stopped partial reply', () => {
  const html = renderTurn([
    userWithUsage, ...process.slice(1),
    { id: 'partial-reply', type: 'assistant', content: 'Here is the first part.', timestamp: 55_000 },
  ], false);
  expect(html.match(/12\.5 积分/g)).toHaveLength(1);
  expect(html).toContain('cowork-message-meta');
});

test('keeps usage hidden while the turn is streaming', () => {
  expect(renderTurn([userWithUsage, ...process.slice(1)], true)).not.toContain('12.5 积分');
});

test.each([
  { status: CoworkTurnUsageStatus.Pending, label: '积分计算中' },
  { status: CoworkTurnUsageStatus.Partial, label: '≥12.5 积分' },
  { status: CoworkTurnUsageStatus.Failed, label: '积分消耗' },
])('renders the $status usage entry without a reply', ({ status, label }) => {
  const html = renderTurn([{ ...userWithUsage, metadata: { turnUsage: { ...usage, status } } }], false);
  expect(html).toContain(label);
});

test('mounts a conversation turn containing only the user message and persisted usage', () => {
  const store = configureStore({ reducer: {
    auth: () => ({ creditQuotaSnapshot: null }),
    enterpriseAccount: () => ({ context: null }),
    kit: () => ({ installedKits: [] }),
    cowork: () => ({ isStreaming: false }),
  } });
  const html = renderToStaticMarkup(React.createElement(Provider, { store,
    children: React.createElement(ConversationTurnsView, { messages: [userWithUsage] }),
  }));
  expect(html).toContain('12.5 积分');
});

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

test('a running step line carries no timer of its own; the status line owns the only clock', () => {
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
  expect(commanding).toContain('data-activity-label="live"');
  expect(commanding).not.toMatch(/ · \d+s/);
});

test('the status line does not repeat the phrase of the step line right above it', () => {
  const startedAt = Date.now() - 20_000;
  const waiting = renderTurn([
    ...process,
    {
      id: 'poll-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'process', toolInput: { action: 'poll', sessionId: 's' }, toolUseId: 'poll-1' },
    },
  ], true, true);
  expect(waiting.match(/正在等待命令输出/g)).toHaveLength(1);
  expect(waiting).toMatch(/role="status"[^>]*>正在处理</);
  // One clock on screen: the turn's, counted from the user's message.
  expect(waiting.match(/tabular-nums/g)).toHaveLength(1);

  // A step line that names its target leaves the status line its own phrase.
  const fetching = renderTurn([
    ...process,
    {
      id: 'fetch-1', type: 'tool_use', content: '', timestamp: startedAt,
      metadata: { toolName: 'web_fetch', toolInput: { url: 'https://github.com/openclaw/openclaw' }, toolUseId: 'fetch-1' },
    },
  ], true, true);
  expect(fetching).toContain('github.com');
  expect(fetching).toMatch(/role="status"[^>]*>[^<]*网页/);
  expect(fetching).not.toMatch(/role="status"[^>]*>正在处理</);
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
