import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  AuthLifecycleEventType,
  AuthRefreshFailureKind,
  AuthRefreshOutcome,
  AuthSessionStatus,
} from '../../shared/auth/constants';
import {
  AuthSessionManager,
  AuthSessionRequestError,
  type AuthTokens,
} from './authSessionManager';

type TestManagerOptions = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  tokens?: AuthTokens | null;
  timeoutMs?: number;
  getSessionKey?: () => string | null;
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
  const manager = new AuthSessionManager({
    getTokens: () => tokens,
    getSessionKey: options.getSessionKey,
    saveTokens,
    fetch: options.fetch,
    getRefreshUrl: () => 'https://server.example/api/auth/refresh',
    buildRefreshRequestBody: refreshToken => JSON.stringify({ refreshToken }),
    onTerminalFailure,
    onLifecycleEvent,
    timeoutMs: options.timeoutMs,
  });

  return {
    manager,
    onLifecycleEvent,
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
      outcome: AuthRefreshOutcome.Success,
      accessToken: 'access-enterprise-b',
    });
    expect(testManager.onTerminalFailure).not.toHaveBeenCalled();
    expect(testManager.saveTokens).not.toHaveBeenCalled();
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
