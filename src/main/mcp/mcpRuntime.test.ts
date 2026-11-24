import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
  ComputerUseKitId,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';
import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { McpAuthMode } from '../../shared/mcp/auth';
import { McpManagedConnection } from '../../shared/mcp/constants';
import { ComputerUseMcpEnv, ComputerUseMcpServerName } from '../computerUse/computerUseMcpServer';
import {
  ComputerUseRuntimeMode,
  ComputerUseRuntimes,
  ComputerUseRuntimeTarget,
  getComputerUseRuntimeRoot,
} from '../computerUse/computerUseRuntime';
import { buildDshMcpServerSpecs } from '../libs/dsh/dshProviderSync';
import { createMcpLaunchSourceFingerprint, McpLaunchResolutionStatus, McpLaunchResolverKind } from './mcpLaunchResolution';
import { McpRuntime } from './mcpRuntime';
import type { McpServerRecord, McpStore } from './mcpStore';

const TEST_USER_DATA = path.join(process.cwd(), '.test-mcp-runtime-computer-use');
const originalPlatform = process.platform;
const originalArch = process.arch;
const MAC_RUNTIMES = [
  ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64],
  ComputerUseRuntimes[ComputerUseRuntimeTarget.MacX64],
];
type MacRuntime = typeof MAC_RUNTIMES[number];

// Built by the lobsterai-computer-use-runtime project (npm run build:release) and copied
// into resources/computer-use/ (gitignored) to run this end-to-end check locally.
function generatedMacRuntimeArchive(runtime: MacRuntime): string {
  return path.join(process.cwd(), 'resources', 'computer-use', runtime.archiveName);
}

function setProcessTarget(target: MacRuntime): void {
  Object.defineProperty(process, 'platform', { value: target.platform });
  Object.defineProperty(process, 'arch', { value: target.arch });
}

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getName: vi.fn(() => 'LobsterAI'),
    getPath: vi.fn((name: string) => (name === 'userData' ? TEST_USER_DATA : '')),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

const mockEnabledServers: unknown[] = [];

vi.mock('./mcpStore', () => ({
  McpStore: class {
    getEnabledServers(): unknown[] {
      return mockEnabledServers;
    }
  },
}));

