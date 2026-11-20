import { describe, expect, test, vi } from 'vitest';

import { getCoworkLlmTrace, isValidLlmTraceId } from '../../../shared/cowork/llmTurnUsage';
import {
  DSH_SESSION_ID_PREFIX,
  DshApprovalPermissionAction,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import type { CoworkMessage } from '../../coworkStore';
import type { DshTypertClient, DshWaterfallEvent, DshWaterfallOutcome } from '../dsh/dshTypertClient';
import { hasLlmUsageContext } from '../llmUsageContext';
import { ContinuityCapsuleSource } from './coworkContinuityCapsule';
import {
  buildLazyContextBridgePrefix,
  type DshAdapterSessionRecord,
  type DshCoworkStorePort,
  DshRuntimeAdapter,
  isDshBackedSessionId,
} from './dshRuntimeAdapter';

function createInMemoryStore(initialSession: DshAdapterSessionRecord): {
  store: DshCoworkStorePort;
  session: DshAdapterSessionRecord;
  messages: CoworkMessage[];
} {
  const messages: CoworkMessage[] = [...(initialSession.messages ?? [])];
  const session: DshAdapterSessionRecord = { ...initialSession, messages };
  let msgSeq = 0;

  const store: DshCoworkStorePort = {
    getSession: (id) => (id === session.id ? session : null),
    getLatestUserMessage: (id) => (
      id === session.id
        ? [...messages].reverse().find((m) => m.type === 'user') ?? null
        : null
    ),
    addMessage: (_sid, msg) => {
      const created: CoworkMessage = {
        id: `msg-${++msgSeq}`,
        type: msg.type,
        content: msg.content,
        timestamp: Date.now(),
        metadata: msg.metadata,
      };
      messages.push(created);
      return created;
    },
    updateMessageContent: (_sid, msgId, content, metadata) => {
      const target = messages.find((m) => m.id === msgId);
      if (target) {
        target.content = content;
        target.metadata = { ...(target.metadata ?? {}), ...(metadata ?? {}) };
      }
    },
    deleteMessage: (_sid, msgId) => {
      const idx = messages.findIndex((m) => m.id === msgId);
      if (idx === -1) return false;
      messages.splice(idx, 1);
      return true;
    },
    updateSession: (_sid, updates) => {
      if (updates.claudeSessionId !== undefined) session.claudeSessionId = updates.claudeSessionId;
      if (updates.modelOverride !== undefined) session.modelOverride = updates.modelOverride;
    },
    getContinuityCapsule: () => ({
      version: 1,
      sessionId: session.id,
      revision: 1,
      updatedAt: Date.now(),
      lastSource: ContinuityCapsuleSource.PostRun,
      currentObjective: 'Migrate LobsterAI from OpenClaw to DSH',
      userConstraints: ['Keep user data safe'],
      decisions: ['Use App-Owned Profile'],
      completedFacts: ['Built DSH 0.2.2-rc.5 runtime'],
      recentActions: [],
      touchedFiles: [],
      keySymbols: [],
      verification: [],
      nextSteps: ['Verify adapter streaming'],
      recentFailures: [],
      activeCapabilities: [],
      openQuestions: [],
    }),
  };

  return { store, session, messages };
}

describe('dshRuntimeAdapter helpers', () => {
  test('distinguishes DSH-backed session IDs from legacy OpenClaw IDs', () => {
    expect(isDshBackedSessionId(`${DSH_SESSION_ID_PREFIX}abc`)).toBe(true);
    expect(isDshBackedSessionId('session-1234')).toBe(true);
    expect(isDshBackedSessionId('agent:main:cowork-123')).toBe(false);
    expect(isDshBackedSessionId(null)).toBe(false);
  });

  test('builds Lazy Context Bridge prefix from capsule and recent messages', () => {
    const prefix = buildLazyContextBridgePrefix(
      {
        version: 1,
        sessionId: 'cw-1',
        revision: 1,
        updatedAt: 1,
        lastSource: ContinuityCapsuleSource.PostRun,
        currentObjective: 'Ship v2 engine',
        userConstraints: [],
        decisions: [],
        completedFacts: [],
        recentActions: [],
        touchedFiles: [],
        keySymbols: [],
        verification: [],
        nextSteps: [],
        recentFailures: [],
        activeCapabilities: [],
        openQuestions: [],
      },
      [
        { id: 'm1', type: 'user', content: 'Hello OpenClaw', timestamp: 1 },
        { id: 'm2', type: 'assistant', content: 'Hi from legacy engine', timestamp: 2 },
      ],
    );
    expect(prefix).toContain('<previous_conversation_context>');
    expect(prefix).toContain('Ship v2 engine');
    expect(prefix).toContain('Hello OpenClaw');
    expect(prefix).toContain('Hi from legacy engine');
  });
});

describe('DshRuntimeAdapter', () => {
  test('keeps the parent stream open across a native yield until the child result has been summarized', async () => {
    const { store, messages } = createInMemoryStore({ id: 'parent', cwd: '/tmp/work', messages: [] });
    const childId = DSH_SESSION_ID_PREFIX + 'child';
    const events: Array<[string, Record<string, unknown>]> = [
      ['tool/call', { callId: 'call', name: 'subagent_fork', arguments: { prompt: 'write a report' } }],
      ['subagent/catalog', { childId: 'child', name: 'worker', childCreatedAt: 1 }],
      ['tool/result', { meta: { kind: 'activation', name: 'worker' }, message: { toolCallId: 'call', content: 'worker' } }],
      ['turn/end', { reason: { kind: 'completed' } }],
      ['user/message', { source: { kind: 'subagent-settled', senderSessionId: 'child', stopReason: 'completed' } }],
      ['assistant/message', { message: { content: [{ type: 'text', text: 'The report is ready' }] } }],
      ['turn/end', { reason: { kind: 'completed' } }],
    ];
    const client = {
      createSession: async () => ({ sessionId: 'native-parent' }),
      promptSession: async () => ({ accepted: true }),
      onWaterfall: () => () => {},
      followSession: async function* () {
        for (const [seq, [type, data]] of events.entries()) yield { type: 'event', event: { type, data, seq } };
      },
    } as unknown as DshTypertClient;
    const sessions = { observeCatalog: () => childId, observeNotice: vi.fn(), getOwningSessionId: vi.fn(), setTask: vi.fn() };
    const adapter = new DshRuntimeAdapter({ store, subagentSessions: sessions, hostManager: {
      start: async () => {}, isReady: () => true, getClient: () => client, bindSessionContext: async () => ({}),
      deleteSessionFiles: async () => ({}),
    } });
    const complete = vi.fn();
    adapter.on('complete', complete);
    await adapter.startSession('parent', 'delegate');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(sessions.setTask).toHaveBeenCalledWith('parent', childId, 'write a report');
    expect(messages.find(m => m.type === 'tool_result')?.metadata?.subagentRunId).toBe(childId);
    expect(messages.at(-1)?.content).toBe('The report is ready');
  });
  test('streams assistant deltas, tool calls, tool results, and resolves interactive approvals', async () => {
    const { store, session, messages } = createInMemoryStore({
      id: 'cw-1',
      cwd: '/tmp/work',
      agentId: 'main',
    });

    const waterfallMap = new Map<string, (evt: DshWaterfallEvent) => Promise<DshWaterfallOutcome>>();
    let capturedPromptContent: Array<{ type: string; text?: string }> = [];

    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-sess-1' })),
      selectModel: vi.fn(async () => ({ selected: {} })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string }> }) => {
        capturedPromptContent = params.content;
        return { accepted: true };
      }),
      cancelSession: vi.fn(async () => ({ accepted: true })),
      forkSession: vi.fn(async () => ({ sessionId: 'dsh-fork-1' })),
      updateQueue: vi.fn(async () => ({ accepted: true })),
      getSessionProjections: vi.fn(async () => ({
        values: { tokenMeter: { usedTokens: 50_000, contextWindow: 200_000 } },
      })),
      onWaterfall: vi.fn((event: string, handler: (evt: DshWaterfallEvent) => Promise<DshWaterfallOutcome>) => {
        waterfallMap.set(event, handler);
        return () => waterfallMap.delete(event);
      }),
      followSession: vi.fn(async function* () {
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'Thinking...' } } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'Hello ' } } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 1, text: 'world!' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 2,
            data: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'Thinking...' },
                  { type: 'text', text: 'Hello world!' },
                ],
              },
            },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'tool/call',
            seq: 3,
            data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'tool/result',
            seq: 4,
            data: { message: { callId: 'c1', content: [{ type: 'text', text: 'file.txt' }], isError: false } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 5, data: {} } };
      }),
    } as unknown as DshTypertClient;

    const hostManager = {
      start: vi.fn(async () => undefined),
      isReady: vi.fn(() => true),
      getClient: vi.fn(() => fakeClient),
      bindSessionContext: vi.fn(async () => ({ ok: true })),
      deleteSessionFiles: vi.fn(async () => ({ ok: true })),
    };

    const adapter = new DshRuntimeAdapter({
      hostManager,
      store,
      resolveModelSelection: () => ({ provider: 'lobster-openai', model: 'gpt-5' }),
    });

    const events: string[] = [];
    adapter.on('complete', () => events.push('complete'));
    adapter.on('permissionRequest', (_sid, req) => {
      events.push(`perm:${req.toolName}`);
      adapter.respondToPermission(req.requestId, { behavior: 'allow' });
    });

    await adapter.startSession('cw-1', 'List files');

    expect(session.claudeSessionId).toBe(`${DSH_SESSION_ID_PREFIX}dsh-sess-1`);
    expect(capturedPromptContent).toEqual([{ type: 'text', text: 'List files' }]);
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant', 'tool_use', 'tool_result']);
    expect(messages[1].content).toBe('Thinking...');
    expect(messages[1].metadata?.isThinking).toBe(true);
    expect(messages[1].metadata?.isStreaming).toBe(false);
    expect(messages[2].content).toBe('Hello world!');
    expect(messages[2].metadata?.isThinking).toBeUndefined();
    expect(messages[2].metadata?.isStreaming).toBe(false);
    expect(messages[3].metadata?.toolName).toBe('bash');
    expect(messages[4].content).toBe('file.txt');
    expect(events).toContain('complete');

    // Verify interactive approval waterfall round-trip
    const approvalHandler = waterfallMap.get('approval/request');
    expect(approvalHandler).toBeDefined();
    const outcome = await approvalHandler!({
      event: 'approval/request',
      eventId: 'ev-1',
      agentId: 'dsh-sess-1',
      request: { toolName: 'bash', reason: 'Run command' },
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({ kind: 'result', value: 'allowed-once' });
    expect(events).toContain('perm:bash');

    // Verify context usage projection & Option B fork/queue
    const usage = await adapter.getContextUsage('cw-1');
    expect(usage?.percent).toBe(25);
    const forked = await adapter.forkDshSession('cw-1', 4);
    expect(forked.storedSessionId).toBe(`${DSH_SESSION_ID_PREFIX}dsh-fork-1`);
    await adapter.updateQueuedMessage('cw-1', 'item-1', { kind: 'remove' });
    expect(fakeClient.updateQueue).toHaveBeenCalled();
  });

  test('applies Lazy Context Bridge once when continuing a legacy OpenClaw session', async () => {
    const { store, session } = createInMemoryStore({
      id: 'cw-legacy',
      cwd: '/tmp/work',
      claudeSessionId: 'agent:main:legacy-openclaw',
      messages: [
        { id: 'old-1', type: 'user', content: 'Old request', timestamp: 1 },
        { id: 'old-2', type: 'assistant', content: 'Old reply', timestamp: 2 },
      ],
    });

    let sentText = '';
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-new-99' })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string }> }) => {
        sentText = params.content[0]?.text ?? '';
        return { accepted: true };
      }),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield { type: 'event', event: { type: 'turn/end', seq: 1, data: {} } };
      }),
    } as unknown as DshTypertClient;

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    await adapter.continueSession('cw-legacy', 'Continue where we left off');

    expect(session.claudeSessionId).toBe(`${DSH_SESSION_ID_PREFIX}dsh-new-99`);
    expect(sentText).toContain('<previous_conversation_context>');
    expect(sentText).toContain('Migrate LobsterAI from OpenClaw to DSH');
    expect(sentText).toContain('Old request');
    expect(sentText).toContain('Continue where we left off');
  });

  test('patchSession retries selectModel without reasoningEffort when model rejects effort level', async () => {
    const { store } = createInMemoryStore({
      id: 'cw-switch',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-switch-1`,
    });

    const selectModel = vi.fn()
      .mockRejectedValueOnce(new Error('provider "lobsterai-server" model "yd-fast" does not support reasoning effort "high"'))
      .mockResolvedValueOnce({ selected: { provider: 'lobsterai-server', model: 'yd-fast' } });

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => ({ selectModel }) as unknown as DshTypertClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
      resolveModelSelection: (_sid, override) => {
        const [provider, model] = String(override || '').split('/');
        return provider && model ? { provider, model } : null;
      },
    });

    const patched = await adapter.patchSession('cw-switch', {
      model: 'lobsterai-server/yd-fast',
      thinkingLevel: 'high',
    });

    expect(selectModel).toHaveBeenNthCalledWith(1, {
      sessionId: 'dsh-switch-1',
      provider: 'lobsterai-server',
      model: 'yd-fast',
      reasoningEffort: 'high',
    });
    expect(selectModel).toHaveBeenNthCalledWith(2, {
      sessionId: 'dsh-switch-1',
      provider: 'lobsterai-server',
      model: 'yd-fast',
    });
    expect(patched).toEqual({
      modelOverride: 'lobsterai-server/yd-fast',
      resolvedModelRef: 'lobsterai-server/yd-fast',
      thinkingLevel: 'high',
    });
  });

  test('stamps per-turn llmTrace on pre-created user message, binds traceId to DSH, and skips lazy bridge on new sessions', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-fresh',
      cwd: '/tmp/work',
      title: 'Fresh chat',
      messages: [
        {
          id: 'u-1',
          type: 'user',
          content: 'Hello credits',
          timestamp: Date.now(),
          metadata: { skillIds: ['web-search'] },
        },
      ],
    });

    let capturedPrompt = '';
    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-fresh-1' })),
      selectModel: vi.fn(async () => ({ selected: {} })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string }> }) => {
        capturedPrompt = params.content[0]?.text ?? '';
        return { accepted: true };
      }),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield { type: 'event', event: { type: 'turn/end', seq: 1, data: {} } };
      }),
    } as unknown as DshTypertClient;

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext,
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
      resolveModelSelection: () => ({ provider: 'lobsterai-server', model: 'yd-fast' }),
    });

    await adapter.startSession('cw-fresh', 'Hello credits', { skipInitialUserMessage: true });

    const llmTrace = getCoworkLlmTrace(messages[0].metadata);
    expect(llmTrace).not.toBeNull();
    expect(isValidLlmTraceId(llmTrace!.traceId)).toBe(true);
    expect(messages[0].metadata?.skillIds).toEqual(['web-search']);
    expect(hasLlmUsageContext(llmTrace!.traceId)).toBe(true);
    expect(bindSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-fresh-1',
      coworkSessionId: 'cw-fresh',
      traceId: llmTrace!.traceId,
    }));
    // Fresh session must NOT inject a legacy OpenClaw context bridge.
    expect(capturedPrompt).toBe('Hello credits');
  });

  test('reuses thinking slot on assistant/attempt retry without ghost messages and skips empty rows on tool-only steps', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-retry',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-retry-1`,
    });

    const fakeClient = {
      selectModel: vi.fn(async () => ({ selected: {} })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        // Attempt 1: truncated reasoning-only stop -> settled as assistant/attempt (retry)
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'User asks about Vietnam. Fetch CN' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 55 } } };
        yield { type: 'event', event: { type: 'assistant/attempt', seq: 55, data: {} } };
        yield { type: 'event', event: { type: 'llm/retry', seq: 56, data: { retry: 1 } } };
        // Attempt 2: reasoning + tool call (no visible text in step 1)
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'Let me fetch VND rate.' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 58 } } };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 58,
            data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Let me fetch VND rate.' }] } },
          },
        };
        yield { type: 'event', event: { type: 'tool/call', seq: 59, data: { callId: 'c-vnd', name: 'bash', arguments: '{"command":"curl"}' } } };
        yield { type: 'event', event: { type: 'tool/result', seq: 60, data: { message: { callId: 'c-vnd', content: [{ type: 'text', text: '3846 VND' }], isError: false } } } };
        // Step 2: final answer without thinking
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: '越南使用越南盾（VND）。' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 61 } } };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 61,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: '越南使用越南盾（VND）。' }] } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 62, data: { reason: { kind: 'completed' } } } };
      }),
    } as unknown as DshTypertClient;

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    await adapter.continueSession('cw-retry', '越南');

    expect(messages.map((m) => ({
      type: m.type,
      isThinking: Boolean(m.metadata?.isThinking),
      content: m.content,
    }))).toEqual([
      { type: 'user', isThinking: false, content: '越南' },
      { type: 'assistant', isThinking: true, content: 'Let me fetch VND rate.' },
      { type: 'tool_use', isThinking: false, content: 'bash' },
      { type: 'tool_result', isThinking: false, content: '3846 VND' },
      { type: 'assistant', isThinking: false, content: '越南使用越南盾（VND）。' },
    ]);
  });

  test('deletes unused retry thinking placeholder and emits error when turn/end reports failure', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-fail',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-fail-1`,
    });

    const fakeClient = {
      selectModel: vi.fn(async () => ({ selected: {} })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'Partial thought...' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 10 } } };
        yield {
          type: 'event',
          event: {
            type: 'turn/end',
            seq: 11,
            data: {
              reason: {
                kind: 'error',
                error: {
                  code: 'EMPTY_RESPONSE',
                  message: 'model "deepseek-flash" returned a completed response with no visible text or tool calls',
                },
              },
            },
          },
        };
      }),
    } as unknown as DshTypertClient;

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    const completed: string[] = [];
    const errors: string[] = [];
    adapter.on('complete', () => completed.push('complete'));
    adapter.on('error', (_sid, err) => errors.push(err));

    await adapter.continueSession('cw-fail', '越南');

    expect(completed).toEqual([]);
    expect(errors).toEqual(['model "deepseek-flash" returned a completed response with no visible text or tool calls']);
    // Failed attempt's placeholder thinking row must be deleted cleanly.
    expect(messages.map((m) => m.type)).toEqual(['user']);
  });

  test('enriches approval requests with cached args and honors allow-session and full-access switch', async () => {
    const { store } = createInMemoryStore({
      id: 'cw-approve',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-approve-1`,
    });

    const waterfallMap = new Map<string, (evt: DshWaterfallEvent) => Promise<DshWaterfallOutcome>>();
    const fakeClient = {
      selectModel: vi.fn(async () => ({ selected: {} })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      onWaterfall: vi.fn((event: string, handler: (evt: DshWaterfallEvent) => Promise<DshWaterfallOutcome>) => {
        waterfallMap.set(event, handler);
        return () => waterfallMap.delete(event);
      }),
      followSession: vi.fn(async function* () {
        yield { type: 'event', event: { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } } };
      }),
    } as unknown as DshTypertClient;

    const setPermissionPreset = vi.fn(async () => ({ ok: true }));
    const onPermissionPresetChanged = vi.fn();

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
        setPermissionPreset,
        consumeApprovalCallContext: vi.fn((callId: string) => (
          callId === 'call-git-1'
            ? {
                toolName: 'bash',
                args: {
                  command: 'cd /Users/demo/repo && git push origin main',
                  description: 'Push committed branch to GitHub',
                },
                permissionPreset: DshPermissionPreset.WorkspaceWrite,
                recordedAt: Date.now(),
              }
            : null
        )),
      },
      store,
      onPermissionPresetChanged,
    });

    await adapter.continueSession('cw-approve', 'Push code');

    const capturedInputs: Array<Record<string, unknown>> = [];
    adapter.on('permissionRequest', (_sid, req) => {
      capturedInputs.push(req.toolInput);
      if (capturedInputs.length === 1) {
        adapter.respondToPermission(req.requestId, {
          behavior: 'allow',
          updatedPermissions: [
            { type: DshApprovalPermissionAction.AllowSession, scope: 'shell:git-push' },
          ],
        });
      } else {
        adapter.respondToPermission(req.requestId, {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: DshApprovalPermissionAction.SetPermissionPreset,
              preset: DshPermissionPreset.FullAccess,
              global: true,
            },
          ],
        });
      }
    });

    const approvalHandler = waterfallMap.get('approval/request')!;
    const out1 = await approvalHandler({
      event: 'approval/request',
      eventId: 'ev-a1',
      agentId: 'dsh-approve-1',
      request: {
        toolName: 'bash',
        callId: 'call-git-1',
        reason: 'Potentially dangerous command requires confirmation (git-push): cd /Users/demo/repo && git push origin main',
      },
      signal: new AbortController().signal,
    });

    expect(out1).toEqual({ kind: 'result', value: 'allowed-once' });
    expect(capturedInputs[0].command).toBe('cd /Users/demo/repo && git push origin main');
    expect(capturedInputs[0].description).toBe('Push committed branch to GitHub');
    expect(capturedInputs[0].dangerLevel).toBe('caution');
    expect(capturedInputs[0].dangerReason).toBe('git-push');
    expect(capturedInputs[0].approvalScopeKey).toBe('shell:git-push');
    expect(
      adapter.isToolAllowedInSession({
        toolName: 'bash',
        args: { command: 'git push origin main' },
        sessionId: 'dsh-approve-1',
      }),
    ).toBe(true);

    const out2 = await approvalHandler({
      event: 'approval/request',
      eventId: 'ev-a2',
      agentId: 'dsh-approve-1',
      request: {
        toolName: 'bash',
        callId: 'call-other',
        reason: 'Needs access outside workspace',
      },
      signal: new AbortController().signal,
    });
    expect(out2).toEqual({ kind: 'result', value: 'allowed-once' });
    expect(setPermissionPreset).toHaveBeenCalledWith(DshPermissionPreset.FullAccess);
    expect(onPermissionPresetChanged).toHaveBeenCalledWith(DshPermissionPreset.FullAccess, undefined);
  });
});
