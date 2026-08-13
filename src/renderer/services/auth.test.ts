import {
  type AuthSessionChangedEvent,
  AuthSessionChangeReason,
  AuthSessionStatus,
} from '@shared/auth/constants';
import { LobsterAIRequestCapability, ProviderName } from '@shared/providers';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
} from '../../shared/enterpriseAccount/constants';
import type { EnterpriseAccountContext } from '../../shared/enterpriseAccount/types';
import { setEnterpriseAccountContext } from '../features/enterpriseAccount/enterpriseAccountSlice';
import { store } from '../store';
import { setLoggedIn, setLoggedOut } from '../store/slices/authSlice';
import { clearServerModels } from '../store/slices/modelSlice';
import {
  authService,
  isAuthAccountRequestCurrent,
  mapAvailableServerModelsToModels,
  mapPricingCatalogTextModelsToServerModels,
  mapPricingCatalogToPublicServerModels,
} from './auth';
import { i18nService } from './i18n';

afterEach(() => {
  authService.destroy();
  store.dispatch(setLoggedOut());
  store.dispatch(clearServerModels());
  store.dispatch(setEnterpriseAccountContext(null));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  i18nService.setLanguage('zh', { persist: false });
});

describe('pricing catalog model mapping', () => {
  test('maps public text models to locked server models', () => {
    const [model] = mapPricingCatalogTextModelsToServerModels([
      {
        modelId: 'qwen3.7-plus',
        modelName: 'Qwen3.7-Plus',
        provider: 'LobsterAI',
        providerLabel: 'LobsterAI Plan',
        description: 'Strong multimodal model',
        supportsImage: true,
        supportsThinking: true,
        thinkingConfig: {
          options: [
            { level: 'off', openclawLevel: 'off' },
            { level: 'high', openclawLevel: 'high' },
            { level: 'max', openclawLevel: 'xhigh' },
          ],
          defaultLevel: 'high',
        },
        contextWindow: 1_000_000,
        costMultiplier: 1.6,
      },
    ]);

    expect(model).toMatchObject({
      id: 'qwen3.7-plus',
      name: 'Qwen3.7-Plus',
      provider: 'LobsterAI Plan',
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      accessible: false,
      description: 'Strong multimodal model',
      supportsImage: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      contextWindow: 1_000_000,
      costMultiplier: 1.6,
    });
  });

  test('maps only textModels from the pricing catalog', () => {
    const models = mapPricingCatalogToPublicServerModels({
      textModels: [
        {
          modelId: 'MiniMax-M3',
          modelName: 'MiniMax M3',
        },
      ],
      imageModels: [
        {
          modelId: 'image-01',
          modelName: 'MiniMax-Image-01',
        },
      ],
      videoModels: [
        {
          modelId: 'happyhorse-1.0-i2v',
          modelName: 'HappyHorse',
        },
      ],
    });

    expect(models.map(model => model.id)).toEqual(['MiniMax-M3']);
    expect(models[0].accessible).toBe(false);
  });
});

