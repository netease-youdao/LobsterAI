import { describe, expect, test, vi } from 'vitest';

import {
  BrowserAnnotationAnchorKind,
  BrowserAnnotationScreenshotStatus,
  type CoworkBrowserAnnotationMessageBatch,
} from '../../../shared/cowork/browserAnnotations';
import { CoworkImageAttachmentRole } from '../../../shared/cowork/imageAttachments';
import { getCoworkLlmTrace, isValidLlmTraceId } from '../../../shared/cowork/llmTurnUsage';
import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
} from '../../../shared/cowork/selectedText';
import {
  DSH_SESSION_ID_PREFIX,
  DshApprovalPermissionAction,
  DshPermissionPreset,
  DshProgressiveCapability,
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
  resolveOfficeAgentPromptForTurn,
  resolveUnlockedCapabilitiesForTurn,
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
    expect(prefix).toContain('[历史会话近期对话]');
    expect(prefix).toContain('Ship v2 engine');
    expect(prefix).toContain('用户: Hello OpenClaw');
    expect(prefix).toContain('助手: Hi from legacy engine');
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
    const promptSession = vi.fn(async () => ({ accepted: true }));
    const client = {
      createSession: async () => ({ sessionId: 'native-parent' }),
      promptSession,
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
    expect(promptSession).toHaveBeenCalledWith(expect.objectContaining({
      clientTimeZone: expect.any(String),
    }));
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
    expect(messages[2].metadata).toMatchObject({ seq: 2, dshSessionId: session.claudeSessionId });
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

  test('patchSession forwards thinkingLevel overrides and resets to 3-arg resolveModelSelection', async () => {
    const { store } = createInMemoryStore({
      id: 'cw-think',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-think-1`,
      modelOverride: 'lobsterai-server/glm-5.3-flash-YoudaoInner',
      thinkingLevel: 'max',
    });

    const selectModel = vi.fn(async () => ({ selected: {} }));
    const resolveModelSelection = vi.fn((_sid: string, _override?: string | null, thinkingOverride?: string | null) => ({
      provider: 'lobsterai-server',
      model: 'glm-5.3-flash-YoudaoInner',
      reasoningEffort: thinkingOverride === null ? 'high' : (thinkingOverride || 'max'),
    }));

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => ({ selectModel }) as unknown as DshTypertClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
      resolveModelSelection,
    });

    await adapter.patchSession('cw-think', { thinkingLevel: 'off' });
    expect(resolveModelSelection).toHaveBeenNthCalledWith(1, 'cw-think', undefined, 'off');
    expect(selectModel).toHaveBeenNthCalledWith(1, {
      sessionId: 'dsh-think-1',
      provider: 'lobsterai-server',
      model: 'glm-5.3-flash-YoudaoInner',
      reasoningEffort: 'off',
    });

    await adapter.patchSession('cw-think', { thinkingLevel: null });
    expect(resolveModelSelection).toHaveBeenNthCalledWith(2, 'cw-think', undefined, null);
    expect(selectModel).toHaveBeenNthCalledWith(2, {
      sessionId: 'dsh-think-1',
      provider: 'lobsterai-server',
      model: 'glm-5.3-flash-YoudaoInner',
      reasoningEffort: 'high',
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

  test('persists localMediaAttachments with empty display text for IM image-only turns while sending model prompt + image', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-im-img',
      cwd: '/tmp/work',
      agentId: 'main',
    });

    const promptPayloads: Array<Array<{ type: string; text?: string; mediaType?: string; data?: string }>> = [];
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-im-img-1' })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string; mediaType?: string; data?: string }> }) => {
        promptPayloads.push(params.content);
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

    const emitted: CoworkMessage[] = [];
    adapter.on('message', (_sid, msg) => emitted.push(msg));

    const localPath = '/Users/demo/Library/Application Support/LobsterAI/cowork-image-originals/sess/abc.png';
    await adapter.startSession('cw-im-img', '请查看这张图片。', {
      userMessageContent: '',
      imageAttachments: [
        {
          name: 'weixin-image-1.png',
          mimeType: 'image/png',
          base64Data: 'iVBORw0KGgo=',
          sizeBytes: 8,
          localPath,
        },
      ],
      localMediaAttachments: [
        {
          localPath,
          mimeType: 'image/png',
          name: 'weixin-image-1.png',
        },
      ],
    });

    // Persisted and emitted user message shows the original image without placeholder text.
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('user');
    expect(messages[0].content).toBe('');
    expect(messages[0].metadata?.localMediaAttachments).toEqual([
      { localPath, mimeType: 'image/png', name: 'weixin-image-1.png' },
    ]);
    expect(messages[0].metadata?.imageAttachmentPreviews).toBeUndefined();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toBe(messages[0].id);

    // DSH model turn still receives the default prompt text and base64 image bytes.
    expect(promptPayloads[0]).toEqual([
      { type: 'text', text: '请查看这张图片。' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);

    // Follow-up continueSession with imageAttachments only (no localMediaAttachments) stores imageAttachmentPreviews.
    await adapter.continueSession('cw-im-img', '看看第二张', {
      imageAttachments: [
        {
          name: 'desktop.png',
          mimeType: 'image/png',
          base64Data: 'iVBORw0KGgo=',
          sizeBytes: 8,
        },
      ],
    });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe('看看第二张');
    expect(messages[1].metadata?.imageAttachmentPreviews).toEqual([
      expect.objectContaining({
        name: 'desktop.png',
        mimeType: 'image/png',
        base64Data: 'iVBORw0KGgo=',
        isPreview: true,
      }),
    ]);
  });

  test('stopSession finalizes streaming message, awaits cancelSession before next prompt, and ignores stale aborted turn/end', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-interrupt',
      cwd: '/tmp/work',
      agentId: 'main',
    });

    const callOrder: string[] = [];
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let followInvocation = 0;

    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-int-1' })),
      cancelSession: vi.fn(async () => {
        callOrder.push('cancel:start');
        await cancelGate;
        callOrder.push('cancel:done');
        return { accepted: true };
      }),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string }> }) => {
        callOrder.push(`prompt:${params.content[0]?.text ?? ''}`);
        return { accepted: true };
      }),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* (_req: unknown, signal?: AbortSignal) {
        followInvocation += 1;
        if (followInvocation === 1) {
          yield { type: 'assistant-stream', frame: { type: 'start' } };
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Partial...' } } };
          // Hold stream open until stopSession aborts it.
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        // Second turn stream sees a trailing aborted turn/end from turn 1 before turn 2's actual output.
        yield { type: 'event', event: { type: 'turn/end', seq: 2, data: { reason: { kind: 'aborted' } } } };
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Final answer' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } } };
        yield { type: 'event', event: { type: 'turn/end', seq: 4, data: {} } };
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
    adapter.on('complete', (sid) => completed.push(sid));

    const turn1Promise = adapter.startSession('cw-interrupt', 'first');
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'assistant' && m.content === 'Partial...')).toBe(true);
    });

    adapter.stopSession('cw-interrupt');
    await turn1Promise;

    // Active streaming message from turn 1 must be finalized (no stuck spinner).
    const partialAssistant = messages.find((m) => m.type === 'assistant' && m.content === 'Partial...');
    expect(partialAssistant?.metadata?.isStreaming).toBe(false);

    // Kick off turn 2 immediately while cancelSession RPC is still in flight.
    const turn2Promise = adapter.continueSession('cw-interrupt', 'second');
    await Promise.resolve();
    expect(callOrder).toEqual(['prompt:first', 'cancel:start']);

    releaseCancel();
    await turn2Promise;

    expect(callOrder).toEqual(['prompt:first', 'cancel:start', 'cancel:done', 'prompt:second']);
    expect(completed).toEqual(['cw-interrupt']);
    expect(messages.some((m) => m.type === 'assistant' && m.content === 'Final answer')).toBe(true);
  });

  test('passes unlockedCapabilities only for explicitly selected messageSkillIds or browserAnnotations', async () => {
    expect(resolveUnlockedCapabilitiesForTurn({ messageSkillIds: ['docx', 'pptx', 'article-writer'] })).toEqual([
      DshProgressiveCapability.Word,
      DshProgressiveCapability.Ppt,
    ]);
    expect(resolveUnlockedCapabilitiesForTurn({
      browserAnnotations: [{ id: 'ann-1', pageUrl: 'https://example.com', pageTitle: 'Example', items: [] }],
    })).toEqual([DshProgressiveCapability.Browser]);

    const { store } = createInMemoryStore({
      id: 'cw-disclosure',
      title: 'Disclosure Test',
      cwd: '/tmp/ws',
      systemPrompt: '',
      executionMode: 'local',
      agentId: 'main',
      claudeSessionId: null,
      messages: [],
    });

    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-disc-1' })),
      promptSession: vi.fn(async () => ({ accepted: true })),
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
    });

    // Turn 1: `skillIds` contains all enabled skills, but no explicit `messageSkillIds` -> must NOT pre-unlock.
    await adapter.startSession('cw-disclosure', '你好', {
      skillIds: ['docx', 'xlsx', 'pptx', 'web-search', 'computer-use'],
    });
    expect(bindSessionContext).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ unlockedCapabilities: expect.anything() }),
    );

    // Turn 2: explicit `messageSkillIds: ['xlsx']` + `browserAnnotations` -> pre-unlocks excel & browser.
    await adapter.continueSession('cw-disclosure', '帮我整理表格', {
      skillIds: ['docx', 'xlsx', 'pptx'],
      messageSkillIds: ['xlsx'],
      browserAnnotations: [{ id: 'ann-2', pageUrl: 'https://example.com', pageTitle: 'Example', items: [] }],
    });
    expect(bindSessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        unlockedCapabilities: [
          DshProgressiveCapability.Excel,
          DshProgressiveCapability.Browser,
        ],
      }),
    );
  });

  test('tracks delegate_agent activation, updates target agentId, and awaits subagent-settled before finishing turn', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-delegate',
      cwd: '/tmp/work',
      agentId: 'translator',
    });

    const observeCatalog = vi.fn(() => 'dsh:child-blog-1');
    const observeNotice = vi.fn();
    const setTask = vi.fn();
    const setDelegatedAgent = vi.fn();

    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-translator-1' })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield {
          type: 'event',
          event: {
            type: 'tool/call',
            seq: 1,
            data: {
              callId: 'call-del-1',
              name: 'delegate_agent',
              arguments: JSON.stringify({
                agent_id: 'blog-publisher',
                description: '发布博客文章',
                prompt: '请发布 /tmp/work/article.md 到 Hugo 博客',
              }),
            },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'subagent/catalog',
            seq: 2,
            data: {
              childId: 'child-blog-1',
              childCreatedAt: 1000,
              name: 'blog-publisher',
              label: '发布博客文章',
              mode: 'continuable',
            },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'tool/result',
            seq: 3,
            data: {
              callId: 'call-del-1',
              content: 'delegated task to specialist agent "博客自动发布" (blog-publisher) as subagent blog-publisher',
              meta: {
                kind: 'activation',
                name: 'blog-publisher',
                childId: 'child-blog-1',
                agentId: 'blog-publisher',
              },
            },
          },
        };
        // Parent yields its first turn while the delegated specialist is still working.
        yield { type: 'event', event: { type: 'turn/end', seq: 4, data: {} } };
        // Specialist finishes and delivers subagent-settled notice back to parent.
        yield {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 5,
            time: 2000,
            data: {
              source: {
                kind: 'subagent-settled',
                stopReason: 'completed',
                senderSessionId: 'child-blog-1',
              },
            },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 6,
            data: { message: { content: '博客自动发布已完成发布。' } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 7, data: {} } };
      }),
    } as unknown as DshTypertClient;

    const adapter = new DshRuntimeAdapter({
      subagentSessions: {
        observeCatalog,
        observeNotice,
        getOwningSessionId: vi.fn(),
        setTask,
        setDelegatedAgent,
      },
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    await adapter.startSession('cw-delegate', '把这篇文章通过博客自动发布 agent 发布到我的博客吧');

    expect(observeCatalog).toHaveBeenCalledTimes(1);
    expect(setTask).toHaveBeenCalledWith('cw-delegate', 'dsh:child-blog-1', '请发布 /tmp/work/article.md 到 Hugo 博客');
    expect(setDelegatedAgent).toHaveBeenCalledWith('cw-delegate', 'dsh:child-blog-1', 'blog-publisher');
    expect(observeNotice).toHaveBeenCalledTimes(1);
    expect(messages.some(m => m.type === 'assistant' && m.content === '博客自动发布已完成发布。')).toBe(true);
    const toolResult = messages.find(m => m.type === 'tool_result');
    expect(toolResult?.metadata?.subagentRunId).toBe('dsh:child-blog-1');
  });

  test('auto-unlocks word/excel/ppt from selectedTextSnippets, prompt file paths, and legacy bridge', () => {
    expect(resolveUnlockedCapabilitiesForTurn({
      selectedTextSnippets: [
        {
          id: 's1',
          text: 'Q3 revenue was $10M',
          sourceType: CoworkSelectedTextSource.ArtifactWord,
          sourceId: 'doc-1',
          sourceTitle: 'report.docx',
          sourcePath: '/tmp/report.docx',
          createdAt: 1,
        },
        {
          id: 's2',
          text: 'Total\t100',
          sourceType: CoworkSelectedTextSource.ArtifactSheet,
          sourceId: 'sheet-1',
          sourceTitle: 'budget.xlsx · Sheet1!A1:B1',
          createdAt: 2,
        },
        {
          id: 's3',
          text: 'Slide 2 title',
          sourceType: CoworkSelectedTextSource.ArtifactSlides,
          sourceId: 'ppt-1',
          sourceTitle: 'deck.pptx',
          createdAt: 3,
        },
      ],
    })).toEqual([
      DshProgressiveCapability.Word,
      DshProgressiveCapability.Excel,
      DshProgressiveCapability.Ppt,
    ]);

    expect(resolveUnlockedCapabilitiesForTurn({
      prompt: '请修改季度报告.docx的第二段，顺便更新 File: /tmp/预算表.xlsx 和 D:\\slides\\汇报.PPTX',
    })).toEqual([
      DshProgressiveCapability.Word,
      DshProgressiveCapability.Excel,
      DshProgressiveCapability.Ppt,
    ]);

    expect(resolveUnlockedCapabilitiesForTurn({
      prompt: '把刚才第二页的标题改短一点',
      lazyBridgePrefix: '<previous_conversation_context>\n助手: 已生成 [deck.pptx](file:///tmp/deck.pptx)\n</previous_conversation_context>',
    })).toEqual([DshProgressiveCapability.Ppt]);

    const wordPrompt = resolveOfficeAgentPromptForTurn([DshProgressiveCapability.Word]);
    expect(wordPrompt).toContain('## Editing Existing Office Files');
    expect(wordPrompt).toContain('`word_read` / `word_edit`');
    expect(wordPrompt).not.toContain('`excel_edit`');
    expect(resolveOfficeAgentPromptForTurn([DshProgressiveCapability.Browser])).toBe('');
  });

  test('injects selectedTextSnippets into outbound DSH prompt while keeping stored user message clean and unlocking Office tools', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-selected-text',
      cwd: '/tmp/office',
      agentId: 'main',
    });

    const promptedContents: Array<Array<{ type: string; text?: string; data?: string; mediaType?: string }>> = [];
    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-office-1' })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string; data?: string; mediaType?: string }> }) => {
        promptedContents.push(params.content);
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
    });

    const wordSnippet: CoworkSelectedTextSnippet = {
      id: 'snip-word-1',
      text: 'Q3 revenue was $10M',
      sourceType: CoworkSelectedTextSource.ArtifactWord,
      sourceId: 'artifact-word-1',
      sourceTitle: 'report.docx',
      sourcePath: '/tmp/report.docx',
      createdAt: 100,
    };

    // Turn 1: startSession with selectedTextSnippets (raw prompt stays clean in SQLite)
    await adapter.startSession('cw-selected-text', '请把这里改成 $12M', {
      selectedTextSnippets: [wordSnippet],
    });

    expect(messages[0]?.type).toBe('user');
    expect(messages[0]?.content).toBe('请把这里改成 $12M');
    expect(messages[0]?.content).not.toContain('[Selected text excerpts]');
    expect(messages[0]?.metadata?.selectedTextSnippets).toEqual([wordSnippet]);

    expect(bindSessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        unlockedCapabilities: [DshProgressiveCapability.Word],
        officeAgentPrompt: expect.stringContaining('`word_read` / `word_edit`'),
      }),
    );

    const turn1Text = promptedContents[0]?.[0]?.text ?? '';
    expect(turn1Text).toContain('[Selected text excerpts]');
    expect(turn1Text).toContain('Source path: /tmp/report.docx');
    expect(turn1Text).toContain('> Q3 revenue was $10M');
    expect(turn1Text).toContain('请把这里改成 $12M');

    // Turn 2: continueSession with Excel snippet accumulates unlocked capabilities & guidance
    const sheetSnippet: CoworkSelectedTextSnippet = {
      id: 'snip-sheet-1',
      text: 'Item\tCost\nGPU\t2000',
      sourceType: CoworkSelectedTextSource.ArtifactSheet,
      sourceId: 'artifact-sheet-1',
      sourceTitle: 'budget.xlsx · Sheet1!A1:B2',
      sourcePath: '/tmp/budget.xlsx',
      createdAt: 200,
    };
    await adapter.continueSession('cw-selected-text', '把单价改成 2500', {
      selectedTextSnippets: [sheetSnippet],
    });

    const userMessages = messages.filter((m) => m.type === 'user');
    expect(userMessages[1]?.content).toBe('把单价改成 2500');
    expect(userMessages[1]?.metadata?.selectedTextSnippets).toEqual([sheetSnippet]);

    expect(bindSessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        unlockedCapabilities: [DshProgressiveCapability.Word, DshProgressiveCapability.Excel],
        officeAgentPrompt: expect.stringContaining('`excel_read` / `excel_edit`'),
      }),
    );

    const turn2Text = promptedContents[1]?.[0]?.text ?? '';
    expect(turn2Text).toContain('[Selected text excerpts]');
    expect(turn2Text).toContain('Source path: /tmp/budget.xlsx');
    expect(turn2Text).toContain('> GPU\t2000');
    expect(turn2Text).toContain('把单价改成 2500');
  });

  test('injects browserAnnotations prompt section and attaches annotation screenshots without duplication', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-browser-ann',
      cwd: '/tmp/web',
      agentId: 'main',
    });

    const promptedContents: Array<Array<{ type: string; text?: string; data?: string; mediaType?: string }>> = [];
    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-web-1' })),
      promptSession: vi.fn(async (params: { content: Array<{ type: string; text?: string; data?: string; mediaType?: string }> }) => {
        promptedContents.push(params.content);
        return { accepted: true };
      }),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield { type: 'event', event: { type: 'turn/end', seq: 1, data: {} } };
      }),
    } as unknown as DshTypertClient;

    const readBrowserAnnotationAsset = vi.fn(({ assetId }: { assetId: string }) => (
      assetId === 'asset-from-store'
        ? { dataUrl: 'data:image/png;base64,U1RPUkVfUE5H', byteSize: 9 }
        : null
    ));

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => fakeClient),
        bindSessionContext,
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
      readBrowserAnnotationAsset,
    });

    const createBatch = (
      assetId: string,
      comment: string,
      transportImageIndex?: number,
    ): CoworkBrowserAnnotationMessageBatch => ({
      version: 1,
      id: `batch-${assetId}`,
      browserTabId: 'tab-1',
      documentId: 'doc-1',
      navigationVersion: 1,
      pageUrl: 'https://example.com/pricing',
      pageTitle: 'Pricing',
      createdAt: 100,
      updatedAt: 100,
      annotations: [{
        id: `ann-${assetId}`,
        order: 0,
        comment,
        anchor: {
          kind: BrowserAnnotationAnchorKind.Element,
          pageUrl: 'https://example.com/pricing',
          pageTitle: 'Pricing',
          framePath: [],
          rect: { x: 10, y: 20, width: 120, height: 40 },
          tagName: 'button',
          selector: '.cta-btn',
          immediateText: 'Start Free',
        },
        capture: {
          viewportWidth: 1280,
          viewportHeight: 800,
          viewportScale: 1,
          zoomPercent: 100,
          scrollX: 0,
          scrollY: 0,
          targetRect: { x: 10, y: 20, width: 120, height: 40 },
        },
        screenshot: {
          status: BrowserAnnotationScreenshotStatus.Ready,
          asset: {
            assetId,
            mimeType: 'image/png',
            width: 300,
            height: 120,
            byteSize: 9,
            capturedAt: 100,
            ...(transportImageIndex ? { transportImageIndex } : {}),
          },
        },
        createdAt: 100,
        updatedAt: 100,
      }],
    });

    // Turn 1: Renderer already packed annotation screenshot into imageAttachments with transportImageIndex: 1
    await adapter.startSession('cw-browser-ann', '请把主按钮改成蓝色', {
      browserAnnotations: [createBatch('asset-prepacked', '把按钮背景改成 #2563EB', 1)],
      imageAttachments: [{
        name: '浏览器注释截图-1.png',
        mimeType: 'image/png',
        base64Data: 'data:image/png;base64,UFJFUExPQURFRA==',
        sizeBytes: 9,
        role: CoworkImageAttachmentRole.BrowserAnnotation,
      }],
    });

    expect(readBrowserAnnotationAsset).not.toHaveBeenCalled();
    expect(messages[0]?.content).toBe('请把主按钮改成蓝色');
    expect(messages[0]?.content).not.toContain('[Browser annotations]');
    expect(messages[0]?.metadata?.browserAnnotations).toHaveLength(1);
    expect(promptedContents[0]).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('[Browser annotations]'),
      },
      {
        type: 'image',
        mediaType: 'image/png',
        data: 'UFJFUExPQURFRA==',
      },
    ]);
    expect(promptedContents[0]?.[0]?.text).toContain('把按钮背景改成 #2563EB');
    expect(promptedContents[0]?.[0]?.text).toContain('Screenshot: transport image 1;');
    expect(promptedContents[0]?.[0]?.text).toContain('请把主按钮改成蓝色');

    // Turn 2: continueSession with empty text + un-indexed ready annotation resolved from asset store
    await adapter.continueSession('cw-browser-ann', '', {
      browserAnnotations: [createBatch('asset-from-store', '缩小字号到 14px')],
    });

    expect(readBrowserAnnotationAsset).toHaveBeenCalledWith({
      draftKey: 'cw-browser-ann',
      batchId: 'batch-asset-from-store',
      annotationId: 'ann-asset-from-store',
      assetId: 'asset-from-store',
    });
    const userMessages = messages.filter((m) => m.type === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]?.content).toBe('');
    expect(userMessages[1]?.metadata?.browserAnnotations).toHaveLength(1);
    expect(promptedContents[1]).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('缩小字号到 14px'),
      },
      {
        type: 'image',
        mediaType: 'image/png',
        data: 'U1RPUkVfUE5H',
      },
    ]);
    expect(promptedContents[1]?.[0]?.text).toContain('Screenshot: transport image 1;');
  });
});
