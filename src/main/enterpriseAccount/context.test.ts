import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  EnterpriseAccountMode,
  EnterpriseApiErrorCode,
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
  EnterpriseQuotaRequestType,
} from '../../shared/enterpriseAccount/constants';
import type { EnterpriseAccountContext } from '../../shared/enterpriseAccount/types';
import type { SqliteStore } from '../sqliteStore';
import {
  buildEnterpriseAccountRequestHeaders,
  fetchEnterpriseAccountContext,
  fetchEnterpriseAccountIdentities,
  getPersistedEnterpriseAccountContext,
  normalizeEnterpriseAccountContext,
  normalizeEnterpriseAccountIdentities,
  persistEnterpriseAccountContext,
  requestEnterpriseQuotaIncrease,
} from './context';

const createStore = (): SqliteStore => {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
  } as unknown as SqliteStore;
};

const createContext = (enterpriseId = 1001): EnterpriseAccountContext => ({
  accountMode: EnterpriseAccountMode.Enterprise,
  enterpriseId,
  memberId: 2001,
  enterpriseName: 'Example Enterprise',
  role: EnterpriseMemberRole.SuperAdmin,
  permissions: {
    manageEnterprise: true,
    adjustMemberQuota: true,
    rechargeEnterprise: true,
  },
  memberQuota: { limit: 100, used: 40, remaining: 60 },
  enterprisePool: { total: 1000, used: 400, remaining: 600 },
  quotaStatus: { available: true, reason: null, errorCode: null },
});

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  {
    status,
    headers: { 'Content-Type': 'application/json' },
  },
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enterprise account context normalization', () => {
  test('normalizes nested context and safe role defaults', () => {
    expect(normalizeEnterpriseAccountContext({
      data: {
        accountMode: EnterpriseAccountMode.Enterprise,
        enterpriseId: '1001',
        memberId: '2001',
        enterpriseName: ' Example Enterprise ',
        role: EnterpriseMemberRole.SuperAdmin,
        memberQuota: { limit: 100, used: 40, remaining: 60 },
        enterprisePool: { total: 1000, used: 400, remaining: 600 },
        quotaStatus: { available: true },
      },
    })).toEqual(createContext());
  });

  test('prefers complete nested context over an incomplete profile summary', () => {
    expect(normalizeEnterpriseAccountContext({
      accountMode: EnterpriseAccountMode.Enterprise,
      enterpriseId: 1001,
      nickname: 'Member',
      enterpriseContext: createContext(),
    })).toEqual(createContext());
  });

  test('preserves optional member quota period metadata', () => {
    const normalized = normalizeEnterpriseAccountContext({
      ...createContext(),
      memberQuota: {
        limit: 100,
        used: 40,
        reserved: 10,
        remaining: 50,
        refreshCycle: 'natural_week',
        periodStart: '2026-08-10T00:00:00+08:00',
        periodEndExclusive: '2026-08-17T00:00:00+08:00',
      },
    });

    expect(normalized?.memberQuota).toEqual({
      limit: 100,
      used: 40,
      reserved: 10,
      remaining: 50,
      refreshCycle: 'natural_week',
      periodStart: '2026-08-10T00:00:00+08:00',
      periodEndExclusive: '2026-08-17T00:00:00+08:00',
    });
  });

  test('ignores invalid optional member quota period metadata', () => {
    const normalized = normalizeEnterpriseAccountContext({
      ...createContext(),
      memberQuota: {
        limit: 100,
        used: 40,
        remaining: 60,
        refreshCycle: 'rolling_week',
        periodStart: 'not-a-date',
        periodEndExclusive: 'also-not-a-date',
      },
    });

    expect(normalized?.memberQuota).toEqual({
      limit: 100,
      used: 40,
      remaining: 60,
    });
  });

  test('ignores stale nested enterprise data when the account is personal', () => {
    expect(normalizeEnterpriseAccountContext({
      accountMode: EnterpriseAccountMode.Personal,
      enterpriseContext: createContext(),
    })).toBeNull();
  });

  test('treats a missing or malformed persisted value as no context', () => {
    const store = createStore();
    expect(getPersistedEnterpriseAccountContext(store)).toBeNull();

    store.set('enterprise_account_context', { enterpriseId: -1 });
    expect(getPersistedEnterpriseAccountContext(store)).toBeNull();
    expect(buildEnterpriseAccountRequestHeaders(null)).toEqual({});
  });

  test('normalizes only valid joined enterprise identities', () => {
    expect(normalizeEnterpriseAccountIdentities({
      enterprises: [
        { enterpriseId: '1001', enterpriseName: 'Enterprise A', role: 'super_admin' },
        { enterpriseId: 1002, enterpriseName: 'Enterprise B', role: 'member' },
        { enterpriseId: -1, enterpriseName: 'Invalid', role: 'member' },
      ],
    })).toEqual([
      { enterpriseId: 1001, enterpriseName: 'Enterprise A', role: 'super_admin' },
      { enterpriseId: 1002, enterpriseName: 'Enterprise B', role: 'member' },
    ]);
  });
});

