import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ComputerUseKitBundle,
  ComputerUseKitBundleIntegrity,
  ComputerUseKitId,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';

const TEST_USER_DATA = path.join(process.cwd(), '.test-computer-use-kit');
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalResourcesPath = process.resourcesPath;

const { isTrustedAccessibilityClient } = vi.hoisted(() => ({
  isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => false),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => (name === 'userData' ? TEST_USER_DATA : '')),
  },
  systemPreferences: {
    isTrustedAccessibilityClient,
  },
}));

import { KitStoreKey } from '../../shared/kit/constants';
import type { SqliteStore } from '../sqliteStore';
import {
  buildComputerUseMarketplaceKit,
  getCurrentComputerUseKitBundleDescriptor,
  isComputerUseKitSupportedPlatform,
  promptComputerUseAccessibilityPermission,
  resolveBundledComputerUseKitArchivePath,
  syncComputerUseSkillFromRuntime,
} from './computerUseKit';
import {
  ComputerUseRuntimes,
  ComputerUseRuntimeTarget,
} from './computerUseRuntime';

const MAC_RUNTIME = ComputerUseRuntimes[ComputerUseRuntimeTarget.MacArm64];

function setProcessTarget(runtime: { platform: string; arch: string }): void {
  Object.defineProperty(process, 'platform', { value: runtime.platform });
  Object.defineProperty(process, 'arch', { value: runtime.arch });
}

beforeEach(() => {
  setProcessTarget(MAC_RUNTIME);
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
});

describe('Computer Use kit bundle catalog', () => {
  test('uses the hosted macOS skill bundle descriptor on macOS arm64', () => {
    const descriptor = getCurrentComputerUseKitBundleDescriptor();

    expect(descriptor).toEqual({
      bundle: ComputerUseKitBundle.MacArm64,
      sha256: ComputerUseKitBundleIntegrity.MacArm64.Sha256,
      sizeBytes: ComputerUseKitBundleIntegrity.MacArm64.SizeBytes,
    });
  });

  test('supports macOS when the skill bundle is hosted remotely', () => {
    const descriptor = getCurrentComputerUseKitBundleDescriptor();

    expect(descriptor).toBeTruthy();
    expect(descriptor?.archiveName).toBeUndefined();
    expect(resolveBundledComputerUseKitArchivePath(descriptor!)).toBeNull();
    expect(isComputerUseKitSupportedPlatform()).toBe(true);
  });

  test('resolves an explicitly bundled skill archive path when a descriptor uses archiveName', () => {
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    const archivePath = path.join(TEST_USER_DATA, 'computer-use-skill.zip');
    fs.writeFileSync(archivePath, 'placeholder');
    vi.stubEnv('LOBSTER_COMPUTER_USE_KIT_ARCHIVE', archivePath);

    const descriptor = {
      archiveName: 'computer-use-skill.zip',
      bundle: ComputerUseKitBundle.MacArm64,
      sha256: ComputerUseKitBundleIntegrity.MacArm64.Sha256,
      sizeBytes: ComputerUseKitBundleIntegrity.MacArm64.SizeBytes,
    };

    expect(resolveBundledComputerUseKitArchivePath(descriptor)).toBe(archivePath);
  });

  test('resolves an explicitly bundled skill archive from packaged Electron resources', () => {
    const resourcesPath = path.join(TEST_USER_DATA, 'Resources');
    const archivePath = path.join(
      resourcesPath,
      'computer-use',
      'computer-use-skill.zip',
    );
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, 'placeholder');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath,
    });

    const descriptor = {
      archiveName: 'computer-use-skill.zip',
      bundle: ComputerUseKitBundle.MacArm64,
      sha256: ComputerUseKitBundleIntegrity.MacArm64.Sha256,
      sizeBytes: ComputerUseKitBundleIntegrity.MacArm64.SizeBytes,
    };

    expect(resolveBundledComputerUseKitArchivePath(descriptor)).toBe(archivePath);
  });

  test('builds a macOS marketplace entry with hosted bundle integrity metadata', () => {
    const kit = buildComputerUseMarketplaceKit() as {
      id?: unknown;
      skills?: {
        bundle?: unknown;
        bundleSha256?: unknown;
        bundleSizeBytes?: unknown;
        list?: Array<{ id?: unknown }>;
      };
      version?: unknown;
    };

    expect(kit.id).toBe(ComputerUseKitId.BuiltIn);
    expect(kit.version).toBe(MAC_RUNTIME.version);
    expect(kit.skills?.bundle).toBe(ComputerUseKitBundle.MacArm64);
    expect(kit.skills?.bundleSha256).toBe(ComputerUseKitBundleIntegrity.MacArm64.Sha256);
    expect(kit.skills?.bundleSizeBytes).toBe(ComputerUseKitBundleIntegrity.MacArm64.SizeBytes);
    expect(kit.skills?.list?.map(skill => skill.id)).toEqual([ComputerUseSkillId.BuiltIn]);
  });
});

