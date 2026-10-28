import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IMCoworkHandler } = require('../dist-electron/main/im/imCoworkHandler.js');

class FakeRuntime extends EventEmitter {
  respondToPermission() {}
}

class FakeCoworkStore {
  constructor() {
    this.sessions = new Map();
    this.sessionCounter = 0;
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
}

class FakeIMStore {
  constructor() {
    this.mappings = [];
  }

  listSessionMappings() {
    return [...this.mappings];
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
}

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
