import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkTurnUsageStatus } from '../../shared/cowork/llmTurnUsage';
import type { CoworkMessage } from '../coworkStore';
import { type CoworkTurnUsageEvent, CoworkTurnUsageService } from './coworkTurnUsage';
import { clearLlmUsageContexts, getLlmUsageHeaders, LlmUsageHeader } from './llmUsageContext';
import { claimNativeRunTurnUsage, clearNativeRunTurnUsage, type NativeRunTurnUsage, recordNativeRunLlmTrace } from './nativeRunTurnUsage';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const RELATED_TRACE_ID = '11112222333344445555666677778888';
const SESSION_ID = 'session-1';
const MESSAGE_ID = 'user-1';

const summary = (requestCount: number, creditsUsed = 12.5) => ({
  traceId: TRACE_ID,
  billingScope: 'personal',
  requestCount,
  failedRequestCount: 0,
  models: ['deepseek-v4.1-flash'],
  creditsUsed,
  uncachedInputTokens: 100,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
  outputTokens: 50,
});

const jsonResponse = (body: unknown, status = 200): Response => (
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
);

type Harness = {
  service: CoworkTurnUsageService;
  message: CoworkMessage;
  fetchWithAuth: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  events: CoworkTurnUsageEvent[];
  updateMessage: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  stats: { requests: number; completed: number } | null;
  statsByTrace?: Record<string, { requests: number; completed: number }>;
  conversation?: CoworkMessage[];
  claimNativeRunTurnUsage: ReturnType<typeof vi.fn<(runIds: string[]) => NativeRunTurnUsage | null>>;
};

const createHarness = (options: { metadata?: Record<string, unknown>; signedIn?: boolean } = {}): Harness => {
  const message: CoworkMessage = {
    id: MESSAGE_ID,
    type: 'user',
    content: 'hello',
    timestamp: 1_000,
    metadata: options.metadata ?? { skillIds: ['docx'], llmTrace: { traceId: TRACE_ID, startedAt: 1_790_000_000_000 } },
  };
  const updateMessage = vi.fn((_sessionId: string, messageId: string, updates: { metadata?: Record<string, unknown> }) => {
    if (messageId === harness.message.id) harness.message.metadata = updates.metadata;
  });
  const events: CoworkTurnUsageEvent[] = [];
  const fetchWithAuth = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const sleep = vi.fn(async () => {});
  const claimNativeRunTurnUsage = vi.fn<(runIds: string[]) => NativeRunTurnUsage | null>(() => null);
  const harness: Harness = {
    message,
    fetchWithAuth,
    events,
    updateMessage,
    sleep,
    stats: { requests: 3, completed: 3 },
    claimNativeRunTurnUsage,
    service: undefined as unknown as CoworkTurnUsageService,
  };
  harness.service = new CoworkTurnUsageService({
    getStore: () => ({
      getMessage: (sessionId, messageId) => (
        sessionId === SESSION_ID && messageId === harness.message.id ? harness.message : null
      ),
      getLatestUserMessage: sessionId => (sessionId === SESSION_ID ? harness.message : null),
      getRecentConversationMessages: () => harness.conversation ?? [harness.message],
      updateMessage,
    }),
    fetchWithAuth,
    hasAuthTokens: () => options.signedIn ?? true,
    buildServerUrl: pathWithQuery => `https://server.test${pathWithQuery}&keyfrom=lobsterai`,
    getTraceStats: traceId => (harness.statsByTrace ? harness.statsByTrace[traceId] ?? null : harness.stats),
    emitTurnUsage: event => events.push(event),
    claimNativeRunTurnUsage,
    now: () => 5_000,
    sleep,
  });
  return harness;
};

