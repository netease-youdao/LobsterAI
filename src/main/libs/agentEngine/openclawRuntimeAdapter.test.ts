import { expect, test, vi } from 'vitest';

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

// ==================== Session patch tests ====================

function createPatchAdapter(options?: {
  isChannelSession?: boolean;
  persistedSessionKey?: string | null;
}) {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    claudeSessionId: null,
    status: 'completed',
    pinned: false,
    cwd: '',
    systemPrompt: '',
    modelOverride: '',
    executionMode: 'local',
    activeSkillIds: [],
    agentId: 'main',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    updateSession: () => {},
  };
  const engineManager = {
    startGateway: async () => ({ phase: 'running', message: '' }),
    getGatewayConnectionInfo: () => ({
      url: 'ws://127.0.0.1:9999',
      token: 'token',
      version: 'test-version',
      clientEntryPath: '/tmp/openclaw-gateway-client.js',
    }),
  };
  const adapter = new OpenClawRuntimeAdapter(store as never, engineManager as never);
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params: params as Record<string, unknown> });
      return {};
    },
  };
  adapter.gatewayClientVersion = 'test-version';
  adapter.gatewayClientEntryPath = '/tmp/openclaw-gateway-client.js';
  adapter.gatewayReadyPromise = Promise.resolve();
  if (options?.isChannelSession !== undefined) {
    adapter.channelSessionSync = {
      getOpenClawSessionKeyForCoworkSession: () => ({
        isChannelSession: !!options.isChannelSession,
        sessionKey: options.persistedSessionKey ?? null,
      }),
    };
  }
  return { adapter, requests };
}

test('patchSession uses the persisted IM channel session key after runtime cache is empty', async () => {
  const { adapter, requests } = createPatchAdapter({
    isChannelSession: true,
    persistedSessionKey: 'agent:main:feishu:dm:ou_123',
  });

  await adapter.patchSession('session-1', { model: 'lobsterai-server/qwen3.6-plus-YoudaoInner' });

  expect(requests).toEqual([
    {
      method: 'sessions.patch',
      params: {
        key: 'agent:main:feishu:dm:ou_123',
        model: 'lobsterai-server/qwen3.6-plus-YoudaoInner',
      },
    },
  ]);
});

test('patchSession rejects IM channel sessions when the real OpenClaw key is missing', async () => {
  const { adapter, requests } = createPatchAdapter({
    isChannelSession: true,
    persistedSessionKey: null,
  });

  await expect(adapter.patchSession('session-1', { model: 'lobsterai-server/qwen3.6-plus-YoudaoInner' }))
    .rejects.toThrow('Cannot patch IM channel session because the OpenClaw session key is missing.');

  expect(requests).toHaveLength(0);
});

test('patchSession keeps managed-key fallback for normal Cowork sessions', async () => {
  const { adapter, requests } = createPatchAdapter({
    isChannelSession: false,
    persistedSessionKey: null,
  });

  await adapter.patchSession('session-1', { model: 'moonshot/kimi-k2.6' });

  expect(requests[0]).toEqual({
    method: 'sessions.patch',
    params: {
      key: 'agent:main:lobsterai:session-1',
      model: 'moonshot/kimi-k2.6',
    },
  });
});

