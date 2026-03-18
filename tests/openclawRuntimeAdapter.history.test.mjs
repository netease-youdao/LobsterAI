import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const originalModuleLoad = Module._load;

Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
      BrowserWindow: {
        getAllWindows: () => [],
      },
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { OpenClawRuntimeAdapter } = require('../dist-electron/main/libs/agentEngine/openclawRuntimeAdapter.js');

const createStore = (messages) => {
  const session = {
    id: 'session-1',
    title: 'Channel Session',
    claudeSessionId: null,
    status: 'completed',
    pinned: false,
    cwd: '',
    systemPrompt: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [...messages],
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = session.messages.length + 1;

  return {
    session,
    store: {
      getSession: (sessionId) => (sessionId === session.id ? session : null),
      addMessage: (sessionId, message) => {
        assert.equal(sessionId, session.id);
        const created = {
          id: `msg-${nextId++}`,
          timestamp: nextId,
          metadata: {},
          ...message,
        };
        session.messages.push(created);
        return created;
      },
      updateSession: () => {},
    },
  };
};

const getSystemMessages = (session) => session.messages.filter((message) => message.type === 'system');

test.after(() => {
  Module._load = originalModuleLoad;
});

test('syncFullChannelHistory seeds gateway history cursor so old reminders are not replayed', async () => {
  const { session, store } = createStore([
    { id: 'msg-1', type: 'user', content: 'old user', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'old assistant', timestamp: 2, metadata: { isStreaming: false, isFinal: true } },
  ]);
  const historyMessages = [
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: 'old assistant' },
    { role: 'system', content: 'Reminder: old reminder' },
  ];

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({ messages: historyMessages }),
  };

  await adapter.syncFullChannelHistory(session.id, 'dingtalk-connector:acct:user');

  assert.equal(adapter.gatewayHistoryCountBySession.get(session.id), historyMessages.length);

  adapter.syncSystemMessagesFromHistory(session.id, historyMessages, {
    previousCountKnown: adapter.gatewayHistoryCountBySession.has(session.id),
    previousCount: adapter.gatewayHistoryCountBySession.get(session.id) ?? 0,
  });

  assert.equal(getSystemMessages(session).length, 0);
});

test('prefetchChannelUserMessages also consumes existing reminder history backlog', async () => {
  const { session, store } = createStore([
    { id: 'msg-1', type: 'user', content: 'old user', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'old assistant', timestamp: 2, metadata: { isStreaming: false, isFinal: true } },
  ]);
  const historyMessages = [
    { role: 'user', content: 'old user' },
    { role: 'assistant', content: 'old assistant' },
    { role: 'system', content: 'Reminder: old reminder' },
    { role: 'user', content: 'new user turn' },
  ];

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({ messages: historyMessages }),
  };

  await adapter.prefetchChannelUserMessages(session.id, 'dingtalk-connector:acct:user');

  assert.equal(adapter.gatewayHistoryCountBySession.get(session.id), historyMessages.length);
  assert.equal(session.messages.filter((message) => message.type === 'user').length, 2);

  adapter.syncSystemMessagesFromHistory(session.id, historyMessages, {
    previousCountKnown: adapter.gatewayHistoryCountBySession.has(session.id),
    previousCount: adapter.gatewayHistoryCountBySession.get(session.id) ?? 0,
  });

  assert.equal(getSystemMessages(session).length, 0);
});

test('getSessionKeysForSession prefers channel keys before managed fallback', () => {
  const { store } = createStore([]);
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.rememberSessionKey('session-1', 'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374');
  adapter.rememberSessionKey('session-1', 'agent:main:lobsterai:session-1');

  assert.deepEqual(adapter.getSessionKeysForSession('session-1'), [
    'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374',
    'agent:main:lobsterai:session-1',
  ]);
});
