import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PythonEncodingEnv } from '../libs/pythonEncodingEnv';
import { McpLaunchResolutionStatus, McpLaunchResolverKind } from './mcpLaunchResolution';
import { McpRuntime } from './mcpRuntime';
import type { McpServerRecord } from './mcpStore';

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/test-profile', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../libs/coworkUtil', () => ({
  getElectronNodeRuntimePath: () => '/electron/node',
  ensureElectronNodeShim: () => '/node-shims',
  getSkillsRoot: () => '/skills',
}));

const originalPlatform = process.platform;

function makeRuntime(managed: boolean, serverEnv?: Record<string, string>, managedEnv?: Record<string, string>) {
  const server: McpServerRecord = {
    id: 'python-server', name: 'Python server', description: '', transportType: 'stdio',
    command: 'python', args: ['server.py'], env: serverEnv,
    enabled: true, isBuiltIn: false, createdAt: 1, updatedAt: 1,
  };
  const runtime = new McpRuntime({
    getStore: () => { throw new Error('Unexpected database access'); },
    syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
  });
  vi.spyOn(runtime, 'getStore').mockReturnValue({
    getServer: () => server,
    getEnabledServers: () => [server],
  } as never);
  vi.spyOn(runtime, 'getLaunchResolverManager').mockReturnValue({
    canOptimize: () => managed,
    getReadyResolution: () => managed ? {
      serverId: server.id, resolverKind: McpLaunchResolverKind.Npx,
      sourceFingerprint: 'test', status: McpLaunchResolutionStatus.Ready,
      command: '/managed/python', args: ['server.py'], env: managedEnv, updatedAt: 1,
    } : undefined,
  } as never);
  return { runtime, server };
}

async function getLaunchEnvironments(harness: ReturnType<typeof makeRuntime>) {
  const { runtime, server } = harness;
  const servers = await runtime.refreshResolvedServersCache();
  const probe = await runtime.resolveToolDiscoveryLaunch({ serverId: server.id, ...server });
  expect(servers).toHaveLength(1);
  return [servers[0].env, probe.env];
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  for (const key of Object.keys(process.env)) {
    if (Object.values(PythonEncodingEnv).some(name => name === key.toUpperCase())) vi.stubEnv(key, undefined);
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.each([false, true])('MCP Python env (managed launch: %s)', managed => {
  test('both native config and discovery explicitly pass defaults without leaking parent secrets', async () => {
    vi.stubEnv('PRIVATE_PARENT_TOKEN', 'must-not-inherit');
    const environments = await getLaunchEnvironments(makeRuntime(managed));

    for (const env of environments) {
      expect(env).toMatchObject({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
      expect(env).not.toHaveProperty('PRIVATE_PARENT_TOKEN');
    }
  });

  test('inherits explicit parent encodings through the MCP whitelist boundary', async () => {
    vi.stubEnv(PythonEncodingEnv.Utf8, '0');
    vi.stubEnv(PythonEncodingEnv.IoEncoding, 'gbk:backslashreplace');
    const environments = await getLaunchEnvironments(makeRuntime(managed));

    for (const env of environments) {
      expect(env).toMatchObject({ [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk:backslashreplace' });
    }
  });

  test('server values override resolved and inherited encodings across Windows key casing', async () => {
    vi.stubEnv(PythonEncodingEnv.Utf8, '1');
    vi.stubEnv(PythonEncodingEnv.IoEncoding, 'latin-1');
    const harness = makeRuntime(managed, {
      pythonutf8: '0', PythonIoEncoding: 'gbk', SERVER_TOKEN: 'explicit-server-token',
    }, { [PythonEncodingEnv.IoEncoding]: 'utf-8:surrogateescape' });

    for (const env of await getLaunchEnvironments(harness)) {
      expect(env).toMatchObject({
        [PythonEncodingEnv.Utf8]: '0', [PythonEncodingEnv.IoEncoding]: 'gbk', SERVER_TOKEN: 'explicit-server-token',
      });
      expect(env).not.toHaveProperty('pythonutf8');
      expect(env).not.toHaveProperty('PythonIoEncoding');
    }
  });

  test('an empty server encoding selects the default instead of a parent legacy value', async () => {
    vi.stubEnv(PythonEncodingEnv.IoEncoding, 'gbk');
    const environments = await getLaunchEnvironments(makeRuntime(managed, { pythonioencoding: '' }));

    for (const env of environments) {
      expect(env).toMatchObject({ [PythonEncodingEnv.Utf8]: '1', [PythonEncodingEnv.IoEncoding]: 'utf-8' });
      expect(env).not.toHaveProperty('pythonioencoding');
    }
  });

  test.each(['darwin', 'linux'] as const)('keeps %s launch environments unchanged', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.stubEnv(PythonEncodingEnv.IoEncoding, 'parent-only');
    const environments = await getLaunchEnvironments(makeRuntime(managed, { pythonutf8: '0' }));

    for (const env of environments) {
      expect(env).toHaveProperty('pythonutf8', '0');
      expect(env).not.toHaveProperty(PythonEncodingEnv.Utf8);
      expect(env).not.toHaveProperty(PythonEncodingEnv.IoEncoding);
    }
  });
});
