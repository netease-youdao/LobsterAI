import { expect, test } from 'vitest';

import type { CoworkMessage, CoworkSession } from '../../types/cowork';
import { CoworkSessionStatusValue } from '../../types/cowork';
import {
  buildCoworkSessionJSON,
  buildCoworkSessionMarkdown,
  mergeCoworkTextExportMessages,
} from './sessionExport';

const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);

function createMessage(id: string, type: CoworkMessage['type'], content: string): CoworkMessage {
  return {
    id,
    type,
    content,
    timestamp: baseTime + Number(id.replace(/\D/g, '') || 0),
  };
}

function createSession(messages: CoworkMessage[]): CoworkSession {
  return {
    id: 'session-1',
    title: 'Long export',
    claudeSessionId: null,
    scheduledTaskId: null,
    status: CoworkSessionStatusValue.Completed,
    pinned: false,
    cwd: '/tmp/project',
    systemPrompt: '',
    modelOverride: '',
    executionMode: 'local',
    activeSkillIds: [],
    agentId: 'main',
    messages,
    messagesOffset: Math.max(0, 120 - messages.length),
    totalMessages: 120,
    createdAt: baseTime,
    updatedAt: baseTime + 120,
  };
}

test('buildCoworkSessionMarkdown exports the provided full message list', () => {
  const loadedTail = [createMessage('message-120', 'assistant', 'tail only')];
  const fullMessages = [
    createMessage('message-1', 'user', 'first prompt'),
    createMessage('message-2', 'assistant', 'first answer'),
    createMessage('message-120', 'assistant', 'tail only'),
  ];

  const markdown = buildCoworkSessionMarkdown(
    createSession(loadedTail),
    fullMessages,
    key => key,
  );

  expect(markdown).toContain('first prompt');
  expect(markdown).toContain('first answer');
  expect(markdown).toContain('tail only');
});

test('buildCoworkSessionJSON exports the provided full message list', () => {
  const loadedTail = [createMessage('message-120', 'assistant', 'tail only')];
  const fullMessages = [
    createMessage('message-1', 'user', 'first prompt'),
    createMessage('message-2', 'assistant', 'first answer'),
    createMessage('message-120', 'assistant', 'tail only'),
  ];

  const parsed = JSON.parse(buildCoworkSessionJSON(createSession(loadedTail), fullMessages));

  expect(parsed.messages).toHaveLength(3);
  expect(parsed.messages[0].content).toBe('first prompt');
  expect(parsed.messages[2].content).toBe('tail only');
});

test('mergeCoworkTextExportMessages keeps stored order and prefers current message updates', () => {
  const storedMessages = [
    createMessage('message-1', 'user', 'first prompt'),
    createMessage('message-2', 'assistant', 'old streaming text'),
  ];
  const currentMessages = [
    createMessage('message-2', 'assistant', 'new streaming text'),
    createMessage('message-3', 'tool_result', 'not persisted yet'),
  ];

  const merged = mergeCoworkTextExportMessages(storedMessages, currentMessages);

  expect(merged.map(message => message.id)).toEqual(['message-1', 'message-2', 'message-3']);
  expect(merged[1].content).toBe('new streaming text');
  expect(merged[2].content).toBe('not persisted yet');
});
