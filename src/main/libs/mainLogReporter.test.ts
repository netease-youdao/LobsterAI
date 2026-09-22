import { describe, expect, test, vi } from 'vitest';

import {
  LogReporterAction,
  LogReporterStoreKey,
} from '../../shared/analytics/constants';
import { buildMainLogUrl, MainLogReporter } from './mainLogReporter';

const createStore = (initial: Record<string, unknown> = {}) => {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    set: <T>(key: string, value: T): void => {
      values.set(key, value);
    },
    values,
  };
};

describe('MainLogReporter', () => {
  test('builds an analyzer URL with fixed common parameters', () => {
    const result = new URL(buildMainLogUrl({
      action: LogReporterAction.ImPromptSubmit,
      _npid: 'unexpected-product',
      platform: 'telegram',
    }, {
      appVersion: '2026.7.31',
      arch: 'arm64',
      firstKeyfrom: 'official',
      installationId: 'installation-1',
      language: 'zh',
      latestKeyfrom: 'campaign',
      platform: 'darwin',
      timestamp: 1234,
      userId: 'user-1',
    }));

    expect(result.searchParams.get('action')).toBe('lobsterai_im_prompt_submit');
    expect(result.searchParams.get('_npid')).toBe('wisdom');
    expect(result.searchParams.get('_ncat')).toBe('actions');
    expect(result.searchParams.get('platform')).toBe('telegram');
    expect(result.searchParams.get('app_version')).toBe('2026.7.31');
    expect(result.searchParams.get('os_platform')).toBe('darwin');
    expect(result.searchParams.get('os_arch')).toBe('arm64');
    expect(result.searchParams.get('language')).toBe('zh');
    expect(result.searchParams.get('uuid')).toBe('installation-1');
    expect(result.searchParams.get('firstKeyfrom')).toBe('official');
    expect(result.searchParams.get('latestKeyfrom')).toBe('campaign');
    expect(result.searchParams.get('keyfrom')).toBe('campaign');
    expect(result.searchParams.get('is_logged_in')).toBe('true');
    expect(result.searchParams.get('log_Usid')).toBe('user-1');
    expect(result.searchParams.get('user_id')).toBe('user-1');
    expect(result.searchParams.get('uts')).toBe('1234');
  });

  test('skips sending without creating an installation id when analytics is disabled', async () => {
    const store = createStore({
      [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: false },
    });
    const fetch = vi.fn();
    const reporter = new MainLogReporter({
      appVersion: '1.0.0',
      createInstallationId: () => 'new-installation',
      fetch,
      store,
    });

    await expect(reporter.report({ action: LogReporterAction.ImPromptSubmit })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.values.has(LogReporterStoreKey.InstallationUuid)).toBe(false);
  });

  test('sends a main-process event with persisted attribution context', async () => {
    const store = createStore({
      // Legacy app_config rows do not contain usageAnalyticsEnabled and remain opted in.
      [LogReporterStoreKey.AppConfig]: { language: 'en' },
      [LogReporterStoreKey.AuthUser]: { yid: 'user-2' },
      [LogReporterStoreKey.InstallationUuid]: 'installation-2',
      'keyfrom.attribution.v1': {
        firstKeyfrom: 'official',
        latestKeyfrom: 'partner',
        updatedAt: 1,
      },
    });
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const reporter = new MainLogReporter({
      appVersion: '2.0.0',
      arch: 'x64',
      fetch,
      now: () => 5678,
      platform: 'win32',
      store,
    });

    await expect(reporter.report({
      action: LogReporterAction.ImPromptSubmit,
      source: 'openclaw_channel',
      platform: 'feishu',
    })).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledOnce();
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('source')).toBe('openclaw_channel');
    expect(url.searchParams.get('platform')).toBe('feishu');
    expect(url.searchParams.get('uuid')).toBe('installation-2');
    expect(url.searchParams.get('log_Usid')).toBe('user-2');
    expect(url.searchParams.get('user_id')).toBe('user-2');
    expect(url.searchParams.get('latestKeyfrom')).toBe('partner');
    expect(url.searchParams.get('keyfrom')).toBe('partner');
  });

  test('returns false when the analyzer request fails', async () => {
    const store = createStore({
      [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: true },
    });
    const reporter = new MainLogReporter({
      appVersion: '1.0.0',
      createInstallationId: () => 'installation-3',
      fetch: vi.fn().mockRejectedValue(new Error('network unavailable')),
      store,
    });

    await expect(reporter.report({ action: LogReporterAction.ImPromptSubmit })).resolves.toBe(false);
  });

  test('aborts a request that exceeds the configured timeout', async () => {
    vi.useFakeTimers();
    const store = createStore({
      [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: true },
    });
    const fetch = vi.fn((_url: string, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    const reporter = new MainLogReporter({
      appVersion: '1.0.0',
      createInstallationId: () => 'installation-4',
      fetch,
      requestTimeoutMs: 25,
      store,
    });

    try {
      const result = reporter.report({ action: LogReporterAction.ImPromptSubmit });
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toBe(false);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('fails closed when the analytics setting cannot be read', async () => {
    const store = {
      get: vi.fn(() => {
        throw new Error('store unavailable');
      }),
      set: vi.fn(),
    };
    const fetch = vi.fn();
    const reporter = new MainLogReporter({
      appVersion: '1.0.0',
      fetch,
      store,
    });

    await expect(reporter.report({ action: LogReporterAction.ImPromptSubmit })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(store.set).not.toHaveBeenCalled();
  });

  test('skips excess requests without growing the in-flight request set', async () => {
    const store = createStore({
      [LogReporterStoreKey.AppConfig]: { usageAnalyticsEnabled: true },
    });
    let finishRequest: ((response: { ok: boolean; status: number }) => void) | null = null;
    const fetch = vi.fn(() => new Promise<{ ok: boolean; status: number }>((resolve) => {
      finishRequest = resolve;
    }));
    const reporter = new MainLogReporter({
      appVersion: '1.0.0',
      createInstallationId: () => 'installation-5',
      fetch,
      maxConcurrentRequests: 1,
      store,
    });

    const firstRequest = reporter.report({ action: LogReporterAction.ImPromptSubmit });
    await expect(reporter.report({ action: LogReporterAction.ImPromptSubmit })).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledOnce();

    if (!finishRequest) throw new Error('request did not start');
    finishRequest({ ok: true, status: 200 });
    await expect(firstRequest).resolves.toBe(true);
  });
});
