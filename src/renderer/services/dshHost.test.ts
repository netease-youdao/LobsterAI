import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import {
  DEFAULT_DSH_AGENT_PRESET_SETTINGS,
  dispatchOpenEmbeddedPlugin,
  DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT,
  DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY,
  DSH_OPEN_EMBEDDED_PLUGIN_EVENT,
  DSH_PERMISSION_PRESET_CHANGED_EVENT,
  DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY,
  DSH_PLUGINS_CHANGED_EVENT,
  dshHostService,
  loadDshAgentPresetSettings,
  loadDshPluginInstallRegistry,
  mapDshPluginModelsToStoreModels,
  sanitizeDshAgentPresetSettings,
  sanitizePersistedInstallRegistryChoice,
  saveDshAgentPresetSettings,
  saveDshPluginInstallRegistry,
  shouldApplyPermissionPresetEvent,
} from './dshHost';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shouldApplyPermissionPresetEvent', () => {
  test('isolates per-session events so Session B and Home ignore Session A switches', () => {
    const detail = {
      preset: DshPermissionPreset.FullAccess,
      defaultPreset: DshPermissionPreset.WorkspaceWrite,
      sessionId: 'session-a',
    };

    expect(shouldApplyPermissionPresetEvent('session-a', detail)).toEqual({
      apply: true,
      nextPreset: DshPermissionPreset.FullAccess,
    });
    expect(shouldApplyPermissionPresetEvent('session-b', detail)).toEqual({
      apply: false,
    });
    expect(shouldApplyPermissionPresetEvent(undefined, detail)).toEqual({
      apply: false,
    });
    expect(shouldApplyPermissionPresetEvent(null, detail)).toEqual({
      apply: false,
    });
  });

  test('applies global default events directly to Home and requests refetch for active sessions', () => {
    const detail = {
      preset: DshPermissionPreset.ReadOnly,
      defaultPreset: DshPermissionPreset.ReadOnly,
    };

    expect(shouldApplyPermissionPresetEvent(undefined, detail)).toEqual({
      apply: true,
      nextPreset: DshPermissionPreset.ReadOnly,
    });
    expect(shouldApplyPermissionPresetEvent('session-b', detail)).toEqual({
      apply: false,
      refetch: true,
    });
  });
});

describe('dshHostService.setPermissionPreset', () => {
  test('forwards sessionId and dispatches session-scoped event without clobbering defaultPreset', async () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    const setPermissionPreset = vi.fn(async () => ({
      ok: true,
      preset: DshPermissionPreset.FullAccess,
      defaultPreset: DshPermissionPreset.WorkspaceWrite,
    }));

    vi.stubGlobal('CustomEvent', class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      electron: { dshHost: { setPermissionPreset } },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        dispatched.push(event);
        return true;
      },
    });

    await dshHostService.setPermissionPreset(DshPermissionPreset.FullAccess, 'session-a');

    expect(setPermissionPreset).toHaveBeenCalledWith(DshPermissionPreset.FullAccess, 'session-a');
    expect(dispatched).toEqual([
      {
        type: DSH_PERMISSION_PRESET_CHANGED_EVENT,
        detail: {
          preset: DshPermissionPreset.FullAccess,
          defaultPreset: DshPermissionPreset.WorkspaceWrite,
          sessionId: 'session-a',
        },
      },
    ]);
  });
});

