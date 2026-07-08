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
