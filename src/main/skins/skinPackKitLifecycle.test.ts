import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '', getAppPath: () => '', isPackaged: false },
}));

import { KitStoreKey } from '../../shared/kit/constants';
import { SkinWorkflowKind } from '../../shared/skin/constants';
import {
  SkinPackKitBundle,
  SkinPackKitId,
  SkinPackSkillId,
} from '../../shared/skin/kit';
import { createSkinPackKitLifecycle } from './skinPackKitLifecycle';
import { syncSkinCreatorSkillOnStartup } from './skinPackSkillResources';

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

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skin-kit-'));
  tempRoots.push(dir);
  return dir;
}

function writeSkillSource(root: string, body = '# Skin Creator\n'): string {
  const dir = path.join(root, 'resources', 'skin-pack', SkinPackSkillId.BuiltIn);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: skin-creator\ndescription: Skin creator\n---\n${body}`);
  return dir;
}

function createHarness(options?: { withSource?: boolean }) {
  const root = createTempDir();
  const skillsRoot = path.join(root, 'SKILLs');
  fs.mkdirSync(skillsRoot, { recursive: true });
  const sourceDir = options?.withSource === false ? null : writeSkillSource(root);
  const store = new MemoryStore();
  const skillManager = {
    getSkillsRoot: vi.fn(() => skillsRoot),
    setSkillEnabled: vi.fn(),
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
  };
  const notifySkillsChanged = vi.fn();
  const syncOpenClawConfig = vi.fn(async () => ({ success: true, changed: true }));
  const lifecycle = createSkinPackKitLifecycle({
    getStore: () => store,
    getSkillManager: () => skillManager,
    notifySkillsChanged,
    resolveSkinCreatorSourceDir: () => sourceDir,
    syncOpenClawConfig,
  });

  return {
    lifecycle,
    notifySkillsChanged,
    skillManager,
    skillsRoot,
    sourceDir,
    store,
    syncOpenClawConfig,
  };
}

describe('AI Skin Designer kit lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test('installs the trusted record by copying skin-creator from resources and enabling it', async () => {
    const {
      lifecycle,
      notifySkillsChanged,
      skillManager,
      skillsRoot,
      store,
      syncOpenClawConfig,
    } = createHarness();

    await expect(lifecycle.installIfHandled({
      kitId: SkinPackKitId.BuiltIn,
      bundleUrl: SkinPackKitBundle.BuiltIn,
    })).resolves.toEqual({ success: true, skillIds: [SkinPackSkillId.BuiltIn] });

    expect(fs.existsSync(path.join(skillsRoot, SkinPackSkillId.BuiltIn, 'SKILL.md'))).toBe(true);
    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.setSkillEnabled).toHaveBeenCalledWith(SkinPackSkillId.BuiltIn, true);
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).toHaveBeenCalledOnce();
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'ai-skin-designer-kit-installed',
      expectedImpact: 'sync',
    });
    expect(store.get<Record<string, { workflowKind?: string }>>(KitStoreKey.Installed))
      .toMatchObject({
        [SkinPackKitId.BuiltIn]: {
          workflowKind: SkinWorkflowKind.SkinPack,
        },
      });
  });

  test('restores the watcher if the skin-creator resource directory is unavailable', async () => {
    const { lifecycle, notifySkillsChanged, skillManager } = createHarness({ withSource: false });

    await expect(lifecycle.installIfHandled({
      kitId: SkinPackKitId.BuiltIn,
      bundleUrl: SkinPackKitBundle.BuiltIn,
    })).rejects.toThrow('Bundled AI Skin Creator skill is unavailable');

    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).not.toHaveBeenCalled();
  });

  test('uninstalls by removing skin-creator files and state', async () => {
    const {
      lifecycle,
      notifySkillsChanged,
      skillManager,
      skillsRoot,
      store,
      syncOpenClawConfig,
    } = createHarness();
    const targetDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'SKILL.md'), '# installed\n');
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

    expect(fs.existsSync(targetDir)).toBe(false);
    expect(store.get(KitStoreKey.Installed)).toEqual({});
    expect(store.get(SKILLS_STATE_KEY)).toEqual({});
    expect(skillManager.stopWatching).toHaveBeenCalledOnce();
    expect(skillManager.startWatching).toHaveBeenCalledOnce();
    expect(notifySkillsChanged).toHaveBeenCalledOnce();
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'ai-skin-designer-kit-uninstalled',
      expectedImpact: 'sync',
    });
  });

  test('startup sync refreshes installed kit copy and removes legacy copy when kit is not installed', () => {
    const root = createTempDir();
    const skillsRoot = path.join(root, 'SKILLs');
    const sourceDir = writeSkillSource(root, '# Updated Skin Creator\n');
    const installedDir = path.join(skillsRoot, SkinPackSkillId.BuiltIn);
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, 'SKILL.md'), '# Stale\n');

    const installedStore = new MemoryStore();
    installedStore.set(KitStoreKey.Installed, {
      [SkinPackKitId.BuiltIn]: { id: SkinPackKitId.BuiltIn, version: '0.4.0', installedAt: 1 },
    });
    syncSkinCreatorSkillOnStartup(skillsRoot, installedStore, sourceDir);
    expect(fs.readFileSync(path.join(installedDir, 'SKILL.md'), 'utf8')).toContain('# Updated Skin Creator');

    const cleanStore = new MemoryStore();
    cleanStore.set(SKILLS_STATE_KEY, { [SkinPackSkillId.BuiltIn]: { enabled: false }, other: { enabled: true } });
    syncSkinCreatorSkillOnStartup(skillsRoot, cleanStore, sourceDir);
    expect(fs.existsSync(installedDir)).toBe(false);
    expect(cleanStore.get(SKILLS_STATE_KEY)).toEqual({ other: { enabled: true } });
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

  test('install and uninstall preserve a previous third-party kit using the same skill ID', async () => {
    const { lifecycle, skillsRoot, sourceDir, store } = createHarness();
    const id = SkinPackSkillId.BuiltIn;
    const userId = `${id}-1`;
    fs.cpSync(sourceDir!, path.join(skillsRoot, id), { recursive: true });
    const skills = { skillIds: [id], metadata: { [id]: { id, name: 'Custom skin' } } };
    store.set(KitStoreKey.Installed, { custom: { id: 'custom', skills } });
    store.set(SKILLS_STATE_KEY, { [id]: { enabled: false } });

    await lifecycle.installIfHandled({ kitId: SkinPackKitId.BuiltIn, bundleUrl: SkinPackKitBundle.BuiltIn });
    await lifecycle.uninstallIfHandled(SkinPackKitId.BuiltIn);

    expect(fs.existsSync(path.join(skillsRoot, id))).toBe(false);
    expect(fs.readFileSync(path.join(skillsRoot, userId, 'SKILL.md')))
      .toEqual(fs.readFileSync(path.join(sourceDir!, 'SKILL.md')));
    expect(store.get(SKILLS_STATE_KEY)).toEqual({ [userId]: { enabled: false } });
    expect(store.get(KitStoreKey.Installed)).toMatchObject({
      custom: { skills: { skillIds: [userId], metadata: { [userId]: { id: userId, name: 'Custom skin' } } } },
    });
  });
});
