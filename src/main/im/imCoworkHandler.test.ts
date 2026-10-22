import EventEmitter from 'node:events';

import { expect, test, vi } from 'vitest';

import { IMCoworkHandler } from './imCoworkHandler';

class FakeRuntime extends EventEmitter {
  permissionResponses: Array<{ requestId: string; result: Record<string, unknown> }> = [];

  respondToPermission(requestId: string, result: Record<string, unknown>) {
    this.permissionResponses.push({ requestId, result });
  }
}

class FakeCoworkStore {
  sessions = new Map<string, Record<string, unknown>>();
  sessionCounter = 0;
  messageCounter = 0;

  createSession(title: string, cwd: string, systemPrompt: string, executionMode: string) {
    const id = `session-${++this.sessionCounter}`;
    const session = {
      id,
      title,
      cwd,
      systemPrompt,
      executionMode,
      claudeSessionId: null,
      status: 'idle',
      messages: [] as Array<Record<string, unknown>>,
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string) {
    return this.sessions.get(id) || null;
  }

  addMessage(sessionId: string, message: Record<string, unknown>) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const created = {
      id: `message-${++this.messageCounter}`,
      timestamp: Date.now(),
      ...message,
    };
    (session.messages as Array<Record<string, unknown>>).push(created);
    return created;
  }
}

class FakeIMStore {
  mappings: Array<Record<string, unknown>> = [];

  listSessionMappings() {
    return [...this.mappings];
  }

  getSessionMappingByCoworkSessionId(coworkSessionId: string) {
    return this.mappings.find((entry) => entry.coworkSessionId === coworkSessionId) || null;
  }

  createSessionMapping(imConversationId: string, platform: string, coworkSessionId: string) {
    const mapping = {
      imConversationId,
      platform,
      coworkSessionId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.mappings.push(mapping);
    return mapping;
  }
}

function createRelayFixture() {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  const relayedReplies: Array<{ platform: string; conversationId: string; text: string }> = [];

  const session = coworkStore.createSession('IM-dingtalk', process.cwd(), '', 'auto');
  const sessionId = session.id as string;
  imStore.createSessionMapping('default:user-42', 'dingtalk', sessionId);

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    sendAsyncReply: async (platform: string, conversationId: string, text: string) => {
      relayedReplies.push({ platform, conversationId, text });
      return true;
    },
  });

  return { runtime, coworkStore, handler, relayedReplies, sessionId };
}

