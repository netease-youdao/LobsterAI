import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IMCoworkHandler } = require('../dist-electron/main/im/imCoworkHandler.js');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.startCalls = [];
    this.continueCalls = [];
  }

  async startSession(sessionId, prompt, options = {}) {
    this.startCalls.push({ sessionId, prompt, options });
  }

  async continueSession(sessionId, prompt, options = {}) {
    this.continueCalls.push({ sessionId, prompt, options });
  }

  stopSession() {}
  stopAllSessions() {}
  respondToPermission() {}
  isSessionActive() { return false; }
  getSessionConfirmationMode() { return 'text'; }
}

class FakeCoworkStore {
  constructor() {
    this.config = {
      workingDirectory: process.cwd(),
      systemPrompt: '',
      executionMode: 'auto',
      agentEngine: 'openclaw',
    };
    this.sessions = new Map();
    this.sessionCounter = 0;
    this.messageCounter = 0;
  }

  getConfig() {
    return this.config;
  }

  createSession(title, cwd, systemPrompt, executionMode) {
    const id = `session-${++this.sessionCounter}`;
    const session = {
      id,
      title,
      cwd,
      systemPrompt,
      executionMode,
      claudeSessionId: null,
      status: 'idle',
      messages: [],
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  updateSession(id, updates) {
    const session = this.sessions.get(id);
    if (!session) return;
    Object.assign(session, updates);
  }

  addMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const created = {
      id: `message-${++this.messageCounter}`,
      timestamp: Date.now(),
      ...message,
    };
    session.messages.push(created);
    return created;
  }
}

class FakeIMStore {
  constructor() {
    this.mappings = [];
    this.settings = { skillsEnabled: false };
  }

  getIMSettings() {
    return this.settings;
  }

  listSessionMappings() {
    return [...this.mappings];
  }

  getSessionMapping(imConversationId, platform) {
    return this.mappings.find((entry) => (
      entry.imConversationId === imConversationId && entry.platform === platform
    )) || null;
  }

  getSessionMappingByCoworkSessionId(coworkSessionId) {
    return this.mappings.find((entry) => entry.coworkSessionId === coworkSessionId) || null;
  }

  createSessionMapping(imConversationId, platform, coworkSessionId) {
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

  updateSessionLastActive(imConversationId, platform) {
    const mapping = this.getSessionMapping(imConversationId, platform);
    if (mapping) {
      mapping.lastActiveAt = Date.now();
    }
  }

  deleteSessionMapping(imConversationId, platform) {
    this.mappings = this.mappings.filter((entry) => (
      entry.imConversationId !== imConversationId || entry.platform !== platform
    ));
  }
}

function createMessage(overrides = {}) {
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
  let createdParams = null;

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
    createScheduledTask: async (params) => {
      createdParams = params;
      return {
        id: 'job-1',
        name: params.request.taskName,
        agentId: 'main',
        sessionKey: `agent:main:lobsterai:${params.sessionId}`,
        payloadText: params.request.payloadText,
        scheduleAt: params.request.scheduleAt,
      };
    },
  });

  const reply = await handler.processMessage(createMessage());

  assert.match(reply, /2分钟后（16:30）会提醒你喝水/u);
  assert.equal(runtime.startCalls.length, 0);
  assert.equal(runtime.continueCalls.length, 0);
  assert.ok(createdParams);
  assert.equal(createdParams.request.taskName, '喝水提醒');
  assert.equal(createdParams.request.payloadText, '⏰ 提醒：喝水');

  const [session] = [...coworkStore.sessions.values()];
  assert.ok(session);
  assert.deepEqual(
    session.messages.map((message) => message.type),
    ['user', 'tool_use', 'tool_result', 'assistant'],
  );
  assert.equal(session.messages[1].metadata.toolName, 'cron');
  assert.equal(session.messages[1].metadata.toolInput.action, 'add');
  assert.equal(session.messages[2].metadata.isError, false);

  handler.destroy();
});

test('async reminder turns on IM-created sessions relay back to the original IM conversation', async () => {
  const runtime = new FakeRuntime();
  const coworkStore = new FakeCoworkStore();
  const imStore = new FakeIMStore();
  const relayedReplies = [];

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
    createScheduledTask: async (params) => ({
      id: 'job-1',
      name: params.request.taskName,
      agentId: 'main',
      sessionKey: `agent:main:lobsterai:${params.sessionId}`,
      payloadText: params.request.payloadText,
      scheduleAt: params.request.scheduleAt,
    }),
    sendAsyncReply: async (platform, conversationId, text) => {
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

  assert.deepEqual(relayedReplies, [
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
  const relayedReplies = [];

  const session = coworkStore.createSession('IM-dingtalk', process.cwd(), '', 'auto');
  imStore.createSessionMapping('default:user-42', 'dingtalk', session.id);

  const handler = new IMCoworkHandler({
    coworkRuntime: runtime,
    coworkStore,
    imStore,
    sendAsyncReply: async (platform, conversationId, text) => {
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

  assert.deepEqual(relayedReplies, [
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

  assert.equal(runtime.startCalls.length, 1);
  assert.equal(runtime.startCalls[0].prompt, '帮我总结一下今天的会议纪要');

  runtime.emit('message', 'session-1', {
    id: 'assistant-1',
    type: 'assistant',
    content: '这是会议纪要摘要。',
    timestamp: Date.now(),
    metadata: {},
  });
  runtime.emit('complete', 'session-1', null);

  const reply = await pending;
  assert.equal(reply, '这是会议纪要摘要。');

  handler.destroy();
});
