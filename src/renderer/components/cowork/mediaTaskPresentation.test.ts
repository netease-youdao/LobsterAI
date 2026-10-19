import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { expect, test, vi } from 'vitest';

import { MediaBillingStatus, MediaDeliveryStatus, MediaProtocol, MediaTaskPhase, MediaTaskStatus } from '../../../shared/media/constants';
import type { CoworkMessage } from '../../types/cowork';
import { mediaTaskLabelKey } from './MediaTaskCard';
import { buildMediaTaskPresentations } from './mediaTaskPresentation';
import { type AssistantTurnItem, buildConversationTurns, buildDisplayItems, consolidateMediaPolling } from './messageDisplayUtils';
import ToolCallGroup from './ToolCallGroup';

const pendingPoll = (id: string): AssistantTurnItem => ({ type: 'tool_group', group: {
  type: 'tool_group',
  toolUse: { id, type: 'tool_use', timestamp: 1, content: '', metadata: {
    toolName: 'lobsterai_video_generate', toolUseId: id, toolInput: { action: 'status', taskId: '287' },
  } },
  toolResult: { id: `${id}-result`, type: 'tool_result', timestamp: 2, content: 'Status: processing', metadata: {
    toolUseId: id, toolResultDetails: { taskId: '287', status: MediaTaskStatus.Processing },
  } },
} });

const consolidate = (message: CoworkMessage) => consolidateMediaPolling([
  pendingPoll('one'), pendingPoll('two'), { type: 'system', message },
]).find(item => item.type === 'media_polling_group');

test('another completed media task cannot finish this task', () => {
  const item = consolidate({ id: 'complete', type: 'system', timestamp: 3,
    content: 'Video generation succeeded.\nTask ID: 2870\nSaved generated video: other.mp4',
    metadata: { toolResultDetails: { taskId: '2870', status: MediaTaskStatus.Succeeded } },
  });
  expect(item?.type === 'media_polling_group' && item.group.isComplete).toBe(false);
});

test('background timeout retains its failure status instead of showing success', () => {
  const item = consolidate({ id: 'complete', type: 'system', timestamp: 3,
    content: 'Video generation timed out.\nTask ID: 287',
    metadata: { toolResultDetails: { taskId: '287', status: MediaTaskStatus.Timeout, billingStatus: MediaBillingStatus.Refunded } },
  });
  expect(item?.type === 'media_polling_group' && item.group.isComplete).toBe(true);
  expect(item?.type === 'media_polling_group' && item.group.lastStatus).toBe(MediaTaskStatus.Timeout);
});

test('generated results still show delivery retry until a file is saved', () => {
  expect(mediaTaskLabelKey({ status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Retrying }))
    .toBe('mediaTaskDownloadRetry');
  expect(mediaTaskLabelKey({ status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved }))
    .toBe('mediaTaskSaved');
  expect(mediaTaskLabelKey({ status: MediaTaskStatus.Failed })).toBe('mediaTaskFailed');
});

const mediaCall = (
  id: string,
  taskId: string | number,
  details: Record<string, unknown> = {},
  query = false,
): CoworkMessage[] => [
  { id, type: 'tool_use', timestamp: 1, content: '', metadata: {
    toolName: 'lobsterai_image_generate', toolUseId: id,
    toolInput: query ? { action: 'status', taskId } : { action: 'generate', prompt: 'A lobster' },
  } },
  { id: `${id}-result`, type: 'tool_result', timestamp: 2, content: 'Original tool result', metadata: {
    toolUseId: id, toolResultDetails: { taskId, protocolVersion: MediaProtocol.Durable,
      status: MediaTaskStatus.Processing, model: 'test-model', ...details },
  } },
];

const turnsOf = (messages: CoworkMessage[]) => buildConversationTurns(buildDisplayItems(messages));

const renderCalls = (messages: CoworkMessage[]) => {
  const turns = turnsOf(messages);
  const presentations = buildMediaTaskPresentations(turns);
  const store = configureStore({ reducer: { cowork: () => ({ isStreaming: false }) } });
  return renderToStaticMarkup(React.createElement(Provider, { store, children:
    turns.flatMap(turn => consolidateMediaPolling(turn.assistantItems, presentations))
      .filter(item => item.type === 'tool_group')
      .map(item => React.createElement(ToolCallGroup, {
        key: item.group.toolUse.id, group: item.group,
        mediaTaskPresentation: presentations.get(item.group.toolUse.id),
      })),
  }));
};

