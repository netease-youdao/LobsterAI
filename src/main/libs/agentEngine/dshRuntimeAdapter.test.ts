import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../../common/coworkSystemMessages';
import { type CoworkGoal, CoworkGoalStatus } from '../../../shared/cowork/goal';
import { getCoworkLlmTrace, isValidLlmTraceId } from '../../../shared/cowork/llmTurnUsage';
import { CoworkSteerStatus } from '../../../shared/cowork/steer';
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
  DshGoalCommandKind,
  DshRuntimeAdapter,
  extractGoalFromDshPayload,
  extractGoalFromProjections,
  isDshBackedSessionId,
  resolveUnlockedCapabilitiesForTurn,
  translateLobsterGoalCommandToDsh,
} from './dshRuntimeAdapter';
import type { CoworkContextUsage } from './types';

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
      if (updates.goal !== undefined) session.goal = updates.goal;
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

  test('preserves both capsule summary and newest turns when Lazy Context Bridge exceeds max chars', () => {
    const longCapsule = {
      version: 1 as const,
      sessionId: 'cw-long',
      revision: 3,
      updatedAt: 1,
      lastSource: ContinuityCapsuleSource.PostRun,
      currentObjective: 'CORE-OBJECTIVE-MARKER: Ship reliable context compaction',
      recentUserRequests: Array.from({ length: 12 }, (_, i) => `User request #${i + 1}: ${'x'.repeat(200)}`),
      userConstraints: Array.from({ length: 8 }, (_, i) => `Constraint #${i + 1}: ${'c'.repeat(180)}`),
      decisions: Array.from({ length: 10 }, (_, i) => `Decision #${i + 1}: ${'d'.repeat(180)}`),
      completedFacts: Array.from({ length: 10 }, (_, i) => `Completed #${i + 1}: ${'f'.repeat(180)}`),
      recentActions: [],
      touchedFiles: [],
      keySymbols: [],
      verification: [],
      nextSteps: ['Verify E2E compaction'],
      recentFailures: [],
      activeCapabilities: [],
      openQuestions: [],
    };
    const longMessages: CoworkMessage[] = Array.from({ length: 8 }, (_, i) => ({
      id: `m-${i + 1}`,
      type: i % 2 === 0 ? 'user' : 'assistant',
      content: `TURN-MARKER-${i + 1} ${'m'.repeat(750)}`,
      timestamp: i + 1,
    }));

    const prefix = buildLazyContextBridgePrefix(longCapsule, longMessages);
    expect(prefix.length).toBeLessThanOrEqual(6_000);
    expect(prefix.startsWith('<previous_conversation_context>\n')).toBe(true);
    expect(prefix.endsWith('\n</previous_conversation_context>')).toBe(true);
    // Capsule objective MUST survive.
    expect(prefix).toContain('CORE-OBJECTIVE-MARKER: Ship reliable context compaction');
    // Newest user/assistant turns MUST survive instead of being sliced off the end.
    expect(prefix).toContain('[历史会话近期对话]');
    expect(prefix).toContain('TURN-MARKER-8');
    expect(prefix).toContain('TURN-MARKER-7');
    // Oldest turns are dropped first to stay within budget.
    expect(prefix).not.toContain('TURN-MARKER-1');

    // When legacy goal and todo/plan are also present, all sections survive within budget.
    const prefixWithGoalAndPlan = buildLazyContextBridgePrefix(
      longCapsule,
      [
        {
          id: 'todo-1',
          type: 'tool_use',
          content: 'TodoWrite',
          timestamp: 0,
          metadata: {
            toolName: 'TodoWrite',
            toolInput: {
              todos: [
                { content: 'LEGACY-PLAN-STEP-1', status: 'completed' },
                { content: 'LEGACY-PLAN-STEP-2', status: 'in_progress' },
              ],
            },
          },
        },
        ...longMessages,
      ],
      {
        id: 'goal-legacy-1',
        objective: 'LEGACY-GOAL-OBJECTIVE',
        status: CoworkGoalStatus.Active,
        createdAt: 1,
        updatedAt: 2,
        tokensUsed: 0,
      },
    );
    expect(prefixWithGoalAndPlan.length).toBeLessThanOrEqual(6_000);
    expect(prefixWithGoalAndPlan.endsWith('\n</previous_conversation_context>')).toBe(true);
    expect(prefixWithGoalAndPlan).toContain('LEGACY-GOAL-OBJECTIVE');
    expect(prefixWithGoalAndPlan).toContain('LEGACY-PLAN-STEP-2');
    expect(prefixWithGoalAndPlan).toContain('CORE-OBJECTIVE-MARKER: Ship reliable context compaction');
    expect(prefixWithGoalAndPlan).toContain('TURN-MARKER-8');
    expect(prefixWithGoalAndPlan).not.toContain('TURN-MARKER-1');
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

  test('translates LobsterAI /goal syntax to DSH parseGoalCommand grammar for fresh, active, and complete goals', () => {
    const activeGoal: CoworkGoal = {
      id: 'goal-1',
      objective: 'Old goal',
      status: CoworkGoalStatus.Active,
      createdAt: 1000,
      updatedAt: 1000,
      tokensUsed: 0,
    };
    const completeGoal: CoworkGoal = {
      ...activeGoal,
      status: CoworkGoalStatus.Complete,
      completedAt: 2000,
    };

    expect(translateLobsterGoalCommandToDsh('/goal start Build a release checklist', null)).toEqual({
      kind: DshGoalCommandKind.Create,
      line: '/goal Build a release checklist',
      objective: 'Build a release checklist',
    });
    expect(translateLobsterGoalCommandToDsh('/goal set Ship v2', null)).toEqual({
      kind: DshGoalCommandKind.Create,
      line: '/goal Ship v2',
      objective: 'Ship v2',
    });
    expect(translateLobsterGoalCommandToDsh('/goal set Updated objective', activeGoal)).toEqual({
      kind: DshGoalCommandKind.Edit,
      line: '/goal edit Updated objective',
      objective: 'Updated objective',
    });
    expect(translateLobsterGoalCommandToDsh('/goal edit New goal after done', completeGoal)).toEqual({
      kind: DshGoalCommandKind.Create,
      line: '/goal New goal after done',
      objective: 'New goal after done',
    });
    expect(translateLobsterGoalCommandToDsh('/goal pause', activeGoal)).toEqual({
      kind: DshGoalCommandKind.Pause,
      line: '/goal pause',
    });
    expect(translateLobsterGoalCommandToDsh('/goal resume', activeGoal)).toEqual({
      kind: DshGoalCommandKind.Resume,
      line: '/goal resume',
    });
    expect(translateLobsterGoalCommandToDsh('/goal clear', activeGoal)).toEqual({
      kind: DshGoalCommandKind.Clear,
      line: '/goal clear',
    });
    expect(translateLobsterGoalCommandToDsh('/goal status', activeGoal)).toEqual({
      kind: DshGoalCommandKind.Show,
      line: '/goal',
    });
  });

  test('parses REAL DSH 0.2.2 nested goal projections and goal/change payloads (plus legacy flat fallback)', () => {
    const realDshProjection = {
      seq: 12,
      values: {
        goal: {
          goal: {
            id: 'goal-uuid-1',
            revision: 3,
            objective: 'Build a release checklist',
            phase: 'blocked',
            maxGoalRounds: 256,
            blockedReason: {
              code: 'missing-credentials',
              message: 'Need npm publish token',
            },
          },
          roundsStarted: 4,
          createdAt: 1700000000000,
          updatedAt: 1700000005000,
        },
      },
    };
    expect(extractGoalFromProjections(realDshProjection)).toEqual({
      id: 'goal-uuid-1',
      objective: 'Build a release checklist',
      status: CoworkGoalStatus.Blocked,
      createdAt: 1700000000000,
      updatedAt: 1700000005000,
      blockedAt: 1700000005000,
      tokensUsed: 0,
      continuationTurns: 4,
      lastStatusNote: 'Need npm publish token',
    });

    expect(extractGoalFromDshPayload({
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: { id: 'goal-uuid-1', revision: 4 },
      clearedAt: 1700000009000,
    })).toBeNull();

    expect(extractGoalFromProjections({
      values: {
        goal: {
          id: 'legacy-flat-1',
          text: 'Legacy objective',
          status: 'paused',
          createdAt: 100,
          updatedAt: 200,
          tokensUsed: 55,
        },
      },
    })).toEqual({
      id: 'legacy-flat-1',
      objective: 'Legacy objective',
      status: CoworkGoalStatus.Paused,
      createdAt: 100,
      updatedAt: 200,
      pausedAt: 200,
      tokensUsed: 55,
    });
  });

  test('includes legacy session goal and latest todo/plan items in Lazy Context Bridge', () => {
    const legacyGoal: CoworkGoal = {
      id: 'g-old',
      objective: 'Complete release migration',
      status: CoworkGoalStatus.Paused,
      createdAt: 1000,
      updatedAt: 2000,
      tokensUsed: 0,
      lastStatusNote: 'Waiting for QA sign-off',
    };
    const prefix = buildLazyContextBridgePrefix(
      null,
      [
        { id: 'm1', type: 'user', content: 'Plan the release', timestamp: 1 },
        {
          id: 'm2',
          type: 'tool_use',
          content: 'TodoWrite',
          timestamp: 2,
          metadata: {
            toolName: 'TodoWrite',
            toolInput: {
              todos: [
                { content: 'Fix /goal routing', status: 'completed' },
                { content: 'Verify E2E with real DSH', status: 'in_progress' },
              ],
            },
          },
        },
      ],
      legacyGoal,
    );
    expect(prefix).toContain('[历史会话目标]');
    expect(prefix).toContain('Complete release migration');
    expect(prefix).toContain('Waiting for QA sign-off');
    expect(prefix).toContain('[历史任务清单/计划]');
    expect(prefix).toContain('[completed] Fix /goal routing');
    expect(prefix).toContain('[in_progress] Verify E2E with real DSH');
  });

  test('routes runGoalCommand and startSession(/goal ...) via executeCommand, handles multi-round goal/change, and supports legacy sessions', async () => {
    const { store, session, messages } = createInMemoryStore({
      id: 'cw-goal-legacy',
      cwd: '/tmp/work',
      claudeSessionId: 'agent:main:legacy-openclaw',
      goal: {
        id: 'old-goal',
        objective: 'Legacy objective',
        status: CoworkGoalStatus.Paused,
        createdAt: 1000,
        updatedAt: 1000,
        tokensUsed: 0,
      },
      messages: [
        { id: 'u-old', type: 'user', content: 'Previous legacy turn', timestamp: 1 },
        {
          id: 't-old',
          type: 'tool_use',
          content: 'update_plan',
          timestamp: 2,
          metadata: {
            toolName: 'update_plan',
            toolInput: {
              explanation: 'Migration checklist',
              plan: [{ step: 'Run E2E tests', status: 'pending' }],
            },
          },
        },
      ],
    });

    const executeCommand = vi.fn(async () => ({
      commandId: 'cmd-1',
      result: { kind: 'success' as const, text: 'Goal created' },
    }));
    const promptSession = vi.fn(async () => ({ accepted: true }));
    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const clientEmitter = new EventEmitter();

    const fakeClient = Object.assign(clientEmitter, {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-goal-1' })),
      executeCommand,
      promptSession,
      getSessionProjections: vi.fn(async () => ({
        values: {
          goal: {
            goal: {
              id: 'goal-dsh-1',
              revision: 1,
              objective: 'Legacy objective',
              phase: 'active',
              maxGoalRounds: 256,
            },
            roundsStarted: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
        },
      })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield {
          type: 'event',
          event: {
            type: 'goal/change',
            seq: 1,
            data: {
              kind: 'goal/change',
              version: 1,
              operation: 'create',
              goal: {
                id: 'goal-dsh-1',
                revision: 1,
                objective: 'Legacy objective',
                phase: 'active',
                maxGoalRounds: 256,
              },
              roundsStarted: 0,
              createdAt: 1000,
              updatedAt: 1000,
            },
          },
        };
        // Round 1 completes while goal stays armed -> stream stays open for Round 2!
        yield { type: 'event', event: { type: 'turn/start', seq: 2, data: { turn: 1 } } };
        yield {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 3,
            data: { source: { kind: 'goal', goalId: 'goal-dsh-1', revision: 1, round: 1 } },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 4,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'Round 1 done' }] } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'stop' } } } };

        // Round 2 marks goal complete -> turn/end closes the follow stream cleanly!
        yield { type: 'event', event: { type: 'turn/start', seq: 6, data: { turn: 2 } } };
        yield {
          type: 'event',
          event: {
            type: 'user/message',
            seq: 7,
            data: { source: { kind: 'goal', goalId: 'goal-dsh-1', revision: 1, round: 2 } },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'goal/change',
            seq: 8,
            data: {
              kind: 'goal/change',
              version: 1,
              operation: 'complete',
              goal: {
                id: 'goal-dsh-1',
                revision: 2,
                objective: 'Legacy objective',
                phase: 'complete',
                maxGoalRounds: 256,
              },
              roundsStarted: 2,
              createdAt: 1000,
              updatedAt: 2000,
            },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 9,
            data: { turn: 2, message: { content: [{ type: 'text', text: 'Round 2 complete!' }] } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 10, data: { turn: 2, reason: { kind: 'stop' } } } };
      }),
    }) as unknown as DshTypertClient;

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

    const goalEvents: Array<CoworkGoal | null> = [];
    const statuses: string[] = [];
    adapter.on('goalUpdate', (_sid, g) => goalEvents.push(g));
    adapter.on('sessionStatus', (_sid, st) => statuses.push(st));

    const resumed = await adapter.runGoalCommand('cw-goal-legacy', '/goal resume');
    expect(resumed?.objective).toBe('Legacy objective');
    expect(executeCommand).toHaveBeenCalledWith({
      agentId: 'dsh-goal-1',
      line: '/goal Legacy objective',
      submittedAttachments: [],
    });
    expect(promptSession).not.toHaveBeenCalled();
    expect(bindSessionContext).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'dsh-goal-1',
      customSystemPrompt: expect.stringContaining('Run E2E tests'),
    }));

    await vi.waitFor(() => {
      expect(adapter.isSessionActive('cw-goal-legacy')).toBe(false);
    });
    expect(session.goal?.status).toBe(CoworkGoalStatus.Complete);
    expect(session.goal?.continuationTurns).toBe(2);
    expect(messages.some((m) => m.content === 'Round 1 done')).toBe(true);
    expect(messages.some((m) => m.content === 'Round 2 complete!')).toBe(true);
    expect(statuses.at(-1)).toBe('completed');
    expect(goalEvents.some((g) => g?.status === CoworkGoalStatus.Complete)).toBe(true);
  });

  test('always binds explicit customSystemPrompt so turning off Plan Mode clears previous turn prompt', async () => {
    const { store } = createInMemoryStore({
      id: 'cw-plan-sticky',
      cwd: '/tmp/work',
      systemPrompt: '',
    });

    const bindSessionContext = vi.fn(async () => ({ ok: true }));
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-plan-1' })),
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

    await adapter.startSession('cw-plan-sticky', 'Plan first', {
      systemPrompt: '# Plan Mode\nDo not write files.',
    });
    expect(bindSessionContext).toHaveBeenNthCalledWith(1, expect.objectContaining({
      customSystemPrompt: '# Plan Mode\nDo not write files.',
    }));

    // Turn 2: Confirm & Execute turns off Plan Mode (`systemPrompt: ''`).
    await adapter.continueSession('cw-plan-sticky', 'Confirm & Execute', {
      systemPrompt: '',
    });
    expect(bindSessionContext).toHaveBeenNthCalledWith(2, expect.objectContaining({
      customSystemPrompt: '',
    }));
  });

  test('submitSteer finalizes pre-steer assistant text above steer bubble and falls back cleanly when turn already ended', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-steer',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-steer-1`,
    });

    let releaseAfterSteer!: () => void;
    const steerGate = new Promise<void>((resolve) => {
      releaseAfterSteer = resolve;
    });
    let followCount = 0;

    const promptSession = vi.fn(async () => ({ accepted: true }));
    const fakeClient = {
      promptSession,
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        followCount += 1;
        if (followCount === 1) {
          yield { type: 'assistant-stream', frame: { type: 'start' } };
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Before steer' } } };
          await steerGate;
          // Step 1's committed assistant/message matching flushed pre-steer text must NOT duplicate.
          yield {
            type: 'event',
            event: {
              type: 'assistant/message',
              seq: 2,
              data: { message: { content: [{ type: 'text', text: 'Before steer' }] } },
            },
          };
          // Step 2 streams post-steer answer in a NEW assistant bubble below the steer message.
          yield { type: 'assistant-stream', frame: { type: 'start' } };
          yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'After steer' } } };
          yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } } };
          yield { type: 'event', event: { type: 'turn/end', seq: 4, data: {} } };
          return;
        }
        // Second turn started by idle-turn steer fallback.
        yield { type: 'assistant-stream', frame: { type: 'start' } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Fallback reply' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } } };
        yield { type: 'event', event: { type: 'turn/end', seq: 6, data: {} } };
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

    const turn1 = adapter.continueSession('cw-steer', 'Initial question');
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'assistant' && m.content === 'Before steer')).toBe(true);
    });

    const midSteer = await adapter.submitSteer('cw-steer', 'Change direction', 'steer-1');
    expect(midSteer).toEqual({
      success: true,
      status: CoworkSteerStatus.Accepted,
      clientSteerId: 'steer-1',
    });
    releaseAfterSteer();
    await turn1;

    expect(messages.map((m) => ({
      type: m.type,
      content: m.content,
      isStreaming: m.metadata?.isStreaming,
    }))).toEqual([
      { type: 'user', content: 'Initial question', isStreaming: undefined },
      { type: 'assistant', content: 'Before steer', isStreaming: false },
      { type: 'user', content: 'Change direction', isStreaming: undefined },
      { type: 'assistant', content: 'After steer', isStreaming: false },
    ]);

    // Idle-turn race: turn already finished before steer arrives -> falls back cleanly to continueSession.
    expect(adapter.isSessionActive('cw-steer')).toBe(false);
    const lateSteer = await adapter.submitSteer('cw-steer', 'Late steer', 'steer-2');
    expect(lateSteer).toEqual({
      success: true,
      status: CoworkSteerStatus.Accepted,
      clientSteerId: 'steer-2',
    });
    await vi.waitFor(() => {
      expect(adapter.isSessionActive('cw-steer')).toBe(false);
      expect(messages.some((m) => m.type === 'assistant' && m.content === 'Fallback reply')).toBe(true);
    });
    expect(promptSession).toHaveBeenLastCalledWith(expect.objectContaining({
      mode: 'queue',
      requestId: 'steer-2',
    }));
  });

  test('ignores delayed interrupted assistant/message and aborted turn/end even after cancelSession RPC already resolved', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-queue-delayed-abort',
      cwd: '/tmp/work',
      agentId: 'main',
    });

    let followInvocation = 0;
    const fakeClient = {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-q-race-1' })),
      // cancelSession acks immediately (clearing pendingCancels long before continueSession runs).
      cancelSession: vi.fn(async () => ({ accepted: true })),
      promptSession: vi.fn(async () => ({ accepted: true })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* (_req: unknown, signal?: AbortSignal) {
        followInvocation += 1;
        if (followInvocation === 1) {
          yield { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } };
          yield { type: 'assistant-stream', frame: { type: 'start', turn: 1 } };
          yield { type: 'assistant-stream', frame: { type: 'chunk', turn: 1, chunk: { type: 'text-delta', index: 0, text: 'Turn 1 partial' } } };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        // Delayed Turn 1 interrupted assistant/message AND Turn 1 aborted turn/end arrive on Turn 2's stream!
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 2,
            data: { turn: 1, interrupted: true, message: { content: [{ type: 'text', text: 'Turn 1 partial' }] } },
          },
        };
        yield {
          type: 'event',
          event: {
            type: 'turn/end',
            seq: 3,
            data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
          },
        };
        // Then Turn 2 runs and completes cleanly!
        yield { type: 'event', event: { type: 'turn/start', seq: 4, data: { turn: 2 } } };
        yield { type: 'assistant-stream', frame: { type: 'start', turn: 2 } };
        yield { type: 'assistant-stream', frame: { type: 'chunk', turn: 2, chunk: { type: 'text-delta', index: 0, text: 'Turn 2 queued answer' } } };
        yield { type: 'assistant-stream', frame: { type: 'end', turn: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 } } };
        yield { type: 'event', event: { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'stop' } } } };
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

    const turn1Promise = adapter.startSession('cw-queue-delayed-abort', 'slow turn 1');
    await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'assistant' && m.content === 'Turn 1 partial')).toBe(true);
    });

    adapter.stopSession('cw-queue-delayed-abort');
    await turn1Promise;
    // Allow cancelSession promise microtask & finally() cleanup to delete pendingCancels!
    await new Promise((r) => setTimeout(r, 15));

    await adapter.continueSession('cw-queue-delayed-abort', 'urgent queued turn 2');

    expect(completed).toEqual(['cw-queue-delayed-abort']);
    expect(messages.filter((m) => m.type === 'assistant' && m.content === 'Turn 1 partial')).toHaveLength(1);
    expect(messages.some((m) => m.type === 'assistant' && m.content === 'Turn 2 queued answer')).toBe(true);
  });

  test('routes startSession(/goal ...) via executeCommand with attachments and exits cleanly when goal disarms between rounds', async () => {
    const { store, session } = createInMemoryStore({
      id: 'cw-start-goal',
      cwd: '/tmp/work',
      agentId: 'main',
    });

    const clientEmitter = new EventEmitter();
    const executeCommand = vi.fn(async () => ({
      commandId: 'cmd-start-1',
      result: { kind: 'success' as const, text: 'Goal created' },
    }));
    const promptSession = vi.fn(async () => ({ accepted: true }));
    const fakeClient = Object.assign(clientEmitter, {
      createSession: vi.fn(async () => ({ sessionId: 'dsh-start-goal-1' })),
      executeCommand,
      promptSession,
      getSessionProjections: vi.fn(async () => ({
        values: {
          goal: {
            goal: {
              id: 'goal-start-1',
              revision: 1,
              objective: 'Ship onboarding',
              phase: 'active',
              maxGoalRounds: 256,
            },
            roundsStarted: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
        },
      })),
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* (_req: unknown, signal?: AbortSignal) {
        yield { type: 'event', event: { type: 'turn/start', seq: 1, data: { turn: 1 } } };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 2,
            data: { turn: 1, message: { content: [{ type: 'text', text: 'Round 1 note' }] } },
          },
        };
        // Turn 1 ends while goal is still armed -> waits for next round or disarm.
        yield { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'stop' } } } };
        // Simulate DSH disarming between rounds via forwarded remote event.
        queueMicrotask(() => {
          clientEmitter.emit('remote:goal/activation-changed', {
            sessionId: 'dsh-start-goal-1',
            goal: { id: 'goal-start-1', revision: 1, activation: 'disarmed' },
          });
        });
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }),
    }) as unknown as DshTypertClient;

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

    await adapter.startSession('cw-start-goal', '/goal start Ship onboarding', {
      imageAttachments: [
        { name: 'mock.png', mimeType: 'image/png', base64Data: 'iVBORw0KGgo=', sizeBytes: 8 },
      ],
    });

    expect(promptSession).not.toHaveBeenCalled();
    expect(executeCommand).toHaveBeenCalledWith({
      agentId: 'dsh-start-goal-1',
      line: '/goal Ship onboarding',
      submittedAttachments: [
        { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'mock.png' },
      ],
    });
    expect(session.goal?.objective).toBe('Ship onboarding');
    expect(adapter.isSessionActive('cw-start-goal')).toBe(false);
    expect(completed).toEqual(['cw-start-goal']);
  });

  test('getContextUsage reads DSH contextPressure, tokenUsage, contextBreakdown, legacy tokenMeter, and respects contextWindowOverride', async () => {
    const { store, session } = createInMemoryStore({
      id: 'cw-usage',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-usage-1`,
    });

    const getSessionProjections = vi.fn();
    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => ({ getSessionProjections }) as unknown as DshTypertClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    // 1. Real DSH 0.2.2 projection: prefers projectedTokens over pressureTokens (crucial post-compaction).
    getSessionProjections.mockResolvedValueOnce({
      asOfSeq: 14,
      values: {
        contextPressure: {
          pressureTokens: 96_000,
          projectedTokens: 32_000,
          contextWindow: 128_000,
        },
        tokenUsage: {
          uncachedInputTokens: 90_000,
          outputTokens: 4_000,
          cacheReadTokens: 6_000,
          cacheWriteTokens: 0,
        },
        contextBreakdown: {
          systemTokens: 1_200,
          toolsTokens: 3_400,
          messageTokens: 27_400,
        },
        modelSelection: {
          lastUsed: { provider: 'lobster-openai', model: 'gpt-5' },
          next: { provider: 'lobster-openai', model: 'gpt-5' },
        },
      },
    });
    const projected = await adapter.getContextUsage('cw-usage');
    expect(projected).toMatchObject({
      sessionId: 'cw-usage',
      sessionKey: 'dsh-usage-1',
      usedTokens: 32_000,
      contextTokens: 128_000,
      percent: 25,
      status: 'normal',
      model: 'lobster-openai/gpt-5',
    });

    // 2. Respects positive session.contextWindowOverride over DSH model contextWindow.
    session.contextWindowOverride = 40_000;
    getSessionProjections.mockResolvedValueOnce({
      asOfSeq: 15,
      values: {
        contextPressure: {
          pressureTokens: 32_000,
          contextWindow: 128_000,
        },
      },
    });
    const overridden = await adapter.getContextUsage('cw-usage');
    expect(overridden).toMatchObject({
      usedTokens: 32_000,
      contextTokens: 40_000,
      percent: 80,
      status: 'warning',
    });

    // 3. Falls back to contextBreakdown when provider usage hasn't been sampled yet.
    session.contextWindowOverride = null;
    getSessionProjections.mockResolvedValueOnce({
      asOfSeq: 4,
      values: {
        contextPressure: { contextWindow: 100_000 },
        tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextBreakdown: { systemTokens: 2_000, toolsTokens: 3_000, messageTokens: 5_000 },
      },
    });
    const fromBreakdown = await adapter.getContextUsage('cw-usage');
    expect(fromBreakdown).toMatchObject({
      usedTokens: 10_000,
      contextTokens: 100_000,
      percent: 10,
      status: 'normal',
    });

    // 4. Falls back to tokenUsage when neither contextPressure counts nor breakdown are present.
    getSessionProjections.mockResolvedValueOnce({
      asOfSeq: 6,
      values: {
        contextPressure: { contextWindow: 100_000 },
        tokenUsage: { uncachedInputTokens: 60_000, outputTokens: 500, cacheReadTokens: 32_000, cacheWriteTokens: 0 },
      },
    });
    const fromTokenUsage = await adapter.getContextUsage('cw-usage');
    expect(fromTokenUsage).toMatchObject({
      usedTokens: 92_000,
      contextTokens: 100_000,
      percent: 92,
      status: 'danger',
    });

    // 5. Returns null for empty/fresh projections with zero usage and no contextWindow.
    getSessionProjections.mockResolvedValueOnce({
      asOfSeq: 0,
      values: {
        contextPressure: {},
        tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
      },
    });
    expect(await adapter.getContextUsage('cw-usage')).toBeNull();
  });

  test('compactContext invokes commands/execute /compact, distinguishes noop vs committed compaction, and persists notice', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-compact',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-compact-1`,
    });

    const executeCommand = vi.fn();
    const promptSession = vi.fn();
    const getSessionProjections = vi.fn(async () => ({
      asOfSeq: 20,
      values: {
        contextPressure: {
          pressureTokens: 80_000,
          projectedTokens: 16_000,
          contextWindow: 128_000,
        },
      },
    }));

    const adapter = new DshRuntimeAdapter({
      hostManager: {
        start: vi.fn(async () => undefined),
        isReady: vi.fn(() => true),
        getClient: vi.fn(() => ({
          executeCommand,
          promptSession,
          getSessionProjections,
          onWaterfall: vi.fn(() => () => undefined),
        }) as unknown as DshTypertClient),
        bindSessionContext: vi.fn(async () => ({ ok: true })),
        deleteSessionFiles: vi.fn(async () => ({ ok: true })),
      },
      store,
    });

    const maintenanceEvents: boolean[] = [];
    const usageUpdates: CoworkContextUsage[] = [];
    const streamedMessages: CoworkMessage[] = [];
    adapter.on('contextMaintenance', (_sid, active) => maintenanceEvents.push(active));
    adapter.on('contextUsageUpdate', (_sid, usage) => usageUpdates.push(usage));
    adapter.on('message', (_sid, msg) => streamedMessages.push(msg));

    // Case 1: No compactable history yet (no sourceEventSeq).
    executeCommand.mockResolvedValueOnce({
      commandId: 'cmd-noop',
      result: { kind: 'success', text: 'No compactable history yet.' },
    });
    const noopRes = await adapter.compactContext('cw-compact');
    expect(executeCommand).toHaveBeenCalledWith({
      agentId: 'dsh-compact-1',
      line: '/compact',
    });
    expect(promptSession).not.toHaveBeenCalled();
    expect(noopRes.compacted).toBe(false);
    expect(noopRes.reason).toBe('No compactable history yet.');
    expect(noopRes.usage?.usedTokens).toBe(16_000);
    expect(messages).toHaveLength(0);
    expect(maintenanceEvents).toEqual([true, false]);

    // Case 2: Actual compaction committed (sourceEventSeq returned).
    executeCommand.mockResolvedValueOnce({
      commandId: 'cmd-ok',
      result: {
        kind: 'success',
        text: 'Compacted 6 history items (~64000 tokens).',
        sourceEventSeq: 18,
      },
    });
    const okRes = await adapter.compactContext('cw-compact');
    expect(okRes.compacted).toBe(true);
    expect(okRes.usage).toMatchObject({
      usedTokens: 16_000,
      contextTokens: 128_000,
      percent: 13,
      status: 'normal',
    });
    expect(usageUpdates).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'system',
      content: '',
      metadata: {
        kind: CoworkSystemMessageKind.ContextCompaction,
        mode: ContextCompactionMode.Manual,
        status: ContextCompactionStatus.Completed,
        compacted: true,
        seq: 18,
        summary: 'Compacted 6 history items (~64000 tokens).',
      },
    });
    expect(streamedMessages).toHaveLength(1);

    // Case 3: Command returns error result -> throws and still clears contextMaintenance.
    executeCommand.mockResolvedValueOnce({
      commandId: 'cmd-err',
      result: {
        kind: 'error',
        text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
      },
    });
    await expect(adapter.compactContext('cw-compact')).rejects.toThrow(/active compaction/i);
    expect(maintenanceEvents).toEqual([true, false, true, false, true, false]);
  });

  test('proactively emits contextUsageUpdate after assistant/message and persists ContextCompaction on auto compaction/end', async () => {
    const { store, messages } = createInMemoryStore({
      id: 'cw-auto-compact',
      cwd: '/tmp/work',
      claudeSessionId: `${DSH_SESSION_ID_PREFIX}dsh-auto-1`,
    });

    const getSessionProjections = vi.fn()
      .mockResolvedValueOnce({
        asOfSeq: 10,
        values: {
          contextPressure: { projectedTokens: 20_000, pressureTokens: 100_000, contextWindow: 128_000 },
        },
      })
      .mockResolvedValueOnce({
        asOfSeq: 12,
        values: {
          contextPressure: { projectedTokens: 24_000, pressureTokens: 23_500, contextWindow: 128_000 },
        },
      });

    const fakeClient = {
      promptSession: vi.fn(async () => ({ accepted: true })),
      getSessionProjections,
      onWaterfall: vi.fn(() => () => undefined),
      followSession: vi.fn(async function* () {
        yield { type: 'event', event: { type: 'compaction/start', seq: 8, data: { compactionId: 'cmp-1', turn: 2 } } };
        yield { type: 'event', event: { type: 'compaction/end', seq: 10, data: { compactionId: 'cmp-1', turn: 2 } } };
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 12,
            data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Done after compaction.' }] } },
          },
        };
        yield { type: 'event', event: { type: 'turn/end', seq: 13, data: { reason: { kind: 'completed' } } } };
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

    const maintenance: boolean[] = [];
    const usages: CoworkContextUsage[] = [];
    adapter.on('contextMaintenance', (_sid, active) => maintenance.push(active));
    adapter.on('contextUsageUpdate', (_sid, usage) => usages.push(usage));

    await adapter.continueSession('cw-auto-compact', 'Keep going');

    expect(maintenance).toEqual([true, false]);
    expect(usages.map((u) => u.usedTokens)).toEqual([20_000, 24_000]);
    const compactionMsg = messages.find(
      (m) => m.type === 'system' && m.metadata?.kind === CoworkSystemMessageKind.ContextCompaction,
    );
    expect(compactionMsg).toBeDefined();
    expect(compactionMsg?.metadata).toMatchObject({
      kind: CoworkSystemMessageKind.ContextCompaction,
      mode: ContextCompactionMode.Auto,
      status: ContextCompactionStatus.Completed,
      compacted: true,
      compactionId: 'cmp-1',
      seq: 10,
    });
  });
});
