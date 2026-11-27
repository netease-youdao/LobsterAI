import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import { type InstalledKitRecord, KitStoreKey } from '../../shared/kit/constants';
import { SKIN_PACK_RESOURCE_DIR_NAME } from '../../shared/skills/constants';
import { SkinPackKitId, SkinPackSkillId } from '../../shared/skin/kit';
import { cpRecursiveSync } from '../fsCompat';
import { removeTreeNoFollowSync } from '../libs/removeTreeNoFollow';
import { resolveSkillInstallTarget } from '../skills/skillInstallTarget';
import { isShippedSkinCreatorCopy } from './legacySkinCreator';

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
  removeTreeNoFollowSync(targetDir);
  cpRecursiveSync(resolvedSource, targetDir, { dereference: true, force: true });
  return hasSkillDefinition(targetDir);
}

export function removeSkinCreatorSkillFromUserRoot(
  skillsRoot: string,
  store: SkinPackSkillStore,
  sourceDir?: string | null,
): void {
  const targetDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
  const copies = [targetDir, `${targetDir}.upgrading`].filter(dir => fs.lstatSync(dir, { throwIfNoEntry: false }));
  let managedCopies = copies;
  let originalId: string = SkinPackSkillId.BuiltIn;
  if (copies.length && !isSkinPackKitInstalled(store)) {
    // A case-insensitive filesystem resolves the reserved path even if the imported ID was uppercase.
    const name = path.basename(copies[0]);
    const folderNames = fs.readdirSync(skillsRoot);
    const originalName = folderNames.includes(name) ? name : folderNames.find(entry => entry.toLowerCase() === name);
    originalId = (originalName ?? name).replace(/\.upgrading$/i, '');
    const bundled = sourceDir === undefined ? resolveBundledSkinCreatorSkillDir() : sourceDir;
    const kits = store.get<InstalledKitsMap>(KitStoreKey.Installed) ?? {};
    const ownedByOtherKit = Object.values(kits).some(kit => kit.skills?.skillIds?.includes(originalId));
    managedCopies = ownedByOtherKit ? [] : copies.filter(dir => isShippedSkinCreatorCopy(dir, bundled));
    const userCopies = copies.filter(dir => !managedCopies.includes(dir));
    if (userCopies.length) preserveUnownedSkinCreator(skillsRoot, originalId, userCopies, store, kits);
  }
  for (const dir of managedCopies) removeTreeNoFollowSync(dir);

  const stateMap = store.get<SkillStateMap>(SKILLS_STATE_KEY);
  if (stateMap && typeof stateMap === 'object' && !Array.isArray(stateMap) && originalId in stateMap) {
    const next = { ...stateMap };
    delete next[originalId];
    store.set(SKILLS_STATE_KEY, next);
  }
}

function preserveUnownedSkinCreator(
  skillsRoot: string, originalId: string, userCopies: string[], store: SkinPackSkillStore, kits: InstalledKitsMap,
): void {
  const { targetDir } = resolveSkillInstallTarget(skillsRoot, originalId);
  const userId = path.basename(targetDir);
  const state = store.get<SkillStateMap>(SKILLS_STATE_KEY);
  // Keep the old preference until cleanup completes. A failed rename can be retried.
  if (state?.[originalId]) store.set(SKILLS_STATE_KEY, { ...state, [userId]: state[originalId] });

  const changedKits: InstalledKitsMap = {};
  for (const [kitId, kit] of Object.entries(kits)) {
    const skills = kit.skills;
    if (!skills?.skillIds?.includes(originalId)) continue;
    const metadata = skills.metadata && { ...skills.metadata };
    if (metadata?.[originalId]) {
      metadata[userId] = { ...metadata[originalId], id: userId };
      delete metadata[originalId];
    }
    changedKits[kitId] = {
      ...kit,
      skills: {
        ...skills,
        skillIds: skills.skillIds.map(skillId => skillId === originalId ? userId : skillId),
        ...(metadata && { metadata }),
      },
    };
  }
  const moved: Array<{ from: string; to: string }> = [];
  try {
    // A lone backup is the recovered skill. Keep a pair together for normal upgrade recovery.
    for (const [index, from] of userCopies.entries()) {
      const to = index === 0 ? targetDir : `${targetDir}.upgrading`;
      fs.renameSync(from, to);
      moved.push({ from, to });
    }
    if (Object.keys(changedKits).length) {
      store.set(KitStoreKey.Installed, { ...kits, ...changedKits });
    }
  } catch (error) {
    for (const { from, to } of moved.reverse()) fs.renameSync(to, from);
    if (state?.[originalId]) store.set(SKILLS_STATE_KEY, state);
    throw error;
  }
  console.log(`[SkinPackKit] Preserved existing user skill at ${targetDir}`);
}

/**
 * Keep `<userData>/SKILLs/skin-creator` aligned with the `ai-skin-designer`
 * Kit installation state on startup:
 * - Installed: refresh skill files from bundled `resources/skin-pack/skin-creator`.
 * - Not installed: remove stock templates and recover user imports under a free ID.
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

  removeSkinCreatorSkillFromUserRoot(skillsRoot, store, sourceDir);
}