test('generation elapsed time excludes time spent awaiting video confirmation', () => {
  const now = Date.parse('2026-10-15T06:30:12Z');
  const messages = mediaCall('generate', '308', {
    createdAt: '2026-10-15T14:30:09', deadlineAt: '2026-10-15T14:50:09+08:00',
  });
  messages[0].timestamp = now - 84_000;
  messages[1].timestamp = now - 2_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    expect(buildMediaTaskPresentations(turnsOf(messages)).get('generate')?.startedAt).toBe(now - 3_000);
    expect(renderCalls(messages)).toContain('已等待 3 秒');
    expect(renderCalls(messages)).not.toContain('已等待 84 秒');
  } finally {
    clock.mockRestore();
  }
});

test.each([
  ['2026-10-15T06:30:09Z', undefined],
  ['2026-10-15T14:30:09+08:00', undefined],
  ['2026-10-15T06:30:09', '2026-10-15T06:50:09Z'],
])('task creation time %s is independent of the desktop timezone', (createdAt, deadlineAt) => {
  const messages = mediaCall('generate', '308', { createdAt, deadlineAt });
  expect(buildMediaTaskPresentations(turnsOf(messages)).get('generate')?.startedAt)
    .toBe(Date.parse('2026-10-15T06:30:09Z'));
});

test.each([
  {},
  { createdAt: 'invalid', deadlineAt: '2026-10-15T14:50:09+08:00' },
  { createdAt: '2026-10-15T14:30:09' },
])('history without a usable creation time uses the first task result and never a later query', details => {
  const messages = [...mediaCall('generate', '308', details), ...mediaCall('query', '308', {}, true)];
  messages[0].timestamp = 1_000;
  messages[1].timestamp = 82_000;
  messages[2].timestamp = 120_000;
  messages[3].timestamp = 121_000;
  const presentations = buildMediaTaskPresentations(turnsOf(messages));
  expect(presentations.get('generate')?.startedAt).toBe(82_000);
  expect(presentations.get('query')?.startedAt).toBe(82_000);
});

test('a later task snapshot supplies the original creation time across history reloads', () => {
  const queried = mediaCall('query', '308', {
    createdAt: '2026-10-15T14:30:09', deadlineAt: '2026-10-15T14:50:09+08:00',
  }, true);
  const messages = [...mediaCall('generate', '308'), ...queried];
  const expected = Date.parse('2026-10-15T06:30:09Z');
  expect(buildMediaTaskPresentations(turnsOf(messages)).get('generate')?.startedAt).toBe(expected);
  expect(buildMediaTaskPresentations(turnsOf(queried)).get('query')?.startedAt).toBe(expected);
  expect(buildMediaTaskPresentations(turnsOf(JSON.parse(JSON.stringify(messages))))
    .get('generate')?.startedAt).toBe(expected);
});

test('a task without an acknowledged timestamp does not display a misleading elapsed time', () => {
  const messages = mediaCall('generate', '308');
  messages[0].metadata!.mediaStatusDetails = messages[1].metadata!.toolResultDetails;
  messages.pop();
  expect(buildMediaTaskPresentations(turnsOf(messages)).get('generate')?.startedAt).toBeUndefined();
  expect(renderCalls(messages)).not.toContain('已等待');
});

test.each([MediaTaskStatus.Cancelled, MediaTaskStatus.Failed, MediaTaskStatus.Timeout, MediaTaskStatus.Succeeded])(
  'generate and repeated queries render one card with the final %s state', status => {
    const messages = [
      ...mediaCall('generate', '293'),
      ...mediaCall('query-1', 293, {}, true),
      ...mediaCall('query-2', '293', { status, billingStatus: MediaBillingStatus.Refunded }, true),
    ];
    const html = renderCalls(messages);
    expect(html.match(/data-media-task-id="293"/g)).toHaveLength(1);
    expect(html.match(/生成任务 293 的调用记录/g)).toHaveLength(2);
    expect(html).toContain('本次预扣积分已退回');
    expect(html).not.toContain('已等待');
    // Calls and their original results remain in the expanded tool history.
    const turns = turnsOf(messages);
    expect(consolidateMediaPolling(turns[0].assistantItems, buildMediaTaskPresentations(turns)))
      .toHaveLength(3);
    expect(messages.filter(message => message.content === 'Original tool result')).toHaveLength(3);
  },
);