test('holds a chat turn until DSH acknowledges a managed MCP connection', async () => {
  const server: McpServerRecord = {
    id: 'context7',
    name: 'Context7',
    description: '',
    enabled: true,
    transportType: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    isBuiltIn: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const resolution = {
    serverId: server.id,
    sourceFingerprint: createMcpLaunchSourceFingerprint(server),
    resolverKind: McpLaunchResolverKind.Npx,
    status: McpLaunchResolutionStatus.Ready,
    command: 'node',
    args: ['context7.js'],
    updatedAt: 2,
  };
  server.launchResolution = resolution;
  const store = {
    getServer: vi.fn(() => server),
    listServers: vi.fn(() => [server]),
    getLaunchResolution: vi.fn(() => resolution),
  };
  const { promise, resolve } = Promise.withResolvers<{
    success: boolean;
    changed: boolean;
    mcpServerConnected: boolean;
  }>();
  const syncOpenClawConfig = vi.fn(() => promise);
  const runtime = new McpRuntime({ getStore: vi.fn(), syncOpenClawConfig });
  vi.spyOn(runtime, 'getStore').mockReturnValue(store as unknown as McpStore);

  runtime.ensureLaunchResolution(server.id, 'mcp-server-enabled');
  expect(runtime.getDisplayServers()[0].runtimeConnection).toBe(McpManagedConnection.Connecting);
  const controller = new AbortController();
  const proceeded = vi.fn();
  const ongoingTurn = runtime.waitForPendingLaunchConnections(controller.signal).then(proceeded);
  await Promise.resolve();
  expect(syncOpenClawConfig).toHaveBeenCalledWith(expect.objectContaining({ waitForMcpServerId: server.id }));
  expect(proceeded).not.toHaveBeenCalled();

  const cancelled = new AbortController();
  const cancelledTurn = runtime.waitForPendingLaunchConnections(cancelled.signal);
  cancelled.abort();
  await cancelledTurn;
  expect(runtime.getDisplayServers()[0].runtimeConnection).toBe(McpManagedConnection.Connecting);

  resolve({ success: true, changed: true, mcpServerConnected: true });
  await ongoingTurn;
  expect(proceeded).toHaveBeenCalledOnce();
  expect(runtime.getDisplayServers()[0].runtimeConnection).toBe(McpManagedConnection.Connected);
});

function buildInstalledComputerUseRecord(runtime: MacRuntime): InstalledKitRecord {
  return {
    id: ComputerUseKitId.BuiltIn,
    version: runtime.version,
    installedAt: Date.now(),
    skills: {
      skillIds: [ComputerUseKitId.BuiltIn],
    },
    mcpServers: [{ id: ComputerUseKitId.BuiltIn, name: 'Computer Use' }],
    connectors: [],
  };
}

describe.each(MAC_RUNTIMES)('McpRuntime Computer Use integration ($target)', (macRuntime) => {
  const generatedArchive = generatedMacRuntimeArchive(macRuntime);
  const generatedMacComputerUseTest = originalPlatform === 'darwin' && fs.existsSync(generatedArchive)
    ? test
    : test.skip;

  beforeEach(() => {
    setProcessTarget(macRuntime);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  generatedMacComputerUseTest('injects the built-in Computer Use server when the kit is installed', async () => {
    const installed = {
      [ComputerUseKitId.BuiltIn]: buildInstalledComputerUseRecord(macRuntime),
    };
    const sqliteStore = {
      get: vi.fn((key: string) => (key === KitStoreKey.Installed ? installed : undefined)),
      set: vi.fn(),
      getDatabase: vi.fn(() => ({})),
    };
    const runtime = new McpRuntime({
      getStore: () => sqliteStore as never,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });
    (runtime as unknown as { bridgeServer: { askUserCallbackUrl: string } }).bridgeServer = {
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
    };
    vi.stubEnv('LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE', generatedArchive);

    const servers = await runtime.refreshResolvedServersCache();

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transportType: 'stdio',
      requestTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    expect(servers[0].requestTimeoutMs).toBeGreaterThanOrEqual(180_000);
    expect(servers[0].args?.[0]).toContain('computer-use-mcp-server.mjs');
    expect(servers[0].env?.[ComputerUseMcpEnv.AskUserUrl]).toBe('http://127.0.0.1:1234/ask-user');
    expect(servers[0].env?.[ComputerUseMcpEnv.ClientModulePath]).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'dist',
      'macos',
      'computer_use_client.js',
    ));
    expect(fs.readFileSync(path.join(TEST_USER_DATA, 'SKILLs', ComputerUseKitId.BuiltIn, 'SKILL.md'), 'utf8'))
      .toMatch(/^---\nname: computer-use\ndescription: /);
    expect(servers[0].env?.[ComputerUseMcpEnv.ExePath]).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'bin',
      'macos',
      'lobster-computer-use',
    ));
  });
});

describe('McpRuntime resolved server metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('carries real SQLite server.id and timeouts across raw stdio, optimized stdio, and remote servers', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const enabledServers: McpServerRecord[] = [
      {
        id: 'uuid-raw-stdio',
        name: '高德地图',
        description: '',
        enabled: true,
        transportType: 'stdio',
        command: 'node',
        args: ['server.js'],
        requestTimeoutMs: 75_000,
        connectionTimeoutMs: 12_000,
        isBuiltIn: false,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'uuid-npx-opt',
        name: 'Context7',
        description: '',
        enabled: true,
        transportType: 'stdio',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        requestTimeoutMs: 90_000,
        connectionTimeoutMs: 25_000,
        isBuiltIn: false,
        createdAt: 2,
        updatedAt: 2,
      },
      {
        id: 'uuid-remote-http',
        name: 'Linear Remote',
        description: '',
        enabled: true,
        transportType: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { 'X-Client': 'lobsterai' },
        auth: McpAuthMode.OAuth,
        requestTimeoutMs: 120_000,
        connectionTimeoutMs: 30_000,
        isBuiltIn: false,
        createdAt: 3,
        updatedAt: 3,
      },
    ];

    const runtime = new McpRuntime({
      getStore: () => ({ get: () => undefined, set: () => {}, getDatabase: () => ({}) }) as never,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });
    vi.spyOn(runtime, 'getStore').mockReturnValue({
      getEnabledServers: () => enabledServers,
    } as never);
    vi.spyOn(runtime, 'getLaunchResolverManager').mockReturnValue({
      canOptimize: (srv: McpServerRecord) => srv.id === 'uuid-npx-opt',
      getReadyResolution: (srv: McpServerRecord) => (
        srv.id === 'uuid-npx-opt'
          ? {
            serverId: srv.id,
            resolverKind: McpLaunchResolverKind.Npx,
            sourceFingerprint: 'fp',
            status: McpLaunchResolutionStatus.Ready,
            command: '/electron/node',
            args: ['/userData/mcp-packages/uuid-npx-opt/bin.js'],
            updatedAt: 1,
          }
          : undefined
      ),
    } as never);

    const resolved = await runtime.refreshResolvedServersCache();
    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toMatchObject({
      id: 'uuid-raw-stdio',
      name: '高德地图',
      transportType: 'stdio',
      requestTimeoutMs: 75_000,
      connectionTimeoutMs: 12_000,
    });
    expect(resolved[1]).toMatchObject({
      id: 'uuid-npx-opt',
      name: 'Context7',
      transportType: 'stdio',
      command: '/electron/node',
      args: ['/userData/mcp-packages/uuid-npx-opt/bin.js'],
      requestTimeoutMs: 90_000,
      connectionTimeoutMs: 25_000,
    });
    expect(resolved[2]).toMatchObject({
      id: 'uuid-remote-http',
      name: 'Linear Remote',
      transportType: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: McpAuthMode.OAuth,
      requestTimeoutMs: 120_000,
      connectionTimeoutMs: 30_000,
    });
  });
});

