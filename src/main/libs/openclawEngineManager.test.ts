import { type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';
import { setLanguage } from '../i18n';

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
  extractOpenClawPluginVerificationFailure,
  isOpenClawConfigStartupFailure,
  isOpenClawGatewayHeapOutOfMemory,
  OpenClawEngineManager,
  type OpenClawEngineStatus,
  probeOpenClawGatewayStartup,
} from './openclawEngineManager';

const PLUGIN_FAILURE = 'OpenClaw plugin verification failed; refusing to report the gateway ready.';
const PLUGIN_CONSENT_DETAIL = '- Plugin "vydra" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry. Run `openclaw update repair` to retry plugin repair.';

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

describe('extractOpenClawPluginVerificationFailure', () => {
  test('keeps the terminal failure and consent detail without ANSI or unrelated warnings', () => {
    expect(extractOpenClawPluginVerificationFailure([
      '[stderr] plugins.entries.acpx: plugin not installed',
      `[stderr] \u001b[31m${PLUGIN_FAILURE}\u001b[0m`,
      `[stderr] \u001b[33m${PLUGIN_CONSENT_DETAIL}\u001b[0m`,
      '[stderr] Resolve the plugin verification errors above, then restart the Gateway.',
      '[stderr] unrelated shutdown detail',
    ].join('\n'))).toBe(`${PLUGIN_FAILURE}\n${PLUGIN_CONSENT_DETAIL}`);
  });

  test.each([
    undefined,
    '[config] warnings: plugins.allow: plugin not installed: qqbot',
    'Plugin "vydra" requires capability consent.',
    'Plugin download failed: ECONNRESET',
    'Config validation failed: plugins.allow: unknown plugin id',
  ])('does not suppress retries without the terminal verification marker: %s', (output) => {
    expect(extractOpenClawPluginVerificationFailure(output)).toBeNull();
  });

  test('bounds large diagnostics while retaining the first cause', () => {
    const result = extractOpenClawPluginVerificationFailure(`${PLUGIN_FAILURE}\n${PLUGIN_CONSENT_DETAIL}\n- ${'x'.repeat(1_000)}`);
    expect(result).toContain('Plugin "vydra" requires capability consent.');
    expect(result).toHaveLength(400);
    expect(result?.endsWith('…')).toBe(true);
  });
});

describe('gateway terminal plugin verification failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setLanguage('zh');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const makeSupervisor = (output: string) => {
    const child = new EventEmitter() as ChildProcess;
    // Exercise the real exit handler without the constructor's runtime setup
    // or user-data writes, and never spawn a gateway in these tests.
    const manager = Object.assign(Object.create(OpenClawEngineManager.prototype), {
      status: { phase: OpenClawEnginePhase.Starting, version: '2026.8.1', canRetry: false },
      gatewayProcess: child,
      gatewayRecentOutput: new WeakMap([[child, output.split('\n')]]),
      gatewayFailureByProcess: new WeakMap(),
      expectedGatewayExits: new WeakSet(),
      gatewayRestartTimer: null,
      gatewayRestartWait: null,
      gatewayRestartAttempt: 0,
      shutdownRequested: false,
      gatewayPort: 18789,
      startGatewayPromise: null,
    }) as OpenClawEngineManager;
    const internals = manager as unknown as {
      attachGatewayExitHandlers: (process: ChildProcess) => void;
      gatewayRestartAttempt: number;
      gatewayRestartTimer: ReturnType<typeof setTimeout> | null;
      gatewayRestartWait: { promise: Promise<boolean>; resolve: (retry: boolean) => void } | null;
    };
    internals.attachGatewayExitHandlers(child);
    const start = vi.spyOn(manager, 'startGateway').mockResolvedValue({
      phase: OpenClawEnginePhase.Running, version: '2026.8.1', canRetry: false,
    });
    const statuses: OpenClawEngineStatus[] = [];
    manager.on('status', status => statuses.push(status));
    return { child, manager, internals, start, statuses };
  };

  test.each(['zh', 'en'] as const)('cancels pending retries and exposes the original failure in %s', async (language) => {
    setLanguage(language);
    const { child, manager, internals, start, statuses } = makeSupervisor(`${PLUGIN_FAILURE}\n${PLUGIN_CONSENT_DETAIL}`);
    const pendingRestart = vi.fn();
    const resolveRetry = vi.fn();
    internals.gatewayRestartAttempt = 2;
    internals.gatewayRestartTimer = setTimeout(pendingRestart, 3_000);
    internals.gatewayRestartWait = { promise: Promise.resolve(true), resolve: resolveRetry };

    child.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Error, canRetry: true });
    expect(statuses).toHaveLength(1);
    expect(statuses[0].message).toContain(PLUGIN_CONSENT_DETAIL);
    expect(statuses[0].message).toContain(language === 'zh' ? '已停止自动重启' : 'Automatic restarts stopped');
    expect(statuses[0].message).not.toContain('openclaw.json is invalid');
    expect(start).not.toHaveBeenCalled();
    expect(pendingRestart).not.toHaveBeenCalled();
    expect(resolveRetry).toHaveBeenCalledExactlyOnceWith(false);
    expect(internals.gatewayRestartTimer).toBeNull();
    expect(internals.gatewayRestartWait).toBeNull();
    expect(internals.gatewayRestartAttempt).toBe(0);
  });

  test('retains automatic retries for plugin warnings followed by a transient crash', async () => {
    const { child, manager, start } = makeSupervisor('[config] warnings: plugins.allow: plugin not installed: qqbot\nPlugin download failed: ECONNRESET');
    child.emit('exit', 1);
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Starting, canRetry: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(start).toHaveBeenCalledExactlyOnceWith('auto-restart-after-crash');
  });

  test('keeps config-validation text inside a terminal plugin diagnostic in the plugin error', () => {
    const pluginDetail = '- Plugin "custom" failed: config validation failed: missing capability declaration';
    const { child, manager } = makeSupervisor(`${PLUGIN_FAILURE}\n${pluginDetail}`);
    child.emit('exit', 1);
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Error, canRetry: true });
    expect(manager.getStatus().message).toContain(pluginDetail);
    expect(manager.getStatus().message).not.toContain('openclaw.json is invalid');
  });

  test('preserves the existing invalid-json error classification', () => {
    const { child, manager } = makeSupervisor('JSON5 parse failed: invalid character at 4:3 in openclaw.json');
    child.emit('exit', 1);
    expect(manager.getStatus()).toMatchObject({ phase: OpenClawEnginePhase.Error, canRetry: true });
    expect(manager.getStatus().message).toContain('openclaw.json is invalid');
    expect(manager.getStatus().message).not.toContain(PLUGIN_FAILURE);
  });
});