test('queries in later turns share the first card and do not merge different tasks', () => {
  const messages = [
    ...mediaCall('generate-a', '293'),
    ...mediaCall('generate-b', '2930'),
    { id: 'followup', type: 'user', content: 'Check both tasks', timestamp: 3 } as CoworkMessage,
    ...mediaCall('query-a', '293', {}, true),
    ...mediaCall('query-b', '2930', {}, true),
  ];
  const html = renderCalls(messages);
  expect(html.match(/data-media-task-id=/g)).toHaveLength(2);
  expect(html.match(/data-media-task-id="293"/g)).toHaveLength(1);
  expect(html.match(/data-media-task-id="2930"/g)).toHaveLength(1);
});

test('an in-flight query keeps its detail row without adding a second loading indicator', () => {
  const messages = [...mediaCall('generate', '293'), mediaCall('query', '293', {}, true)[0]];
  const presentations = buildMediaTaskPresentations(turnsOf(messages));
  expect(presentations.get('query')?.showCard).toBe(false);
  expect(renderCalls(messages).match(/data-media-task-id=/g)).toHaveLength(1);
});

test('background updates replace the owner state without an old query rolling it back', () => {
  const messages = [...mediaCall('generate', '293'), ...mediaCall('query', '293', {}, true)];
  messages[0].metadata!.mediaStatusDetails = {
    protocolVersion: MediaProtocol.Durable, taskId: '293', status: MediaTaskStatus.Cancelled,
    phase: MediaTaskPhase.Finished, billingStatus: MediaBillingStatus.Refunded, canCancel: false,
  };
  const presentations = buildMediaTaskPresentations(turnsOf(messages));
  expect(presentations.get('generate')?.details.status).toBe(MediaTaskStatus.Cancelled);
  expect(presentations.get('query')?.details.billingStatus).toBe(MediaBillingStatus.Refunded);
  expect(presentations.get('generate')?.details.canCancel).toBe(false);
});

test('saved delivery is not replaced by a stale download retry snapshot', () => {
  const messages = [
    ...mediaCall('generate', '293', { status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved }),
    ...mediaCall('query', '293', { status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Retrying }, true),
  ];
  expect(buildMediaTaskPresentations(turnsOf(messages)).get('generate')?.details.deliveryStatus)
    .toBe(MediaDeliveryStatus.Saved);
});

test('a loaded history page without the creation call still has a card', () => {
  const messages = [...mediaCall('query-1', '293', {}, true), ...mediaCall('query-2', '293', {}, true)];
  const partial = buildMediaTaskPresentations(turnsOf(messages));
  expect(partial.get('query-1')?.showCard).toBe(true);
  expect(partial.get('query-2')?.showCard).toBe(false);
  const complete = buildMediaTaskPresentations(turnsOf([...mediaCall('generate', '293'), ...messages]));
  expect(complete.get('generate')?.showCard).toBe(true);
  expect(complete.get('query-1')?.showCard).toBe(false);
  // The owner is scoped to this loaded conversation, never a global cache.
  expect(buildMediaTaskPresentations(turnsOf(messages)).get('query-1')?.showCard).toBe(true);
});

test('legacy polling remains consolidated and unrelated status tools remain untouched', () => {
  const legacyItems = [pendingPoll('one'), pendingPoll('two')];
  const legacy = [{ id: 'legacy', userMessage: null, assistantItems: legacyItems }];
  const presentations = buildMediaTaskPresentations(legacy);
  expect(presentations.size).toBe(0);
  expect(consolidateMediaPolling(legacyItems, presentations).some(item => item.type === 'media_polling_group'))
    .toBe(true);
  const other = mediaCall('other-tool', '293', {}, true)[0];
  other.metadata!.toolName = 'unrelated_status_tool';
  expect(buildMediaTaskPresentations(turnsOf([...mediaCall('generate', '293'), other])).has('other-tool'))
    .toBe(false);
});
