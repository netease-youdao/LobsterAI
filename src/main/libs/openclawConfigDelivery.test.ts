import { beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import {
  __resetOpenClawConfigDeliveryStateForTests,
  deliverOpenClawConfigToGateway,
  OpenClawConfigDeliveryMode,
  type OpenClawConfigRpcClient,
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
      if (method === 'config.get') {
        return { hash: handlers.hash ? handlers.hash() : 'hash-1' } as T;
      }
      if (method === 'config.set') {
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
    expect(calls.map((call) => call.method)).toEqual(['config.get', 'config.set']);
    const setParams = calls[1].params as { raw: string; baseHash?: string };
    expect(setParams.raw).toBe(FILE_CONTENT);
    expect(setParams.baseHash).toBe('hash-1');
  });

  test('base hash conflict retries once with a fresh hash and succeeds', async () => {
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
    const result = await deliverOpenClawConfigToGateway(baseInput({
      ensureRpcClient: async () => client,
      scheduleDeferredRestart,
    }));

    expect(result.mode).toBe(OpenClawConfigDeliveryMode.Rpc);
    expect(calls.map((call) => call.method)).toEqual([
      'config.get',
      'config.set',
      'config.get',
      'config.set',
    ]);
    const retryParams = calls[3].params as { baseHash?: string };
    expect(retryParams.baseHash).toBe('hash-2');
    expect(scheduleDeferredRestart).not.toHaveBeenCalled();
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
    expect(calls.map((call) => call.method)).toEqual(['config.get', 'config.set']);
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

    const setParams = calls.find((call) => call.method === 'config.set')?.params as { raw: string };
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
    const setParams = calls.find((call) => call.method === 'config.set')?.params as { raw: string };
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