describe('authenticated server model mapping', () => {
  test('preserves K3 runtime, modality, token, and agentic metadata', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'kimi-k3-YoudaoInner',
      modelName: 'Kimi K3',
      provider: 'moonshot',
      apiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
      supportsToolCalling: true,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      accessible: true,
    }]);

    expect(model).toMatchObject({
      id: 'kimi-k3-YoudaoInner',
      providerKey: ProviderName.LobsteraiServer,
      isServerModel: true,
      serverApiFormat: 'openai',
      runtimeProfile: 'moonshot-kimi-k3',
      supportsImage: true,
      supportsVideo: true,
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
          { level: 'max', openclawLevel: 'xhigh' },
        ],
        defaultLevel: 'high',
      },
      requestCapabilities: [LobsterAIRequestCapability.OptionsV1],
      supportsToolCalling: true,
      agenticReady: false,
      contextWindow: 1_048_576,
      maxTokens: 8_192,
      accessible: true,
    });
  });

  test('ignores malformed thinking configuration without hiding the model', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      provider: 'LobsterAI',
      apiFormat: 'openai',
      supportsThinking: true,
      thinkingConfig: {
        options: [
          { level: 'off', openclawLevel: 'off' },
          { level: 'high', openclawLevel: 'high' },
        ],
        defaultLevel: 'max',
      },
    }]);

    expect(model.id).toBe('deepseek-v4-flash');
    expect(model.supportsThinking).toBe(true);
    expect(model.thinkingConfig).toBeUndefined();
  });

  test('filters unknown request capabilities from the server response', () => {
    const [model] = mapAvailableServerModelsToModels([{
      modelId: 'capability-test',
      modelName: 'Capability Test',
      provider: 'LobsterAI',
      apiFormat: 'openai',
      requestCapabilities: [
        LobsterAIRequestCapability.OptionsV1,
        'future-unknown-capability',
      ],
    }]);

    expect(model.requestCapabilities).toEqual([LobsterAIRequestCapability.OptionsV1]);
  });
});

describe('auth-scoped renderer requests', () => {
  test('rejects late model, profile, and public-catalog responses after auth changes', () => {
    const personalA = {
      isLoggedIn: true,
      ownerAccountKey: 'personal:6',
      accountGeneration: 3,
    };

    expect(isAuthAccountRequestCurrent(personalA, { ...personalA })).toBe(true);
    expect(isAuthAccountRequestCurrent(personalA, {
      isLoggedIn: true,
      ownerAccountKey: 'enterprise:6:1001',
      accountGeneration: 4,
    })).toBe(false);
    expect(isAuthAccountRequestCurrent({
      isLoggedIn: false,
      ownerAccountKey: null,
      accountGeneration: 4,
    }, personalA)).toBe(false);
  });

  test('clears the previous renderer account when a committed exchange lacks a stable owner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electron: {
        auth: {
          exchange: vi.fn().mockResolvedValue({
            success: true,
            user: {
              yid: 'enterprise-user',
              accountMode: 'enterprise',
              nickname: 'Enterprise User',
              avatarUrl: null,
            },
            quota: null,
            enterpriseContext: null,
          }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'previous-user',
        nickname: 'Previous User',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:previous-user',
    }));

    await expect(authService.handleCallback('auth-code')).resolves.toBe(false);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: false,
      ownerAccountKey: null,
      user: null,
      quota: null,
    });
  });
});

describe('login diagnostics', () => {
  test('persists renderer lifecycle logs without including the login URL', async () => {
    const fromRenderer = vi.fn();
    const loginResult = {
      success: true,
      redirectUrl: 'https://lobsterai.youdao.com/portal#/login?source=electron',
    };
    const login = vi.fn().mockResolvedValue(loginResult);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electron: {
        api: {
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            data: { data: { value: 'https://lobsterai.youdao.com/portal#/login' } },
          }),
        },
        auth: { login },
        log: { fromRenderer },
      },
    });

    await expect(authService.login()).resolves.toEqual(loginResult);

    expect(login).toHaveBeenCalledWith(
      'https://c.youdao.com/dict/hardware/octopus/lobsterai-portal-subscription.html#/login',
    );
    expect(fromRenderer).toHaveBeenCalledWith(
      'info',
      'AuthService',
      expect.stringMatching(/^login attempt \d+ started$/),
    );
    expect(fromRenderer).toHaveBeenCalledWith(
      'info',
      'AuthService',
      expect.stringMatching(/^login attempt \d+ handed off to the system browser$/),
    );
    expect(fromRenderer.mock.calls.flat().join(' ')).not.toContain('lobsterai.youdao.com');
  });

  test('returns the IPC failure result without throwing and records a warning', async () => {
    const fromRenderer = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('window', {
      electron: {
        api: {
          fetch: vi.fn().mockResolvedValue({
            ok: true,
            data: { data: { value: 'https://lobsterai.youdao.com/portal#/login' } },
          }),
        },
        auth: { login: vi.fn().mockResolvedValue({ success: false, error: 'open failed' }) },
        log: { fromRenderer },
      },
    });

    await expect(authService.login()).resolves.toEqual({
      success: false,
      error: 'open failed',
    });

    expect(fromRenderer).toHaveBeenCalledWith(
      'warn',
      'AuthService',
      expect.stringMatching(/^login attempt \d+ could not open the system browser$/),
    );
  });
});

