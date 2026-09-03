import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

import {
  buildOpenClawCompileCacheEnv,
  buildOpenClawGatewayExecArgv,
  isOpenClawConfigStartupFailure,
  isOpenClawGatewayHeapOutOfMemory,
  probeOpenClawGatewayStartup,
} from './openclawEngineManager';

describe('buildOpenClawCompileCacheEnv', () => {
  test('prevents the packaged launcher from respawning Electron Helper', () => {
    expect(buildOpenClawCompileCacheEnv('/tmp/openclaw-cache')).toEqual({
      NODE_COMPILE_CACHE: '/tmp/openclaw-cache',
      OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1',
    });
  });
});

describe('buildOpenClawGatewayExecArgv', () => {
  test('adds a gateway heap limit when NODE_OPTIONS is empty', () => {
    expect(buildOpenClawGatewayExecArgv(undefined)).toEqual(['--max-old-space-size=4096']);
  });

  test('adds a gateway heap limit alongside unrelated NODE_OPTIONS', () => {
    expect(buildOpenClawGatewayExecArgv('--trace-warnings')).toEqual(['--max-old-space-size=4096']);
  });

  test('respects an existing max old space setting with equals syntax', () => {
    expect(buildOpenClawGatewayExecArgv('--max-old-space-size=8192 --trace-warnings')).toEqual([]);
  });

  test('respects an existing max old space setting with space syntax', () => {
    expect(buildOpenClawGatewayExecArgv('--max-old-space-size 8192 --trace-warnings')).toEqual([]);
  });
});

describe('probeOpenClawGatewayStartup', () => {
  test('does not admit a listening gateway while startup is still pending', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, status: 'starting', pendingReason: 'startup-sidecars' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    ));

    const result = await probeOpenClawGatewayStartup(18789, 25, fetcher);

    expect(result).toEqual({
      ready: false,
      detail: '/startupz → HTTP 503, status=starting',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:18789/startupz', 25);
  });

  test('admits the gateway only after startupz explicitly reports started', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, status: 'started' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(probeOpenClawGatewayStartup(18789, 25, fetcher)).resolves.toMatchObject({
      ready: true,
    });
  });

  test('rejects a successful HTTP response without the startup contract', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, status: 'live' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(probeOpenClawGatewayStartup(18789, 25, fetcher)).resolves.toMatchObject({
      ready: false,
    });
  });

  test('falls back to the legacy ready contract only when startupz is unavailable', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ready: true, failing: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));

    const result = await probeOpenClawGatewayStartup(18789, 25, fetcher);

    expect(result.ready).toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:18789/startupz', 25);
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:18789/ready', 25);
  });
});

describe('isOpenClawConfigStartupFailure', () => {
  test('matches OpenClaw config validation failures', () => {
    expect(isOpenClawConfigStartupFailure([
      '[stderr] Error: Invalid config at /Users/test/Library/Application Support/LobsterAI/openclaw/state/openclaw.json.',
      '[stderr] - models.providers.openai.api: invalid config: unsupported value',
    ].join('\n'))).toBe(true);
  });

  test('matches JSON5 parse failures for openclaw.json', () => {
    expect(isOpenClawConfigStartupFailure(
      '[stderr] JSON5 parse failed: invalid character at 4:3 in openclaw.json'
    )).toBe(true);
  });

  test('matches schema validation messages', () => {
    expect(isOpenClawConfigStartupFailure(
      '[stderr] Config validation failed: plugins.allow: unknown plugin id'
    )).toBe(true);
  });

  test('does not match unrelated runtime configuration errors', () => {
    expect(isOpenClawConfigStartupFailure(
      '[stderr] Invalid configuration: region from ARN does not match client region'
    )).toBe(false);
  });
});

describe('isOpenClawGatewayHeapOutOfMemory', () => {
  test('matches the V8 fatal heap OOM emitted by the gateway', () => {
    expect(isOpenClawGatewayHeapOutOfMemory(
      'FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory',
    )).toBe(true);
  });

  test('matches the alternate mark-compacts heap limit signature', () => {
    expect(isOpenClawGatewayHeapOutOfMemory(
      'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed',
    )).toBe(true);
  });

  test('does not classify ordinary gateway disconnects as heap OOM', () => {
    expect(isOpenClawGatewayHeapOutOfMemory(
      'gateway websocket closed with code=1006',
    )).toBe(false);
  });
});
