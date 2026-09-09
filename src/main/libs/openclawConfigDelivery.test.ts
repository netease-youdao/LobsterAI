import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import {
  __resetOpenClawConfigDeliveryStateForTests,
  CONFIG_DELIVERY_FALLBACK_REASON_PREFIX,
  DEFERRED_SYNC_REASON_PREFIX,
  deliverOpenClawConfigToGateway,
  isConfigDeliveryFallbackReason,
  mergeDeferredGatewayRestartReason,
  OpenClawConfigDeliveryMode,
  type OpenClawConfigRpcClient,
  OpenClawConfigRpcMethod,
  stripPluginIndexManagedKeysFromRawConfig,
} from './openclawConfigDelivery';

const FILE_CONTENT = '{"models":{"providers":{"p":{"models":[{"id":"m-b"}]}}},"meta":{"lastTouchedVersion":"2026.8.1"}}\n';

type RpcCall = { method: string; params: unknown };

function createClient(handlers: {
  hash?: () => unknown;
  set?: (params: unknown, callIndex: number) => unknown;
}): { client: OpenClawConfigRpcClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let setCalls = 0;
  const client: OpenClawConfigRpcClient = {
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (method === OpenClawConfigRpcMethod.Get) {
        return { hash: handlers.hash ? handlers.hash() : 'hash-1' } as T;
      }
      if (method === OpenClawConfigRpcMethod.Set) {
        setCalls += 1;
        return (handlers.set ? handlers.set(params, setCalls) : { ok: true }) as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, calls };
}

function baseInput(overrides: Partial<Parameters<typeof deliverOpenClawConfigToGateway>[0]> = {}) {
  return {
    reason: 'server-models-updated',
    gatewayPhase: OpenClawEnginePhase.Running,
    readConfigFile: () => FILE_CONTENT,
    ensureRpcClient: async () => null as OpenClawConfigRpcClient | null,
    scheduleDeferredRestart: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  __resetOpenClawConfigDeliveryStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deliverOpenClawConfigToGateway', () => {
  test('running gateway with healthy rpc acks via config.set and schedules no restart', async () => {
    const { client, calls } = createClient({});
    const scheduleDeferredRestart = vi.fn();
    const result = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(result.restartScheduled).toBe(false);
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual([OpenClawConfigRpcMethod.Get, OpenClawConfigRpcMethod.Set]);
    const setParams = calls[1].params as { raw: string; baseHash?: string };
    expect(setParams.raw).toBe(FILE_CONTENT);
    expect(setParams.baseHash).toBe('hash-1');
  });

  test('base hash conflict retries once with a fresh hash and succeeds', async () => {
    vi.useFakeTimers();
    let hashCalls = 0;
    const { client, calls } = createClient({
      hash: () => {
        hashCalls += 1;
        return `hash-${hashCalls}`;
      },
      set: (_params, callIndex) => {
        if (callIndex === 1) {
          throw new Error('INVALID_REQUEST: config changed since last load; re-run config.get and retry');
        }
        return { ok: true };
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const resultPromise = deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(calls.map((call) => call.method)).toEqual([
      OpenClawConfigRpcMethod.Get,
      OpenClawConfigRpcMethod.Set,
      OpenClawConfigRpcMethod.Get,
      OpenClawConfigRpcMethod.Set,
    ]);
    const retryParams = calls[3].params as { baseHash?: string };
    expect(retryParams.baseHash).toBe('hash-2');
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
  });

  test('waits for the watcher-owned hash cache to refresh during a slow Windows reload', async () => {
    vi.useFakeTimers();
    let cachedHash = 'before-model-switch';
    const { client, calls } = createClient({
      hash: () => cachedHash,
      set: (params) => {
        if ((params as { baseHash: string }).baseHash !== 'after-model-switch') {
          throw new Error('config changed since last load; re-run config.get and retry');
        }
        return { ok: true };
      },
    });
    const scheduleDeferredRestart = vi.fn();
    setTimeout(() => { cachedHash = 'after-model-switch'; }, 6_000);
    const resultPromise = deliverOpenClawConfigToGateway(baseInput({
      reason: 'agent-updated',
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(6_000);
    expect(result.restartScheduled).toBe(false);
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
    const writes = calls.filter(call => call.method === OpenClawConfigRpcMethod.Set);
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.at(-1)?.params).toMatchObject({ baseHash: 'after-model-switch' });
  });

  test('hash retries reread the file and preserve changes made during watcher migration', async () => {
    vi.useFakeTimers();
    let raw = FILE_CONTENT;
    const migrated = JSON.stringify({
      ...JSON.parse(FILE_CONTENT),
      agents: { entries: { main: { model: { primary: 'p/m-b' } } } },
      plugins: { entries: { browser: { enabled: true } }, installs: { browser: {} } },
    });
    const { client, calls } = createClient({
      hash: () => raw === FILE_CONTENT ? 'before-migration' : 'after-migration',
      set: (_params, callIndex) => {
        if (callIndex === 1) {
          raw = migrated;
          throw new Error('config changed since last load');
        }
        return { ok: true };
      },
    });
    const resultPromise = deliverOpenClawConfigToGateway(baseInput({
      readConfigFile: () => raw,
      ensureRpcClient: async () => client,
    }));
    await vi.runAllTimersAsync();

    expect((await resultPromise).mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    const lastWrite = calls.filter(call => call.method === OpenClawConfigRpcMethod.Set).at(-1);
    expect(lastWrite?.params).toEqual({
      raw: stripPluginIndexManagedKeysFromRawConfig(migrated),
      baseHash: 'after-migration',
    });
  });

  test('persistent hash conflicts exhaust a bounded wait and schedule one fallback', async () => {
    vi.useFakeTimers();
    const { client } = createClient({
      set: () => { throw new Error('config changed since last load'); },
    });
    const scheduleDeferredRestart = vi.fn();
    const resultPromise = deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(6_000);
    expect(result.elapsedMs).toBeLessThanOrEqual(12_000);
    expect(result.restartScheduled).toBe(true);
    expect(scheduleDeferredRestart).toHaveBeenCalledExactlyOnceWith(
      `${CONFIG_DELIVERY_FALLBACK_REASON_PREFIX}server-models-updated`,
    );
  });

  test('a queued fallback can be satisfied by retrying delivery after the watcher catches up', async () => {
    vi.useFakeTimers();
    let watcherCaughtUp = false;
    const { client } = createClient({
      hash: () => watcherCaughtUp ? 'new-hash' : 'old-hash',
      set: () => {
        if (!watcherCaughtUp) throw new Error('config changed since last load');
        return { ok: true };
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const firstPromise = deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));
    await vi.runAllTimersAsync();
    expect((await firstPromise).restartScheduled).toBe(true);

    watcherCaughtUp = true;
    const recheck = await deliverOpenClawConfigToGateway(baseInput({
      reason: `${DEFERRED_SYNC_REASON_PREFIX}${CONFIG_DELIVERY_FALLBACK_REASON_PREFIX}server-models-updated`,
      ensureRpcClient: async () => client,
      scheduleDeferredRestart: undefined,
    }));
    expect(recheck.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(recheck.restartScheduled).toBe(false);
    expect(scheduleDeferredRestart).toHaveBeenCalledTimes(1);
  });

  test('a failed restart recheck does not requeue itself or consume the restart rate limit', async () => {
    const recheck = await deliverOpenClawConfigToGateway(baseInput({ scheduleDeferredRestart: undefined }));
    expect(recheck.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(recheck.restartScheduled).toBe(false);

    const scheduleDeferredRestart = vi.fn();
    const next = await deliverOpenClawConfigToGateway(baseInput({ scheduleDeferredRestart }));
    expect(next.restartScheduled).toBe(true);
    expect(scheduleDeferredRestart).toHaveBeenCalledTimes(1);
  });

  test('non-hash rpc failure falls back to the deferred restart', async () => {
    const { client } = createClient({
      set: () => {
        throw new Error('socket closed');
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const result = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(result.restartScheduled).toBe(true);
    expect(scheduleDeferredRestart).toHaveBeenCalledWith(
      'config-delivery-fallback:server-models-updated',
    );
  });

  test('second fallback within the rate-limit window does not schedule another restart', async () => {
    const scheduleDeferredRestart = vi.fn();
    let fakeNow = 1_000_000;
    const input = baseInput({
      ensureRpcClient: async () => null,
      scheduleDeferredRestart,
      nowMs: () => fakeNow,
    });

    const first = await deliverOpenClawConfigToGateway(input);
    fakeNow += 60_000;
    const second = await deliverOpenClawConfigToGateway(input);
    fakeNow += 11 * 60_000;
    const third = await deliverOpenClawConfigToGateway(input);

    expect(first.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(first.restartScheduled).toBe(true);
    expect(second.restartScheduled).toBe(false);
    expect(second.detail).toContain('rate-limited');
    expect(third.restartScheduled).toBe(true);
    expect(scheduleDeferredRestart).toHaveBeenCalledTimes(2);
  });

  test('starting gateway still attempts rpc delivery', async () => {
    const { client, calls } = createClient({});
    const ensureRpcClient = vi.fn(async () => client);
    const result = await deliverOpenClawConfigToGateway(baseInput({
      gatewayPhase: OpenClawEnginePhase.Starting,
      ensureRpcClient,
    }));

    expect(ensureRpcClient).toHaveBeenCalledTimes(1);
    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(calls.map((call) => call.method)).toEqual([OpenClawConfigRpcMethod.Get, OpenClawConfigRpcMethod.Set]);
  });

  test('stopped gateway skips delivery without touching the rpc client', async () => {
    const ensureRpcClient = vi.fn(async () => null);
    const scheduleDeferredRestart = vi.fn();
    const result = await deliverOpenClawConfigToGateway(baseInput({
      gatewayPhase: OpenClawEnginePhase.Ready,
      ensureRpcClient,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Skipped);
    expect(ensureRpcClient).not.toHaveBeenCalled();
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
  });

  test('unavailable gateway client falls back with a scheduled restart', async () => {
    const scheduleDeferredRestart = vi.fn();
    const result = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => null,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(result.restartScheduled).toBe(true);
  });

  test('config file read failure and empty content degrade to fallback', async () => {
    const readFailure = await deliverOpenClawConfigToGateway(baseInput({
      readConfigFile: () => {
        throw new Error('ENOENT');
      },
    }));
    expect(readFailure.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(readFailure.detail).toContain('config file read failed');

    __resetOpenClawConfigDeliveryStateForTests();
    const emptyFile = await deliverOpenClawConfigToGateway(baseInput({
      readConfigFile: () => '   ',
    }));
    expect(emptyFile.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(emptyFile.detail).toContain('config file is empty');
  });

  test('config.set payload is the exact file content, never config.get output', async () => {
    const { client, calls } = createClient({
      hash: () => 'hash-x',
    });
    await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
    }));

    const setParams = calls.find((call) => call.method === OpenClawConfigRpcMethod.Set)?.params as { raw: string };
    expect(setParams.raw).toBe(FILE_CONTENT);
    expect(setParams.raw).not.toContain('__OPENCLAW_REDACTED__');
  });

  test('plugins.installs is stripped from the config.set payload, other keys survive', async () => {
    const fileWithInstalls = JSON.stringify({
      plugins: {
        entries: { xai: { enabled: true } },
        allow: ['xai'],
        installs: { xai: { version: '1.0.0' } },
      },
      meta: { lastTouchedVersion: '2026.8.1' },
    });
    const { client, calls } = createClient({});
    const result = await deliverOpenClawConfigToGateway(baseInput({
      readConfigFile: () => fileWithInstalls,
      ensureRpcClient: async () => client,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    const setParams = calls.find((call) => call.method === OpenClawConfigRpcMethod.Set)?.params as { raw: string };
    const sent = JSON.parse(setParams.raw) as {
      plugins: Record<string, unknown>;
      meta: Record<string, unknown>;
    };
    expect(sent.plugins.installs).toBeUndefined();
    expect(sent.plugins.entries).toEqual({ xai: { enabled: true } });
    expect(sent.plugins.allow).toEqual(['xai']);
    expect(sent.meta).toEqual({ lastTouchedVersion: '2026.8.1' });
  });

  test('invalid-config rejection reports rejected mode and never schedules a restart', async () => {
    const { client } = createClient({
      set: () => {
        throw new Error('invalid config: plugins: Unrecognized key: "installs"');
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const result = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rejected);
    expect(result.restartScheduled).toBe(false);
    expect(result.detail).toContain('restart skipped');
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
  });

  test('rejection does not consume the fallback restart rate-limit window', async () => {
    const rejecting = createClient({
      set: () => {
        throw new Error('invalid config: plugins: Unrecognized key: "installs"');
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const rejected = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => rejecting.client,
      scheduleDeferredRestart,
    }));
    const disconnected = createClient({
      set: () => {
        throw new Error('socket closed');
      },
    });
    const fellBack = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => disconnected.client,
      scheduleDeferredRestart,
    }));

    expect(rejected.mode).toBe(OpenClawConfigDeliveryMode.Rejected);
    expect(fellBack.mode).toBe(OpenClawConfigDeliveryMode.Fallback);
    expect(fellBack.restartScheduled).toBe(true);
    expect(scheduleDeferredRestart).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('rejects QA ownership validation failures without restarting (hash retry=%s)', async (retry) => {
    vi.useFakeTimers();
    const cause = 'UNAVAILABLE: Config validation failed: agents.ownership: '
      + 'agents.ownership=explicit cannot be combined with a legacy default=true marker: '
      + 'code=CONFIG_VALIDATION_FAILED';
    const { client, calls } = createClient({
      set: (_params, callIndex) => {
        if (retry && callIndex === 1) {
          throw new Error('INVALID_REQUEST: config changed since last load');
        }
        throw new Error(cause);
      },
    });
    const scheduleDeferredRestart = vi.fn();
    const resultPromise = deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rejected);
    expect(result.restartScheduled).toBe(false);
    expect(result.detail).toContain('agents.ownership');
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
    expect(calls.filter(call => call.method === OpenClawConfigRpcMethod.Set)).toHaveLength(retry ? 2 : 1);
  });
});

describe('deferred gateway restart reasons', () => {
  const fallback = `${CONFIG_DELIVERY_FALLBACK_REASON_PREFIX}agent-updated`;
  const deferredFallback = `${DEFERRED_SYNC_REASON_PREFIX}${fallback}`;
  const imRestart = 'im-config-updated';

  test.each([fallback, deferredFallback])('recognizes only delivery fallback reasons: %s', (reason) => {
    expect(isConfigDeliveryFallbackReason(reason)).toBe(true);
    expect(isConfigDeliveryFallbackReason(imRestart)).toBe(false);
    expect(isConfigDeliveryFallbackReason(`${DEFERRED_SYNC_REASON_PREFIX}${imRestart}`)).toBe(false);
  });

  test.each([fallback, deferredFallback])('keeps a later required restart when delivery originally failed: %s', (reason) => {
    expect(mergeDeferredGatewayRestartReason(reason, imRestart)).toBe(imRestart);
    expect(mergeDeferredGatewayRestartReason(imRestart, reason)).toBe(imRestart);
  });

  test('keeps the original required restart when more changes arrive', () => {
    expect(mergeDeferredGatewayRestartReason(null, fallback)).toBe(fallback);
    expect(mergeDeferredGatewayRestartReason(imRestart, 'plugin-installed')).toBe(imRestart);
  });
});

describe('stripPluginIndexManagedKeysFromRawConfig', () => {
  test('returns non-JSON and installs-free content unchanged', () => {
    expect(stripPluginIndexManagedKeysFromRawConfig('not json {')).toBe('not json {');
    expect(stripPluginIndexManagedKeysFromRawConfig(FILE_CONTENT)).toBe(FILE_CONTENT);
    const noPlugins = '{"gateway":{"mode":"local"}}\n';
    expect(stripPluginIndexManagedKeysFromRawConfig(noPlugins)).toBe(noPlugins);
  });

  test('drops the plugins object entirely when installs was its only key', () => {
    const raw = JSON.stringify({
      plugins: { installs: { xai: { version: '1.0.0' } } },
      gateway: { mode: 'local' },
    });
    const stripped = JSON.parse(stripPluginIndexManagedKeysFromRawConfig(raw)) as Record<string, unknown>;
    expect(stripped.plugins).toBeUndefined();
    expect(stripped.gateway).toEqual({ mode: 'local' });
  });
});