describe('CoworkTurnUsageService', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    clearLlmUsageContexts();
    clearNativeRunTurnUsage();
    consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];
    return () => consoleSpies.forEach(spy => spy.mockRestore());
  });

  test('settles a finished turn from the server ledger and keeps existing metadata', async () => {
    const harness = createHarness();
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth).toHaveBeenCalledWith(
      `https://server.test/api/usage/llm-traces/${TRACE_ID}?since=1790000000000&keyfrom=lobsterai`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(harness.events.map(event => event.turnUsage.status)).toEqual([
      CoworkTurnUsageStatus.Pending,
      CoworkTurnUsageStatus.Settled,
    ]);
    expect(harness.message.metadata).toMatchObject({
      skillIds: ['docx'],
      llmTrace: { traceId: TRACE_ID },
      turnUsage: {
        status: CoworkTurnUsageStatus.Settled,
        requestCount: 3,
        creditsUsed: 12.5,
        inputTokens: 1_000,
        totalTokens: 1_050,
        observedCompletedRequests: 3,
      },
    });
  });

  test('binds the traces an IM/cron run reported to its synced user message', async () => {
    const harness = createHarness({ metadata: { localMediaAttachments: [] } });
    harness.claimNativeRunTurnUsage.mockReturnValueOnce({
      trace: { traceId: TRACE_ID, startedAt: 1_790_000_000_000 },
      mediaTaskIds: ['7'],
      modelPreset: { modelPresetId: 'balanced', resolvedModelId: 'deepseek-flash-YoudaoInner' },
    });
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));

    await harness.service.settleLatestTurn(SESSION_ID, { runIds: ['run-1'] });

    expect(harness.claimNativeRunTurnUsage).toHaveBeenCalledWith(['run-1']);
    expect(harness.fetchWithAuth).toHaveBeenCalledWith(
      `https://server.test/api/usage/llm-traces/${TRACE_ID}?since=1790000000000&mediaTaskIds=7&keyfrom=lobsterai`,
      expect.anything(),
    );
    expect(harness.message.metadata).toMatchObject({
      localMediaAttachments: [],
      llmTrace: { traceId: TRACE_ID, startedAt: 1_790_000_000_000 },
      turnMediaTaskIds: ['7'],
      modelPresetId: 'balanced',
      resolvedModelId: 'deepseek-flash-YoudaoInner',
      turnUsage: { status: CoworkTurnUsageStatus.Settled, requestCount: 3 },
    });
  });

  test('settles manual and automatic cron executions independently with their flagship preset', async () => {
    const harness = createHarness({ metadata: {} });
    harness.claimNativeRunTurnUsage.mockImplementation(claimNativeRunTurnUsage);
    harness.stats = { requests: 1, completed: 1 };
    const messages: CoworkMessage[] = [];
    for (const [index, traceId] of [TRACE_ID, RELATED_TRACE_ID].entries()) {
      const runId = `cron-run-${index}`;
      const startedAt = 1_000 + index * 120_000;
      harness.message = {
        id: `cron-user-${index}`, type: 'user', content: '[cron:job-1] decorated runtime prompt',
        timestamp: startedAt, metadata: {},
      };
      expect(recordNativeRunLlmTrace({
        runId, traceId, sessionKey: `agent:main:cron:job-1:run:${runId}`,
        trigger: 'cron', jobId: 'job-1', jobTitle: '报数', userMessage: '每1分钟报一下当前时间',
        virtualModelId: 'yd-ultra', model: 'glm-5.3',
      }, startedAt)).toBe(true);
      const headers = getLlmUsageHeaders(`00-${traceId}-1111111111111111-01`, 'glm-5.3');
      expect(headers).toMatchObject({
        [LlmUsageHeader.Session]: 'cron:job-1', [LlmUsageHeader.Turn]: traceId,
        [LlmUsageHeader.ModelPreset]: 'ultimate',
      });
      expect(decodeURIComponent(headers[LlmUsageHeader.UserMessage])).toBe('每1分钟报一下当前时间');
      harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({
        code: 0, data: { ...summary(1, 11.8 + index), traceId, models: ['glm-5.3'] },
      }));
      await harness.service.settleLatestTurn(SESSION_ID, { runIds: [runId], startedAt });
      messages.push(harness.message);
      expect(harness.message.metadata).toMatchObject({
        modelPresetId: 'ultimate', resolvedModelId: 'glm-5.3', llmTrace: { traceId, startedAt },
        turnUsage: { status: CoworkTurnUsageStatus.Settled, requestCount: 1, creditsUsed: 11.8 + index },
      });
    }
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(messages[0].metadata?.turnUsage).toMatchObject({ traceId: TRACE_ID, creditsUsed: 11.8 });
    expect(messages[1].metadata?.turnUsage).toMatchObject({ traceId: RELATED_TRACE_ID, creditsUsed: 12.8 });
  });

  test('does not charge an earlier turn when the run message has not synced yet', async () => {
    const harness = createHarness({ metadata: {} });
    harness.conversation = [harness.message, {
      id: 'assistant-1', type: 'assistant', content: 'earlier reply', timestamp: 1_500, metadata: {},
    }];
    harness.claimNativeRunTurnUsage.mockReturnValueOnce({ trace: { traceId: TRACE_ID, startedAt: 2_100 }, mediaTaskIds: [] });

    await harness.service.settleLatestTurn(SESSION_ID, { runIds: ['run-1'], startedAt: 2_000 });

    expect(harness.message.metadata).toEqual({});
    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
  });

  test('binds a reply stamped before the trace report but after the run started', async () => {
    const harness = createHarness({ metadata: {} });
    harness.conversation = [harness.message, {
      id: 'assistant-1', type: 'assistant', content: 'reply', timestamp: 2_050, metadata: {},
    }];
    // The plugin reports the trace asynchronously, after OpenClaw stamped the reply.
    harness.claimNativeRunTurnUsage.mockReturnValueOnce({ trace: { traceId: TRACE_ID, startedAt: 2_080 }, mediaTaskIds: [] });
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));

    await harness.service.settleLatestTurn(SESSION_ID, { runIds: ['run-1'], startedAt: 2_000 });

    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Settled });
  });

  test('stores usage on the copy of a message that IM history sync replaced meanwhile', async () => {
    const harness = createHarness();
    harness.fetchWithAuth.mockImplementationOnce(async () => {
      harness.message = { ...harness.message, id: 'user-2', metadata: { ...harness.message.metadata } };
      return jsonResponse({ code: 0, data: summary(3) });
    });

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Settled });
    expect(harness.events.at(-1)).toMatchObject({ messageId: 'user-2' });
  });

  test('keeps the trace of a desktop prompt sent into an IM session', async () => {
    const harness = createHarness();
    harness.claimNativeRunTurnUsage.mockReturnValueOnce({
      trace: { traceId: RELATED_TRACE_ID, startedAt: 1 },
      mediaTaskIds: [],
    });
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));

    await harness.service.settleLatestTurn(SESSION_ID, { runIds: ['run-1'] });

    expect(harness.message.metadata?.llmTrace).toEqual({ traceId: TRACE_ID, startedAt: 1_790_000_000_000 });
    expect(harness.fetchWithAuth.mock.calls[0][0]).toContain(`/llm-traces/${TRACE_ID}?`);
  });

  test('sums every attempt trace of a retried cron run', async () => {
    const harness = createHarness({
      metadata: {
        llmTrace: { traceId: TRACE_ID, startedAt: 1_790_000_000_000, relatedTraceIds: [RELATED_TRACE_ID] },
        turnMediaTaskIds: ['7'],
      },
    });
    harness.statsByTrace = {
      [TRACE_ID]: { requests: 3, completed: 3 },
      [RELATED_TRACE_ID]: { requests: 1, completed: 1 },
    };
    harness.fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { ...summary(1, 2), traceId: RELATED_TRACE_ID } }));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth.mock.calls.map(call => call[0])).toEqual([
      `https://server.test/api/usage/llm-traces/${TRACE_ID}?since=1790000000000&mediaTaskIds=7&keyfrom=lobsterai`,
      `https://server.test/api/usage/llm-traces/${RELATED_TRACE_ID}?since=1790000000000&keyfrom=lobsterai`,
    ]);
    expect(harness.message.metadata?.turnUsage).toMatchObject({
      traceId: TRACE_ID,
      status: CoworkTurnUsageStatus.Settled,
      requestCount: 4,
      creditsUsed: 14.5,
      totalTokens: 2_100,
      observedCompletedRequests: 4,
    });
  });

  test('fails a multi-trace turn when one of its traces cannot be fetched', async () => {
    const harness = createHarness({
      metadata: { llmTrace: { traceId: TRACE_ID, startedAt: 1, relatedTraceIds: [RELATED_TRACE_ID] } },
    });
    harness.fetchWithAuth.mockImplementation(async url => (
      url.includes(RELATED_TRACE_ID)
        ? jsonResponse({ code: 5000 }, 500)
        : jsonResponse({ code: 0, data: summary(3) })
    ));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Failed });
  });

  test('skips turns that made no LobsterAI model requests', async () => {
    const harness = createHarness();
    harness.stats = null;

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  test('skips user messages without a trace', async () => {
    const harness = createHarness({ metadata: {} });

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
  });

  test('retries once when the ledger has fewer requests than the proxy completed', async () => {
    const harness = createHarness();
    harness.fetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(2) }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.sleep).toHaveBeenCalledTimes(1);
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Settled, requestCount: 3 });
  });

  test('stores a partial summary when the ledger still lags after the retry', async () => {
    const harness = createHarness();
    harness.fetchWithAuth.mockImplementation(async () => jsonResponse({ code: 0, data: summary(2) }));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Partial, requestCount: 2 });
  });

  test('stores a failed state that the user can retry', async () => {
    const harness = createHarness();
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 4000, message: 'bad' }));

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.message.metadata?.turnUsage).toMatchObject({
      traceId: TRACE_ID,
      status: CoworkTurnUsageStatus.Failed,
      requestCount: 0,
    });

    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));
    const refreshed = await harness.service.refresh(SESSION_ID, MESSAGE_ID);

    expect(refreshed?.status).toBe(CoworkTurnUsageStatus.Settled);
    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Settled });
  });

  test('a failed refresh keeps a summary that was already fetched', async () => {
    const harness = createHarness();
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));
    await harness.service.settleLatestTurn(SESSION_ID);
    harness.updateMessage.mockClear();
    harness.fetchWithAuth.mockRejectedValueOnce(new Error('offline'));

    const refreshed = await harness.service.refresh(SESSION_ID, MESSAGE_ID);

    expect(refreshed?.status).toBe(CoworkTurnUsageStatus.Settled);
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events.at(-1)?.turnUsage.status).toBe(CoworkTurnUsageStatus.Settled);
  });

  test('does not request the server without a signed-in account', async () => {
    const harness = createHarness({ signedIn: false });

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
    expect(harness.message.metadata?.turnUsage).toMatchObject({ status: CoworkTurnUsageStatus.Failed });
  });

  test('shares one request between concurrent settlements of the same message', async () => {
    const harness = createHarness();
    let resolveFetch: (response: Response) => void = () => {};
    harness.fetchWithAuth.mockReturnValueOnce(new Promise(resolve => {
      resolveFetch = resolve;
    }));

    const first = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    const second = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    resolveFetch(jsonResponse({ code: 0, data: summary(3) }));

    await expect(first).resolves.toMatchObject({ requestCount: 3 });
    await expect(second).resolves.toMatchObject({ requestCount: 3 });
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  test('ignores refresh requests for unknown or non-user messages', async () => {
    const harness = createHarness();

    await expect(harness.service.refresh(SESSION_ID, 'missing')).resolves.toBeNull();
    harness.message.type = 'assistant';
    await expect(harness.service.refresh(SESSION_ID, MESSAGE_ID)).resolves.toBeNull();
    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
  });
});
