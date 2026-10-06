import { expect, test, vi } from 'vitest';

import type { CoworkMessage } from '../../../coworkStore';
import {
  type OpenClawThinkingReconciliationStore,
  reconcileOpenClawThinkingBlocks,
} from './reconciliation';

const createMessage = (
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata: CoworkMessage['metadata'] = {},
): CoworkMessage => ({
  id,
  type,
  content,
  metadata,
  timestamp: Number(id.replace(/\D/g, '')) || 1,
});

const createStore = (initialMessages: CoworkMessage[], pageSize = Number.POSITIVE_INFINITY) => {
  const messages = [...initialMessages];
  let nextId = messages.length + 1;
  const insertMessageBeforeId = vi.fn((
    _sessionId: string,
    beforeMessageId: string,
    payload: Omit<CoworkMessage, 'id' | 'timestamp'>,
  ) => {
    const message = createMessage(`msg-${nextId++}`, payload.type, payload.content, payload.metadata);
    const targetIndex = messages.findIndex((candidate) => candidate.id === beforeMessageId);
    messages.splice(targetIndex < 0 ? messages.length : targetIndex, 0, message);
    return message;
  });
  const addMessage = vi.fn((
    _sessionId: string,
    payload: Omit<CoworkMessage, 'id' | 'timestamp'>,
  ) => {
    const message = createMessage(`msg-${nextId++}`, payload.type, payload.content, payload.metadata);
    messages.push(message);
    return message;
  });
  const updateMessage = vi.fn((
    _sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: CoworkMessage['metadata'] },
  ) => {
    const message = messages.find((candidate) => candidate.id === messageId);
    if (message) Object.assign(message, updates);
  });
  const store = {
    addMessage,
    insertMessageBeforeId,
    updateMessage,
    getSession: () => ({
      messages: Number.isFinite(pageSize) ? messages.slice(-pageSize) : messages,
    }),
  } as unknown as OpenClawThinkingReconciliationStore;

  return { addMessage, insertMessageBeforeId, messages, store, updateMessage };
};

const multiRoundHistory = [
  { role: 'user', content: 'inspect and test' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Inspect the source.' },
      { type: 'toolCall', id: 'call-read', name: 'read' },
    ],
  },
  { role: 'toolResult', toolCallId: 'call-read', content: 'source' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Run the tests.' },
      { type: 'toolCall', id: 'call-exec', name: 'exec' },
    ],
  },
  { role: 'toolResult', toolCallId: 'call-exec', content: 'ok' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Summarize the result.' },
      { type: 'text', text: 'Done.' },
    ],
  },
];

test('preserves multiple thinking boundaries and remains idempotent', () => {
  const { messages, store } = createStore([
    createMessage('msg-1', 'user', 'inspect and test'),
    createMessage('msg-2', 'tool_use', 'Using tool: read', { toolUseId: 'call-read' }),
    createMessage('msg-3', 'tool_result', 'source', { toolUseId: 'call-read' }),
    createMessage('msg-4', 'tool_use', 'Using tool: exec', { toolUseId: 'call-exec' }),
    createMessage('msg-5', 'tool_result', 'ok', { toolUseId: 'call-exec' }),
    createMessage('msg-6', 'assistant', 'Done.', { isFinal: true }),
  ]);
  const messageIdByThinkingKey = new Map<string, string>();
  const options = {
    sessionId: 'session-1',
    historyMessages: multiRoundHistory,
    includeUnanchored: true,
    assistantMessageId: 'msg-6',
    toolUseMessageIdByToolCallId: new Map([
      ['call-read', 'msg-2'],
      ['call-exec', 'msg-4'],
    ]),
    messageIdByThinkingKey,
    store,
    emitMessage: vi.fn(),
    emitMessageUpdate: vi.fn(),
  };

  reconcileOpenClawThinkingBlocks(options);
  reconcileOpenClawThinkingBlocks(options);

  expect(messages.map((message) => message.content)).toEqual([
    'inspect and test',
    'Inspect the source.',
    'Using tool: read',
    'source',
    'Run the tests.',
    'Using tool: exec',
    'ok',
    'Summarize the result.',
    'Done.',
  ]);
  expect(messages.filter((message) => message.metadata?.isThinking)).toHaveLength(3);
  expect([...messageIdByThinkingKey.keys()]).toEqual([
    'tool:call-read:thinking:0',
    'tool:call-exec:thinking:0',
    expect.stringMatching(/^final:thinking:/),
  ]);
});

test('does not duplicate an indexed block after it leaves the paginated session tail', () => {
  const { insertMessageBeforeId, messages, store, updateMessage } = createStore([
    createMessage('msg-1', 'user', 'inspect'),
    createMessage('msg-2', 'tool_use', 'Using tool: read', { toolUseId: 'call-read' }),
  ], 30);
  const messageIdByThinkingKey = new Map<string, string>();
  const options = {
    sessionId: 'session-1',
    historyMessages: multiRoundHistory.slice(0, 2),
    includeUnanchored: false,
    toolUseMessageIdByToolCallId: new Map([['call-read', 'msg-2']]),
    messageIdByThinkingKey,
    store,
    emitMessage: vi.fn(),
    emitMessageUpdate: vi.fn(),
  };

  reconcileOpenClawThinkingBlocks(options);
  const thinkingMessageId = messageIdByThinkingKey.get('tool:call-read:thinking:0');
  for (let index = 0; index < 35; index += 1) {
    messages.push(createMessage(
      `tail-${index + 1}`,
      'tool_result',
      `result ${index + 1}`,
      { toolUseId: `tail-call-${index + 1}` },
    ));
  }

  reconcileOpenClawThinkingBlocks(options);

  expect(insertMessageBeforeId).toHaveBeenCalledTimes(1);
  expect(messages.filter((message) => message.metadata?.isThinking)).toHaveLength(1);
  expect(updateMessage).toHaveBeenCalledWith(
    'session-1',
    thinkingMessageId,
    expect.objectContaining({ content: 'Inspect the source.' }),
  );
});

test('reuses an identical provisional live-stream message and assigns its stable key', () => {
  const provisionalMessage = createMessage(
    'msg-2',
    'assistant',
    'Inspect the source.',
    { isThinking: true, isStreaming: false, isFinal: true },
  );
  const { insertMessageBeforeId, messages, store } = createStore([
    createMessage('msg-1', 'user', 'inspect'),
    provisionalMessage,
    createMessage('msg-3', 'tool_use', 'Using tool: read', { toolUseId: 'call-read' }),
  ]);
  const messageIdByThinkingKey = new Map<string, string>();

  reconcileOpenClawThinkingBlocks({
    sessionId: 'session-1',
    historyMessages: multiRoundHistory.slice(0, 2),
    includeUnanchored: false,
    toolUseMessageIdByToolCallId: new Map([['call-read', 'msg-3']]),
    messageIdByThinkingKey,
    store,
    emitMessage: vi.fn(),
    emitMessageUpdate: vi.fn(),
  });

  expect(insertMessageBeforeId).not.toHaveBeenCalled();
  expect(messages.filter((message) => message.metadata?.isThinking)).toHaveLength(1);
  expect(messageIdByThinkingKey.get('tool:call-read:thinking:0')).toBe('msg-2');
  expect(provisionalMessage.metadata).toMatchObject({
    openclawThinkingAnchorToolCallId: 'call-read',
    openclawThinkingKey: 'tool:call-read:thinking:0',
  });
});
