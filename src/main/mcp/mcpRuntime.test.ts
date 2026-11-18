import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ComputerUseKitId } from '../../shared/computerUse/constants';
import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { ComputerUseMcpEnv, ComputerUseMcpServerName } from '../computerUse/computerUseMcpServer';
import { ComputerUseRuntimes, ComputerUseRuntimeTarget } from '../computerUse/computerUseRuntime';
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