test('async reminder turns on channel-synced sessions are tracked lazily and relay back', async () => {
  const { runtime, handler, relayedReplies, sessionId } = createRelayFixture();

  runtime.emit('message', sessionId, {
    id: 'system-1',
    type: 'system',
    content: '⏰ 提醒：开会',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', sessionId, {
    id: 'assistant-1',
    type: 'assistant',
    content: '时间到了，记得开会。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', sessionId, null);

  await new Promise((resolve) => setImmediate(resolve));

  expect(relayedReplies).toEqual([
    {
      platform: 'dingtalk',
      conversationId: 'default:user-42',
      text: '时间到了，记得开会。',
    },
  ]);

  handler.destroy();
});

test('relays only current-turn store messages for an async reminder reply', async () => {
  const { runtime, coworkStore, handler, relayedReplies, sessionId } = createRelayFixture();

  coworkStore.addMessage(sessionId, {
    id: 'old-user',
    type: 'user',
    content: '上一轮问题',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'old-assistant',
    type: 'assistant',
    content: '上一轮答案，不应该出现在本次 IM 回复里。',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'current-system',
    type: 'system',
    content: '⏰ 提醒：查测试环境日志',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'current-assistant',
    type: 'assistant',
    content: '当前轮最终答案。',
    metadata: {},
  });

  runtime.emit('message', sessionId, {
    id: 'current-system',
    type: 'system',
    content: '⏰ 提醒：查测试环境日志',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', sessionId, {
    id: 'current-assistant',
    type: 'assistant',
    content: '当前轮流式快照',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', sessionId, null);

  await new Promise((resolve) => setImmediate(resolve));

  expect(relayedReplies.map((reply) => reply.text)).toEqual(['当前轮最终答案。']);

  handler.destroy();
});

test('falls back to the reminder turn boundary when reconciled store message ids changed', async () => {
  const { runtime, coworkStore, handler, relayedReplies, sessionId } = createRelayFixture();

  coworkStore.addMessage(sessionId, {
    id: 'history-user',
    type: 'user',
    content: '历史问题',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'history-assistant',
    type: 'assistant',
    content: '历史答案，不应该被发送。',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'store-current-system',
    type: 'system',
    content: '⏰ 提醒：继续查错误',
    metadata: {},
  });
  coworkStore.addMessage(sessionId, {
    id: 'runtime-tool-use',
    type: 'tool_use',
    content: 'Using tool: exec',
    metadata: { toolName: 'exec', toolUseId: 'tool-1' },
  });
  coworkStore.addMessage(sessionId, {
    id: 'store-current-assistant',
    type: 'assistant',
    content: '按 boundary 找到的当前轮最终答案。',
    metadata: {},
  });

  runtime.emit('message', sessionId, {
    id: 'runtime-current-system',
    type: 'system',
    content: '⏰ 提醒：继续查错误',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', sessionId, {
    id: 'runtime-tool-use',
    type: 'tool_use',
    content: 'Using tool: exec',
    timestamp: Date.now(),
    metadata: { toolName: 'exec', toolUseId: 'tool-1' },
  });
  runtime.emit('message', sessionId, {
    id: 'runtime-current-assistant',
    type: 'assistant',
    content: '当前轮流式快照',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', sessionId, null);

  await new Promise((resolve) => setImmediate(resolve));

  expect(relayedReplies.map((reply) => reply.text)).toEqual(['按 boundary 找到的当前轮最终答案。']);

  handler.destroy();
});

test('does not relay thinking content for raw async reminder replies', async () => {
  const { runtime, handler, relayedReplies, sessionId } = createRelayFixture();

  runtime.emit('message', sessionId, {
    id: 'system-1',
    type: 'system',
    content: '⏰ 提醒：开会',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', sessionId, {
    id: 'thinking-1',
    type: 'assistant',
    content: '内部推理',
    timestamp: Date.now(),
    metadata: { isThinking: true },
  });
  runtime.emit('message', sessionId, {
    id: 'assistant-1',
    type: 'assistant',
    content: '<thinking>先判断提醒语气</thinking>时间到了，记得开会。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', sessionId, null);

  await new Promise((resolve) => setImmediate(resolve));

  expect(relayedReplies).toEqual([
    {
      platform: 'dingtalk',
      conversationId: 'default:user-42',
      text: '时间到了，记得开会。',
    },
  ]);

  handler.destroy();
});

test('denies IM session permission requests when superseded or after 60s', () => {
  vi.useFakeTimers();
  try {
    const { runtime, handler, sessionId } = createRelayFixture();

    runtime.emit('permissionRequest', sessionId, { requestId: 'request-1', toolName: 'plugin', toolInput: {} });
    runtime.emit('permissionRequest', sessionId, { requestId: 'request-2', toolName: 'plugin', toolInput: {} });

    expect(runtime.permissionResponses).toEqual([
      { requestId: 'request-1', result: { behavior: 'deny', message: 'Superseded by a newer permission request.' } },
    ]);

    vi.advanceTimersByTime(60_000);

    expect(runtime.permissionResponses).toEqual([
      { requestId: 'request-1', result: { behavior: 'deny', message: 'Superseded by a newer permission request.' } },
      { requestId: 'request-2', result: { behavior: 'deny', message: 'Permission request timed out after 60s' } },
    ]);

    handler.destroy();
  } finally {
    vi.useRealTimers();
  }
});

test('destroy tolerates background accumulators', () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  const session = coworkStore.createSession('Background session', process.cwd(), '', 'auto');
  imStore.createSessionMapping('conv-background', 'nim', session.id as string);

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
  });

  runtime.emit('message', session.id, {
    id: 'background-message',
    type: 'assistant',
    content: 'Background reply',
    timestamp: Date.now(),
    metadata: {},
  });

  expect(() => handler.destroy()).not.toThrow();
});
