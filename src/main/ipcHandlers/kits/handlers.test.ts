import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import yazl from 'yazl';

const { isTrustedAccessibilityClient, registeredHandlers, sendSpy } = vi.hoisted(() => ({
  isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => true),
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  sendSpy: vi.fn(),
}));

const TEST_USER_DATA = path.join(process.cwd(), '.test-kit-handlers-computer-use');
const originalPlatform = process.platform;
const originalArch = process.arch;

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return TEST_USER_DATA;
      if (name === 'temp') return path.join(TEST_USER_DATA, 'tmp');
      return '';
    }),
    isPackaged: false,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: vi.fn(() => false),
        webContents: {
          send: sendSpy,
        },
      },
    ]),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
  session: {
    defaultSession: {
      fetch: vi.fn(),
    },
  },
  systemPreferences: {
    isTrustedAccessibilityClient,
  },
}));

import {
  ComputerUseKitBundle,
  ComputerUseKitId,
  ComputerUseSkillId,
} from '../../../shared/computerUse/constants';
import { KitStoreKey } from '../../../shared/kit/constants';
import { getCurrentComputerUseKitBundleDescriptor } from '../../computerUse/computerUseKit';
import {
  ComputerUseRuntimes,
  ComputerUseRuntimeStatus,
  ComputerUseRuntimeTarget,
  getComputerUseRuntimeRoot,
  inspectComputerUseRuntime,
} from '../../computerUse/computerUseRuntime';
import { OpenClawConfigImpact } from '../../libs/openclawConfigImpact';
import type { SqliteStore } from '../../sqliteStore';
import { type KitHandlerDeps, registerKitHandlers } from './handlers';

const MAC_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];
const generatedMacComputerUseTest =
  originalPlatform === 'darwin'
  && fs.existsSync('/usr/bin/ditto')
    ? test
    : test.skip;
const originalRuntimeSha256 = MAC_RUNTIME.sha256;
const originalRuntimeSizeBytes = MAC_RUNTIME.sizeBytes;
const originalKitDescriptor = getCurrentComputerUseKitBundleDescriptor();
const originalKitSha256 = originalKitDescriptor?.sha256;
const originalKitSizeBytes = originalKitDescriptor?.sizeBytes;

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

async function writeRuntimeArchiveFixture(): Promise<string> {
  const archiveRoot = path.join(TEST_USER_DATA, 'fixtures', 'runtime-root');
  const archivePath = path.join(TEST_USER_DATA, 'fixtures', 'runtime.zip');
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
    mode: 'mac-helper',
    platform: MAC_RUNTIME.platform,
    version: MAC_RUNTIME.version,
    clientModule: 'node_modules/@lobsterai/computer-use/dist/macos/computer_use_client.js',
    helper: 'node_modules/@lobsterai/computer-use/bin/macos/lobster-computer-use',
    runtimePackageRoot: 'node_modules/@lobsterai/computer-use',
  }));
  await zipDirectory(archiveRoot, archivePath);
  return archivePath;
}

async function writeSkillArchiveFixture(): Promise<string> {
  const archiveRoot = path.join(TEST_USER_DATA, 'fixtures', 'skill-root');
  const skillPath = path.join(archiveRoot, 'computer-use', 'SKILL.md');
  const archivePath = path.join(TEST_USER_DATA, 'fixtures', 'skill.zip');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, [
    '# Computer Use',
    '',
    'Use check_permissions before controlling desktop applications.',
    '',
  ].join('\n'));
  await zipDirectory(archiveRoot, archivePath);
  return archivePath;
}