function createRunTurnAdapter(options: {
  sessionModelOverride?: string;
  agentModel?: string;
  cachedModel?: string;
  holdFirstModelPatch?: boolean;
} = {}) {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    claudeSessionId: null,
    status: 'completed',
    pinned: false,
    cwd: '',
    systemPrompt: '',
    modelOverride: options.sessionModelOverride ?? '',
    executionMode: 'local',
    activeSkillIds: [],
    agentId: 'main',
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextMessageId = 1;
  let firstModelPatchStartedResolve: (() => void) | null = null;
  let firstModelPatchRelease: (() => void) | null = null;
  let modelPatchCount = 0;
  const firstModelPatchStarted = new Promise<void>((resolve) => {
    firstModelPatchStartedResolve = resolve;
  });
  const firstModelPatchBlocked = new Promise<void>((resolve) => {
    firstModelPatchRelease = resolve;
  });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    updateSession: (sessionId: string, patch: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      Object.assign(session, patch);
    },
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextMessageId++}`,
        timestamp: nextMessageId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: (sessionId: string, messageId: string, patch: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const message = session.messages.find((entry) => entry.id === messageId);
      if (message) {
        Object.assign(message, patch);
      }
    },
    deleteMessage: () => true,
    getAgent: (agentId: string) => (agentId === 'main'
      ? {
        id: 'main',
        name: 'Main',
        model: options.agentModel ?? 'lobsterai-server/qwen3.5-plus-YoudaoInner',
      }
      : null),
    updateAgent: () => {},
  };
  const engineManager = {
    startGateway: async () => ({ phase: 'running', message: '' }),
    getGatewayConnectionInfo: () => ({
      url: 'ws://127.0.0.1:9999',
      token: 'token',
      version: 'test-version',
      clientEntryPath: '/tmp/openclaw-gateway-client.js',
    }),
  };
  const adapter = new OpenClawRuntimeAdapter(store as never, engineManager as never);
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async (method: string, params?: unknown) => {
      const requestParams = (params ?? {}) as Record<string, unknown>;
      requests.push({ method, params: requestParams });
      if (method === 'sessions.patch') {
        modelPatchCount++;
        if (options.holdFirstModelPatch && modelPatchCount === 1) {
          firstModelPatchStartedResolve?.();
          await firstModelPatchBlocked;
        }
        return {};
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'chat.send') {
        const runId = typeof requestParams.idempotencyKey === 'string'
          ? requestParams.idempotencyKey
          : 'run-1';
        const sessionKey = typeof requestParams.sessionKey === 'string'
          ? requestParams.sessionKey
          : 'agent:main:lobsterai:session-1';
        queueMicrotask(() => {
          (adapter as unknown as {
            handleChatEvent: (payload: unknown, seq?: number) => void;
          }).handleChatEvent({
            state: 'final',
            runId,
            sessionKey,
            message: { role: 'assistant', content: 'Done' },
          }, 1);
        });
        return { runId };
      }
      return {};
    },
  };
  adapter.gatewayClientVersion = 'test-version';
  adapter.gatewayClientEntryPath = '/tmp/openclaw-gateway-client.js';
  adapter.gatewayReadyPromise = Promise.resolve();
  adapter.reconcileWithHistory = async () => {};

  if (options.cachedModel) {
    adapter.lastPatchedModelBySession.set(session.id, options.cachedModel);
  }

  return {
    adapter,
    requests,
    releaseFirstModelPatch: () => firstModelPatchRelease?.(),
    firstModelPatchStarted,
  };
}

test('continueSession patches a session override before chat.send even when the model cache matches', async () => {
  const model = 'lobsterai-server/qwen3.6-plus-YoudaoInner';
  const { adapter, requests } = createRunTurnAdapter({
    sessionModelOverride: model,
    cachedModel: model,
  });

  await adapter.continueSession('session-1', 'hello');

  expect(requests.map((request) => request.method).slice(0, 3)).toEqual([
    'sessions.patch',
    'chat.history',
    'chat.send',
  ]);
  expect(requests[0].params).toEqual({
    key: 'agent:main:lobsterai:session-1',
    model,
  });
});

test('continueSession waits for an in-flight model patch before chat.send', async () => {
  const model = 'lobsterai-server/qwen3.6-plus-YoudaoInner';
  const {
    adapter,
    requests,
    firstModelPatchStarted,
    releaseFirstModelPatch,
  } = createRunTurnAdapter({
    sessionModelOverride: model,
    holdFirstModelPatch: true,
  });

  const patchPromise = adapter.patchSession('session-1', { model });
  await firstModelPatchStarted;

  const continuePromise = adapter.continueSession('session-1', 'hello');
  await Promise.resolve();
  await Promise.resolve();

  expect(requests.map((request) => request.method)).toEqual(['sessions.patch']);

  releaseFirstModelPatch();
  await patchPromise;
  await continuePromise;

  expect(requests.map((request) => request.method).slice(0, 4)).toEqual([
    'sessions.patch',
    'sessions.patch',
    'chat.history',
    'chat.send',
  ]);
});

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
    modelOverride: '',
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
      updateSession: (sessionId: string, patch: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        Object.assign(session, patch);
      },
      updateMessage: (sessionId: string, messageId: string, patch: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        const message = session.messages.find((m) => m.id === messageId);
        if (!message) return false;
        Object.assign(message, patch);
        return true;
      },
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

test('reconcileWithHistory: filters heartbeat prompt and ack entries', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        {
          role: 'user',
          content: `Read HEARTBEAT.md if it exists.
When reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md.
Do not infer or repeat old tasks from prior chats.
If nothing needs attention, reply HEARTBEAT_OK.`,
        },
        { role: 'assistant', content: 'HEARTBEAT_OK' },
        { role: 'assistant', content: 'Real answer' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  expect(getLastReplaceArgs()?.authoritative).toEqual([
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'Real answer' },
  ]);
});

test('reconcileWithHistory: duplicate messages locally — triggers replace', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
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

  // Gateway is authoritative — replaces to fix duplicates
  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  expect(args.authoritative.length).toBe(2);
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

test('lifecycle fallback repairs managed session assistant text from history', async () => {
  const brokenTable = [
    'OpenClaw 优缺点总结',
    '',
    '| 维度 | 优点 ✅ | 缺点 ❌ |',
    '|---------|',
    '| 架构设计 | 单 Gateway | 单点风险 |',
  ].join('\n');
  const finalTable = [
    'OpenClaw 优缺点总结',
    '',
    '| 维度 | 优点 ✅ | 缺点 ❌ |',
    '|------|---------|---------|',
    '| 架构设计 | 单 Gateway | 单点风险 |',
  ].join('\n');
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: '以表格总结 OpenClaw', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: brokenTable, timestamp: 2, metadata: { isStreaming: true } },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: '以表格总结 OpenClaw' },
        { role: 'assistant', content: finalTable },
      ],
    }),
  };

  const turn = {
    sessionId: session.id,
    sessionKey: `agent:main:lobsterai:${session.id}`,
    runId: 'run-1',
    turnToken: 1,
    startedAtMs: 1,
    knownRunIds: new Set(['run-1']),
    assistantMessageId: 'msg-2',
    committedAssistantText: '',
    currentAssistantSegmentText: brokenTable,
    currentText: brokenTable,
    agentAssistantTextLength: brokenTable.length,
    currentContentText: brokenTable,
    currentContentBlocks: [brokenTable],
    sawNonTextContentBlocks: false,
    textStreamMode: 'snapshot',
    toolUseMessageIdByToolCallId: new Map(),
    toolResultMessageIdByToolCallId: new Map(),
    toolResultTextByToolCallId: new Map(),
    stopRequested: false,
    pendingUserSync: false,
    bufferedChatPayloads: [],
    bufferedAgentPayloads: [],
  };

  adapter.activeTurns.set(session.id, turn);
  adapter.latestTurnTokenBySession.set(session.id, turn.turnToken);

  await adapter.completeChannelTurnFallback(session.id, turn);

  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.find((message) => message.id === 'msg-2')?.content).toBe(finalTable);
  expect(session.status).toBe('completed');
});

test('late lifecycle fallback event does not reopen a completed managed session', () => {
  const { session, store } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: '你是哪个模型', timestamp: 1, metadata: {} },
    {
      id: 'msg-2',
      type: 'assistant',
      content: '当前会话使用的是 qwen-portal/qwen3.6-plus 模型。',
      timestamp: 2,
      metadata: { isStreaming: false, isFinal: true },
    },
  ]);
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = `agent:main:lobsterai:${session.id}`;

  adapter.rememberSessionKey(session.id, sessionKey);
  adapter.handleGatewayEvent({
    event: 'agent',
    seq: 1,
    payload: {
      runId: 'late-run',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'fallback' },
    },
  });

  expect(session.status).toBe('completed');
  expect(adapter.activeTurns.has(session.id)).toBe(false);
  expect(adapter.sessionIdByRunId.has('late-run')).toBe(false);
});

test('late event for a closed run does not recreate a managed session turn', () => {
  const { session, store } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'done', timestamp: 2, metadata: { isStreaming: false, isFinal: true } },
  ]);
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const sessionKey = `agent:main:lobsterai:${session.id}`;

  adapter.rememberSessionKey(session.id, sessionKey);
  adapter.ensureActiveTurn(session.id, sessionKey, 'closed-run');
  session.status = 'completed';
  adapter.cleanupSessionTurn(session.id);

  adapter.handleGatewayEvent({
    event: 'agent',
    seq: 2,
    payload: {
      runId: 'closed-run',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    },
  });

  expect(session.status).toBe('completed');
  expect(adapter.activeTurns.has(session.id)).toBe(false);
  expect(adapter.sessionIdByRunId.has('closed-run')).toBe(false);
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

test('reconcileWithHistory: gateway returns tail subset — preserves older local messages', async () => {
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

test('reconcileWithHistory: tail window starting with assistant does not rewrite when already synced', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'First question', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'First answer', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Second question', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Second answer', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Second answer' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.length).toBe(4);
});

test('reconcileWithHistory: tail window starting with assistant updates anchored tail without duplication', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'First question', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'First answer', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Second question', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Streaming partial...', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Full complete answer from gateway.' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');
  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  expect(getLastReplaceArgs()!.authoritative).toEqual([
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'First answer' },
    { role: 'user', text: 'Second question' },
    { role: 'assistant', text: 'Full complete answer from gateway.' },
  ]);
});

test('reconcileWithHistory: tail window repairs stale leading assistant before anchor', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'First question', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Stale previous answer', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Second question', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Streaming partial...', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'assistant', content: 'Correct previous answer' },
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Full complete answer from gateway.' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  expect(getLastReplaceArgs()!.authoritative).toEqual([
    { role: 'user', text: 'First question' },
    { role: 'assistant', text: 'Correct previous answer' },
    { role: 'user', text: 'Second question' },
    { role: 'assistant', text: 'Full complete answer from gateway.' },
  ]);
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

test('reconcileWithHistory: tail content mismatch — replaces only tail, preserves prefix', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'First question', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'First answer', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Second question', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Streaming partial...', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Second question' },
        { role: 'assistant', content: 'Full complete answer from gateway.' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  // Prefix [First question, First answer] preserved + auth [Second question, Full complete answer]
  expect(args.authoritative.length).toBe(4);
  expect((args.authoritative[0] as Record<string, unknown>).text).toBe('First question');
  expect((args.authoritative[1] as Record<string, unknown>).text).toBe('First answer');
  expect((args.authoritative[2] as Record<string, unknown>).text).toBe('Second question');
  expect((args.authoritative[3] as Record<string, unknown>).text).toBe('Full complete answer from gateway.');
});

test('reconcileWithHistory: long conversation — preserves prefix, replaces tail', async () => {
  // Simulate a long conversation: 10 local turns, gateway returns last 3 turns
  const localMessages = [];
  for (let i = 1; i <= 10; i++) {
    localMessages.push(
      { id: `msg-u${i}`, type: 'user', content: `Question ${i}`, timestamp: i * 2 - 1, metadata: {} },
      { id: `msg-a${i}`, type: 'assistant', content: `Answer ${i}`, timestamp: i * 2, metadata: {} },
    );
  }

  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore(localMessages);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Question 8' },
        { role: 'assistant', content: 'Answer 8' },
        { role: 'user', content: 'Question 9' },
        { role: 'assistant', content: 'Answer 9' },
        { role: 'user', content: 'Question 10' },
        { role: 'assistant', content: 'Answer 10 updated' }, // updated content
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  // 7 preserved turns (14 entries) + 3 auth turns (6 entries) = 20 total
  expect(args.authoritative.length).toBe(20);
  // First preserved entry
  expect((args.authoritative[0] as Record<string, unknown>).text).toBe('Question 1');
  // Last preserved entry
  expect((args.authoritative[13] as Record<string, unknown>).text).toBe('Answer 7');
  // Last entry from gateway
  expect((args.authoritative[19] as Record<string, unknown>).text).toBe('Answer 10 updated');
});

test('reconcileWithHistory: no overlap — full replace for dashboard consistency', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Old message 1', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Old reply 1', timestamp: 2, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Completely new message' },
        { role: 'assistant', content: 'Completely new reply' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  // No overlap: full replace to match dashboard
  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  expect(args.authoritative.length).toBe(2);
  expect((args.authoritative[0] as Record<string, unknown>).text).toBe('Completely new message');
});

test('reconcileWithHistory: identical user messages — aligns to latest match', async () => {
  const { session, store, getReplaceCallCount } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Hello', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Hi (first)', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Hello', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Hi (second)', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi (second)' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  // Tail matches (user anchor aligns to latest "Hello") — no replace needed
  expect(getReplaceCallCount()).toBe(0);
  expect(session.messages.length).toBe(4);
});

test('reconcileWithHistory: new messages arrived — preserves old and adds new', async () => {
  const { session, store, getReplaceCallCount, getLastReplaceArgs } = createReconcileStore([
    { id: 'msg-1', type: 'user', content: 'Question 1', timestamp: 1, metadata: {} },
    { id: 'msg-2', type: 'assistant', content: 'Answer 1', timestamp: 2, metadata: {} },
    { id: 'msg-3', type: 'user', content: 'Question 2', timestamp: 3, metadata: {} },
    { id: 'msg-4', type: 'assistant', content: 'Answer 2', timestamp: 4, metadata: {} },
  ]);

  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.gatewayClient = {
    start: () => {},
    stop: () => {},
    request: async () => ({
      messages: [
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: 'Answer 2' },
        { role: 'user', content: 'Question 3' },
        { role: 'assistant', content: 'Answer 3' },
      ],
    }),
  };

  await adapter.reconcileWithHistory(session.id, 'managed:session-1');

  expect(getReplaceCallCount()).toBe(1);
  const args = getLastReplaceArgs()!;
  // Preserved [Q1, A1] + auth [Q2, A2, Q3, A3] = 6
  expect(args.authoritative.length).toBe(6);
  expect((args.authoritative[0] as Record<string, unknown>).text).toBe('Question 1');
  expect((args.authoritative[1] as Record<string, unknown>).text).toBe('Answer 1');
  expect((args.authoritative[5] as Record<string, unknown>).text).toBe('Answer 3');
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
      replaceConversationMessages: (sessionId: string, authoritative: Array<{ role: string; text: string }>) => {
        expect(sessionId).toBe(session.id);
        session.messages = session.messages.filter(
          (message) => message.type !== 'user' && message.type !== 'assistant',
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

test('syncSystemMessagesFromHistory skips pure heartbeat ack system messages', () => {
  const { session, store } = createHistoryStore([]);
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const historyMessages = [
    { role: 'system', content: 'HEARTBEAT_OK' },
    { role: 'system', content: 'Reminder fired' },
  ];

  adapter.syncSystemMessagesFromHistory(session.id, historyMessages, {
    previousCountKnown: false,
    previousCount: 0,
  });

  expect(getSystemMessages(session).map((message) => message.content)).toEqual(['Reminder fired']);
});

test('collectChannelHistoryEntries skips heartbeat prompt and ack messages', () => {
  const { store } = createHistoryStore([]);
  const adapter = new OpenClawRuntimeAdapter(store, {});

  const entries = adapter.collectChannelHistoryEntries([
    { role: 'user', content: 'regular user' },
    {
      role: 'user',
      content: `Read HEARTBEAT.md if it exists.
When reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md.
Do not infer or repeat old tasks from prior chats.
If nothing needs attention, reply HEARTBEAT_OK.`,
    },
    { role: 'assistant', content: 'HEARTBEAT_OK' },
    { role: 'assistant', content: 'regular assistant' },
  ]);

  expect(entries).toEqual([
    { role: 'user', text: 'regular user' },
    { role: 'assistant', text: 'regular assistant' },
  ]);
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
