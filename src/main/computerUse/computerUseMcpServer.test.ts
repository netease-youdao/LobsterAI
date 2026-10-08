import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import crypto from 'crypto';
import { session } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import yazl from 'yazl';

const TEST_USER_DATA = path.join(process.cwd(), '.test-computer-use-runtime');
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalResourcesPath = process.resourcesPath;

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getName: vi.fn(() => 'LobsterAI'),
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
  COMPUTER_USE_BRIDGE_SECRET_PLACEHOLDER,
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
  ensureComputerUseHelperStateHome,
  getComputerUseHelperStateHome,
  getComputerUseRuntimeBaseDir,
  getComputerUseRuntimeRoot,
  inspectComputerUseRuntime,
  installComputerUseRuntime,
  removeStaleComputerUseRuntimes,
} from './computerUseRuntime';

const WINDOWS_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.WindowsX64];
const MAC_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];
const GENERATED_MAC_RUNTIME_ARCHIVE = path.join(
  process.cwd(),
  'resources',
  'computer-use',
  MAC_RUNTIME.archiveName,
);
const macArchiveInstallTest = originalPlatform === 'darwin' && fs.existsSync('/usr/bin/ditto')
  ? test
  : test.skip;
const generatedMacArchiveTest = originalPlatform === 'darwin' && fs.existsSync(GENERATED_MAC_RUNTIME_ARCHIVE)
  ? test
  : test.skip;

type JsonRpcMessage = {
  error?: unknown;
  id?: number | string;
  method?: string;
  result?: unknown;
};