describe('enterprise account context refresh', () => {
  test('persists a valid context and builds bounded request headers', async () => {
    const store = createStore();
    const context = createContext();
    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async (_url, options) => {
        expect(options?.headers).toEqual({ Accept: 'application/json' });
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        return jsonResponse({ code: 0, data: context });
      },
      store,
    });

    expect(result).toEqual({ success: true, context });
    expect(getPersistedEnterpriseAccountContext(store)).toEqual(context);
    expect(buildEnterpriseAccountRequestHeaders(context)).toEqual({
      'X-LobsterAI-Account-Mode': EnterpriseAccountMode.Enterprise,
      'X-LobsterAI-Enterprise-Id': '1001',
    });
  });

  test('clears persisted context when the server rejects the selected account', async () => {
    const store = createStore();
    const onAccountModeMismatch = vi.fn();
    persistEnterpriseAccountContext(store, createContext());
    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async () => jsonResponse({
        code: String(EnterpriseApiErrorCode.AccountModeMismatch),
        message: 'Account changed',
      }),
      store,
      onAccountModeMismatch,
    });

    expect(result.success).toBe(false);
    expect(result.context).toBeNull();
    expect(getPersistedEnterpriseAccountContext(store)).toBeNull();
    expect(onAccountModeMismatch).toHaveBeenCalledOnce();
  });

  test('reports membership revocation before clearing the selected enterprise context', async () => {
    const store = createStore();
    const onMembershipRevoked = vi.fn(() => {
      expect(getPersistedEnterpriseAccountContext(store)).toEqual(createContext());
    });
    persistEnterpriseAccountContext(store, createContext());

    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async () => jsonResponse({
        code: EnterpriseApiErrorCode.NotMember,
        message: 'Not an enterprise member',
      }),
      store,
      onMembershipRevoked,
    });

    expect(result.success).toBe(false);
    expect(result.context).toBeNull();
    expect(onMembershipRevoked).toHaveBeenCalledOnce();
    expect(getPersistedEnterpriseAccountContext(store)).toBeNull();
  });

  test('does not overwrite a newer account after auth state changes', async () => {
    const store = createStore();
    const currentContext = createContext(2002);
    persistEnterpriseAccountContext(store, currentContext);
    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async () => jsonResponse({ code: 0, data: createContext(1001) }),
      store,
      isRequestCurrent: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.context).toEqual(currentContext);
    expect(getPersistedEnterpriseAccountContext(store)).toEqual(currentContext);
  });

  test('preserves the cached context when an enterprise response is incomplete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore();
    const cachedContext = createContext();
    persistEnterpriseAccountContext(store, cachedContext);
    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async () => jsonResponse({
        code: 0,
        data: {
          accountMode: EnterpriseAccountMode.Enterprise,
          enterpriseId: cachedContext.enterpriseId,
        },
      }),
      store,
    });

    expect(result).toEqual({
      success: false,
      context: cachedContext,
      error: 'Enterprise account context response was incomplete',
    });
    expect(getPersistedEnterpriseAccountContext(store)).toEqual(cachedContext);
  });

  test('times out without discarding the last valid cached context', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore();
    const cachedContext = createContext();
    persistEnterpriseAccountContext(store, cachedContext);
    const result = await fetchEnterpriseAccountContext({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async (_url, options) => new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
      store,
      requestTimeoutMs: 5,
    });

    expect(result).toEqual({
      success: false,
      context: cachedContext,
      error: 'Enterprise account context request timed out',
    });
  });
});

