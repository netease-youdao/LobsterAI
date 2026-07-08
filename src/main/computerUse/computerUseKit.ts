import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  ComputerUseKitBundle,
  ComputerUseKitBundleArchive,
  ComputerUseKitBundleIntegrity,
  ComputerUseKitId,
  ComputerUseKitMetadata,
  ComputerUseSkillId,
} from '../../shared/computerUse/constants';
import {
  type InstalledKitRecord,
  type InstalledKitSkills,
  type KitSkillMetadata,
  KitStoreKey,
} from '../../shared/kit/constants';
import type { SqliteStore } from '../sqliteStore';
import {
  ComputerUseRuntimeTarget,
  getCurrentComputerUseRuntimeDescriptor,
  isComputerUseRuntimeSupportedPlatform,
} from './computerUseRuntime';

const SKILLS_DIR_NAME = 'SKILLs';
const SKILL_STATE_KEY = 'skills_state';
const COMPUTER_USE_RESOURCE_DIR = 'computer-use';
const COMPUTER_USE_KIT_ICON_URL = 'https://ydhardwarecommon.nosdn.127.net/f02f8c2d2af8b1f88426327944f6e1f5.png';
const COMPUTER_USE_MCP_REF = {
  id: ComputerUseKitId.BuiltIn,
  name: 'Computer Use',
  description: 'Built-in local desktop control MCP server.',
};

type InstalledKitsMap = Record<string, InstalledKitRecord>;
type SkillStateMap = Record<string, { enabled: boolean }>;

export interface ComputerUseKitBundleDescriptor {
  archiveName?: string;
  bundle: ComputerUseKitBundle;
  sha256: string;
  sizeBytes: number;
}

const ComputerUseKitBundlesByRuntimeTarget = {
  [ComputerUseRuntimeTarget.MacArm64]: {
    archiveName: ComputerUseKitBundleArchive.MacArm64,
    bundle: ComputerUseKitBundle.MacArm64,
    sha256: ComputerUseKitBundleIntegrity.MacArm64.Sha256,
    sizeBytes: ComputerUseKitBundleIntegrity.MacArm64.SizeBytes,
  },
  [ComputerUseRuntimeTarget.WindowsX64]: {
    bundle: ComputerUseKitBundle.WindowsX64,
    sha256: ComputerUseKitBundleIntegrity.WindowsX64.Sha256,
    sizeBytes: ComputerUseKitBundleIntegrity.WindowsX64.SizeBytes,
  },
} as const satisfies Record<ComputerUseRuntimeTarget, ComputerUseKitBundleDescriptor>;

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function isComputerUseKitSupportedPlatform(): boolean {
  return isComputerUseRuntimeSupportedPlatform();
}

export function getCurrentComputerUseKitBundleDescriptor(): ComputerUseKitBundleDescriptor | null {
  const runtime = getCurrentComputerUseRuntimeDescriptor();
  return runtime ? ComputerUseKitBundlesByRuntimeTarget[runtime.target] : null;
}

export function resolveBundledComputerUseKitArchivePath(
  descriptor: ComputerUseKitBundleDescriptor,
): string | null {
  if (!descriptor.archiveName) {
    return null;
  }

  const candidates = [
    path.join(process.resourcesPath ?? '', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
    path.join(app.getAppPath(), 'resources', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
    path.join(process.cwd(), 'resources', COMPUTER_USE_RESOURCE_DIR, descriptor.archiveName),
  ];

  return candidates.find(candidate => isFile(candidate)) ?? null;
}

export function buildComputerUseMarketplaceKit(): Record<string, unknown> {
  const runtime = getCurrentComputerUseRuntimeDescriptor();
  const bundleDescriptor = getCurrentComputerUseKitBundleDescriptor();
  return {
    id: ComputerUseKitId.BuiltIn,
    name: ComputerUseKitMetadata.Name,
    description: ComputerUseKitMetadata.Description,
    icon: COMPUTER_USE_KIT_ICON_URL,
    author: 'LobsterAI',
    version: runtime?.version ?? '0.0.0',
    tryAsking: [
      {
        en: 'Open a desktop app and type a short note',
        zh: '打开一个桌面应用并输入一段简短笔记',
      },
      {
        en: 'List the desktop applications I can control',
        zh: '列出可以操作的桌面应用',
      },
    ],
    skills: {
      bundle: bundleDescriptor?.bundle ?? ComputerUseKitBundle.WindowsX64,
      bundleSha256: bundleDescriptor?.sha256 ?? ComputerUseKitBundleIntegrity.WindowsX64.Sha256,
      bundleSizeBytes: bundleDescriptor?.sizeBytes ?? ComputerUseKitBundleIntegrity.WindowsX64.SizeBytes,
      list: [
        {
          id: ComputerUseSkillId.BuiltIn,
          name: ComputerUseKitMetadata.SkillName,
          description: ComputerUseKitMetadata.SkillDescription,
        },
      ],
    },
    mcpServers: [COMPUTER_USE_MCP_REF],
    connectors: [],
  };
}

export function getInstalledKitsMap(store: SqliteStore): InstalledKitsMap {
  return store.get<InstalledKitsMap>(KitStoreKey.Installed) ?? {};
}

export function isComputerUseKitInstalled(store: SqliteStore): boolean {
  return isComputerUseKitSupportedPlatform()
    && Boolean(getInstalledKitsMap(store)[ComputerUseKitId.BuiltIn]);
}

export function buildInstalledComputerUseKitRecord(
  skillIds: string[],
  metadata: Record<string, KitSkillMetadata>,
): InstalledKitRecord {
  const runtime = getCurrentComputerUseRuntimeDescriptor();
  const skills: InstalledKitSkills = {
    skillIds,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  return {
    id: ComputerUseKitId.BuiltIn,
    version: runtime?.version ?? '0.0.0',
    installedAt: Date.now(),
    skills,
    mcpServers: [COMPUTER_USE_MCP_REF],
    connectors: [],
  };
}

function getUserComputerUseSkillDir(): string {
  return path.join(app.getPath('userData'), SKILLS_DIR_NAME, ComputerUseSkillId.BuiltIn);
}

export function removeComputerUseSkillArtifacts(store: SqliteStore): void {
  fs.rmSync(getUserComputerUseSkillDir(), { recursive: true, force: true });
  const stateMap = store.get<SkillStateMap>(SKILL_STATE_KEY) ?? {};
  delete stateMap[ComputerUseSkillId.BuiltIn];
  store.set(SKILL_STATE_KEY, stateMap);
}
