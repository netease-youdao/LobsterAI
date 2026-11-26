import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  AuthLifecycleEventType,
  AuthRefreshFailureKind,
  AuthRefreshOutcome,
  AuthRefreshReason,
  AuthSessionStatus,
} from '../../shared/auth/constants';
import {
  AuthSessionManager,
  AuthSessionRequestError,
  type AuthTokens,
} from './authSessionManager';
import { ServerRouteContextTracker } from './serverRouteContext';

type TestManagerOptions = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  tokens?: AuthTokens | null;
  timeoutMs?: number;
  getSessionKey?: () => string | null;
  getRefreshUrl?: () => string;
  getRequestHeaders?: () => HeadersInit;
};

function createTestManager(options: TestManagerOptions) {
  let tokens = options.tokens === undefined
    ? { accessToken: 'access-old', refreshToken: 'refresh-old' }
    : options.tokens;
  const saveTokens = vi.fn((nextTokens: AuthTokens) => {
    tokens = nextTokens;
  });
  const onTerminalFailure = vi.fn(() => {
    tokens = null;
  });
  const onLifecycleEvent = vi.fn();
  const onRefreshSuccess = vi.fn();
  const manager = new AuthSessionManager({
    getTokens: () => tokens,
    getSessionKey: options.getSessionKey,
    saveTokens,
    fetch: options.fetch,
    getRefreshUrl: options.getRefreshUrl ?? (() => 'https://server.example/api/auth/refresh'),
    getRequestHeaders: options.getRequestHeaders,
    buildRefreshRequestBody: refreshToken => JSON.stringify({ refreshToken }),
    onTerminalFailure,
    onLifecycleEvent,
    onRefreshSuccess,
    timeoutMs: options.timeoutMs,
  });

  return {
    manager,
    onLifecycleEvent,
    onRefreshSuccess,
    onTerminalFailure,
    saveTokens,
    setTokens(nextTokens: AuthTokens | null) {
      tokens = nextTokens;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AuthSessionManager refresh', () => {
  test('deduplicates concurrent refreshes and rotates both tokens once', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const fetch = vi.fn(() => new Promise<Response>(resolve => {
      resolveFetch = resolve;
    }));
    const testManager = createTestManager({ fetch });

    const first = testManager.manager.refresh('passive');
    const second = testManager.manager.refresh('openclaw-proxy');
    resolveFetch?.(new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(testManager.saveTokens).toHaveBeenCalledOnce();
    expect(firstResult).toMatchObject({
      outcome: AuthRefreshOutcome.Success,
      accessToken: 'access-new',
      joinedRequests: 1,
      reason: 'passive',
    });
    expect(secondResult).toEqual(firstResult);
    expect(testManager.onLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: AuthLifecycleEventType.TokenRefresh,
      outcome: AuthRefreshOutcome.Success,
      joinedRequests: 1,
    }));
  });

  test('treats refresh HTTP 401 without a body as terminal', async () => {
    const testManager = createTestManager({
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
    });

    const result = await testManager.manager.refresh('passive');

    expect(result).toMatchObject({
      outcome: AuthRefreshOutcome.TerminalFailure,
      failureKind: AuthRefreshFailureKind.Rejected,
      httpStatus: 401,
    });
    expect(testManager.onTerminalFailure).toHaveBeenCalledOnce();
  });

  test('treats an explicit refresh-token business error as terminal', async () => {
    const testManager = createTestManager({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: 40101,
        message: 'refresh token expired',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    const result = await testManager.manager.refresh('passive');

    expect(result).toMatchObject({
      outcome: AuthRefreshOutcome.TerminalFailure,
      failureKind: AuthRefreshFailureKind.Rejected,
      errorCode: 40101,
    });
    expect(testManager.onTerminalFailure).toHaveBeenCalledOnce();
  });

  test('treats enterprise membership revocation during refresh as terminal', async () => {
    const testManager = createTestManager({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: 41602,
        message: 'Not an enterprise member',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    const result = await testManager.manager.refresh('proactive');

    expect(result).toMatchObject({
      outcome: AuthRefreshOutcome.TerminalFailure,
      failureKind: AuthRefreshFailureKind.Rejected,
      errorCode: 41602,
    });
    expect(testManager.onTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 41602,
    }));
  });

  test('keeps credentials for refresh 5xx responses', async () => {
    const testManager = createTestManager({
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: 50000,
        message: 'temporary failure',
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    const result = await testManager.manager.refresh('passive');

    expect(result).toMatchObject({
      outcome: AuthRefreshOutcome.TransientFailure,
      failureKind: AuthRefreshFailureKind.Http,
      httpStatus: 503,
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
  });

  test('times out refresh without marking the session expired', async () => {
    vi.useFakeTimers();
    const testManager = createTestManager({
      timeoutMs: 1_000,
      fetch: vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })),
    });

    const refresh = testManager.manager.refresh('passive');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await refresh;

    expect(result).toMatchObject({
      outcome: AuthRefreshOutcome.TransientFailure,
      failureKind: AuthRefreshFailureKind.Timeout,
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
  });

  test('does not restore credentials when logout completes during refresh', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const testManager = createTestManager({
      fetch: vi.fn(() => new Promise<Response>(resolve => {
        resolveFetch = resolve;
      })),
    });

    const refresh = testManager.manager.refresh('passive');
    testManager.setTokens(null);
    resolveFetch?.(new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'access-stale',
        refreshToken: 'refresh-stale',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(refresh).resolves.toMatchObject({
      outcome: AuthRefreshOutcome.NoTokens,
    });
    expect(testManager.saveTokens).not.toHaveBeenCalled();
  });

  test('does not let an old refresh rejection clear a newly established session', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    const testManager = createTestManager({
      fetch: vi.fn(() => new Promise<Response>(resolve => {
        resolveFetch = resolve;
      })),
    });

    const refresh = testManager.manager.refresh('passive');
    testManager.setTokens({
      accessToken: 'access-new-login',
      refreshToken: 'refresh-new-login',
    });
    resolveFetch?.(new Response(JSON.stringify({
      code: 41602,
      message: 'Not an enterprise member',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(refresh).resolves.toMatchObject({
      outcome: AuthRefreshOutcome.Success,
      accessToken: 'access-new-login',
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
    expect(testManager.saveTokens).not.toHaveBeenCalled();
  });

  test('does not let a rejection from an older account generation expire the current account', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    let sessionKey = 'enterprise:6:1001:1';
    const testManager = createTestManager({
      getSessionKey: () => sessionKey,
      fetch: vi.fn(() => new Promise<Response>(resolve => {
        resolveFetch = resolve;
      })),
    });

    const refresh = testManager.manager.refresh('passive');
    sessionKey = 'enterprise:6:1002:2';
    testManager.setTokens({
      accessToken: 'access-enterprise-b',
      refreshToken: 'refresh-enterprise-b',
    });
    resolveFetch?.(new Response(JSON.stringify({
      code: 41602,
      message: 'Not an enterprise member',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(refresh).resolves.toMatchObject({
      outcome: AuthRefreshOutcome.TransientFailure,
      failureKind: AuthRefreshFailureKind.ContextChanged,
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
    expect(testManager.saveTokens).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const refreshResponse = (accessToken: string) => new Response(JSON.stringify({ code: 0,
  data: { accessToken, refreshToken: `refresh-${accessToken}` } }), { headers: { 'Content-Type': 'application/json' } });

describe('authenticated route transitions', () => {
  function routes() {
    const tracker = new ServerRouteContextTracker();
    let url = 'https://a.example';
    let owner = 'owner:1';
    const current = () => tracker.capture(url, owner);
    return {
      getSessionKey: () => `${current().authSessionKey}:${current().routeEpoch}`,
      getRefreshUrl: () => `${url}/api/auth/refresh`,
      switchTo(nextUrl: string, nextOwner = owner) { url = nextUrl; owner = nextOwner; current(); },
    };
  }

  test('cancels an A request before a late 401 can refresh against B', async () => {
    const route = routes();
    const response = deferred<Response>();
    const authFetch = vi.fn();
    const transport = vi.fn((_url: string, _init?: RequestInit) => response.promise);
    const { manager, saveTokens, onTerminalFailure, onLifecycleEvent } = createTestManager({ fetch: authFetch, ...route });
    const request = manager.fetchWithAuth('https://a.example/api/remote/poll', {}, transport);
    const rejected = expect(request).rejects.toMatchObject({ failureKind: AuthRefreshFailureKind.ContextChanged });
    route.switchTo('https://b.example');
    manager.invalidateContext();
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    response.resolve(new Response(null, { status: 401 }));
    await rejected;
    expect(authFetch).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(onLifecycleEvent).not.toHaveBeenCalled();
  });

  test('does not join the first A refresh or let its finally clear the second A refresh', async () => {
    const route = routes();
    const oldResponse = deferred<Response>(), nextResponse = deferred<Response>();
    const fetch = vi.fn().mockImplementationOnce(() => oldResponse.promise).mockImplementationOnce(() => nextResponse.promise);
    const { manager, saveTokens, onLifecycleEvent, onRefreshSuccess } = createTestManager({ fetch, ...route });
    const old = manager.refresh(AuthRefreshReason.Passive);
    route.switchTo('https://b.example'); manager.invalidateContext();
    route.switchTo('https://a.example'); manager.invalidateContext();
    const next = manager.refresh(AuthRefreshReason.Passive);
    expect(fetch).toHaveBeenCalledTimes(2);
    oldResponse.resolve(refreshResponse('stale'));
    await expect(old).resolves.toMatchObject({ outcome: AuthRefreshOutcome.TransientFailure, failureKind: AuthRefreshFailureKind.ContextChanged });
    expect(saveTokens).not.toHaveBeenCalled();
    expect(onLifecycleEvent).not.toHaveBeenCalled();
    const joined = manager.refresh(AuthRefreshReason.Manual);
    expect(fetch).toHaveBeenCalledTimes(2);
    nextResponse.resolve(refreshResponse('current'));
    const results = await Promise.all([next, joined]);
    expect(results[0]).toMatchObject({ outcome: AuthRefreshOutcome.Success, accessToken: 'current', joinedRequests: 1 });
    expect(results[1]).toEqual(results[0]);
    expect(saveTokens).toHaveBeenCalledExactlyOnceWith({ accessToken: 'current', refreshToken: 'refresh-current' });
    expect(onLifecycleEvent).toHaveBeenCalledOnce();
    expect(onRefreshSuccess).toHaveBeenCalledOnce();
  });

  test.each([200, 401])('ignores a refresh body completed after A → B → A (HTTP %s)', async status => {
    const route = routes();
    const body = deferred<unknown>(), reading = deferred<void>();
    const response = new Response(null, { status });
    response.json = () => { reading.resolve(); return body.promise; };
    const { manager, saveTokens, onLifecycleEvent, onTerminalFailure, onRefreshSuccess } = createTestManager({
      fetch: vi.fn(async () => response), ...route,
    });
    const refresh = manager.refresh(AuthRefreshReason.Passive);
    await reading.promise;
    route.switchTo('https://b.example'); manager.invalidateContext();
    route.switchTo('https://a.example'); manager.invalidateContext();
    body.resolve(status === 200 ? { code: 0, data: { accessToken: 'stale', refreshToken: 'stale' } } : { code: 40101 });
    const result = await refresh;
    expect(result).toMatchObject({ outcome: AuthRefreshOutcome.TransientFailure, failureKind: AuthRefreshFailureKind.ContextChanged });
    expect(result).not.toHaveProperty('accessToken');
    expect(saveTokens).not.toHaveBeenCalled();
    expect(onTerminalFailure).not.toHaveBeenCalled();
    expect(onRefreshSuccess).not.toHaveBeenCalled();
    expect(onLifecycleEvent).not.toHaveBeenCalled();
  });

  test('does not turn an obsolete refresh transport failure into a current lifecycle event', async () => {
    const route = routes(), response = deferred<Response>();
    const { manager, onLifecycleEvent, onTerminalFailure } = createTestManager({ fetch: () => response.promise, ...route });
    const refresh = manager.refresh(AuthRefreshReason.Proactive);
    route.switchTo('https://b.example'); manager.invalidateContext();
    await manager.waitForPendingRefresh();
    response.reject(new Error('old network failure'));
    await expect(refresh).resolves.toMatchObject({ failureKind: AuthRefreshFailureKind.ContextChanged });
    expect(onLifecycleEvent).not.toHaveBeenCalled();
    expect(onTerminalFailure).not.toHaveBeenCalled();
  });

  test('checks the effective route even before a route-change notification', async () => {
    let url = 'https://a.example';
    const response = deferred<Response>();
    const { manager, saveTokens } = createTestManager({ fetch: () => response.promise,
      getSessionKey: () => 'same-owner', getRefreshUrl: () => `${url}/api/auth/refresh` });
    const refresh = manager.refresh(AuthRefreshReason.Passive);
    url = 'https://b.example';
    response.resolve(refreshResponse('stale'));
    await expect(refresh).resolves.toMatchObject({ failureKind: AuthRefreshFailureKind.ContextChanged });
    expect(saveTokens).not.toHaveBeenCalled();
  });

  test('freezes account and caller headers for the 401 refresh and retry', async () => {
    let accountHeaders = { 'X-Account': 'first' };
    const callerHeaders = new Headers({ 'X-Request': 'first', 'X-Account': 'caller-override' });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/auth/refresh')) return refreshResponse('current');
      if (new Headers(init?.headers).get('Authorization') === 'Bearer access-old') {
        accountHeaders = { 'X-Account': 'later' }; callerHeaders.set('X-Request', 'later');
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 200 });
    });
    const { manager } = createTestManager({ fetch, getRequestHeaders: () => accountHeaders });
    await manager.fetchWithAuth('https://server.example/api/remote/poll', { headers: callerHeaders });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('X-Account'))).toEqual(['first', 'first', 'first']);
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get('X-Request')).toBe('first');
  });
});

describe('AuthSessionManager authenticated fetch', () => {
  test('recovers concurrent request 401s with one refresh request', async () => {
    let resolveRefresh: ((response: Response) => void) | null = null;
    const fetch = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/api/auth/refresh')) {
        return new Promise<Response>(resolve => {
          resolveRefresh = resolve;
        });
      }
      const authorization = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(new Response(null, {
        status: authorization === 'Bearer access-new' ? 200 : 401,
      }));
    });
    const testManager = createTestManager({ fetch });

    const first = testManager.manager.fetchWithAuth('https://server.example/api/user/profile');
    const second = testManager.manager.fetchWithAuth('https://server.example/api/user/quota');
    await vi.waitFor(() => {
      expect(resolveRefresh).not.toBeNull();
    });
    resolveRefresh?.(new Response(JSON.stringify({
      code: 0,
      data: {
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const refreshCalls = fetch.mock.calls.filter(([url]) => url.endsWith('/api/auth/refresh'));

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(refreshCalls).toHaveLength(1);
  });

  test('retries a stale 401 with a token already refreshed by another request', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === 'Bearer access-old') {
        testManager.setTokens({
          accessToken: 'access-new',
          refreshToken: 'refresh-new',
        });
        return new Response(null, { status: 401 });
      }
      return new Response('ok', { status: 200 });
    });
    const testManager = createTestManager({ fetch });

    const response = await testManager.manager.fetchWithAuth('https://server.example/api/user/profile');

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalledWith(
      'https://server.example/api/auth/refresh',
      expect.anything(),
    );
  });

  test('does not refresh on HTTP 403', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    const testManager = createTestManager({ fetch });

    const response = await testManager.manager.fetchWithAuth('https://server.example/api/user/profile');

    expect(response.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('surfaces refresh network failures as temporarily unavailable', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        throw new Error('network unavailable');
      }
      return new Response(null, { status: 401 });
    });
    const testManager = createTestManager({ fetch });

    await expect(
      testManager.manager.fetchWithAuth('https://server.example/api/user/profile'),
    ).rejects.toMatchObject<AuthSessionRequestError>({
      status: AuthSessionStatus.TemporarilyUnavailable,
      failureKind: AuthRefreshFailureKind.Network,
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
  });
});


describe('authenticated transport isolation', () => {
  test('uses the supplied transport for requests and retries while refresh stays on the auth transport', async () => {
    const authFetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ code: 0, data: { accessToken: 'new', refreshToken: 'refresh-new' } })));
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const authenticated = new Headers(init?.headers).get('Authorization') === 'Bearer new';
      return new Response(JSON.stringify(authenticated ? { code: 0, data: { items: [] } } : { code: 40101 }), {
        status: authenticated ? 200 : 401, headers: { 'Content-Type': 'application/json' },
      });
    });
    const { manager } = createTestManager({ fetch: authFetch });
    const response = await manager.fetchWithAuth('https://server.example/api/remote/poll', {}, transport);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: 0, data: { items: [] } });
    expect(authFetch).toHaveBeenCalledOnce();
    expect(authFetch.mock.calls[0][0]).toContain('/api/auth/refresh');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  test.each(['resolved', 'rejected', 'pending'] as const)('cancels a stale response without waiting for %s cleanup', async cleanup => {
    let session = 'a';
    const authFetch = vi.fn();
    const { manager } = createTestManager({ fetch: authFetch, getSessionKey: () => session });
    const cancel = vi.fn(() => cleanup === 'pending' ? new Promise<void>(() => {})
      : cleanup === 'rejected' ? Promise.reject(new Error('Cleanup unavailable')) : undefined);
    const response = new Response(new ReadableStream({ cancel }));
    await expect(manager.fetchWithAuth('https://server.example/api/remote/poll', {}, async () => {
      session = 'b'; return response;
    })).rejects.toMatchObject({ status: AuthSessionStatus.TemporarilyUnavailable });
    expect(cancel).toHaveBeenCalledOnce();
    expect(authFetch).not.toHaveBeenCalled();
  });
  test('returns a current binary stream without consuming or cloning its body', async () => {
    const authFetch = vi.fn();
    const { manager } = createTestManager({ fetch: authFetch });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(bytes); controller.close();
    });
    const original = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const response = await manager.fetchWithAuth('https://server.example/api/remote/v1/input-assets/asset/content', {}, async () => original);
    expect(response).toBe(original);
    expect(pull).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(authFetch).not.toHaveBeenCalled();
  });
});
