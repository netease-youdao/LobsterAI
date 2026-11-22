// Renderer service for LobsterAI's primary DeepSeek Harness (DSH) host,
// plugin management (`dsh plugin`), and on-demand DSH Ecosystem Web View.

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  type DshPermissionPreset,
} from '../../shared/dshEngine/hostConstants';

export const DSH_PERMISSION_PRESET_CHANGED_EVENT = 'dsh:permissionPresetChanged';

export interface DshPermissionPresetChangedDetail {
  preset: DshPermissionPreset;
  defaultPreset?: DshPermissionPreset;
  sessionId?: string;
}

export interface PermissionPresetEventReaction {
  apply: boolean;
  nextPreset?: DshPermissionPreset;
  refetch?: boolean;
}

/**
 * Determine how a `PermissionModeSelector` bound to `currentSessionId` should
 * react to a `DSH_PERMISSION_PRESET_CHANGED_EVENT`:
 * - Session-scoped events (`event.sessionId`) only apply to the matching session.
 * - Global default events (`!event.sessionId`) apply directly to the home/new-session
 *   selector (`!currentSessionId`) and trigger a re-fetch for active session selectors
 *   so unpinned sessions adopt the new default while pinned sessions stay isolated.
 */
export function shouldApplyPermissionPresetEvent(
  currentSessionId: string | null | undefined,
  detail: DshPermissionPresetChangedDetail | null | undefined,
): PermissionPresetEventReaction {
  if (!detail) return { apply: false };
  const currentSid = typeof currentSessionId === 'string' && currentSessionId.trim()
    ? currentSessionId.trim()
    : undefined;
  const eventSid = typeof detail.sessionId === 'string' && detail.sessionId.trim()
    ? detail.sessionId.trim()
    : undefined;
  if (eventSid) {
    if (eventSid === currentSid) {
      return { apply: true, nextPreset: detail.preset };
    }
    return { apply: false };
  }
  if (!currentSid) {
    return { apply: true, nextPreset: detail.defaultPreset ?? detail.preset };
  }
  return { apply: false, refetch: true };
}

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
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : undefined;
    const res = await window.electron.dshHost.setPermissionPreset(preset, normalizedSessionId);
    if (res?.ok && typeof window !== 'undefined') {
      const detail: DshPermissionPresetChangedDetail = {
        preset: res.preset ?? preset,
        ...(res.defaultPreset
          ? { defaultPreset: res.defaultPreset }
          : (!normalizedSessionId ? { defaultPreset: preset } : {})),
        ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
      };
      window.dispatchEvent(new CustomEvent(DSH_PERMISSION_PRESET_CHANGED_EVENT, { detail }));
    }
    return res;
  },
};
