import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
  ComputerUseKitId,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';
import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { ComputerUseMcpEnv, ComputerUseMcpServerName } from '../computerUse/computerUseMcpServer';
import {
  ComputerUseRuntimeMode,
  ComputerUseRuntimes,
  ComputerUseRuntimeTarget,
  getComputerUseRuntimeRoot,
} from '../computerUse/computerUseRuntime';
import { buildDshMcpServerSpecs } from '../libs/dsh/dshProviderSync';
import { McpRuntime } from './mcpRuntime';

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