describe('quota checks', () => {
  test('returns a failure without issuing IPC requests when logged out', async () => {
    const getQuota = vi.fn();
    vi.stubGlobal('window', {
      electron: {
        auth: { getQuota },
        log: { fromRenderer: vi.fn() },
      },
    });

    await expect(authService.checkQuota()).resolves.toEqual({
      success: false,
      enterpriseQuotaAvailable: false,
    });
    expect(getQuota).not.toHaveBeenCalled();
  });

  test('refreshes quota, profile summary, and server model accessibility together', async () => {
    const getQuota = vi.fn().mockResolvedValue({
      success: true,
      quota: {
        planName: 'Enterprise',
        subscriptionStatus: 'active',
        creditsLimit: 100,
        creditsUsed: 10,
        creditsRemaining: 90,
      },
      enterpriseContext: null,
    });
    const getProfileSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        id: 1,
        nickname: 'Tester',
        avatarUrl: null,
        totalCreditsRemaining: 90,
        creditItems: [],
      },
    });
    const getModels = vi.fn().mockResolvedValue({
      success: true,
      models: [{
        modelId: 'qwen3.7-plus',
        modelName: 'Qwen3.7 Plus',
        provider: 'LobsterAI',
        apiFormat: 'openai',
        accessible: true,
      }],
    });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary,
          getModels,
        },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:tester',
    }));

    await expect(authService.checkQuota()).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: true,
    });

    expect(getQuota).toHaveBeenCalledOnce();
    expect(getProfileSummary).toHaveBeenCalledOnce();
    expect(getModels).toHaveBeenCalledOnce();
    expect(store.getState().auth.quota?.creditsRemaining).toBe(90);
    expect(store.getState().model.availableModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'qwen3.7-plus',
        providerKey: ProviderName.LobsteraiServer,
        accessible: true,
      }),
    ]));
  });

  test('shares concurrent quota checks to avoid duplicate IPC requests', async () => {
    let resolveQuota: ((value: {
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }) => void) | undefined;
    const quotaResponse = new Promise<{
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }>((resolve) => {
      resolveQuota = resolve;
    });
    const getQuota = vi.fn().mockReturnValue(quotaResponse);
    const getProfileSummary = vi.fn().mockResolvedValue({ success: true, data: null });
    const getModels = vi.fn().mockResolvedValue({ success: true, models: [] });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary,
          getModels,
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'personal:tester',
    }));

    const firstCheck = authService.checkQuota();
    const secondCheck = authService.checkQuota();
    resolveQuota?.({
      success: true,
      quota: null,
      enterpriseContext: null,
    });

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual([
      { success: true, enterpriseQuotaAvailable: true },
      { success: true, enterpriseQuotaAvailable: true },
    ]);
    expect(getQuota).toHaveBeenCalledOnce();
    expect(getProfileSummary).toHaveBeenCalledOnce();
    expect(getModels).toHaveBeenCalledOnce();
  });

  test('does not join a quota check started by a previous account', async () => {
    let resolveFirstQuota!: (value: {
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }) => void;
    const firstQuotaResponse = new Promise<{
      success: boolean;
      quota: null;
      enterpriseContext: null;
    }>(resolve => {
      resolveFirstQuota = resolve;
    });
    const getQuota = vi.fn()
      .mockReturnValueOnce(firstQuotaResponse)
      .mockResolvedValueOnce({
        success: true,
        quota: null,
        enterpriseContext: null,
      });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary: vi.fn().mockResolvedValue({ success: true, data: null }),
          getModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: { yid: 'first', nickname: 'First', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'personal:first',
    }));

    const firstCheck = authService.checkQuota();
    store.dispatch(setLoggedIn({
      user: { yid: 'second', nickname: 'Second', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'personal:second',
    }));
    const secondCheck = authService.checkQuota();

    await expect(secondCheck).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    expect(getQuota).toHaveBeenCalledTimes(2);

    resolveFirstQuota({ success: true, quota: null, enterpriseContext: null });
    await expect(firstCheck).resolves.toEqual({
      success: false,
      enterpriseQuotaAvailable: false,
    });
  });

  test('reports the refreshed enterprise quota as unavailable', async () => {
    const getQuota = vi.fn().mockResolvedValue({
      success: true,
      quota: null,
      enterpriseContext: {
        accountMode: 'enterprise',
        enterpriseId: 1001,
        memberId: 2001,
        enterpriseName: 'Example enterprise',
        role: EnterpriseMemberRole.Member,
        permissions: {
          manageEnterprise: false,
          adjustMemberQuota: false,
          rechargeEnterprise: false,
        },
        memberQuota: { limit: 100, used: 100, remaining: 0 },
        enterprisePool: { total: 1000, used: 400, remaining: 600 },
        quotaStatus: {
          available: false,
          reason: EnterpriseQuotaReason.MemberMonthlyQuotaExhausted,
          errorCode: 41606,
        },
      },
    });
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getQuota,
          getProfileSummary: vi.fn(),
          getModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
        },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user: {
        yid: 'tester',
        nickname: 'Tester',
        avatarUrl: null,
      },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));

    await expect(authService.checkQuota()).resolves.toEqual({
      success: true,
      enterpriseQuotaAvailable: false,
    });
    expect(store.getState().enterpriseAccount.context?.quotaStatus.reason)
      .toBe(EnterpriseQuotaReason.MemberMonthlyQuotaExhausted);
  });
});