describe('dshHostService plugin operations', () => {
  test('forwards inspect, install, cancel, registries, local dir picker, and copy CLI calls', async () => {
    const inspectPlugin = vi.fn(async () => ({ ok: true, status: 'accepted' as const }));
    const installPlugin = vi.fn(async () => ({ ok: true, restartRequired: false }));
    const cancelPluginInstall = vi.fn(async () => ({ ok: true, status: 'cancelled' as const }));
    const getPluginRegistries = vi.fn(async () => ({ ok: true, fastest: 'https://registry.npmmirror.com/' }));
    const pickLocalPluginDir = vi.fn(async () => ({ ok: true, canceled: false, path: '/tmp/plugin' }));
    const copyCliShimCommand = vi.fn(async () => ({ ok: true, cliShimPath: '/tmp/bin/dsh' }));

    vi.stubGlobal('window', {
      electron: {
        dshHost: {
          inspectPlugin,
          installPlugin,
          cancelPluginInstall,
          getPluginRegistries,
          pickLocalPluginDir,
          copyCliShimCommand,
        },
      },
    });

    await dshHostService.inspectPlugin({ spec: '@acme/tool', registry: 'https://registry.npmmirror.com/' });
    expect(inspectPlugin).toHaveBeenCalledWith({
      spec: '@acme/tool',
      registry: 'https://registry.npmmirror.com/',
    });

    await dshHostService.installPlugin({ spec: '@acme/tool', requestId: 'r-1', enabled: true });
    expect(installPlugin).toHaveBeenCalledWith({ spec: '@acme/tool', requestId: 'r-1', enabled: true });

    await dshHostService.cancelPluginInstall('r-1');
    expect(cancelPluginInstall).toHaveBeenCalledWith('r-1');

    expect(await dshHostService.getPluginRegistries()).toEqual({
      ok: true,
      fastest: 'https://registry.npmmirror.com/',
    });
    expect(await dshHostService.pickLocalPluginDir()).toEqual({
      ok: true,
      canceled: false,
      path: '/tmp/plugin',
    });
    expect(await dshHostService.copyCliShimCommand()).toEqual({
      ok: true,
      cliShimPath: '/tmp/bin/dsh',
    });
  });

  test('dispatches DSH_PLUGINS_CHANGED_EVENT on successful plugin mutations and DSH_OPEN_EMBEDDED_PLUGIN_EVENT', async () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    const samplePlugins = [
      { name: 'dsh-media-desk', specifier: '^2.7.2', managed: false, enabled: true, panelId: 'media-desk' },
    ];
    const installPlugin = vi.fn(async () => ({ ok: true, plugins: samplePlugins }));
    const setPluginEnabled = vi.fn(async () => ({ ok: true, plugins: samplePlugins }));
    const removePlugin = vi.fn(async () => ({ ok: true, plugins: [] }));

    vi.stubGlobal('CustomEvent', class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      electron: {
        dshHost: {
          installPlugin,
          setPluginEnabled,
          removePlugin,
        },
      },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        dispatched.push(event);
        return true;
      },
    });

    await dshHostService.installPlugin({ spec: 'dsh-media-desk' });
    await dshHostService.setPluginEnabled('dsh-media-desk', false);
    await dshHostService.removePlugin('dsh-media-desk');
    dispatchOpenEmbeddedPlugin({ name: 'dsh-media-desk', panelId: 'media-desk', title: '自媒体工作台' });

    expect(dispatched).toEqual([
      { type: DSH_PLUGINS_CHANGED_EVENT, detail: { plugins: samplePlugins } },
      { type: DSH_PLUGINS_CHANGED_EVENT, detail: { plugins: samplePlugins } },
      { type: DSH_PLUGINS_CHANGED_EVENT, detail: { plugins: [] } },
      {
        type: DSH_OPEN_EMBEDDED_PLUGIN_EVENT,
        detail: { name: 'dsh-media-desk', panelId: 'media-desk', title: '自媒体工作台' },
      },
    ]);
  });

  test('forwards checkPluginVersions, updatePlugin, and event subscriptions', async () => {
    const dispatched: Array<{ type: string; detail: unknown }> = [];
    const updatedPlugins = [
      { name: '@acme/tool', specifier: '1.2.0', managed: false, enabled: true, version: '1.2.0' },
    ];
    const checkPluginVersions = vi.fn(async () => ({
      ok: true,
      checkedAt: 1234,
      list: {
        status: 'listed' as const,
        installed: '1.0.0',
        registry: 'https://registry.npmmirror.com/',
        attempts: [],
        versions: [],
        omitted: 0,
      },
    }));
    const updatePlugin = vi.fn(async () => ({
      ok: true,
      outcome: 'applied' as const,
      from: '1.0.0',
      to: '1.2.0',
      plugins: updatedPlugins,
    }));
    const unsubUpdate = vi.fn();
    const unsubChanged = vi.fn();
    const onPluginUpdateState = vi.fn(() => unsubUpdate);
    const onPluginsChanged = vi.fn(() => unsubChanged);

    vi.stubGlobal('CustomEvent', class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      electron: {
        dshHost: {
          checkPluginVersions,
          updatePlugin,
          onPluginUpdateState,
          onPluginsChanged,
        },
      },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        dispatched.push(event);
        return true;
      },
    });

    const versionsRes = await dshHostService.checkPluginVersions({ name: '@acme/tool' });
    expect(checkPluginVersions).toHaveBeenCalledWith({ name: '@acme/tool' });
    expect(versionsRes.ok).toBe(true);

    const updateRes = await dshHostService.updatePlugin({
      name: '@acme/tool',
      version: '1.2.0',
      registry: 'https://registry.npmmirror.com/',
      requestId: 'upd-1',
    });
    expect(updatePlugin).toHaveBeenCalledWith({
      name: '@acme/tool',
      version: '1.2.0',
      registry: 'https://registry.npmmirror.com/',
      requestId: 'upd-1',
    });
    expect(updateRes.ok).toBe(true);
    expect(dispatched).toEqual([
      { type: DSH_PLUGINS_CHANGED_EVENT, detail: { plugins: updatedPlugins } },
    ]);

    const offUpdate = dshHostService.onPluginUpdateState(() => undefined);
    const offChanged = dshHostService.onPluginsChanged(() => undefined);
    offUpdate();
    offChanged();
    expect(onPluginUpdateState).toHaveBeenCalledTimes(1);
    expect(onPluginsChanged).toHaveBeenCalledTimes(1);
    expect(unsubUpdate).toHaveBeenCalledTimes(1);
    expect(unsubChanged).toHaveBeenCalledTimes(1);
  });

  test('forwards install state/log subscriptions and persists install registry choice', async () => {
    const unsubState = vi.fn();
    const unsubLog = vi.fn();
    const onPluginInstallState = vi.fn(() => unsubState);
    const onPluginInstallLog = vi.fn(() => unsubLog);
    const storeGet = vi.fn(async () => ({ kind: 'offered', registry: 'https://registry.npmmirror.com/' }));
    const storeSet = vi.fn(async () => undefined);

    vi.stubGlobal('window', {
      electron: {
        dshHost: {
          onPluginInstallState,
          onPluginInstallLog,
        },
        store: {
          get: storeGet,
          set: storeSet,
        },
      },
    });

    const offState = dshHostService.onPluginInstallState(() => undefined);
    const offLog = dshHostService.onPluginInstallLog(() => undefined);
    offState();
    offLog();
    expect(onPluginInstallState).toHaveBeenCalledTimes(1);
    expect(onPluginInstallLog).toHaveBeenCalledTimes(1);
    expect(unsubState).toHaveBeenCalledTimes(1);
    expect(unsubLog).toHaveBeenCalledTimes(1);

    expect(await loadDshPluginInstallRegistry()).toEqual({
      kind: 'offered',
      registry: 'https://registry.npmmirror.com/',
    });
    expect(storeGet).toHaveBeenCalledWith(DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY);

    await saveDshPluginInstallRegistry({ kind: 'custom', url: ' https://npm.corp.example/ ' });
    expect(storeSet).toHaveBeenCalledWith(DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY, {
      kind: 'custom',
      url: 'https://npm.corp.example/',
    });

    expect(sanitizePersistedInstallRegistryChoice({ kind: 'offered', registry: null })).toEqual({
      kind: 'offered',
      registry: null,
    });
    expect(sanitizePersistedInstallRegistryChoice({ kind: 'custom', url: '   ' })).toBeNull();
    expect(sanitizePersistedInstallRegistryChoice('invalid')).toBeNull();
  });

  test('maps DSH plugin models to store models with thinking config and handles listPluginModels gracefully', async () => {
    const mapped = mapDshPluginModelsToStoreModels([
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        providerId: 'our-free-model',
        providerName: 'Our Free Model',
        description: 'Free route',
        badge: 'Free',
        defaultReasoningEffort: 'high',
        reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
      },
    ]);
    expect(mapped).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        provider: 'Our Free Model',
        providerKey: 'our-free-model',
        openClawProviderId: 'our-free-model',
        isDshPluginModel: true,
        dshPluginBadge: 'Free',
        description: 'Free route',
        supportsThinking: true,
        thinkingConfig: {
          defaultLevel: 'high',
          options: [
            { level: 'low', openclawLevel: 'low' },
            { level: 'high', openclawLevel: 'high' },
          ],
        },
      },
    ]);

    // Missing preload method fails soft without throwing.
    vi.stubGlobal('window', { electron: { dshHost: {} } });
    expect(await dshHostService.listPluginModels()).toMatchObject({ ok: false, models: [], groups: [] });

    const listPluginModels = vi.fn(async () => ({
      ok: true,
      groups: [],
      models: [],
      failures: [],
      fetchedAt: 99,
    }));
    vi.stubGlobal('window', { electron: { dshHost: { listPluginModels } } });
    expect(await dshHostService.listPluginModels({ forceRefresh: true })).toMatchObject({
      ok: true,
      fetchedAt: 99,
    });
    expect(listPluginModels).toHaveBeenCalledWith({ forceRefresh: true });
  });

  test('forwards listAgentPresets and listPluginSkills and fails soft when unavailable', async () => {
    vi.stubGlobal('window', { electron: { dshHost: {} } });
    expect(await dshHostService.listAgentPresets()).toMatchObject({
      ok: false,
      presets: [],
      usablePresets: [],
      hasThirdPartyPresets: false,
    });
    expect(await dshHostService.listPluginSkills()).toMatchObject({
      ok: false,
      skills: [],
    });

    const listAgentPresets = vi.fn(async () => ({
      ok: true,
      presets: [
        { id: 'lobsterai', name: 'LobsterAI', isDefault: true },
        { id: 'pi', name: 'Pi', isDefault: false },
      ],
      usablePresets: [
        { id: 'lobsterai', name: 'LobsterAI', isDefault: true },
        { id: 'pi', name: 'Pi', isDefault: false },
      ],
      hasThirdPartyPresets: true,
      defaultPresetId: 'lobsterai',
    }));
    const listPluginSkills = vi.fn(async () => ({
      ok: true,
      skills: [
        {
          name: 'design-audit',
          description: 'Review UI design',
          provider: 'dsh-guizang-design',
          modelInvocable: true,
          userInvocable: true,
        },
      ],
    }));

    vi.stubGlobal('window', { electron: { dshHost: { listAgentPresets, listPluginSkills } } });

    const presetsRes = await dshHostService.listAgentPresets();
    expect(listAgentPresets).toHaveBeenCalledTimes(1);
    expect(presetsRes.ok).toBe(true);
    expect(presetsRes.hasThirdPartyPresets).toBe(true);

    const skillsRes = await dshHostService.listPluginSkills({ cwd: '/work/demo' });
    expect(listPluginSkills).toHaveBeenCalledWith({ cwd: '/work/demo' });
    expect(skillsRes.ok).toBe(true);
    expect(skillsRes.skills).toHaveLength(1);
  });

  test('sanitizes, persists, and broadcasts DSH agent preset settings', async () => {
    expect(sanitizeDshAgentPresetSettings(null)).toEqual(DEFAULT_DSH_AGENT_PRESET_SETTINGS);
    expect(sanitizeDshAgentPresetSettings({ enabled: true, defaultPresetId: '  ' })).toEqual({
      enabled: true,
      defaultPresetId: 'lobsterai',
    });

    const dispatched: Array<{ type: string; detail: unknown }> = [];
    const storeGet = vi.fn(async () => ({
      enabled: true,
      defaultPresetId: 'pi-plus',
    }));
    const storeSet = vi.fn(async () => undefined);

    vi.stubGlobal('CustomEvent', class MockCustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', {
      electron: { store: { get: storeGet, set: storeSet } },
      dispatchEvent: (event: { type: string; detail: unknown }) => {
        dispatched.push(event);
        return true;
      },
    });

    expect(await loadDshAgentPresetSettings()).toEqual({
      enabled: true,
      defaultPresetId: 'pi-plus',
    });
    expect(storeGet).toHaveBeenCalledWith(DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY);

    const saved = await saveDshAgentPresetSettings({
      enabled: true,
      defaultPresetId: ' pi ',
    });
    expect(saved).toEqual({
      enabled: true,
      defaultPresetId: 'pi',
    });
    expect(storeSet).toHaveBeenCalledWith(DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY, saved);
    expect(dispatched).toEqual([
      { type: DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, detail: saved },
    ]);
  });
});
