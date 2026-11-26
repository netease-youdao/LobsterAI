// Renderer service for LobsterAI's primary DeepSeek Harness (DSH) host,
// HMR-backed plugin management, and on-demand DSH Web View.

import {
  DEFAULT_DSH_PERMISSION_PRESET,
  type DshPermissionPreset,
  type DshPluginApplicationStatus,
  type DshPluginAvailability,
  type DshPluginSurface,
  type DshPluginUpdateKind,
  type DshPluginUpdateOutcomeKind,
  type DshPluginUpdateStep,
} from '../../shared/dshEngine/hostConstants';

export const DSH_PERMISSION_PRESET_CHANGED_EVENT = 'dsh:permissionPresetChanged';
export const DSH_PLUGINS_CHANGED_EVENT = 'dsh:pluginsChanged';
export const DSH_PLUGIN_ORDER_CHANGED_EVENT = 'dsh:pluginOrderChanged';
export const DSH_OPEN_EMBEDDED_PLUGIN_EVENT = 'dsh:openEmbeddedPlugin';
export const DSH_PLUGIN_ORDER_STORAGE_KEY = 'dsh.plugins.displayOrder';

export interface DshEmbeddedPluginTarget {
  name: string;
  panelId: string;
  title: string;
  icon?: string;
}

export interface DshPluginsChangedDetail {
  plugins?: DshPluginEntry[];
}

export interface DshPluginOrderChangedDetail {
  order: string[];
}

export function sanitizeDshPluginOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function dispatchDshPluginOrderChanged(order: readonly string[]): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
    return;
  }
  const detail: DshPluginOrderChangedDetail = {
    order: sanitizeDshPluginOrder(order),
  };
  window.dispatchEvent(new CustomEvent(DSH_PLUGIN_ORDER_CHANGED_EVENT, { detail }));
}

export async function loadDshPluginOrder(): Promise<string[]> {
  try {
    const raw = await window.electron?.store?.get?.(DSH_PLUGIN_ORDER_STORAGE_KEY);
    return sanitizeDshPluginOrder(raw);
  } catch (error) {
    console.warn('[dshHost] failed to load plugin display order:', error);
    return [];
  }
}

export async function saveDshPluginOrder(order: readonly string[]): Promise<string[]> {
  const normalized = sanitizeDshPluginOrder(order);
  dispatchDshPluginOrderChanged(normalized);
  try {
    await window.electron?.store?.set?.(DSH_PLUGIN_ORDER_STORAGE_KEY, normalized);
  } catch (error) {
    console.warn('[dshHost] failed to save plugin display order:', error);
  }
  return normalized;
}

export function dispatchDshPluginsChanged(plugins?: DshPluginEntry[]): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
    return;
  }
  const detail: DshPluginsChangedDetail = plugins ? { plugins } : {};
  window.dispatchEvent(new CustomEvent(DSH_PLUGINS_CHANGED_EVENT, { detail }));
}

export function dispatchOpenEmbeddedPlugin(target: DshEmbeddedPluginTarget): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
    return;
  }
  window.dispatchEvent(new CustomEvent(DSH_OPEN_EMBEDDED_PLUGIN_EVENT, { detail: target }));
}

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

export interface DshPluginLocalizedText {
  en?: string;
  zh?: string;
}

export interface DshPluginIncompatibleInfo {
  name: string;
  version: string;
  runtimeVersion: string;
  requirements: Record<string, string>;
}

export interface DshPluginEntry {
  name: string;
  specifier: string;
  managed: boolean;
  enabled: boolean;
  version?: string;
  title?: DshPluginLocalizedText;
  description?: DshPluginLocalizedText;
  icon?: string;
  official?: boolean;
  availability?: DshPluginAvailability;
  update?: DshPluginUpdateKind;
  source?: string;
  removable?: boolean;
  surface?: DshPluginSurface;
  isThemePlugin?: boolean;
  panelId?: string;
  panelLabel?: DshPluginLocalizedText;
  errorCode?: string;
  errorMessage?: string;
  rowCount?: number;
  activeRowCount?: number;
}

export interface DshPluginInspectRequest {
  spec: string;
  registry?: string | null;
}

export interface DshPluginInspectResult {
  ok: boolean;
  status?: 'accepted' | 'refused';
  kind?: 'registry' | 'path' | 'git' | 'tarball';
  name?: string;
  version?: string;
  description?: string;
  bundle?: boolean | null;
  registry?: string | null;
  host?: string;
  problem?: string;
  reason?: string;
  registries?: Array<string | null>;
  surface?: DshPluginSurface;
  isThemePlugin?: boolean;
  heuristicOnly?: boolean;
  error?: string;
}

export interface DshPluginInstallRequest {
  spec: string;
  registry?: string | null;
  approvedBuilds?: string[];
  enabled?: boolean;
  requestId?: string;
}

export interface DshPluginMutationResult {
  ok: boolean;
  application?: DshPluginApplicationStatus;
  restartRequired?: boolean;
  restartReason?: string;
  changed?: boolean;
  enabled?: boolean;
  bundle?: string;
  version?: string;
  errorCode?: string;
  failureKind?: string;
  failedAt?: 'registry' | 'spec-host';
  error?: string;
  pendingBuilds?: string[];
  incompatible?: DshPluginIncompatibleInfo[];
  output?: string;
  logPath?: string;
  stdout?: string;
  stderr?: string;
  plugins?: DshPluginEntry[];
}

export interface DshPluginRegistriesResult {
  ok: boolean;
  registry?: string | null;
  fallbackRegistries?: string[];
  resolved?: string | null;
  fastest?: string | null;
  error?: string;
}