describe('enterprise quota period boundary refresh', () => {
  const context = (endExclusive: string): EnterpriseAccountContext => ({
    accountMode: 'enterprise',
    enterpriseId: 1001,
    memberId: 2001,
    enterpriseName: 'Example enterprise',
    role: EnterpriseMemberRole.Member,
    permissions: {
      manageEnterprise: false,
      adjustMemberQuota: false,
      rechargeEnterprise: false,
    },
    memberQuota: {
      limit: 100,
      used: 100,
      remaining: 0,
      refreshCycle: 'natural_week',
      periodStart: '2026-08-10T00:00:00+08:00',
      periodEndExclusive: endExclusive,
    },
    enterprisePool: { total: 1000, used: 400, remaining: 600 },
    quotaStatus: {
      available: false,
      reason: EnterpriseQuotaReason.MemberMonthlyQuotaExhausted,
      errorCode: 41606,
    },
  });

  test('checks quota once after the current period boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T23:59:58+08:00'));
    store.dispatch(setLoggedIn({
      user: { yid: 'tester', nickname: 'Tester', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));
    const enterpriseContext = context('2026-08-17T00:00:00+08:00');
    store.dispatch(setEnterpriseAccountContext(enterpriseContext));
    const quotaSpy = vi.spyOn(authService, 'checkQuota').mockResolvedValue({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    const boundaryService = authService as unknown as {
      scheduleEnterpriseQuotaBoundary: (
        value: EnterpriseAccountContext | null,
      ) => void;
    };

    boundaryService.scheduleEnterpriseQuotaBoundary(enterpriseContext);
    await vi.advanceTimersByTimeAsync(3_001);

    expect(quotaSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(quotaSpy).toHaveBeenCalledOnce();
  });

  test('clears the old boundary timer when enterprise context is removed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T23:59:58+08:00'));
    store.dispatch(setLoggedIn({
      user: { yid: 'tester', nickname: 'Tester', avatarUrl: null },
      quota: null,
      ownerAccountKey: 'enterprise:tester:1001',
    }));
    const enterpriseContext = context('2026-08-17T00:00:00+08:00');
    store.dispatch(setEnterpriseAccountContext(enterpriseContext));
    const quotaSpy = vi.spyOn(authService, 'checkQuota').mockResolvedValue({
      success: true,
      enterpriseQuotaAvailable: true,
    });
    const boundaryService = authService as unknown as {
      scheduleEnterpriseQuotaBoundary: (
        value: EnterpriseAccountContext | null,
      ) => void;
    };

    boundaryService.scheduleEnterpriseQuotaBoundary(enterpriseContext);
    boundaryService.scheduleEnterpriseQuotaBoundary(null);
    store.dispatch(setEnterpriseAccountContext(null));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(quotaSpy).not.toHaveBeenCalled();
  });
});

