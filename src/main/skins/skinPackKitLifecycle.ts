import type { InstalledKitRecord } from '../../shared/kit/constants';
import { KitStoreKey } from '../../shared/kit/constants';
import {
  SkinPackKitBundle,
  SkinPackKitId,
  SkinPackSkillId,
} from '../../shared/skin/kit';
import { OpenClawConfigImpact } from '../libs/openclawConfigImpact';
import {
  buildInstalledSkinPackKitRecord,
  buildSkinPackMarketplaceKit,
} from './skinPackKit';

const SKILLS_STATE_KEY = 'skills_state';

type InstalledKitsMap = Record<string, InstalledKitRecord>;
type SkillStateMap = Record<string, { enabled: boolean }>;

interface SkinPackKitStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

interface SkinPackKitSkillManager {
  listSkills(): Array<{ id: string }>;
  setSkillEnabled(id: string, enabled: boolean): unknown;
  startWatching(): void;
  stopWatching(): void;
  syncBundledSkillsToUserData(): void;
}

export interface SkinPackKitLifecycleDeps {
  getStore: () => SkinPackKitStore;
  getSkillManager: () => SkinPackKitSkillManager;
  notifySkillsChanged: () => void;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean; error?: string }>;
}

export interface SkinPackKitInstallRequest {
  kitId: string;
  bundleUrl: string;
}

export interface SkinPackKitLifecycle {
  appendToStoreResponse(
    data: string,
    additionalBuiltInKits?: readonly Record<string, unknown>[],
  ): string;
  buildOfflineStoreResponse(
    additionalBuiltInKits?: readonly Record<string, unknown>[],
  ): string;
  installIfHandled(
    request: SkinPackKitInstallRequest,
  ): Promise<{ success: true; skillIds: string[] } | undefined>;
  uninstallIfHandled(
    kitId: string,
  ): Promise<{ success: boolean; error?: string } | undefined>;
}

function appendToStoreResponse(
  data: string,
  additionalBuiltInKits: readonly Record<string, unknown>[] = [],
): string {
  const parsed = JSON.parse(data) as Record<string, unknown>;
  const valueContainer = (parsed as { data?: { value?: unknown } }).data;
  const rawValue = valueContainer?.value;
  if (!valueContainer || !rawValue) {
    return data;
  }

  const value = typeof rawValue === 'string'
    ? JSON.parse(rawValue) as Record<string, unknown>
    : rawValue as Record<string, unknown>;
  const kits = Array.isArray(value.kits) ? value.kits : [];
  const builtInKits = [
    buildSkinPackMarketplaceKit(),
    ...additionalBuiltInKits,
  ];
  const builtInKitIds = new Set(builtInKits.map(kit => kit.id));
  const withoutDuplicate = kits.filter((kit) => (
    !kit
    || typeof kit !== 'object'
    || !builtInKitIds.has((kit as Record<string, unknown>).id)
  ));
  const nextValue = {
    ...value,
    kits: [
      ...withoutDuplicate,
      ...builtInKits,
    ],
  };

  valueContainer.value = typeof rawValue === 'string' ? JSON.stringify(nextValue) : nextValue;
  return JSON.stringify(parsed);
}

function buildOfflineStoreResponse(
  additionalBuiltInKits: readonly Record<string, unknown>[] = [],
): string {
  return appendToStoreResponse(JSON.stringify({
    data: {
      value: {
        kits: [],
      },
    },
  }), additionalBuiltInKits);
}

export function createSkinPackKitLifecycle(
  deps: SkinPackKitLifecycleDeps,
): SkinPackKitLifecycle {
  const withPausedSkillWatcher = async <T>(
    operation: (skillManager: SkinPackKitSkillManager) => Promise<T>,
  ): Promise<T> => {
    const skillManager = deps.getSkillManager();
    skillManager.stopWatching();
    let watcherRestarted = false;
    try {
      const result = await operation(skillManager);
      skillManager.startWatching();
      watcherRestarted = true;
      deps.notifySkillsChanged();
      return result;
    } finally {
      if (!watcherRestarted) {
        try {
          skillManager.startWatching();
        } catch (error) {
          console.warn('[SkinPackKit] Failed to restart skill watcher:', error);
        }
      }
    }
  };

  const installIfHandled = async (
    request: SkinPackKitInstallRequest,
  ): Promise<{ success: true; skillIds: string[] } | undefined> => {
    if (request.kitId !== SkinPackKitId.BuiltIn) {
      return undefined;
    }
    if (request.bundleUrl !== SkinPackKitBundle.BuiltIn) {
      throw new Error('AI Skin Designer kit bundle URL does not match the built-in catalog entry');
    }

    return withPausedSkillWatcher(async (skillManager) => {
      skillManager.syncBundledSkillsToUserData();
      const skinSkill = skillManager.listSkills().find(skill => skill.id === SkinPackSkillId.BuiltIn);
      if (!skinSkill) {
        throw new Error('Bundled AI Skin Creator skill is unavailable');
      }
      skillManager.setSkillEnabled(SkinPackSkillId.BuiltIn, true);

      const store = deps.getStore();
      const installedMap = store.get<InstalledKitsMap>(KitStoreKey.Installed) ?? {};
      installedMap[SkinPackKitId.BuiltIn] = buildInstalledSkinPackKitRecord();
      store.set(KitStoreKey.Installed, installedMap);

      const syncResult = await deps.syncOpenClawConfig({
        reason: 'ai-skin-designer-kit-installed',
        expectedImpact: OpenClawConfigImpact.Sync,
      });
      if (!syncResult.success) {
        throw new Error(syncResult.error || 'OpenClaw config sync failed after AI Skin Designer install');
      }

      console.log(`[SkinPackKit] Kit installed with bundled skill: ${SkinPackSkillId.BuiltIn}`);
      return { success: true, skillIds: [SkinPackSkillId.BuiltIn] };
    });
  };

  const uninstallIfHandled = async (
    kitId: string,
  ): Promise<{ success: boolean; error?: string } | undefined> => {
    if (kitId !== SkinPackKitId.BuiltIn) {
      return undefined;
    }

    const store = deps.getStore();
    const installedMap = store.get<InstalledKitsMap>(KitStoreKey.Installed) ?? {};
    if (!installedMap[kitId]) {
      return { success: false, error: `Kit "${kitId}" is not installed` };
    }

    return withPausedSkillWatcher(async () => {
      const stateMap = store.get<SkillStateMap>(SKILLS_STATE_KEY) ?? {};
      stateMap[SkinPackSkillId.BuiltIn] = { enabled: false };
      store.set(SKILLS_STATE_KEY, stateMap);

      delete installedMap[kitId];
      store.set(KitStoreKey.Installed, installedMap);

      const syncResult = await deps.syncOpenClawConfig({
        reason: 'ai-skin-designer-kit-uninstalled',
        expectedImpact: OpenClawConfigImpact.Sync,
      });
      if (!syncResult.success) {
        throw new Error(syncResult.error || 'OpenClaw config sync failed after AI Skin Designer uninstall');
      }

      console.log('[SkinPackKit] Kit uninstalled successfully');
      return { success: true };
    });
  };

  return {
    appendToStoreResponse,
    buildOfflineStoreResponse,
    installIfHandled,
    uninstallIfHandled,
  };
}
