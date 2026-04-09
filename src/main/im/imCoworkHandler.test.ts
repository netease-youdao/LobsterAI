import { test, expect } from 'vitest';
import EventEmitter from 'node:events';
import { IMCoworkHandler } from './imCoworkHandler';

class FakeRuntime extends EventEmitter {
  startCalls: Array<{ sessionId: string; prompt: string; options: Record<string, unknown> }> = [];
  continueCalls: Array<{ sessionId: string; prompt: string; options: Record<string, unknown> }> = [];

  async startSession(sessionId: string, prompt: string, options = {}) {
    this.startCalls.push({ sessionId, prompt, options });
  }

  async continueSession(sessionId: string, prompt: string, options = {}) {
    this.continueCalls.push({ sessionId, prompt, options });
  }

  stopSession() {}
  stopAllSessions() {}
  respondToPermission() {}
  isSessionActive() { return false; }
  getSessionConfirmationMode() { return 'text'; }
}

class FakeCoworkStore {
  config = {
    workingDirectory: process.cwd(),
    systemPrompt: '',
    executionMode: 'auto',
    agentEngine: 'openclaw',
  };
  sessions = new Map<string, Record<string, unknown>>();
  sessionCounter = 0;
  messageCounter = 0;

  getConfig() {
    return this.config;
  }

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

  updateSession(id: string, updates: Record<string, unknown>) {
    const session = this.sessions.get(id);
    if (!session) return;
    Object.assign(session, updates);
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
  settings = { skillsEnabled: false };

  getIMSettings() {
    return this.settings;
  }

  listSessionMappings() {
    return [...this.mappings];
  }

  getSessionMapping(imConversationId: string, platform: string) {
    return this.mappings.find((entry) => (
      entry.imConversationId === imConversationId && entry.platform === platform
    )) || null;
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

  updateSessionLastActive(imConversationId: string, platform: string) {
    const mapping = this.getSessionMapping(imConversationId, platform);
    if (mapping) {
      mapping.lastActiveAt = Date.now();
    }
  }

  deleteSessionMapping(imConversationId: string, platform: string) {
    this.mappings = this.mappings.filter((entry) => (
      entry.imConversationId !== imConversationId || entry.platform !== platform
    ));
  }
}

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'nim',
    messageId: 'im-msg-1',
    conversationId: 'conv-1',
    senderId: 'user-1',
    senderName: 'Tester',
    content: '2分钟后提醒我喝水',
    chatType: 'direct',
    timestamp: Date.parse('2026-03-15T16:28:00+08:00'),
    ...overrides,
  };
}

test('IM scheduled-task requests bypass agent execution and create a real cron.add turn', async () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  let createdParams: Record<string, unknown> | null = null;

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    detectScheduledTaskRequest: async () => ({
      kind: 'create',
      sourceText: '2分钟后提醒我喝水',
      reminderBody: '喝水',
      delayMs: 120000,
      delayLabel: '2分钟后',
      runAt: new Date('2026-03-15T16:30:00+08:00'),
      scheduleAt: '2026-03-15T16:30:00+08:00',
      taskName: '喝水提醒',
      payloadText: '⏰ 提醒：喝水',
      confirmationText: '好的，已设置好提醒！2分钟后（16:30）会提醒你喝水。',
    }),
    createScheduledTask: async (params: Record<string, unknown>) => {
      createdParams = params;
      return {
        id: 'job-1',
        name: (params.request as Record<string, unknown>).taskName,
        agentId: 'main',
        sessionKey: `agent:main:lobsterai:${params.sessionId}`,
        payloadText: (params.request as Record<string, unknown>).payloadText,
        scheduleAt: (params.request as Record<string, unknown>).scheduleAt,
      };
    },
  });

  const reply = await handler.processMessage(createMessage());

  expect(reply).toMatch(/2分钟后（16:30）会提醒你喝水/u);
  expect(runtime.startCalls.length).toBe(0);
  expect(runtime.continueCalls.length).toBe(0);
  expect(createdParams).toBeTruthy();
  expect((createdParams!.request as Record<string, unknown>).taskName).toBe('喝水提醒');
  expect((createdParams!.request as Record<string, unknown>).payloadText).toBe('⏰ 提醒：喝水');

  const [session] = [...coworkStore.sessions.values()];
  expect(session).toBeTruthy();
  expect(
    (session.messages as Array<Record<string, unknown>>).map((message) => message.type),
  ).toEqual(['user', 'tool_use', 'tool_result', 'assistant']);
  expect(((session.messages as Array<Record<string, unknown>>)[1].metadata as Record<string, unknown>).toolName).toBe('cron');
  expect(((session.messages as Array<Record<string, unknown>>)[1].metadata as Record<string, unknown>).toolInput as Record<string, unknown>).toHaveProperty('action', 'add');
  expect(((session.messages as Array<Record<string, unknown>>)[2].metadata as Record<string, unknown>).isError).toBe(false);

  handler.destroy();
});

