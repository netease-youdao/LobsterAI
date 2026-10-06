import { beforeEach, describe, expect, test, vi } from 'vitest';

import { KitStoreKey } from '../../shared/kit/constants';
import { SkinWorkflowKind } from '../../shared/skin/constants';
import {
  SkinPackKitBundle,
  SkinPackKitId,
  SkinPackSkillId,
} from '../../shared/skin/kit';
import { OpenClawConfigImpact } from '../libs/openclawConfigImpact';
import { createSkinPackKitLifecycle } from './skinPackKitLifecycle';

const SKILLS_STATE_KEY = 'skills_state';

class MemoryStore {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }
}

function createHarness(skills: Array<{ id: string }> = [{ id: SkinPackSkillId.BuiltIn }]) {
  const store = new MemoryStore();
  const skillManager = {
    listSkills: vi.fn(() => skills),
    setSkillEnabled: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
    syncBundledSkillsToUserData: vi.fn(),
  };
  const notifySkillsChanged = vi.fn();
  const syncOpenClawConfig = vi.fn(async () => ({ success: true, changed: true }));
  const lifecycle = createSkinPackKitLifecycle({
    getStore: () => store,
    getSkillManager: () => skillManager,
    notifySkillsChanged,
    syncOpenClawConfig,
  });

  return {
    lifecycle,
    notifySkillsChanged,
    skillManager,
    store,
    syncOpenClawConfig,
  };
}

describe('AI Skin Designer kit lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('adds one current skin kit while preserving remote and additional built-ins', () => {
    const { lifecycle } = createHarness();
    const additionalKit = { id: 'computer-use', version: 'test' };
    const response = lifecycle.appendToStoreResponse(JSON.stringify({
      data: {
        value: JSON.stringify({
          kits: [
            { id: 'remote-kit' },
            { id: SkinPackKitId.BuiltIn, version: 'stale' },
            { id: additionalKit.id, version: 'stale' },
          ],
        }),
      },
    }), [additionalKit]);

    const envelope = JSON.parse(response) as { data: { value: string } };
    const catalog = JSON.parse(envelope.data.value) as { kits: Array<{ id: string; version?: string }> };
    expect(catalog.kits.map(kit => kit.id)).toEqual([
      'remote-kit',
      SkinPackKitId.BuiltIn,
      additionalKit.id,
    ]);
    expect(catalog.kits.filter(kit => kit.id === SkinPackKitId.BuiltIn)).toHaveLength(1);
    expect(catalog.kits.at(-1)).toEqual(additionalKit);
  });

  test('builds an offline catalog containing the skin kit', () => {
    const { lifecycle } = createHarness();
    const response = lifecycle.buildOfflineStoreResponse();
    const envelope = JSON.parse(response) as { data: { value: { kits: Array<{ id: string }> } } };

    expect(envelope.data.value.kits.map(kit => kit.id)).toEqual([SkinPackKitId.BuiltIn]);
  });

  test('installs the trusted record and enables the bundled skill', async () => {
    const {
      lifecycle,
      notifySkillsChanged,
      skillManager,
      store,
      syncOpenClawConfig,
    } = createHarness();

    await expect(lifecycle.installIfHandled({
      kitId: SkinPackKitId.BuiltIn,
      bundleUrl: SkinPackKitBundle.BuiltIn,
    })).resolves.toEqual({ success: true, skillIds: [SkinPackSkillId.BuiltIn] });

    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.syncBundledSkillsToUserData).toHaveBeenCalledOnce();
    expect(skillManager.setSkillEnabled).toHaveBeenCalledWith(SkinPackSkillId.BuiltIn, true);
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).toHaveBeenCalledOnce();
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'ai-skin-designer-kit-installed',
      expectedImpact: OpenClawConfigImpact.Sync,
    });
    expect(store.get<Record<string, { workflowKind?: string }>>(KitStoreKey.Installed))
      .toMatchObject({
        [SkinPackKitId.BuiltIn]: {
          workflowKind: SkinWorkflowKind.SkinPack,
        },
      });
  });

  test('restores the watcher if the bundled skill is unavailable', async () => {
    const { lifecycle, notifySkillsChanged, skillManager } = createHarness([]);

    await expect(lifecycle.installIfHandled({
      kitId: SkinPackKitId.BuiltIn,
      bundleUrl: SkinPackKitBundle.BuiltIn,
    })).rejects.toThrow('Bundled AI Skin Creator skill is unavailable');

    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).not.toHaveBeenCalled();
  });

  test('uninstalls by disabling, but retaining, the bundled skill', async () => {
    const {
      lifecycle,
      notifySkillsChanged,
      skillManager,
      store,
      syncOpenClawConfig,
    } = createHarness();
    store.set(KitStoreKey.Installed, {
      [SkinPackKitId.BuiltIn]: {
        id: SkinPackKitId.BuiltIn,
        version: '0.1.0',
        installedAt: 1,
        skills: { skillIds: [SkinPackSkillId.BuiltIn] },
        mcpServers: [],
        connectors: [],
      },
    });
    store.set(SKILLS_STATE_KEY, {
      [SkinPackSkillId.BuiltIn]: { enabled: true },
    });

    await expect(lifecycle.uninstallIfHandled(SkinPackKitId.BuiltIn))
      .resolves.toEqual({ success: true });

    expect(store.get(KitStoreKey.Installed)).toEqual({});
    expect(store.get(SKILLS_STATE_KEY)).toEqual({
      [SkinPackSkillId.BuiltIn]: { enabled: false },
    });
    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).toHaveBeenCalledOnce();
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'ai-skin-designer-kit-uninstalled',
      expectedImpact: OpenClawConfigImpact.Sync,
    });
  });

  test('leaves unrelated kits to the generic handler', async () => {
    const { lifecycle, skillManager } = createHarness();

    await expect(lifecycle.installIfHandled({
      kitId: 'remote-kit',
      bundleUrl: 'https://example.com/kit.zip',
    })).resolves.toBeUndefined();
    await expect(lifecycle.uninstallIfHandled('remote-kit')).resolves.toBeUndefined();
    expect(skillManager.stopWatching).not.toHaveBeenCalled();
  });
});