async function prepareComputerUseArchives(): Promise<void> {
  const runtimeArchivePath = await writeRuntimeArchiveFixture();
  const skillArchivePath = await writeSkillArchiveFixture();
  const kitDescriptor = getCurrentComputerUseKitBundleDescriptor();
  if (!kitDescriptor) {
    throw new Error('macOS Computer Use kit descriptor missing');
  }

  (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = sha256File(runtimeArchivePath);
  (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = fs.statSync(runtimeArchivePath).size;
  (kitDescriptor as { sha256: string; sizeBytes: number }).sha256 = sha256File(skillArchivePath);
  (kitDescriptor as { sha256: string; sizeBytes: number }).sizeBytes = fs.statSync(skillArchivePath).size;
  vi.stubEnv('LOBSTER_COMPUTER_USE_RUNTIME_ARCHIVE', runtimeArchivePath);
  vi.stubEnv('LOBSTER_COMPUTER_USE_KIT_ARCHIVE', skillArchivePath);
}

function restoreComputerUseDescriptors(): void {
  (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sha256 = originalRuntimeSha256;
  (MAC_RUNTIME as { sha256: string; sizeBytes: number }).sizeBytes = originalRuntimeSizeBytes;
  if (originalKitDescriptor && originalKitSha256 && originalKitSizeBytes !== undefined) {
    (originalKitDescriptor as { sha256: string; sizeBytes: number }).sha256 = originalKitSha256;
    (originalKitDescriptor as { sha256: string; sizeBytes: number }).sizeBytes = originalKitSizeBytes;
  }
}

function setProcessTarget(target: typeof MAC_RUNTIME): void {
  Object.defineProperty(process, 'platform', { value: target.platform });
  Object.defineProperty(process, 'arch', { value: target.arch });
}

function makeDeps(sequence: string[]): {
  deps: KitHandlerDeps;
  skillManager: { startWatching: ReturnType<typeof vi.fn>; stopWatching: ReturnType<typeof vi.fn> };
  storeData: Record<string, unknown>;
  syncOpenClawConfig: ReturnType<typeof vi.fn>;
} {
  const storeData: Record<string, unknown> = {};
  const store = {
    get: vi.fn((key: string) => storeData[key]),
    getDatabase: vi.fn(() => ({})),
    set: vi.fn((key: string, value: unknown) => {
      sequence.push(`store:${key}`);
      storeData[key] = value;
    }),
  };
  const skillManager = {
    startWatching: vi.fn(() => {
      sequence.push('skills:startWatching');
    }),
    stopWatching: vi.fn(() => {
      sequence.push('skills:stopWatching');
    }),
  };
  const syncOpenClawConfig = vi.fn(async (options: { reason: string }) => {
    sequence.push(`sync:${options.reason}`);
    return { success: true, changed: true };
  });
  const deps: KitHandlerDeps = {
    getKitStoreUrl: () => 'https://example.invalid/kits.json',
    getSkillManager: () => skillManager as never,
    getStore: () => store as unknown as SqliteStore,
    syncOpenClawConfig,
  };
  return { deps, skillManager, storeData, syncOpenClawConfig };
}

async function installComputerUseKit(): Promise<{
  deps: KitHandlerDeps;
  result: unknown;
  sequence: string[];
  skillManager: { startWatching: ReturnType<typeof vi.fn>; stopWatching: ReturnType<typeof vi.fn> };
  storeData: Record<string, unknown>;
  syncOpenClawConfig: ReturnType<typeof vi.fn>;
}> {
  const sequence: string[] = [];
  const { deps, skillManager, storeData, syncOpenClawConfig } = makeDeps(sequence);
  registerKitHandlers(deps);

  const handler = registeredHandlers.get('kits:install');
  expect(handler).toBeDefined();

  const result = await handler?.(undefined, {
    bundleUrl: ComputerUseKitBundle.MacArm64,
    connectors: [],
    kitId: ComputerUseKitId.BuiltIn,
    mcpServers: [{ id: ComputerUseKitId.BuiltIn, name: 'Computer Use' }],
    skillList: [
      {
        id: ComputerUseSkillId.BuiltIn,
        name: { en: 'Computer Use', zh: '电脑操作' },
      },
    ],
    skillListIds: [ComputerUseSkillId.BuiltIn],
    version: MAC_RUNTIME.version,
  });

  return {
    deps,
    result,
    sequence,
    skillManager,
    storeData,
    syncOpenClawConfig,
  };
}

beforeEach(async () => {
  registeredHandlers.clear();
  sendSpy.mockClear();
  setProcessTarget(MAC_RUNTIME);
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_USER_DATA, 'tmp'), { recursive: true });
  await prepareComputerUseArchives();
});

afterEach(() => {
  restoreComputerUseDescriptors();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  Object.defineProperty(process, 'arch', { value: originalArch });
  fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('registerKitHandlers Computer Use integration', () => {
  generatedMacComputerUseTest('installs Computer Use skill, runtime, kit record, and syncs OpenClaw after state is ready', async () => {
    const {
      result,
      sequence,
      skillManager,
      storeData,
      syncOpenClawConfig,
    } = await installComputerUseKit();

    expect(result).toEqual({
      success: true,
      skillIds: [ComputerUseSkillId.BuiltIn],
    });
    expect(fs.readFileSync(
      path.join(TEST_USER_DATA, 'SKILLs', ComputerUseSkillId.BuiltIn, 'SKILL.md'),
      'utf8',
    )).toContain('check_permissions');
    expect(inspectComputerUseRuntime().status).toBe(ComputerUseRuntimeStatus.Installed);
    expect(fs.existsSync(getComputerUseRuntimeRoot(MAC_RUNTIME))).toBe(true);
    expect(storeData.skills_state).toEqual({
      [ComputerUseSkillId.BuiltIn]: { enabled: true },
    });
    expect(storeData[KitStoreKey.Installed]).toMatchObject({
      [ComputerUseKitId.BuiltIn]: {
        id: ComputerUseKitId.BuiltIn,
        mcpServers: [{ id: ComputerUseKitId.BuiltIn, name: 'Computer Use' }],
        skills: {
          skillIds: [ComputerUseSkillId.BuiltIn],
        },
        version: MAC_RUNTIME.version,
      },
    });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      expectedImpact: OpenClawConfigImpact.Restart,
      reason: 'computer-use-kit-installed',
      restartGatewayIfRunning: true,
    });
    expect(skillManager.stopWatching).toHaveBeenCalledTimes(1);
    expect(skillManager.startWatching).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('skills:changed');
    expect(sequence.indexOf(`store:${KitStoreKey.Installed}`)).toBeLessThan(
      sequence.indexOf('sync:computer-use-kit-installed'),
    );
    expect(sequence.indexOf('sync:computer-use-kit-installed')).toBeLessThan(
      sequence.indexOf('skills:startWatching'),
    );
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
  });

  generatedMacComputerUseTest('uninstalls Computer Use skill, runtime, kit record, and syncs OpenClaw', async () => {
    const { storeData, syncOpenClawConfig } = await installComputerUseKit();
    sendSpy.mockClear();

    const handler = registeredHandlers.get('kits:uninstall');
    expect(handler).toBeDefined();

    const result = await handler?.(undefined, ComputerUseKitId.BuiltIn);

    expect(result).toEqual({ success: true });
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'SKILLs', ComputerUseSkillId.BuiltIn))).toBe(false);
    expect(fs.existsSync(getComputerUseRuntimeRoot(MAC_RUNTIME))).toBe(false);
    expect(storeData.skills_state).toEqual({});
    expect(storeData[KitStoreKey.Installed]).toEqual({});
    expect(syncOpenClawConfig).toHaveBeenLastCalledWith({
      expectedImpact: OpenClawConfigImpact.Restart,
      reason: 'computer-use-kit-uninstalled',
      restartGatewayIfRunning: true,
    });
    expect(sendSpy).toHaveBeenCalledWith('skills:changed');
  });
});