describe('enterprise identity list refresh', () => {
  test('loads all enterprise identities through the authenticated API', async () => {
    const result = await fetchEnterpriseAccountIdentities({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async (url, options) => {
        expect(url).toBe('https://example.test/api/enterprise/identities');
        expect(options?.headers).toEqual({ Accept: 'application/json' });
        return jsonResponse({
          code: 0,
          data: {
            enterprises: [
              { enterpriseId: 1001, enterpriseName: 'Enterprise A', role: 'super_admin' },
              { enterpriseId: 1002, enterpriseName: 'Enterprise B', role: 'member' },
            ],
          },
        });
      },
    });

    expect(result).toEqual({
      success: true,
      identities: [
        { enterpriseId: 1001, enterpriseName: 'Enterprise A', role: 'super_admin' },
        { enterpriseId: 1002, enterpriseName: 'Enterprise B', role: 'member' },
      ],
    });
  });

  test('does not expose identities from a stale auth request', async () => {
    const result = await fetchEnterpriseAccountIdentities({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async () => jsonResponse({
        code: 0,
        data: {
          enterprises: [
            { enterpriseId: 1001, enterpriseName: 'Enterprise A', role: 'super_admin' },
          ],
        },
      }),
      isRequestCurrent: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.identities).toEqual([]);
  });
});

describe('enterprise quota request', () => {
  test('submits a member quota request through the authenticated API', async () => {
    const result = await requestEnterpriseQuotaIncrease({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async (url, options) => {
        expect(url).toBe('https://example.test/api/enterprise/1001/quota-requests');
        expect(options?.method).toBe('POST');
        expect(options?.body).toBe(JSON.stringify({
          requestType: EnterpriseQuotaRequestType.MemberQuota,
        }));
        return jsonResponse({
          code: 0,
          data: {
            requestId: 3001,
            requestType: EnterpriseQuotaRequestType.MemberQuota,
            status: 'pending',
            created: true,
          },
        });
      },
    }, 1001, EnterpriseQuotaRequestType.MemberQuota);

    expect(result).toEqual({
      success: true,
      requestId: 3001,
      requestType: EnterpriseQuotaRequestType.MemberQuota,
      status: 'pending',
      created: true,
    });
  });

  test('rejects invalid IPC parameters before making a network request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchWithAuth = vi.fn();
    const deps = {
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth,
    };

    await expect(requestEnterpriseQuotaIncrease(
      deps,
      -1,
      EnterpriseQuotaRequestType.MemberQuota,
    )).resolves.toEqual({ success: false, error: 'Invalid enterprise ID' });
    await expect(requestEnterpriseQuotaIncrease(
      deps,
      1001,
      'unexpected' as EnterpriseQuotaRequestType,
    )).resolves.toEqual({
      success: false,
      error: 'Invalid enterprise quota request type',
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  test('times out a quota request so the renderer cannot remain stuck submitting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await requestEnterpriseQuotaIncrease({
      getServerBaseUrl: () => 'https://example.test',
      fetchWithAuth: async (_url, options) => new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
      requestTimeoutMs: 5,
    }, 1001, EnterpriseQuotaRequestType.EnterprisePool);

    expect(result).toEqual({
      success: false,
      error: 'Enterprise quota request timed out',
    });
  });

  test('normalizes a blocked quota status from enterprise context', () => {
    expect(normalizeEnterpriseAccountContext({
      accountMode: EnterpriseAccountMode.Enterprise,
      enterpriseId: 1001,
      memberId: 2001,
      enterpriseName: 'Example Enterprise',
      role: EnterpriseMemberRole.Member,
      memberQuota: { limit: 100, used: 100, remaining: 0 },
      enterprisePool: { total: 1000, used: 1000, remaining: 0 },
      quotaStatus: {
        available: false,
        reason: EnterpriseQuotaReason.EnterprisePoolExhausted,
        errorCode: EnterpriseApiErrorCode.EnterprisePoolExhausted,
      },
    })?.quotaStatus).toEqual({
      available: false,
      reason: EnterpriseQuotaReason.EnterprisePoolExhausted,
      errorCode: EnterpriseApiErrorCode.EnterprisePoolExhausted,
    });
  });
});