export interface DshPluginRegistryAttempt {
  registry: string | null;
  problem?: 'not-found' | 'network' | 'unknown';
  reason?: string;
}

export interface DshPluginVersionInfo {
  version: string;
  publishedAt?: string;
  tags: string[];
  prerelease: boolean;
  deprecated?: string;
  bundle: boolean;
  incompatible?: DshPluginIncompatibleInfo;
}

export type DshPluginVersionList =
  | {
    status: 'listed';
    installed: string;
    registry: string | null;
    attempts: DshPluginRegistryAttempt[];
    versions: DshPluginVersionInfo[];
    omitted: number;
  }
  | {
    status: 'refused';
    problem: 'not-updatable' | 'not-found' | 'network' | 'unknown';
    reason: string;
    attempts: DshPluginRegistryAttempt[];
  };

export interface DshPluginCheckVersionsRequest {
  name: string;
  registry?: string | null;
}

export interface DshPluginCheckVersionsResult {
  ok: boolean;
  checkedAt?: number;
  list?: DshPluginVersionList;
  error?: string;
}

export interface DshPluginUpdateRequest {
  name: string;
  version: string;
  registry?: string | null;
  spec?: string;
  requestId?: string;
}

export interface DshPluginUpdateProgress {
  requestId: string;
  step: DshPluginUpdateStep;
}

export interface DshPluginUpdateOutcome {
  ok: boolean;
  outcome: DshPluginUpdateOutcomeKind;
  from: string;
  to: string;
  step?: 'check' | 'remove' | 'install';
  application?: DshPluginApplicationStatus;
  restartRequired?: boolean;
  restartReason?: string;
  errorCode?: string;
  failureKind?: string;
  failedAt?: 'registry' | 'spec-host';
  error?: string;
  pendingBuilds?: string[];
  incompatible?: DshPluginIncompatibleInfo[];
  output?: string;
  logPath?: string;
  restored?: boolean;
  restoreApplication?: DshPluginApplicationStatus;
  restoreError?: string;
  plugins?: DshPluginEntry[];
}

export interface DshPluginChangedPayload {
  reason?: string;
}

export const dshHostService = {
  getStatus(): Promise<DshHostStatusSnapshot | null> {
    return window.electron.dshHost.getStatus();
  },

  async restart(): Promise<{ ok: boolean; error?: string }> {
    const res = await window.electron.dshHost.restart();
    if (res?.ok) {
      dispatchDshPluginsChanged();
    }
    return res;
  },

  getWebUrl(): Promise<{ ok: boolean; url?: string | null; error?: string }> {
    return window.electron.dshHost.getWebUrl();
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
    hmrAvailable?: boolean;
    plugins: DshPluginEntry[];
  }> {
    return window.electron.dshHost.listPlugins();
  },

  inspectPlugin(request: string | DshPluginInspectRequest): Promise<DshPluginInspectResult> {
    return window.electron.dshHost.inspectPlugin(request);
  },

  async installPlugin(request: string | DshPluginInstallRequest): Promise<DshPluginMutationResult> {
    const res = await window.electron.dshHost.installPlugin(request);
    if (res?.ok) {
      dispatchDshPluginsChanged(res.plugins);
    }
    return res;
  },

  cancelPluginInstall(requestId: string): Promise<{
    ok: boolean;
    status?: 'cancelled' | 'too-late' | 'not-running';
    error?: string;
  }> {
    return window.electron.dshHost.cancelPluginInstall(requestId);
  },

  async removePlugin(packageName: string): Promise<DshPluginMutationResult> {
    const res = await window.electron.dshHost.removePlugin(packageName);
    if (res?.ok) {
      dispatchDshPluginsChanged(res.plugins);
    }
    return res;
  },

  async setPluginEnabled(packageName: string, enabled: boolean): Promise<DshPluginMutationResult> {
    const res = await window.electron.dshHost.setPluginEnabled(packageName, enabled);
    if (res?.ok) {
      dispatchDshPluginsChanged(res.plugins);
    }
    return res;
  },

  checkPluginVersions(
    request: string | DshPluginCheckVersionsRequest,
  ): Promise<DshPluginCheckVersionsResult> {
    return window.electron.dshHost.checkPluginVersions(request);
  },

  async updatePlugin(request: DshPluginUpdateRequest): Promise<DshPluginUpdateOutcome> {
    const res = await window.electron.dshHost.updatePlugin(request);
    if (res?.plugins) {
      dispatchDshPluginsChanged(res.plugins);
    }
    return res;
  },

  onPluginUpdateState(listener: (progress: DshPluginUpdateProgress) => void): () => void {
    const subscribe = window.electron?.dshHost?.onPluginUpdateState;
    if (typeof subscribe !== 'function') {
      return () => undefined;
    }
    return subscribe(listener);
  },

  onPluginsChanged(listener: (change: DshPluginChangedPayload) => void): () => void {
    const subscribe = window.electron?.dshHost?.onPluginsChanged;
    if (typeof subscribe !== 'function') {
      return () => undefined;
    }
    return subscribe(listener);
  },

  getPluginRegistries(): Promise<DshPluginRegistriesResult> {
    return window.electron.dshHost.getPluginRegistries();
  },

  pickLocalPluginDir(): Promise<{ ok: boolean; canceled?: boolean; path?: string | null }> {
    return window.electron.dshHost.pickLocalPluginDir();
  },

  openProfileDir(): Promise<{ ok: boolean; profileDir?: string }> {
    return window.electron.dshHost.openProfileDir();
  },

  copyCliShimCommand(): Promise<{ ok: boolean; cliShimPath?: string; error?: string }> {
    return window.electron.dshHost.copyCliShimCommand();
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
