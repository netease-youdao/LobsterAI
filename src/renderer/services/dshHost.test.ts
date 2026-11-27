import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import {
  dispatchOpenEmbeddedPlugin,
  DSH_OPEN_EMBEDDED_PLUGIN_EVENT,
  DSH_PERMISSION_PRESET_CHANGED_EVENT,
  DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY,
  DSH_PLUGINS_CHANGED_EVENT,
  dshHostService,
  loadDshPluginInstallRegistry,
  sanitizePersistedInstallRegistryChoice,
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
});
