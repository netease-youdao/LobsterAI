import { test, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

// ==================== Reconcile tests ====================

function createReconcileStore(messages: Array<Record<string, unknown>>) {
  const session = {
    id: 'session-1',
    title: 'Test Session',
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
  let replaceCallCount = 0;
  let lastReplaceArgs: { sessionId: string; authoritative: unknown[] } | null = null;

  return {
    session,
    getReplaceCallCount: () => replaceCallCount,
    getLastReplaceArgs: () => lastReplaceArgs,
    store: {
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      addMessage: (sessionId: string, message: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
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
      replaceConversationMessages: (sessionId: string, authoritative: Array<{ role: string; text: string }>) => {
        replaceCallCount++;
        lastReplaceArgs = { sessionId, authoritative };
        // Simulate: remove old user/assistant, insert new ones
        session.messages = session.messages.filter(
          (m) => m.type !== 'user' && m.type !== 'assistant',
        );
        for (const entry of authoritative) {
          session.messages.push({
            id: `msg-${nextId++}`,
            type: entry.role,
            content: entry.text,
            metadata: { isStreaming: false, isFinal: true },
            timestamp: nextId,
          });
        }
      },
      deleteMessage: () => true,
    },
  };
}

test('reconcileWithHistory: already in sync — skips replace', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Hi there', timestamp: 2, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.length).toBe(2);
});

test('reconcileWithHistory: missing assistant message — triggers replace', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    // assistant message missing locally
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  expect(args.sessionId).toBe(session.id);
  expect(args.authoritative).toEqual([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Hi there' },
  ]);
});

test('reconcileWithHistory: duplicate messages locally — skips replace to preserve local history', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Hi there', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'assistant', content: 'Hi there', timestamp: 3, metadata: {} }, // duplicate
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  // Gateway has fewer entries than local — skip replace to avoid data loss
  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.length).toBe(3);
});

test('reconcileWithHistory: content mismatch — triggers replace', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Streaming partial...', timestamp: 2, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Full complete response from the model.' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  expect((args.authoritative[1] as Record<string, unknown>).text).toBe('Full complete response from the model.');
});

test('reconcileWithHistory: preserves tool messages', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Run a command', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'tool_use', content: 'Using bash', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'tool_result', content: 'OK', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Done!', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Run a command' },
        { role: 'assistant', content: 'Done!' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
});

test('reconcileWithHistory: gateway has fewer entries — skips replace to preserve local history', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Hi there', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'How are you?', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'I am fine', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am fine' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.length).toBe(4);
});

test('reconcileWithHistory: empty history — sets cursor to 0', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({ messages: [] }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
  expect(adapter.channelSyncCursor.get(session.id)).toBe(0);
});

test('reconcileWithHistory: multi-turn conversation — correct order', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'First', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Reply 1', timestamp: 2, metadata: {} },
    // Missing second turn
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply 1' },
        { role: 'user', content: 'Second' },
        { role: 'assistant', content: 'Reply 2' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  expect(args.authoritative.length).toBe(4);
  expect((args.authoritative[2] as Record<string, unknown>).text).toBe('Second');
  expect((args.authoritative[3] as Record<string, unknown>).text).toBe('Reply 2');
});

test('reconcileWithHistory: gateway error — does not crash', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => { throw new Error('Network timeout'); },
  };

  // Should not throw
  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
});

// ==================== History tests ====================

function createHistoryStore(messages: Array<Record<string, unknown>>) {
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
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      addMessage: (sessionId: string, message: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
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
}

const getSystemMessages = (session: { messages: Array<{ type: string }> }) =>
  session.messages.filter((message) => message.type === 'system');

test('syncFullChannelHistory seeds gateway history cursor so old reminders are not replayed', async () => {
  const { session, store } = createHistoryStore([
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

  expect(adapter.gatewayHistoryCountBySession.get(session.id)).toBe(historyMessages.length);

  adapter.syncSystemMessagesFromHistory(session.id, historyMessages, {
    previousCountKnown: adapter.gatewayHistoryCountBySession.has(session.id),
    previousCount: adapter.gatewayHistoryCountBySession.get(session.id) ?? 0,
  });

  expect(getSystemMessages(session).length).toBe(0);
});

test('prefetchChannelUserMessages also consumes existing reminder history backlog', async () => {
  const { session, store } = createHistoryStore([
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

  expect(adapter.gatewayHistoryCountBySession.get(session.id)).toBe(historyMessages.length);
  expect(session.messages.filter((message: Record<string, unknown>) => message.type === 'user').length).toBe(2);

  adapter.syncSystemMessagesFromHistory(session.id, historyMessages, {
    previousCountKnown: adapter.gatewayHistoryCountBySession.has(session.id),
    previousCount: adapter.gatewayHistoryCountBySession.get(session.id) ?? 0,
  });

  expect(getSystemMessages(session).length).toBe(0);
});

test('getSessionKeysForSession prefers channel keys before managed fallback', () => {
  const { store } = createHistoryStore([]);
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.rememberSessionKey('session-1', 'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374');
  adapter.rememberSessionKey('session-1', 'agent:main:lobsterai:session-1');

  expect(adapter.getSessionKeysForSession('session-1')).toEqual([
    'agent:main:openai-user:dingtalk-connector:__default__:2459325231940374',
    'agent:main:lobsterai:session-1',
  ]);
});
