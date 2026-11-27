import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { SKIN_PACK_RESOURCE_DIR_NAME } from '../../shared/skills/constants';
import { SkinPackKitId, SkinPackSkillId } from '../../shared/skin/kit';
import { cpRecursiveSync } from '../fsCompat';

const SKILL_FILE_NAME = 'SKILL.md';
const SKILLS_STATE_KEY = 'skills_state';

type InstalledKitsMap = Record<string, InstalledKitRecord>;
type SkillStateMap = Record<string, { enabled: boolean }>;

export interface SkinPackSkillStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

function hasSkillDefinition(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, SKILL_FILE_NAME)).isFile();
  } catch {
    return false;
  }
}

export function isSkinPackKitInstalled(store: Pick<SkinPackSkillStore, 'get'>): boolean {
  const installed = store.get<InstalledKitsMap>(KitStoreKey.Installed);
  return Boolean(installed?.[SkinPackKitId.BuiltIn]);
}

export function resolveBundledSkinCreatorSkillDir(options?: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  cwd?: string;
}): string | null {
  const isPackaged = options?.isPackaged ?? app?.isPackaged ?? false;
  const resourcesPath = options?.resourcesPath ?? process.resourcesPath ?? '';
  const appPath = options?.appPath ?? (typeof app?.getAppPath === 'function' ? app.getAppPath() : '');
  const cwd = options?.cwd ?? process.cwd();

  const candidates = isPackaged
    ? [
      path.join(resourcesPath, SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn),
      path.join(appPath, 'resources', SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn),
    ]
    : [
      path.join(__dirname, '..', '..', '..', 'resources', SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn),
      path.join(__dirname, '..', '..', 'resources', SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn),
      ...(appPath ? [path.join(appPath, 'resources', SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn)] : []),
      path.join(cwd, 'resources', SKIN_PACK_RESOURCE_DIR_NAME, SkinPackSkillId.BuiltIn),
    ];

  for (const candidate of candidates) {
    if (candidate && hasSkillDefinition(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function installSkinCreatorSkillToUserRoot(
  skillsRoot: string,
  sourceDir?: string | null,
): boolean {
  const resolvedSource = sourceDir === undefined ? resolveBundledSkinCreatorSkillDir() : sourceDir;
  if (!resolvedSource || !hasSkillDefinition(resolvedSource)) {
    return false;
  }

  fs.mkdirSync(skillsRoot, { recursive: true });
  const targetDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  cpRecursiveSync(resolvedSource, targetDir, { dereference: true, force: true });
  return hasSkillDefinition(targetDir);
}

export function removeSkinCreatorSkillFromUserRoot(
  skillsRoot: string,
  store: SkinPackSkillStore,
): void {
  const targetDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
  const upgradingDir = path.join(skillsRoot, `${SkinPackSkillId.BuiltIn}.upgrading`);
  for (const dir of [targetDir, upgradingDir]) {
    if (!fs.existsSync(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      console.warn(`[SkinPackKit] Failed to remove skin-creator skill artifacts at ${dir}:`, error);
    }
  }

  const stateMap = store.get<SkillStateMap>(SKILLS_STATE_KEY);
  if (stateMap && typeof stateMap === 'object' && !Array.isArray(stateMap) && SkinPackSkillId.BuiltIn in stateMap) {
    const next = { ...stateMap };
    delete next[SkinPackSkillId.BuiltIn];
    store.set(SKILLS_STATE_KEY, next);
  }
}

/**
 * Keep `<userData>/SKILLs/skin-creator` aligned with the `ai-skin-designer`
 * Kit installation state on startup:
 * - Installed: refresh skill files from bundled `resources/skin-pack/skin-creator`.
 * - Not installed: clean up any legacy bundled copy left behind by older app releases.
 */
export function syncSkinCreatorSkillOnStartup(
  skillsRoot: string,
  store: SkinPackSkillStore,
  sourceDir?: string | null,
): void {
  if (isSkinPackKitInstalled(store)) {
    const resolvedSource = sourceDir === undefined ? resolveBundledSkinCreatorSkillDir() : sourceDir;
    if (!resolvedSource) {
      console.warn('[SkinPackKit] Bundled skin-creator resource directory not found during startup refresh');
      return;
    }
    try {
      installSkinCreatorSkillToUserRoot(skillsRoot, resolvedSource);
    } catch (error) {
      console.warn('[SkinPackKit] Failed to refresh skin-creator skill on startup:', error);
    }
    return;
  }

  const legacyDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
  const legacyUpgrading = path.join(skillsRoot, `${SkinPackSkillId.BuiltIn}.upgrading`);
  const stateMap = store.get<SkillStateMap>(SKILLS_STATE_KEY);
  const hasLegacyState = Boolean(
    stateMap && typeof stateMap === 'object' && !Array.isArray(stateMap) && SkinPackSkillId.BuiltIn in stateMap,
  );
  if (fs.existsSync(legacyDir) || fs.existsSync(legacyUpgrading) || hasLegacyState) {
    removeSkinCreatorSkillFromUserRoot(skillsRoot, store);
  }
}
