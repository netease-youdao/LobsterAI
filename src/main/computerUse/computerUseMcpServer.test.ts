import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_USER_DATA = path.join(process.cwd(), '.test-computer-use-runtime');
const originalPlatform = process.platform;
const originalArch = process.arch;

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => (name === 'userData' ? TEST_USER_DATA : '')),
    isPackaged: false,
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
}));

import {
  ComputerUseMcpEnv,
  ensureComputerUseMcpServerScript,
  resolveComputerUseMcpServer,
  resolveComputerUseRuntimePaths,
  resolvePackageRoot,
} from './computerUseMcpServer';
import {
  ComputerUseRuntimeMode,
  ComputerUseRuntimes,
  ComputerUseRuntimeTarget,
  getComputerUseHelperStateHome,
  getComputerUseRuntimeRoot,
  inspectComputerUseRuntime,
} from './computerUseRuntime';

const WINDOWS_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.WindowsX64];
const MAC_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];

function setProcessTarget(runtime: { platform: string; arch: string }): void {
  Object.defineProperty(process, 'platform', { value: runtime.platform });
  Object.defineProperty(process, 'arch', { value: runtime.arch });
}

beforeEach(() => {
  setProcessTarget(WINDOWS_RUNTIME);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('resolvePackageRoot', () => {
  test('resolves the MCP SDK package root instead of its exported cjs package marker', () => {
    const root = resolvePackageRoot('@modelcontextprotocol/sdk');

    expect(root).toBeTruthy();
    expect(path.basename(root!)).toBe('sdk');
    expect(root).not.toContain(`${path.sep}dist${path.sep}cjs`);
  });
});

describe('resolveComputerUseRuntimePaths', () => {
  function writeWindowsRuntimeFixture(): {
    clientModulePath: string;
    helperExePath: string;
    rootDir: string;
    runtimePackageRoot: string;
  } {
    const rootDir = getComputerUseRuntimeRoot(WINDOWS_RUNTIME);
    const runtimePackageRoot = path.join(rootDir, 'node_modules', '@lobsterai', 'computer-use');
    const helperExePath = path.join(runtimePackageRoot, 'bin', 'windows', 'lobster-computer-use.exe');
    const clientPath = path.join(
      runtimePackageRoot,
      'dist',
      'windows',
      'computer_use_client.js',
    );
    fs.mkdirSync(path.dirname(helperExePath), { recursive: true });
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'runtime.json'), `\uFEFF${JSON.stringify({
      arch: WINDOWS_RUNTIME.arch,
      id: WINDOWS_RUNTIME.id,
      mode: ComputerUseRuntimeMode.WindowsHelper,
      platform: WINDOWS_RUNTIME.platform,
      version: WINDOWS_RUNTIME.version,
      clientModule: 'node_modules/@lobsterai/computer-use/dist/windows/computer_use_client.js',
      helper: 'node_modules/@lobsterai/computer-use/bin/windows/lobster-computer-use.exe',
      runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    })}`);
    fs.writeFileSync(helperExePath, '');
    fs.writeFileSync(clientPath, '');
    return { clientModulePath: clientPath, helperExePath, rootDir, runtimePackageRoot };
  }

  function writeMacRuntimeFixture(): {
    mcpCommandPath: string;
    mcpCwd: string;
    rootDir: string;
  } {
    setProcessTarget(MAC_RUNTIME);
    const rootDir = getComputerUseRuntimeRoot(MAC_RUNTIME);
    const mcpCwd = path.join(rootDir, 'computer-use');
    const mcpCommandPath = path.join(
      mcpCwd,
      'Codex Computer Use.app',
      'Contents',
      'SharedSupport',
      'SkyComputerUseClient.app',
      'Contents',
      'MacOS',
      'SkyComputerUseClient',
    );
    fs.mkdirSync(path.dirname(mcpCommandPath), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'runtime.json'), JSON.stringify({
      arch: MAC_RUNTIME.arch,
      id: MAC_RUNTIME.id,
      mode: ComputerUseRuntimeMode.MacMcpApp,
      platform: MAC_RUNTIME.platform,
      version: MAC_RUNTIME.version,
      mcpArgs: ['mcp'],
      mcpCommand: 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
      mcpCwd: 'computer-use',
    }));
    fs.writeFileSync(mcpCommandPath, '');
    return { mcpCommandPath, mcpCwd, rootDir };
  }

  test('resolves the installed Windows helper runtime from userData runtimes directory', () => {
    const { clientModulePath, helperExePath, rootDir, runtimePackageRoot } = writeWindowsRuntimeFixture();

    const inspection = inspectComputerUseRuntime();
    const paths = resolveComputerUseRuntimePaths();

    expect(inspection.missing).toEqual([]);
    expect(paths).toEqual({
      clientModulePath,
      helperExePath,
      mode: ComputerUseRuntimeMode.WindowsHelper,
      rootDir,
      runtimePackageRoot,
    });
  });

  test('configures the Windows helper with LobsterAI branding', () => {
    writeWindowsRuntimeFixture();

    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      bridgeSecret: 'secret',
      electronNodePath: process.execPath,
    });
    const helperStateHome = getComputerUseHelperStateHome();
    const config = JSON.parse(fs.readFileSync(
      path.join(helperStateHome, 'computer-use', 'config.json'),
      'utf8',
    )) as { strings?: { escToCancel?: string; usingComputer?: string } };

    expect(server?.env?.[ComputerUseMcpEnv.HelperStateHome]).toBe(helperStateHome);
    expect(server?.env?.[ComputerUseMcpEnv.ClientModulePath]).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'dist',
      'windows',
      'computer_use_client.js',
    ));
    expect(server?.env?.[ComputerUseMcpEnv.LogDir]).toBe(path.join(TEST_USER_DATA, 'computer-use', 'logs'));
    expect(server?.env?.[ComputerUseMcpEnv.LogLevel]).toBe('info');
    expect(server?.env?.[ComputerUseMcpEnv.LogRetentionDays]).toBe('7');
    expect(config.strings?.usingComputer).toBe('LobsterAI正在使用你的电脑');
    expect(config.strings?.escToCancel).toBe('按 Esc 取消');
  });

  test('resolves the macOS Computer Use MCP app runtime', () => {
    const { mcpCommandPath, mcpCwd, rootDir } = writeMacRuntimeFixture();

    const inspection = inspectComputerUseRuntime();
    const paths = resolveComputerUseRuntimePaths();
    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      bridgeSecret: 'secret',
      electronNodePath: process.execPath,
    });

    expect(inspection.missing).toEqual([]);
    expect(paths).toEqual({
      mcpArgs: ['mcp'],
      mcpCommandPath,
      mcpCwd,
      mode: ComputerUseRuntimeMode.MacMcpApp,
      rootDir,
    });
    expect(server).toEqual({
      name: 'computer-use',
      transportType: 'stdio',
      command: mcpCommandPath,
      args: ['mcp'],
      cwd: mcpCwd,
    });
  });

  test('reports Escape cancellation before renewing the helper turn', () => {
    const scriptPath = ensureComputerUseMcpServerScript();
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_HOME')");
    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_CLIENT_MODULE')");
    expect(script).not.toContain("requireEnv('CODEX_HOME')");
    expect(script).not.toContain('sky_js');
    expect(script).not.toContain('@oai');
    expect(script).not.toContain('x-oai-cua-approved-app');
    expect(script).toContain("const APPROVED_APP_META_KEY = 'x-lobsterai-computer-use-approved-app'");
    expect(script).toContain('computerUseHome: helperStateHome');
    expect(script).toContain('function hasHelperInterruptMarker()');
    expect(script).toContain('function assertHelperTurnActive()');
    expect(script).toContain('assertHelperTurnActive();');
    expect(script).toContain('function renewHelperTurn()');
    expect(script).toContain('renewHelperTurn();');
    expect(script).not.toContain('function ensureFreshHelperTurn()');
    expect(script).toContain('function isComputerUseStoppedError(error)');
    expect(script).toContain("error.message.includes('physical Escape key')");
    expect(script).toContain('STOPPED_BY_USER_MESSAGE');
    expect(script).not.toContain('turn_id: String(Date.now())');
    expect(script).not.toContain("client.transport?.request?.('end_turn'");
  });
});
