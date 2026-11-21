// Renderer service for LobsterAI's primary DeepSeek Harness (DSH) host,
// plugin management (`dsh plugin`), and on-demand DSH Ecosystem Web View.

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  type DshPermissionPreset,
} from '../../shared/dshEngine/hostConstants';

export const DSH_PERMISSION_PRESET_CHANGED_EVENT = 'dsh:permissionPresetChanged';

export interface DshHostStatusSnapshot {
  phase: string;
  origin: string | null;
  authenticatedWebUrl: string | null;
  pid: number | null;
  runtimeVersion: string | null;
  profileDir: string;
  dshHomeDir: string;
  cliShimPath: string | null;
  lastError: string | null;
  startedAt: number | null;
  restartCount: number;
}

export interface DshPluginEntry {
  name: string;
  specifier: string;
  managed: boolean;
  enabled: boolean;
}

export const dshHostService = {
  getStatus(): Promise<DshHostStatusSnapshot | null> {
    return window.electron.dshHost.getStatus();
  },

  restart(): Promise<{ ok: boolean; error?: string }> {
    return window.electron.dshHost.restart();
  },

  openEcosystemView(routeHash?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    return window.electron.dshHost.openEcosystemView(routeHash);
  },

  closeEcosystemView(): Promise<{ ok: boolean }> {
    return window.electron.dshHost.closeEcosystemView();
  },

  listPlugins(): Promise<{
    ok: boolean;
    profileDir?: string;
    cliShimPath?: string | null;
    plugins: DshPluginEntry[];
  }> {
    return window.electron.dshHost.listPlugins();
  },

  installPlugin(packageSpec: string): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    plugins?: DshPluginEntry[];
  }> {
    return window.electron.dshHost.installPlugin(packageSpec);
  },

  removePlugin(packageName: string): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    plugins?: DshPluginEntry[];
  }> {
    return window.electron.dshHost.removePlugin(packageName);
  },

  setPluginEnabled(packageName: string, enabled: boolean): Promise<{
    ok: boolean;
    changed?: boolean;
    enabled?: boolean;
    error?: string;
    plugins?: DshPluginEntry[];
  }> {
    return window.electron.dshHost.setPluginEnabled(packageName, enabled);
  },

  openProfileDir(): Promise<{ ok: boolean; profileDir?: string }> {
    return window.electron.dshHost.openProfileDir();
  },

  async getPermissionPreset(sessionId?: string): Promise<{
    preset: DshPermissionPreset;
    defaultPreset: DshPermissionPreset;
  }> {
    try {
      const res = await window.electron.dshHost.getPermissionPreset(sessionId);
      if (res?.ok) {
        return {
          preset: res.preset,
          defaultPreset: res.defaultPreset,
        };
      }
    } catch {
      // Fallback to default preset when bridge is unavailable.
    }
    return {
      preset: DEFAULT_DSH_PERMISSION_PRESET,
      defaultPreset: DEFAULT_DSH_PERMISSION_PRESET,
    };
  },

  async setPermissionPreset(
    preset: DshPermissionPreset,
    sessionId?: string,
  ): Promise<{ ok: boolean; preset?: DshPermissionPreset; defaultPreset?: DshPermissionPreset; error?: string }> {
    const res = await window.electron.dshHost.setPermissionPreset(preset, sessionId);
    if (res?.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(DSH_PERMISSION_PRESET_CHANGED_EVENT, {
        detail: {
          preset: res.preset ?? preset,
          defaultPreset: res.defaultPreset ?? preset,
          sessionId,
        },
      }));
    }
    return res;
  },
};
