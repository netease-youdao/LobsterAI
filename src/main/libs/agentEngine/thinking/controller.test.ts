import { expect, test, vi } from 'vitest';

import type { CoworkMessage } from '../../../coworkStore';
import {
  createOpenClawThinkingTurnState,
  OpenClawThinkingController,
  type OpenClawThinkingTurnContext,
} from './controller';

const createHarness = (initialMessages: CoworkMessage[]) => {
  const messages = [...initialMessages];
  let nextId = messages.length + 1;
  const updateMessage = vi.fn((
    _sessionId: string,
    messageId: string,
    updates: { content?: string; metadata?: CoworkMessage['metadata'] },
  ) => {
    const message = messages.find((candidate) => candidate.id === messageId);
    if (message) Object.assign(message, updates);
  });
  const createMessage = (payload: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage => ({
    ...payload,
    id: `msg-${nextId++}`,
    timestamp: nextId,
  });
  const store = {
    getSession: () => ({ messages }),
    addMessage: (_sessionId: string, payload: Omit<CoworkMessage, 'id' | 'timestamp'>) => {
      const message = createMessage(payload);
      messages.push(message);
      return message;
    },
    insertMessageBeforeId: (
      _sessionId: string,
      beforeMessageId: string,
      payload: Omit<CoworkMessage, 'id' | 'timestamp'>,
    ) => {
      const message = createMessage(payload);
      const index = messages.findIndex((candidate) => candidate.id === beforeMessageId);
      messages.splice(index < 0 ? messages.length : index, 0, message);
      return message;
    },
    updateMessage,
  };
  const emitMessage = vi.fn();
  const emitMessageUpdate = vi.fn();
  const controller = new OpenClawThinkingController({
    store: store as never,
    emitMessage,
    emitMessageUpdate,
    throttledStoreUpdate: (sessionId, messageId, content, metadata) => {
      updateMessage(sessionId, messageId, { content, metadata });
    },
    throttledEmitMessageUpdate: (sessionId, messageId, content) => {
      emitMessageUpdate(sessionId, messageId, content);
    },
    flushPendingStoreUpdate: vi.fn(),
    clearPendingMessageUpdate: vi.fn(),
  });

  return { controller, emitMessage, messages };
};

const message = (
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata: CoworkMessage['metadata'] = {},
): CoworkMessage => ({ id, type, content, metadata, timestamp: 1 });

const createTurn = (assistantMessageId?: string): OpenClawThinkingTurnContext => ({
  assistantMessageId,
  toolUseMessageIdByToolCallId: new Map(),
  thinking: createOpenClawThinkingTurnState(),
});

test('streams, finalizes, anchors, and reconciles one thinking message before its tool', () => {
  const { controller, messages } = createHarness([
    message('msg-1', 'user', 'inspect'),
    message('msg-2', 'assistant', 'Working...', { isStreaming: true }),
  ]);
  const turn = createTurn('msg-2');

  controller.handleStream('session-1', turn, { text: 'Inspect' });
  controller.handleStream('session-1', turn, { delta: ' repository' });
  controller.finalizeBeforeTool('session-1', turn, 'call-read');
  messages.push(message('msg-4', 'tool_use', 'Using tool: read', { toolUseId: 'call-read' }));
  turn.toolUseMessageIdByToolCallId.set('call-read', 'msg-4');
  controller.reconcile('session-1', turn, [
    { role: 'user', content: 'inspect' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspect repository' },
        { type: 'toolCall', id: 'call-read', name: 'read' },
      ],
    },
  ], false);

  const thinkingMessages = messages.filter((candidate) => candidate.metadata?.isThinking);
  expect(thinkingMessages).toHaveLength(1);
  expect(messages.indexOf(thinkingMessages[0])).toBeLessThan(
    messages.findIndex((candidate) => candidate.metadata?.toolUseId === 'call-read'),
  );
  expect(thinkingMessages[0]).toMatchObject({
    content: 'Inspect repository',
    metadata: {
      isStreaming: false,
      isFinal: true,
      openclawThinkingKey: 'tool:call-read:thinking:0',
    },
  });
});

test('reuses an existing finalized unkeyed thinking message for the final block', () => {
  const thinkingText = 'Summarize the completed subagent work.';
  const existingThinking = message(
    'msg-2',
    'assistant',
    thinkingText,
    { isThinking: true, isStreaming: false, isFinal: true },
  );
  const { controller, emitMessage, messages } = createHarness([
    message('msg-1', 'user', 'run two subagents'),
    existingThinking,
    message('msg-3', 'assistant', 'Both completed.', { isFinal: true }),
  ]);
  const turn = createTurn('msg-3');

  controller.reconcile('session-1', turn, [
    { role: 'user', content: 'run two subagents' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: thinkingText },
        { type: 'text', text: 'Both completed.' },
      ],
    },
  ], true);

  expect(messages.filter((candidate) => candidate.metadata?.isThinking)).toEqual([existingThinking]);
  expect(existingThinking.metadata?.openclawThinkingKey).toMatch(/^final:thinking:/);
  expect(emitMessage).not.toHaveBeenCalled();
});

test('finalizes a previous block when a cumulative stream resets', () => {
  const { controller, messages } = createHarness([message('msg-1', 'user', 'inspect')]);
  const turn = createTurn();

  controller.handleStream('session-1', turn, { text: 'First block' });
  controller.handleStream('session-1', turn, { text: 'Second block' });

  expect(messages.filter((candidate) => candidate.metadata?.isThinking)).toHaveLength(2);
  expect(messages[1].metadata).toMatchObject({ isStreaming: false, isFinal: true });
  expect(messages[2].metadata).toMatchObject({ isStreaming: true, isFinal: false });
});
