import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CoworkTurnUsageStatus } from '../../shared/cowork/llmTurnUsage';
import type { CoworkMessage } from '../coworkStore';
import { type CoworkTurnUsageEvent, CoworkTurnUsageService, type CoworkTurnUsageServiceDeps } from './coworkTurnUsage';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Harness = {
  service: CoworkTurnUsageService;
  message: CoworkMessage;
  fetchWithAuth: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
  events: CoworkTurnUsageEvent[];
  updateMessage: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  getStore: ReturnType<typeof vi.fn>;
  stats: { requests: number; completed: number } | null;
};

const createHarness = (options: {
  metadata?: Record<string, unknown>;
  signedIn?: boolean;
  captureSessionAccess?: CoworkTurnUsageServiceDeps['captureSessionAccess'];
} = {}): Harness => {
  const message: CoworkMessage = {
    id: MESSAGE_ID,
    type: 'user',
    content: 'hello',
    timestamp: 1_000,
    metadata: options.metadata ?? { skillIds: ['docx'], llmTrace: { traceId: TRACE_ID, startedAt: 1_790_000_000_000 } },
  };
  const updateMessage = vi.fn((_sessionId: string, _messageId: string, updates: { metadata?: Record<string, unknown> }) => {
    message.metadata = updates.metadata;
  });
  const events: CoworkTurnUsageEvent[] = [];
  const fetchWithAuth = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const sleep = vi.fn(async () => {});
  const getStore = vi.fn(() => ({
    getMessage: (sessionId: string, messageId: string) => (sessionId === SESSION_ID && messageId === MESSAGE_ID ? message : null),
    getLatestUserMessage: (sessionId: string) => (sessionId === SESSION_ID ? message : null),
    updateMessage,
  }));
  const harness: Harness = {
    message,
    fetchWithAuth,
    events,
    updateMessage,
    sleep,
    getStore,
    stats: { requests: 3, completed: 3 },
    service: undefined as unknown as CoworkTurnUsageService,
  };
  harness.service = new CoworkTurnUsageService({
    getStore,
    fetchWithAuth,
    hasAuthTokens: () => options.signedIn ?? true,
    buildServerUrl: pathWithQuery => `https://server.test${pathWithQuery}&keyfrom=lobsterai`,
    getTraceStats: () => harness.stats,
    emitTurnUsage: event => events.push(event),
    captureSessionAccess: options.captureSessionAccess,
    now: () => 5_000,
    sleep,
  });
  return harness;
};

describe('CoworkTurnUsageService', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
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

  test('rejects inaccessible sessions before reading messages or fetching usage', async () => {
    const harness = createHarness({ captureSessionAccess: () => () => false });

    await harness.service.settleLatestTurn(SESSION_ID);
    await expect(harness.service.refresh(SESSION_ID, MESSAGE_ID)).resolves.toBeNull();

    expect(harness.getStore).not.toHaveBeenCalled();
    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  test('does not return a cached summary after access changes while fetching', async () => {
    let allowed = true;
    const harness = createHarness({ captureSessionAccess: () => () => allowed });
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(3) }));
    await harness.service.refresh(SESSION_ID, MESSAGE_ID);
    harness.updateMessage.mockClear();
    harness.events.length = 0;
    const response = deferred<Response>();
    harness.fetchWithAuth.mockReturnValueOnce(response.promise);

    const request = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    allowed = false;
    response.resolve(jsonResponse({ code: 4000 }));

    await expect(request).resolves.toBeNull();
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  test('drops a summary when access changes while reading the response body', async () => {
    let allowed = true;
    const harness = createHarness({ captureSessionAccess: () => () => allowed });
    const body = deferred<unknown>();
    const reading = deferred<void>();
    const response = jsonResponse(null);
    vi.spyOn(response, 'json').mockImplementation(() => {
      reading.resolve();
      return body.promise;
    });
    harness.fetchWithAuth.mockResolvedValueOnce(response);

    const request = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    await reading.promise;
    allowed = false;
    body.resolve({ code: 0, data: summary(3) });

    await expect(request).resolves.toBeNull();
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  test('does not retry or persist when access changes during the retry delay', async () => {
    let allowed = true;
    const harness = createHarness({ captureSessionAccess: () => () => allowed });
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: summary(2) }));
    harness.sleep.mockImplementationOnce(async () => { allowed = false; });

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events.map(event => event.turnUsage.status)).toEqual([CoworkTurnUsageStatus.Pending]);
  });

  test('media-only usage includes task ids and keeps the access fence during an empty-ledger retry', async () => {
    let allowed = true;
    const harness = createHarness({ captureSessionAccess: () => () => allowed });
    harness.stats = null;
    harness.service.recordMediaTask(SESSION_ID, MESSAGE_ID, '123');
    harness.updateMessage.mockClear();
    harness.fetchWithAuth.mockResolvedValueOnce(jsonResponse({ code: 0, data: {
      ...summary(0, 0), models: [], uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    } }));
    harness.sleep.mockImplementationOnce(async () => { allowed = false; });

    await harness.service.settleLatestTurn(SESSION_ID);

    expect(new URL(harness.fetchWithAuth.mock.calls[0][0]).searchParams.get('mediaTaskIds')).toBe('123');
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.events.map(event => event.turnUsage.status)).toEqual([CoworkTurnUsageStatus.Pending]);
    harness.service.recordMediaTask(SESSION_ID, MESSAGE_ID, '456');
    expect(harness.message.metadata?.turnMediaTaskIds).toEqual(['123']);
  });

  test('reentry after an account change does not share or remove a newer in-flight request', async () => {
    let epoch = 0;
    const harness = createHarness({ captureSessionAccess: () => {
      const captured = epoch;
      return () => captured === epoch;
    } });
    const oldResponse = deferred<Response>();
    const currentResponse = deferred<Response>();
    harness.fetchWithAuth.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(currentResponse.promise);

    const oldRequest = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    epoch += 1;
    const currentRequest = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    oldResponse.resolve(jsonResponse({ code: 0, data: summary(3, 100) }));
    await expect(oldRequest).resolves.toBeNull();
    const joinedRequest = harness.service.refresh(SESSION_ID, MESSAGE_ID);
    expect(joinedRequest).toBe(currentRequest);
    currentResponse.resolve(jsonResponse({ code: 0, data: summary(3, 20) }));

    await expect(currentRequest).resolves.toMatchObject({ creditsUsed: 20 });
    await expect(joinedRequest).resolves.toMatchObject({ creditsUsed: 20 });
    expect(harness.fetchWithAuth).toHaveBeenCalledTimes(2);
    expect(harness.updateMessage).toHaveBeenCalledTimes(1);
    expect(harness.events.map(event => event.turnUsage.creditsUsed)).toEqual([20]);
  });

  test('ignores refresh requests for unknown or non-user messages', async () => {
    const harness = createHarness();

    await expect(harness.service.refresh(SESSION_ID, 'missing')).resolves.toBeNull();
    harness.message.type = 'assistant';
    await expect(harness.service.refresh(SESSION_ID, MESSAGE_ID)).resolves.toBeNull();
    expect(harness.fetchWithAuth).not.toHaveBeenCalled();
  });
});