function createJsonRpcReader(child: ChildProcessWithoutNullStreams): {
  next: (predicate: (message: JsonRpcMessage) => boolean, timeoutMs?: number) => Promise<JsonRpcMessage>;
} {
  let buffer = '';
  const messages: JsonRpcMessage[] = [];
  const waiters: Array<{
    predicate: (message: JsonRpcMessage) => boolean;
    reject: (error: Error) => void;
    resolve: (message: JsonRpcMessage) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  const dispatch = (message: JsonRpcMessage): void => {
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      dispatch(JSON.parse(line) as JsonRpcMessage);
    }
  });

  child.once('exit', (code, signal) => {
    const error = new Error(`MCP server exited before response code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  });

  return {
    next(predicate, timeoutMs = 5000) {
      const queuedIndex = messages.findIndex(predicate);
      if (queuedIndex !== -1) {
        const [message] = messages.splice(queuedIndex, 1);
        return Promise.resolve(message);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const waiterIndex = waiters.findIndex(waiter => waiter.reject === reject);
          if (waiterIndex !== -1) {
            waiters.splice(waiterIndex, 1);
          }
          reject(new Error('Timed out waiting for MCP JSON-RPC message'));
        }, timeoutMs);
        waiters.push({ predicate, reject, resolve, timeout });
      });
    },
  };
}

function writeJsonRpc(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

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
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: originalResourcesPath,
  });
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
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
  function zipDirectory(sourceDir: string, zipPath: string): Promise<void> {
    const zipFile = new yazl.ZipFile();
    const fixedMtime = new Date('2026-01-01T00:00:00.000Z');
    const visit = (dir: string, prefix = ''): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const absolutePath = path.join(dir, entry.name);
        const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) {
          visit(absolutePath, relativePath);
        } else if (entry.isFile()) {
          zipFile.addFile(absolutePath, relativePath, {
            mode: entry.name === 'lobster-computer-use' ? 0o100755 : 0o100644,
            mtime: fixedMtime,
          });
        }
      }
    };

    visit(sourceDir);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    return new Promise((resolve, reject) => {
      zipFile.outputStream
        .pipe(fs.createWriteStream(zipPath))
        .on('close', resolve)
        .on('error', reject);
      zipFile.end();
    });
  }

  function sha256(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

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
    clientModulePath: string;
    helperExePath: string;
    rootDir: string;
    runtimePackageRoot: string;
  } {
    setProcessTarget(MAC_RUNTIME);
    const rootDir = getComputerUseRuntimeRoot(MAC_RUNTIME);
    const runtimePackageRoot = path.join(rootDir, 'node_modules', '@lobsterai', 'computer-use');
    const helperExePath = path.join(runtimePackageRoot, 'bin', 'macos', 'lobster-computer-use');
    const clientPath = path.join(
      runtimePackageRoot,
      'dist',
      'macos',
      'computer_use_client.js',
    );
    fs.mkdirSync(path.dirname(helperExePath), { recursive: true });
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'runtime.json'), JSON.stringify({
      arch: MAC_RUNTIME.arch,
      id: MAC_RUNTIME.id,
      mode: ComputerUseRuntimeMode.MacHelper,
      platform: MAC_RUNTIME.platform,
      version: MAC_RUNTIME.version,
      clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
      helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
      runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    }));
    fs.writeFileSync(helperExePath, '');
    fs.writeFileSync(clientPath, '');
    return { clientModulePath: clientPath, helperExePath, rootDir, runtimePackageRoot };
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
    expect(server?.env?.[ComputerUseMcpEnv.Locale]).toBe('zh');
    expect(server?.env?.[ComputerUseMcpEnv.SelfAppName]).toBe('LobsterAI');
    expect(server?.env?.[ComputerUseMcpEnv.SelfPid]).toBe(String(process.pid));
    expect(config.strings?.usingComputer).toBe('LobsterAI正在使用你的电脑');
    expect(config.strings?.escToCancel).toBe('按 Esc 取消');
  });

  test('writes helper overlay strings in the app language', () => {
    const stateHome = ensureComputerUseHelperStateHome('en');
    const config = JSON.parse(fs.readFileSync(path.join(stateHome, 'computer-use', 'config.json'), 'utf8')) as {
      locale?: string;
      strings?: Record<string, string>;
    };

    expect(config.locale).toBe('en-US');
    expect(config.strings).toEqual({
      escToCancel: 'Press Esc to stop',
      usingComputer: 'LobsterAI is using your computer',
      stopped: 'Computer Use stopped',
    });
  });

  test('removes runtime versions and archives left by earlier releases', async () => {
    setProcessTarget(MAC_RUNTIME);
    const targetDir = path.join(getComputerUseRuntimeBaseDir(), MAC_RUNTIME.target);
    const downloadsDir = path.join(getComputerUseRuntimeBaseDir(), 'downloads');
    for (const version of ['1.0.809', '0.1.0', MAC_RUNTIME.version]) {
      fs.mkdirSync(path.join(targetDir, version), { recursive: true });
    }
    const freshStaging = path.join(targetDir, `${MAC_RUNTIME.version}.tmp-${Date.now()}`);
    fs.mkdirSync(freshStaging, { recursive: true });
    fs.mkdirSync(downloadsDir, { recursive: true });
    for (const name of [
      'lobsterai-computer-use-runtime-mac-arm64-1.0.809.zip',
      MAC_RUNTIME.archiveName,
      'lobsterai-computer-use-runtime-win-x64-1.0.7.zip',
    ]) {
      fs.writeFileSync(path.join(downloadsDir, name), 'zip');
    }

    const removed = await removeStaleComputerUseRuntimes(MAC_RUNTIME);

    expect(removed).toHaveLength(3);
    expect(fs.readdirSync(targetDir).sort()).toEqual([MAC_RUNTIME.version, path.basename(freshStaging)].sort());
    expect(fs.readdirSync(downloadsDir).sort()).toEqual([
      MAC_RUNTIME.archiveName,
      'lobsterai-computer-use-runtime-win-x64-1.0.7.zip',
    ].sort());
  });

  test('keeps the per-launch bridge secret out of openclaw.json', () => {
    writeWindowsRuntimeFixture();

    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      electronNodePath: process.execPath,
    });

    expect(server?.env?.[ComputerUseMcpEnv.BridgeSecret]).toBe(COMPUTER_USE_BRIDGE_SECRET_PLACEHOLDER);
    expect(COMPUTER_USE_BRIDGE_SECRET_PLACEHOLDER).toBe('${LOBSTER_MCP_BRIDGE_SECRET}');
  });

  test('resolves the macOS Computer Use helper runtime', () => {
    const { clientModulePath, helperExePath, rootDir, runtimePackageRoot } = writeMacRuntimeFixture();

    const inspection = inspectComputerUseRuntime();
    const paths = resolveComputerUseRuntimePaths();
    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      electronNodePath: process.execPath,
    });

    expect(inspection.missing).toEqual([]);
    expect(paths).toEqual({
      clientModulePath,
      helperExePath,
      mode: ComputerUseRuntimeMode.MacHelper,
      rootDir,
      runtimePackageRoot,
    });
    expect(server?.name).toBe('computer-use');
    expect(server?.transportType).toBe('stdio');
    expect(server?.args?.[0]).toContain('computer-use-mcp-server.mjs');
    expect(server?.env?.[ComputerUseMcpEnv.ClientModulePath]).toBe(clientModulePath);
    expect(server?.env?.[ComputerUseMcpEnv.ExePath]).toBe(helperExePath);
    expect(server?.env?.[ComputerUseMcpEnv.RuntimePackageRoot]).toBe(runtimePackageRoot);
  });

  macArchiveInstallTest('installs and resolves a macOS helper runtime archive', async () => {
    setProcessTarget(MAC_RUNTIME);
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    const archiveRoot = path.join(TEST_USER_DATA, 'archive-root');
    const archivePath = path.join(TEST_USER_DATA, 'fixtures', 'mac-runtime.zip');
    const packageRoot = path.join(archiveRoot, 'node_modules', '@lobsterai', 'computer-use');
    const helperPath = path.join(packageRoot, 'bin', 'macos', 'lobster-computer-use');
    const clientPath = path.join(packageRoot, 'dist', 'macos', 'computer_use_client.js');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helperPath, 0o755);
    fs.writeFileSync(clientPath, 'export class ComputerUseClient {}\n');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@lobsterai/computer-use',
      version: MAC_RUNTIME.version,
      type: 'module',
    }));
    fs.writeFileSync(path.join(archiveRoot, 'runtime.json'), JSON.stringify({
      arch: MAC_RUNTIME.arch,
      id: MAC_RUNTIME.id,
      mode: ComputerUseRuntimeMode.MacHelper,
      platform: MAC_RUNTIME.platform,
      version: MAC_RUNTIME.version,
      clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
      helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
      runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    }));
    await zipDirectory(archiveRoot, archivePath);

    const originalSha256 = MAC_RUNTIME.sha256;
    const originalSizeBytes = MAC_RUNTIME.sizeBytes;
    (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = sha256(archivePath);
    (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = fs.statSync(archivePath).size;
    vi.stubEnv('LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE', archivePath);
    try {
      const result = await installComputerUseRuntime();

      expect(result.success).toBe(true);
      expect(result.paths).toEqual({
        clientModulePath: path.join(
          getComputerUseRuntimeRoot(MAC_RUNTIME),
          'node_modules',
          '@lobsterai',
          'computer-use',
          'dist',
          'macos',
          'computer_use_client.js',
        ),
        helperExePath: path.join(
          getComputerUseRuntimeRoot(MAC_RUNTIME),
          'node_modules',
          '@lobsterai',
          'computer-use',
          'bin',
          'macos',
          'lobster-computer-use',
        ),
        mode: ComputerUseRuntimeMode.MacHelper,
        rootDir: getComputerUseRuntimeRoot(MAC_RUNTIME),
        runtimePackageRoot: path.join(
          getComputerUseRuntimeRoot(MAC_RUNTIME),
          'node_modules',
          '@lobsterai',
          'computer-use',
        ),
      });
    } finally {
      (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = originalSha256;
      (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = originalSizeBytes;
    }
  });

  macArchiveInstallTest('downloads and installs a macOS helper runtime archive from the descriptor URL', async () => {
    setProcessTarget(MAC_RUNTIME);
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    const archiveRoot = path.join(TEST_USER_DATA, 'remote-archive-root');
    const archivePath = path.join(TEST_USER_DATA, 'fixtures', 'remote-mac-runtime.zip');
    const packageRoot = path.join(archiveRoot, 'node_modules', '@lobsterai', 'computer-use');
    const helperPath = path.join(packageRoot, 'bin', 'macos', 'lobster-computer-use');
    const clientPath = path.join(packageRoot, 'dist', 'macos', 'computer_use_client.js');
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.mkdirSync(path.dirname(clientPath), { recursive: true });
    fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(helperPath, 0o755);
    fs.writeFileSync(clientPath, 'export class ComputerUseClient {}\n');
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: '@lobsterai/computer-use',
      version: MAC_RUNTIME.version,
      type: 'module',
    }));
    fs.writeFileSync(path.join(archiveRoot, 'runtime.json'), JSON.stringify({
      arch: MAC_RUNTIME.arch,
      id: MAC_RUNTIME.id,
      mode: ComputerUseRuntimeMode.MacHelper,
      platform: MAC_RUNTIME.platform,
      version: MAC_RUNTIME.version,
      clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
      helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
      runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
    }));
    await zipDirectory(archiveRoot, archivePath);

    const originalSha256 = MAC_RUNTIME.sha256;
    const originalSizeBytes = MAC_RUNTIME.sizeBytes;
    const originalArchiveName = MAC_RUNTIME.archiveName;
    const originalDownloadUrl = MAC_RUNTIME.downloadUrl;
    const mutableRuntime = MAC_RUNTIME as unknown as { archiveName: string; downloadUrl: string | null };
    (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = sha256(archivePath);
    (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = fs.statSync(archivePath).size;
    // Point at a remote URL and an archive name that no local resources directory provides.
    mutableRuntime.archiveName = 'lobsterai-computer-use-runtime-mac-arm64-download-test.zip';
    mutableRuntime.downloadUrl = 'https://example.invalid/lobsterai-computer-use-runtime.zip';
    vi.mocked(session.defaultSession.fetch).mockResolvedValue(new Response(
      fs.readFileSync(archivePath),
      {
        headers: {
          'content-length': String(fs.statSync(archivePath).size),
        },
      },
    ) as unknown as Awaited<ReturnType<typeof session.defaultSession.fetch>>);
    try {
      const result = await installComputerUseRuntime();

      expect(session.defaultSession.fetch).toHaveBeenCalledWith(MAC_RUNTIME.downloadUrl);
      expect(result.success).toBe(true);
      expect(result.paths?.mode).toBe(ComputerUseRuntimeMode.MacHelper);
      expect(result.paths?.helperExePath && fs.statSync(result.paths.helperExePath).isFile()).toBe(true);
      expect(fs.existsSync(path.join(
        TEST_USER_DATA,
        'runtimes',
        'computer-use',
        'downloads',
        MAC_RUNTIME.archiveName,
      ))).toBe(true);
    } finally {
      (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = originalSha256;
      (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = originalSizeBytes;
      mutableRuntime.archiveName = originalArchiveName;
      mutableRuntime.downloadUrl = originalDownloadUrl;
    }
  });

  generatedMacArchiveTest('installs and resolves the generated macOS helper runtime archive', async () => {
    setProcessTarget(MAC_RUNTIME);
    vi.stubEnv('LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE', GENERATED_MAC_RUNTIME_ARCHIVE);

    const result = await installComputerUseRuntime();
    const paths = result.paths;

    expect(result.success).toBe(true);
    expect(paths?.mode).toBe(ComputerUseRuntimeMode.MacHelper);
    expect(paths?.clientModulePath).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'dist',
      'macos',
      'computer_use_client.js',
    ));
    expect(paths?.helperExePath).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
      'bin',
      'macos',
      'lobster-computer-use',
    ));
    expect(paths?.runtimePackageRoot).toContain(path.join(
      'node_modules',
      '@lobsterai',
      'computer-use',
    ));
    expect(paths?.clientModulePath && fs.statSync(paths.clientModulePath).isFile()).toBe(true);
    expect(paths?.helperExePath && fs.statSync(paths.helperExePath).isFile()).toBe(true);

    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: 'http://127.0.0.1:1234/ask-user',
      electronNodePath: process.execPath,
    });
    expect(server?.env?.[ComputerUseMcpEnv.ClientModulePath]).toBe(paths?.clientModulePath);
    expect(server?.env?.[ComputerUseMcpEnv.ExePath]).toBe(paths?.helperExePath);
    expect(server?.env?.[ComputerUseMcpEnv.RuntimePackageRoot]).toBe(paths?.runtimePackageRoot);
  });

  generatedMacArchiveTest('installs the generated macOS helper runtime from packaged Electron resources', async () => {
    setProcessTarget(MAC_RUNTIME);
    const resourcesPath = path.join(TEST_USER_DATA, 'Resources');
    const archivePath = path.join(resourcesPath, 'computer-use', MAC_RUNTIME.archiveName);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.copyFileSync(GENERATED_MAC_RUNTIME_ARCHIVE, archivePath);
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    });

    const result = await installComputerUseRuntime();

    expect(result.success).toBe(true);
    expect(result.paths?.mode).toBe(ComputerUseRuntimeMode.MacHelper);
    expect(result.paths?.helperExePath && fs.statSync(result.paths.helperExePath).isFile()).toBe(true);
  });

  generatedMacArchiveTest('runs the generated macOS helper runtime through the MCP stdio bridge', async () => {
    setProcessTarget(MAC_RUNTIME);
    vi.stubEnv('LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE', GENERATED_MAC_RUNTIME_ARCHIVE);
    // Approve every app prompt so the bridge reaches the real helper.
    const askServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const question = (JSON.parse(body) as { questions: Array<{ question: string; options: Array<{ label: string }> }> }).questions[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ behavior: 'allow', answers: { [question.question]: question.options[0].label } }));
      });
    });
    await new Promise<void>(resolve => askServer.listen(0, '127.0.0.1', resolve));
    const askPort = (askServer.address() as { port: number }).port;

    const installResult = await installComputerUseRuntime();
    expect(installResult.success).toBe(true);
    const server = resolveComputerUseMcpServer({
      askUserCallbackUrl: `http://127.0.0.1:${askPort}/ask-user`,
      electronNodePath: process.execPath,
    });
    expect(server?.command).toBeTruthy();
    expect(server?.args?.length).toBeGreaterThan(0);

    const child = spawn(server!.command, server!.args ?? [], {
      cwd: server!.cwd ?? process.cwd(),
      // OpenClaw substitutes the secret placeholder from its own environment.
      env: { ...process.env, ...(server!.env ?? {}), [ComputerUseMcpEnv.BridgeSecret]: 'test-secret' },
      stdio: 'pipe',
    });
    const stderrChunks: string[] = [];
    child.stderr.on('data', chunk => stderrChunks.push(String(chunk)));
    const reader = createJsonRpcReader(child);

    try {
      writeJsonRpc(child, {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: {
            name: 'lobsterai-computer-use-test',
            version: '0.0.0',
          },
        },
      });
      const initialized = await reader.next(message => message.id === 1);
      expect(initialized.error).toBeUndefined();
      expect(initialized.result).toMatchObject({
        serverInfo: { name: 'computer-use' },
      });

      writeJsonRpc(child, {
        method: 'notifications/initialized',
        params: {},
      });
      writeJsonRpc(child, {
        id: 2,
        method: 'tools/list',
        params: {},
      });
      const toolsList = await reader.next(message => message.id === 2);
      expect(toolsList.error).toBeUndefined();
      const tools = (toolsList.result as { tools?: Array<{ name?: string }> }).tools ?? [];
      expect(tools.map(tool => tool.name)).toContain('list_windows');
      expect(tools.map(tool => tool.name)).toContain('wait_for_text');

      writeJsonRpc(child, {
        id: 3,
        method: 'tools/call',
        params: {
          name: 'list_windows',
          arguments: {},
        },
      });
      const listWindows = await reader.next(message => message.id === 3);
      expect(listWindows.error).toBeUndefined();
      expect(listWindows.result).toMatchObject({
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'text' }),
        ]),
      });
      const listWindowsContent = (listWindows.result as { content?: Array<{ text?: string; type?: string }> }).content ?? [];
      const listWindowsText = listWindowsContent.find(item => item.type === 'text')?.text ?? '[]';
      const windows = JSON.parse(listWindowsText) as Array<{ app?: string; id?: number; title?: string }>;
      if (windows.length === 0) {
        console.warn('[ComputerUseMCPTest] skipped get_window_state smoke because list_windows returned no windows');
        return;
      }

      writeJsonRpc(child, {
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_window_state',
          arguments: {
            window: windows[0],
            include_screenshot: true,
            include_text: false,
          },
        },
      });
      const windowState = await reader.next(message => message.id === 4, 10000);
      expect(windowState.error).toBeUndefined();
      const windowStateContent = (windowState.result as {
        content?: Array<{ text?: string; type?: string }>;
      }).content ?? [];
      const windowStateText = windowStateContent.find(item => item.type === 'text')?.text;
      expect(windowStateText).toBeTruthy();
      const state = JSON.parse(windowStateText!) as {
        screenshots?: unknown[];
        window?: { app?: string; id?: number; title?: string };
      };
      expect(state.window).toMatchObject({
        app: windows[0].app,
        id: windows[0].id,
      });
      expect(Array.isArray(state.screenshots)).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 1500);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await new Promise<void>(resolve => askServer.close(() => resolve()));
    }

    expect(stderrChunks.join('')).not.toContain('Error:');
  });

  test('reports Escape cancellation before renewing the helper turn', () => {
    const scriptPath = ensureComputerUseMcpServerScript();
    const script = fs.readFileSync(scriptPath, 'utf8');

    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_HOME')");
    expect(script).toContain("requireEnv('LOBSTER_COMPUTER_USE_CLIENT_MODULE')");
    expect(script).toContain('const ComputerUseClient = clientModule.ComputerUseClient');
    expect(script).toContain("const APPROVED_APP_META_KEY = 'x-lobsterai-computer-use-approved-app'");
    expect(script).toContain("const CoordinateSpaceSchema = z.enum(['screenshot_pixels', 'window_points'])");
    expect(script).toContain("const DeliverySchema = z.enum(['auto', 'background', 'foreground', 'hid', 'pid'])");
    expect(script).toContain('async function ensureAppApproved(appLabel, details = {})');
    expect(script).not.toContain('`');
    expect(script).toContain('coordinate actions require screenshotId from get_window_state');
    expect(script).toContain('state_id: state.state_id');
    expect(script).toContain("registerTool('wait_for_text'");
    expect(script).toContain('async function applyExpectedText(args, actionResult)');
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