function makeStore(initial: Record<string, unknown>): SqliteStore & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
  } as unknown as SqliteStore & { data: Record<string, unknown> };
}

describe('Computer Use kit upgrades', () => {
  function writeRuntimeSkill(content: string): string {
    const skillDir = path.join(TEST_USER_DATA, 'runtime', 'skill', 'computer-use');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    return skillDir;
  }

  test('refreshes the installed skill and kit version from the runtime copy', () => {
    const skillDir = writeRuntimeSkill('---\nname: computer-use\ndescription: new\n---\n');
    const installedSkill = path.join(TEST_USER_DATA, 'SKILLs', ComputerUseSkillId.BuiltIn, 'SKILL.md');
    fs.mkdirSync(path.dirname(installedSkill), { recursive: true });
    fs.writeFileSync(installedSkill, '# old skill without frontmatter\n');
    const store = makeStore({
      [KitStoreKey.Installed]: {
        [ComputerUseKitId.BuiltIn]: {
          id: ComputerUseKitId.BuiltIn,
          version: '0.1.2',
          installedAt: 1,
          skills: { skillIds: [ComputerUseSkillId.BuiltIn] },
          mcpServers: [],
          connectors: [],
        },
      },
    });

    expect(syncComputerUseSkillFromRuntime(store, skillDir)).toBe(true);
    expect(fs.readFileSync(installedSkill, 'utf8')).toContain('description: new');
    expect((store.data[KitStoreKey.Installed] as Record<string, { version: string }>)[ComputerUseKitId.BuiltIn].version)
      .toBe(MAC_RUNTIME.version);
    expect(syncComputerUseSkillFromRuntime(store, skillDir)).toBe(false);
  });

  test('does nothing when the kit is not installed', () => {
    const skillDir = writeRuntimeSkill('---\nname: computer-use\ndescription: new\n---\n');
    const store = makeStore({});

    expect(syncComputerUseSkillFromRuntime(store, skillDir)).toBe(false);
    expect(fs.existsSync(path.join(TEST_USER_DATA, 'SKILLs', ComputerUseSkillId.BuiltIn))).toBe(false);
  });

  test('asks macOS for Accessibility once after install', () => {
    isTrustedAccessibilityClient.mockReturnValueOnce(false);

    expect(promptComputerUseAccessibilityPermission()).toBe(false);
    expect(isTrustedAccessibilityClient).toHaveBeenNthCalledWith(1, false);
    expect(isTrustedAccessibilityClient).toHaveBeenNthCalledWith(2, true);

    isTrustedAccessibilityClient.mockClear();
    isTrustedAccessibilityClient.mockReturnValueOnce(true);
    expect(promptComputerUseAccessibilityPermission()).toBe(true);
    expect(isTrustedAccessibilityClient).toHaveBeenCalledTimes(1);
  });
});