describe('auth state restoration', () => {
  const user = {
    yid: 'user@example.com',
    nickname: 'Lobster User',
    avatarUrl: null,
  };
  const quota = {
    planName: '专业',
    subscriptionStatus: 'active',
    creditsLimit: 1_000,
    creditsUsed: 100,
    creditsRemaining: 900,
  };

  test('preserves the current login snapshot for a temporary verification failure', async () => {
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: false,
            status: AuthSessionStatus.TemporarilyUnavailable,
            hasCredentials: true,
            cachedUser: user,
          }),
        },
      },
    });

    const result = await authService.refreshAuthState({ clearOnFailure: true });

    expect(result.isLoggedIn).toBe(true);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: true,
      sessionStatus: AuthSessionStatus.TemporarilyUnavailable,
      user,
      quota,
    });
  });

  test('clears the current login snapshot for terminal expiration', async () => {
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: false,
            status: AuthSessionStatus.Expired,
            hasCredentials: false,
          }),
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const result = await authService.refreshAuthState({ clearOnFailure: true });

    expect(result.isLoggedIn).toBe(false);
    expect(store.getState().auth).toMatchObject({
      isLoggedIn: false,
      sessionStatus: AuthSessionStatus.Expired,
      user: null,
      quota: null,
    });
  });

  test('shows a re-login toast when the main process reports terminal expiration', async () => {
    const dispatchEvent = vi.fn();
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      dispatchEvent,
      electron: {
        auth: {
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const serviceWithSessionHandler = authService as unknown as {
      handleSessionChanged: (event: AuthSessionChangedEvent) => Promise<void>;
    };
    await serviceWithSessionHandler.handleSessionChanged({
      status: AuthSessionStatus.Expired,
      reason: AuthSessionChangeReason.RefreshRejected,
    });

    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.Expired);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const toastEvent = dispatchEvent.mock.calls[0][0] as CustomEvent<string>;
    expect(toastEvent.type).toBe('app:showToast');
    expect(toastEvent.detail).toContain('登录状态已过期');
  });

  test('shows the dedicated signed-out toast when enterprise membership is revoked', async () => {
    const dispatchEvent = vi.fn();
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'enterprise:user@example.com:1001',
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('window', {
      dispatchEvent,
      electron: {
        auth: {
          getPricingCatalog: vi.fn().mockResolvedValue({
            success: true,
            textModels: [],
          }),
        },
      },
    });

    const serviceWithSessionHandler = authService as unknown as {
      handleSessionChanged: (event: AuthSessionChangedEvent) => Promise<void>;
    };
    await serviceWithSessionHandler.handleSessionChanged({
      status: AuthSessionStatus.Expired,
      reason: AuthSessionChangeReason.EnterpriseMembershipRevoked,
    });

    expect(store.getState().auth.sessionStatus).toBe(AuthSessionStatus.Expired);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const toastEvent = dispatchEvent.mock.calls[0][0] as CustomEvent<string>;
    expect(toastEvent.type).toBe('app:showToast');
    expect(toastEvent.detail).toBe('你已被移出当前团队，已退出登录。请重新登录并选择可用身份。');
  });

  test('provides the enterprise membership revocation message in English', () => {
    i18nService.setLanguage('en', { persist: false });

    expect(i18nService.t('coworkErrorEnterpriseMembershipRevoked')).toBe(
      'You have been removed from the current team and signed out. '
      + 'Sign in again to choose an available identity.',
    );
  });

  test('discards a stale restore response after the renderer account changes', async () => {
    let resolveUser!: (value: {
      success: true;
      user: typeof user;
      quota: typeof quota;
      enterpriseContext: null;
    }) => void;
    const getUser = vi.fn(() => new Promise<{
      success: true;
      user: typeof user;
      quota: typeof quota;
      enterpriseContext: null;
    }>(resolve => {
      resolveUser = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: { getUser },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));

    const refresh = authService.refreshAuthState({ clearOnFailure: true });
    const nextUser = {
      ...user,
      yid: 'next@example.com',
      nickname: 'Next User',
    };
    store.dispatch(setLoggedIn({
      user: nextUser,
      quota: null,
      ownerAccountKey: 'personal:next@example.com',
    }));
    resolveUser({
      success: true,
      user,
      quota,
      enterpriseContext: null,
    });

    await expect(refresh).resolves.toMatchObject({
      isLoggedIn: true,
      user: nextUser,
      quota: null,
    });
    expect(store.getState().auth.ownerAccountKey).toBe('personal:next@example.com');
  });

  test('does not apply a stale enterprise context after the renderer account changes', async () => {
    let resolveContext!: (value: {
      success: true;
      context: {
        enterpriseId: number;
        enterpriseName: string;
        role: EnterpriseMemberRole;
        quotaStatus: {
          available: true;
          reason: null;
        };
      };
    }) => void;
    const getContext = vi.fn(() => new Promise<{
      success: true;
      context: {
        enterpriseId: number;
        enterpriseName: string;
        role: EnterpriseMemberRole;
        quotaStatus: {
          available: true;
          reason: null;
        };
      };
    }>(resolve => {
      resolveContext = resolve;
    }));
    vi.stubGlobal('window', {
      electron: {
        auth: {
          getUser: vi.fn().mockResolvedValue({
            success: true,
            user,
            quota,
          }),
        },
        enterpriseAccount: { getContext },
        log: { fromRenderer: vi.fn() },
      },
    });
    store.dispatch(setLoggedIn({
      user,
      quota,
      ownerAccountKey: 'personal:user@example.com',
    }));

    const refresh = authService.refreshAuthState({ clearOnFailure: true });
    await vi.waitFor(() => expect(getContext).toHaveBeenCalledOnce());
    const nextUser = {
      ...user,
      yid: 'next@example.com',
      nickname: 'Next User',
    };
    store.dispatch(setLoggedIn({
      user: nextUser,
      quota: null,
      ownerAccountKey: 'personal:next@example.com',
    }));
    resolveContext({
      success: true,
      context: {
        enterpriseId: 1001,
        enterpriseName: 'Stale Enterprise',
        role: EnterpriseMemberRole.Member,
        quotaStatus: {
          available: true,
          reason: null,
        },
      },
    });

    await expect(refresh).resolves.toMatchObject({
      isLoggedIn: true,
      user: nextUser,
      quota: null,
      enterpriseContext: null,
    });
    expect(store.getState().enterpriseAccount.context).toBeNull();
    expect(store.getState().auth.ownerAccountKey).toBe('personal:next@example.com');
  });
});