describe('McpRuntime resolved server IDs', () => {
  afterEach(() => {
    mockEnabledServers.length = 0;
  });

  test('preserves SQLite server.id on resolved remote OAuth servers', async () => {
    mockEnabledServers.push({
      id: 'srv-uuid-1234',
      name: 'Linear OAuth',
      description: 'Remote OAuth server',
      enabled: true,
      transportType: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: McpAuthMode.OAuth,
      isBuiltIn: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const sqliteStore = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getDatabase: vi.fn(() => ({})),
    };
    const runtime = new McpRuntime({
      getStore: () => sqliteStore as never,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });

    const resolved = await runtime.refreshResolvedServersCache();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: 'srv-uuid-1234',
      name: 'Linear OAuth',
      transportType: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: McpAuthMode.OAuth,
    });
  });
});

describe('McpRuntime remote SSE resolution', () => {
  test('preserves server id, transportType sse, headers, timeouts, and oauth mode', async () => {
    const sqliteStore = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      getDatabase: vi.fn(() => ({})),
    };
    const runtime = new McpRuntime({
      getStore: () => sqliteStore as never,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });
    vi.spyOn(runtime, 'getStore').mockReturnValue({
      getEnabledServers: () => [
        {
          id: 'srv-uuid-sse-1',
          name: 'Legacy SSE',
          description: '',
          enabled: true,
          transportType: 'sse',
          url: 'https://legacy.example.com/sse',
          headers: { Authorization: 'Bearer tok-123' },
          auth: McpAuthMode.OAuth,
          requestTimeoutMs: 30_000,
          connectionTimeoutMs: 10_000,
          isBuiltIn: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as never);

    const servers = await runtime.refreshResolvedServersCache();
    expect(servers).toEqual([
      {
        id: 'srv-uuid-sse-1',
        name: 'Legacy SSE',
        transportType: 'sse',
        url: 'https://legacy.example.com/sse',
        headers: { Authorization: 'Bearer tok-123' },
        auth: McpAuthMode.OAuth,
        requestTimeoutMs: 30_000,
        connectionTimeoutMs: 10_000,
      },
    ]);
  });
});

function writeInstalledMacRuntimeFixture(macRuntime: MacRuntime): void {
  const rootDir = getComputerUseRuntimeRoot(macRuntime);
  const runtimePackageRoot = path.join(rootDir, 'node_modules', '@lobsterai', 'computer-use');
  const helperExePath = path.join(runtimePackageRoot, 'bin', 'macos', 'lobster-computer-use');
  const clientPath = path.join(runtimePackageRoot, 'dist', 'macos', 'computer_use_client.js');
  const skillDir = path.join(runtimePackageRoot, 'skill', ComputerUseSkillId.BuiltIn);
  fs.mkdirSync(path.dirname(helperExePath), { recursive: true });
  fs.mkdirSync(path.dirname(clientPath), { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'runtime.json'), JSON.stringify({
    arch: macRuntime.arch,
    id: macRuntime.id,
    mode: ComputerUseRuntimeMode.MacHelper,
    platform: macRuntime.platform,
    version: macRuntime.version,
    clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
    helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
    runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    skillDir: `node_modules/@lobsterai/computer-use/skill/${ComputerUseSkillId.BuiltIn}`,
  }));
  fs.writeFileSync(helperExePath, '');
  fs.writeFileSync(clientPath, '');
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: computer-use\ndescription: Control desktop apps\n---\n# Computer Use\n',
  );
}

describe('McpRuntime Computer Use timeout and skill toggle policy', () => {
  const macRuntime = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];

  beforeEach(() => {
    setProcessTarget(macRuntime);
    writeInstalledMacRuntimeFixture(macRuntime);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function createRuntimeFixture(initialKv: Record<string, unknown>) {
    const kv = new Map<string, unknown>(Object.entries(initialKv));
    const sqliteStore = {
      get: vi.fn((key: string) => kv.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        kv.set(key, value);
      }),
      getDatabase: vi.fn(() => ({})),
    };
    const runtime = new McpRuntime({
      getStore: () => sqliteStore as never,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });
    (runtime as unknown as { bridgeServer: { askUserCallbackUrl: string } }).bridgeServer = {
      askUserCallbackUrl: 'http://127.0.0.1:1234/askuser',
    };
    return { kv, sqliteStore, runtime };
  }

  test('mounts computer-use with requestTimeoutMs >= 180_000 by default when installed and not explicitly disabled', async () => {
    const { runtime } = createRuntimeFixture({
      [KitStoreKey.Installed]: {
        [ComputerUseKitId.BuiltIn]: buildInstalledComputerUseRecord(macRuntime),
      },
    });

    const servers = await runtime.refreshResolvedServersCache();

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transportType: 'stdio',
      requestTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    expect(servers[0].requestTimeoutMs).toBeGreaterThanOrEqual(180_000);
    // Runtime, kit, and skills all survive outside <userData>/openclaw/.
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'openclaw'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'runtimes', ComputerUseKitId.BuiltIn))).toBe(true);
  });

  test('unmounts computer-use when skills_state disables it and remounts with timeout when re-enabled', async () => {
    const { kv, runtime } = createRuntimeFixture({
      [KitStoreKey.Installed]: {
        [ComputerUseKitId.BuiltIn]: buildInstalledComputerUseRecord(macRuntime),
      },
      skills_state: {
        [ComputerUseSkillId.BuiltIn]: { enabled: false },
      },
    });

    // Disabled -> must not mount computer-use MCP server.
    const disabledServers = await runtime.refreshResolvedServersCache();
    expect(disabledServers).toEqual([]);

    // Re-enabled -> must remount computer-use MCP server and propagate toolCallTimeoutMs to DSH.
    kv.set('skills_state', { [ComputerUseSkillId.BuiltIn]: { enabled: true } });
    const enabledServers = await runtime.refreshResolvedServersCache();
    expect(enabledServers).toHaveLength(1);
    expect(enabledServers[0].name).toBe(ComputerUseMcpServerName.BuiltIn);
    expect(enabledServers[0].requestTimeoutMs).toBe(COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS);
    expect(enabledServers[0].requestTimeoutMs).toBeGreaterThanOrEqual(180_000);

    const dshSpecs = await buildDshMcpServerSpecs(
      enabledServers.map(srv => ({
        id: srv.name,
        name: srv.name,
        enabled: true,
        transportType: srv.transportType,
        command: srv.command,
        args: srv.args,
        env: srv.env,
        cwd: srv.cwd,
        url: srv.url,
        headers: srv.headers,
        oauthEnabled: srv.auth === 'oauth',
        requestTimeoutMs: srv.requestTimeoutMs,
        connectionTimeoutMs: srv.connectionTimeoutMs,
      })),
    );
    expect(dshSpecs.servers).toHaveLength(1);
    expect(dshSpecs.servers[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transport: 'stdio',
      toolCallTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    expect(dshSpecs.servers[0].toolCallTimeoutMs).toBeGreaterThanOrEqual(180_000);

    // Disable again -> immediately unmounts.
    kv.set('skills_state', { [ComputerUseSkillId.BuiltIn]: { enabled: false } });
    const reDisabledServers = await runtime.refreshResolvedServersCache();
    expect(reDisabledServers).toEqual([]);
  });
});
