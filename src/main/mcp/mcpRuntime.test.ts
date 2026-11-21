import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ComputerUseKitId } from '../../shared/computerUse/constants';
import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { McpAuthMode } from '../../shared/mcp/auth';
import { ComputerUseMcpEnv, ComputerUseMcpServerName } from '../computerUse/computerUseMcpServer';
import { ComputerUseRuntimes, ComputerUseRuntimeTarget } from '../computerUse/computerUseRuntime';
import { McpLaunchResolutionStatus, McpLaunchResolverKind } from './mcpLaunchResolution';
import { McpRuntime } from './mcpRuntime';
import type { McpServerRecord } from './mcpStore';

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

vi.mock('./mcpStore', () => ({
  McpStore: class {
    getEnabledServers(): unknown[] {
      return [];
    }
  },
}));

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
    });
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
