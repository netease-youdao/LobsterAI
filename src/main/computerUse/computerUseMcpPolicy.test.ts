import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
  ComputerUseKitId,
  ComputerUseMcpServerName,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';
import { KitStoreKey } from '../../shared/kit/constants';

const fixture = vi.hoisted(() => ({ root: '', userData: '', temp: '' }));
const registeredHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => path.join(fixture.root, 'app')),
    getName: vi.fn(() => 'LobsterAI'),
    getPath: vi.fn((name: string) => (name === 'temp' ? fixture.temp : fixture.userData)),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    },
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    },
  },
}));

vi.mock('../mcp/mcpStore', () => ({
  McpStore: class {
    getEnabledServers(): unknown[] {
      return [];
    }
  },
}));

import { registerSkillHandlers } from '../ipcHandlers/skills/handlers';
import type { DshHostMcpServerSpec } from '../libs/dsh/dshHostManager';
import { buildDshMcpServerSpecs } from '../libs/dsh/dshProviderSync';
import { McpRuntime } from '../mcp/mcpRuntime';
import { SkillManager } from '../skills/skillManager';
import type { SqliteStore } from '../sqliteStore';
import {
  ComputerUseRuntimeMode,
  ComputerUseRuntimes,
  ComputerUseRuntimeTarget,
  getComputerUseRuntimeRoot,
} from './computerUseRuntime';

const originalPlatform = process.platform;
const originalArch = process.arch;
const MAC_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];

function writeMacRuntimeAndSkillFixtures(): void {
  const rootDir = getComputerUseRuntimeRoot(MAC_RUNTIME);
  const runtimePackageRoot = path.join(rootDir, 'node_modules', '@lobsterai', 'computer-use');
  const helperExePath = path.join(runtimePackageRoot, 'bin', 'macos', 'lobster-computer-use');
  const clientPath = path.join(runtimePackageRoot, 'dist', 'macos', 'computer_use_client.js');
  const runtimeSkillDir = path.join(runtimePackageRoot, 'skill', ComputerUseSkillId.BuiltIn);
  const userSkillDir = path.join(fixture.userData, 'SKILLs', ComputerUseSkillId.BuiltIn);

  fs.mkdirSync(path.dirname(helperExePath), { recursive: true });
  fs.mkdirSync(path.dirname(clientPath), { recursive: true });
  fs.mkdirSync(runtimeSkillDir, { recursive: true });
  fs.mkdirSync(userSkillDir, { recursive: true });

  const skillMarkdown = '---\nname: computer-use\ndescription: Control desktop apps\n---\n# Computer Use\n';
  fs.writeFileSync(path.join(rootDir, 'runtime.json'), JSON.stringify({
    arch: MAC_RUNTIME.arch,
    id: MAC_RUNTIME.id,
    mode: ComputerUseRuntimeMode.MacHelper,
    platform: MAC_RUNTIME.platform,
    version: MAC_RUNTIME.version,
    clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
    helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
    runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    skillDir: `node_modules/@lobsterai/computer-use/skill/${ComputerUseSkillId.BuiltIn}`,
  }));
  fs.writeFileSync(helperExePath, '');
  fs.writeFileSync(clientPath, '');
  fs.writeFileSync(path.join(runtimeSkillDir, 'SKILL.md'), skillMarkdown);
  fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), skillMarkdown);
}

describe('Computer Use skills:setEnabled -> McpRuntime -> DSH sync policy', () => {
  let skillManager: SkillManager;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: MAC_RUNTIME.platform });
    Object.defineProperty(process, 'arch', { value: MAC_RUNTIME.arch });
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-cu-policy-'));
    fixture.userData = path.join(fixture.root, 'userData');
    fixture.temp = path.join(fixture.root, 'temp');
    fs.mkdirSync(fixture.userData, { recursive: true });
    fs.mkdirSync(fixture.temp, { recursive: true });
    registeredHandlers.clear();
    writeMacRuntimeAndSkillFixtures();
  });

  afterEach(() => {
    skillManager?.stopWatching();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
    if (fixture.root && path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('unmounts computer-use MCP on skills:setEnabled(false) and remounts with timeout on skills:setEnabled(true)', async () => {
    const kv = new Map<string, unknown>([
      [
        KitStoreKey.Installed,
        {
          [ComputerUseKitId.BuiltIn]: {
            id: ComputerUseKitId.BuiltIn,
            version: MAC_RUNTIME.version,
            installedAt: 1,
            skills: { skillIds: [ComputerUseSkillId.BuiltIn] },
            mcpServers: [{ id: ComputerUseKitId.BuiltIn, name: 'Computer Use' }],
            connectors: [],
          },
        },
      ],
    ]);
    const store = {
      get: vi.fn((key: string) => kv.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        kv.set(key, value);
      }),
      getDatabase: vi.fn(() => ({})),
    } as unknown as SqliteStore;

    skillManager = new SkillManager(() => store);
    const mcpRuntime = new McpRuntime({
      getStore: () => store,
      syncOpenClawConfig: vi.fn(async () => ({ success: true, changed: false })),
    });
    (mcpRuntime as unknown as { bridgeServer: { askUserCallbackUrl: string } }).bridgeServer = {
      askUserCallbackUrl: 'http://127.0.0.1:43210/askuser',
    };

    let syncedSpecs: DshHostMcpServerSpec[] = [];
    const runSync = async (): Promise<void> => {
      const resolved = await mcpRuntime.refreshResolvedServersCache();
      const { servers } = await buildDshMcpServerSpecs(
        resolved.map(srv => ({
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
      syncedSpecs = servers;
    };

    registerSkillHandlers({
      getSkillManager: () => skillManager,
      getSkillStoreUrl: () => '',
      onSkillsPolicyChanged: runSync,
    });

    const setEnabled = registeredHandlers.get('skills:setEnabled');
    expect(setEnabled).toBeTypeOf('function');

    // Initial startup sync: installed kit + unset skills_state defaults to enabled.
    await runSync();
    expect(syncedSpecs).toHaveLength(1);
    expect(syncedSpecs[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transport: 'stdio',
      toolCallTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    expect(syncedSpecs[0].toolCallTimeoutMs).toBeGreaterThanOrEqual(180_000);

    // Turning computer-use skill OFF via IPC immediately unmounts its MCP server.
    const disableResult = await setEnabled!({}, { id: ComputerUseSkillId.BuiltIn, enabled: false }) as {
      success: boolean;
      skills: Array<{ id: string; enabled: boolean }>;
    };
    expect(disableResult.success).toBe(true);
    expect(disableResult.skills.find(s => s.id === ComputerUseSkillId.BuiltIn)?.enabled).toBe(false);
    expect(syncedSpecs).toEqual([]);

    // Turning computer-use skill back ON via IPC immediately remounts it with timeout.
    const enableResult = await setEnabled!({}, { id: ComputerUseSkillId.BuiltIn, enabled: true }) as {
      success: boolean;
      skills: Array<{ id: string; enabled: boolean }>;
    };
    expect(enableResult.success).toBe(true);
    expect(enableResult.skills.find(s => s.id === ComputerUseSkillId.BuiltIn)?.enabled).toBe(true);
    expect(syncedSpecs).toHaveLength(1);
    expect(syncedSpecs[0]).toMatchObject({
      name: ComputerUseMcpServerName.BuiltIn,
      transport: 'stdio',
      toolCallTimeoutMs: COMPUTER_USE_MCP_TOOL_CALL_TIMEOUT_MS,
    });
  });
});
