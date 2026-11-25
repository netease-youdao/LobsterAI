import { afterEach, describe, expect, test, vi } from 'vitest';

import { DshPermissionPreset } from '../../shared/dshEngine/hostConstants';
import {
  dispatchOpenEmbeddedPlugin,
  DSH_OPEN_EMBEDDED_PLUGIN_EVENT,
  DSH_PERMISSION_PRESET_CHANGED_EVENT,
  DSH_PLUGINS_CHANGED_EVENT,
  dshHostService,
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
});