test.skip('async reminder turns on IM-created sessions relay back to the original IM conversation', async () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  const relayedReplies: Array<{ platform: string; conversationId: string; text: string }> = [];

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    detectScheduledTaskRequest: async () => ({
      kind: 'create',
      sourceText: '2分钟后提醒我喝水',
      reminderBody: '喝水',
      delayMs: 120000,
      delayLabel: '2分钟后',
      runAt: new Date('2026-03-15T16:30:00+08:00'),
      scheduleAt: '2026-03-15T16:30:00+08:00',
      taskName: '喝水提醒',
      payloadText: '⏰ 提醒：喝水',
      confirmationText: '好的，已设置好提醒！2分钟后（16:30）会提醒你喝水。',
    }),
    createScheduledTask: async (params: Record<string, unknown>) => ({
      id: 'job-1',
      name: (params.request as Record<string, unknown>).taskName,
      agentId: 'main',
      sessionKey: `agent:main:lobsterai:${params.sessionId}`,
      payloadText: (params.request as Record<string, unknown>).payloadText,
      scheduleAt: (params.request as Record<string, unknown>).scheduleAt,
    }),
    sendAsyncReply: async (platform: string, conversationId: string, text: string) => {
      relayedReplies.push({ platform, conversationId, text });
      return true;
    },
  });

  await handler.processMessage(createMessage());
  const [session] = [...coworkStore.sessions.values()];

  runtime.emit('message', session.id, {
    id: 'system-1',
    type: 'system',
    content: '⏰ 提醒：喝水',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', session.id, {
    id: 'assistant-1',
    type: 'assistant',
    content: '⏰ 该喝水啦！起身喝一杯水吧。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', session.id, null);

  await new Promise((resolve) => setImmediate(resolve));

  expect(relayedReplies).toEqual([
    {
      platform: 'nim',
      conversationId: 'conv-1',
      text: '⏰ 该喝水啦！起身喝一杯水吧。',
    },
  ]);

  handler.destroy();
});

test('async reminder turns on channel-synced sessions are tracked lazily and relay back', async () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  const relayedReplies: Array<{ platform: string; conversationId: string; text: string }> = [];

  const session = coworkStore.createSession('IM-dingtalk', process.cwd(), '', 'auto');
  imStore.createSessionMapping('default:user-42', 'dingtalk', session.id as string);

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    sendAsyncReply: async (platform: string, conversationId: string, text: string) => {
      relayedReplies.push({ platform, conversationId, text });
      return true;
    },
  });

  runtime.emit('message', session.id, {
    id: 'system-1',
    type: 'system',
    content: '⏰ 提醒：开会',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('message', session.id, {
    id: 'assistant-1',
    type: 'assistant',
    content: '时间到了，记得开会。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', session.id, null);

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

test('falls back to normal agent execution when detector does not recognize a scheduled task', async () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    detectScheduledTaskRequest: async () => null,
  });

  const pending = handler.processMessage(createMessage({ content: '帮我总结一下今天的会议纪要' }));
  await new Promise((resolve) => setImmediate(resolve));

  expect(runtime.startCalls.length).toBe(1);
  expect(runtime.startCalls[0].prompt).toBe('帮我总结一下今天的会议纪要');

  runtime.emit('message', 'session-1', {
    id: 'assistant-1',
    type: 'assistant',
    content: '这是会议纪要摘要。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', 'session-1', null);

  const reply = await pending;
  expect(reply).toBe('这是会议纪要摘要。');

  handler.destroy();
});
