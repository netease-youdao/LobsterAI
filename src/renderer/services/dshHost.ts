// Renderer service for LobsterAI's primary DeepSeek Harness (DSH) host,
// HMR-backed plugin management, and on-demand DSH Web View.

import {
  type ModelThinkingConfig,
  ModelThinkingLevel,
  type ModelThinkingOption,
  OpenClawThinkingLevel,
  parseModelThinkingLevel,
  parseOpenClawThinkingLevel,
} from '@shared/providers/modelThinking';

import {
  DEFAULT_DSH_AGENT_PRESET_ID,
  DEFAULT_DSH_PERMISSION_PRESET,
  type DshPermissionPreset,
  type DshPluginApplicationStatus,
  type DshPluginAvailability,
  type DshPluginInstallPhase,
  type DshPluginPanelKind,
  type DshPluginSurface,
  type DshPluginUpdateKind,
  type DshPluginUpdateOutcomeKind,
  type DshPluginUpdateStep,
} from '../../shared/dshEngine/hostConstants';
import type { Model } from '../store/slices/modelSlice';

export const DSH_PERMISSION_PRESET_CHANGED_EVENT = 'dsh:permissionPresetChanged';
export const DSH_PLUGINS_CHANGED_EVENT = 'dsh:pluginsChanged';
export const DSH_PLUGIN_ORDER_CHANGED_EVENT = 'dsh:pluginOrderChanged';
export const DSH_OPEN_EMBEDDED_PLUGIN_EVENT = 'dsh:openEmbeddedPlugin';
export const DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT = 'dsh:agentPresetSettingsChanged';
export const DSH_PLUGIN_ORDER_STORAGE_KEY = 'dsh.plugins.displayOrder';
export const DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY = 'dsh.plugins.installRegistry';
export const DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY = 'dsh.plugins.agentPresetSettings';

export interface DshAgentPresetSettings {
  enabled: boolean;
  defaultPresetId: string;
}

export const DEFAULT_DSH_AGENT_PRESET_SETTINGS: DshAgentPresetSettings = {
  enabled: false,
  defaultPresetId: DEFAULT_DSH_AGENT_PRESET_ID,
};

export function sanitizeDshAgentPresetSettings(value: unknown): DshAgentPresetSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_DSH_AGENT_PRESET_SETTINGS };
  }
  const record = value as Record<string, unknown>;
  const enabled = record.enabled === true;
  const rawDefaultPresetId = typeof record.defaultPresetId === 'string'
    ? record.defaultPresetId.trim()
    : '';
  return {
    enabled,
    defaultPresetId: rawDefaultPresetId || DEFAULT_DSH_AGENT_PRESET_ID,
  };
}

export function dispatchDshAgentPresetSettingsChanged(settings: DshAgentPresetSettings): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
    return;
  }
  const sanitized = sanitizeDshAgentPresetSettings(settings);
  window.dispatchEvent(new CustomEvent(DSH_AGENT_PRESET_SETTINGS_CHANGED_EVENT, { detail: sanitized }));
}

export async function loadDshAgentPresetSettings(): Promise<DshAgentPresetSettings> {
  try {
    const raw = await window.electron?.store?.get?.(DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY);
    return sanitizeDshAgentPresetSettings(raw);
  } catch (error) {
    console.warn('[dshHost] failed to load agent preset settings:', error);
    return { ...DEFAULT_DSH_AGENT_PRESET_SETTINGS };
  }
}

export async function saveDshAgentPresetSettings(
  settings: Partial<DshAgentPresetSettings>,
): Promise<DshAgentPresetSettings> {
  const sanitized = sanitizeDshAgentPresetSettings(settings);
  dispatchDshAgentPresetSettingsChanged(sanitized);
  try {
    await window.electron?.store?.set?.(DSH_AGENT_PRESET_SETTINGS_STORAGE_KEY, sanitized);
  } catch (error) {
    console.warn('[dshHost] failed to save agent preset settings:', error);
  }
  return sanitized;
}

export interface DshEmbeddedPluginTarget {
  name: string;
  panelId: string;
  panelKind?: DshPluginPanelKind;
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

export type PersistedInstallRegistryChoice =
  | { readonly kind: 'offered'; readonly registry: string | null }
  | { readonly kind: 'custom'; readonly url: string };

export function sanitizePersistedInstallRegistryChoice(
  value: unknown,
): PersistedInstallRegistryChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'offered') {
    if (record.registry === null) {
      return { kind: 'offered', registry: null };
    }
    if (typeof record.registry === 'string' && record.registry.trim()) {
      return { kind: 'offered', registry: record.registry.trim() };
    }
    return null;
  }
  if (record.kind === 'custom' && typeof record.url === 'string' && record.url.trim()) {
    return { kind: 'custom', url: record.url.trim() };
  }
  return null;
}

export async function loadDshPluginInstallRegistry(): Promise<PersistedInstallRegistryChoice | null> {
  try {
    const raw = await window.electron?.store?.get?.(DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY);
    return sanitizePersistedInstallRegistryChoice(raw);
  } catch (error) {
    console.warn('[dshHost] failed to load plugin install registry choice:', error);
    return null;
  }
}

export async function saveDshPluginInstallRegistry(
  choice: PersistedInstallRegistryChoice,
): Promise<void> {
  const sanitized = sanitizePersistedInstallRegistryChoice(choice);
  if (!sanitized) return;
  try {
    await window.electron?.store?.set?.(DSH_PLUGIN_INSTALL_REGISTRY_STORAGE_KEY, sanitized);
  } catch (error) {
    console.warn('[dshHost] failed to save plugin install registry choice:', error);
  }
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
  panelKind?: DshPluginPanelKind;
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
  stage?: 'install' | 'enable' | 'remove';
  changed?: boolean;
  enabled?: boolean;
  bundle?: string;
  version?: string;
  errorCode?: string;
  failureKind?: string;
  failedAt?: 'registry' | 'spec-host';
  error?: string;
  pendingBuilds?: string[];
  approvedBuilds?: string[];
  registries?: Array<string | null>;
  incompatible?: DshPluginIncompatibleInfo[];
  exitCode?: number | null;
  output?: string;
  logPath?: string;
  stdout?: string;
  stderr?: string;
  plugins?: DshPluginEntry[];
}

export interface DshPluginInstallAttempt {
  registry: string | null;
  index: number;
  total: number;
}

export interface DshPluginInstallProgress {
  requestId: string;
  phase: DshPluginInstallPhase;
  attempt?: DshPluginInstallAttempt;
}

export interface DshPluginInstallLogChunk {
  requestId?: string;
  jobId: string;
  argv: string[];
  cwd: string;
  stream: 'stdout' | 'stderr';
  text: string;
  exitCode?: number | null;
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

export interface DshPluginModelReasoningEffort {
  id: string;
  name?: string;
  description?: string;
}

export interface DshPluginModelEntry {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  description?: string;
  badge?: string;
  reasoningEfforts?: DshPluginModelReasoningEffort[];
  defaultReasoningEffort?: string;
}

export interface DshPluginModelGroup {
  providerId: string;
  providerName: string;
  models: DshPluginModelEntry[];
}

export interface DshPluginModelFailure {
  providerId: string;
  providerName: string;
  message: string;
}

export interface DshPluginModelsResult {
  ok: boolean;
  groups: DshPluginModelGroup[];
  models: DshPluginModelEntry[];
  failures: DshPluginModelFailure[];
  fetchedAt: number;
  error?: string;
}

export interface DshAgentPresetInfo {
  id: string;
  name?: string;
  description?: string;
  order?: number;
  broken?: string;
  isDefault: boolean;
}

export interface DshAgentPresetsResult {
  ok: boolean;
  presets: DshAgentPresetInfo[];
  usablePresets: DshAgentPresetInfo[];
  hasThirdPartyPresets: boolean;
  defaultPresetId: string;
  error?: string;
}

export interface DshPluginSkillEntry {
  name: string;
  description: string;
  provider: string;
  source?: string;
  path?: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

export interface DshPluginSkillsResult {
  ok: boolean;
  skills: DshPluginSkillEntry[];
  error?: string;
}

export function buildDshPluginModelThinkingConfig(
  efforts: readonly DshPluginModelReasoningEffort[] | undefined,
  defaultEffort?: string,
): ModelThinkingConfig | undefined {
  if (!efforts || efforts.length === 0) return undefined;
  const options: ModelThinkingOption[] = [];
  const seenLevels = new Set<ModelThinkingLevel>();

  for (const effort of efforts) {
    const level = parseModelThinkingLevel(effort.id);
    if (!level || seenLevels.has(level)) continue;
    const openclawLevel = level === ModelThinkingLevel.Max
      ? OpenClawThinkingLevel.XHigh
      : parseOpenClawThinkingLevel(level);
    if (!openclawLevel) continue;
    seenLevels.add(level);
    options.push({ level, openclawLevel });
  }

  if (options.length === 0) return undefined;
  if (options.length === 1 && options[0]?.level === ModelThinkingLevel.Off) return undefined;

  const parsedDefault = parseModelThinkingLevel(defaultEffort);
  const defaultLevel = parsedDefault && seenLevels.has(parsedDefault)
    ? parsedDefault
    : options[0]!.level;

  return { options, defaultLevel };
}

export function mapDshPluginModelsToStoreModels(
  entries: readonly DshPluginModelEntry[],
): Model[] {
  return entries.map((entry) => {
    const thinkingConfig = buildDshPluginModelThinkingConfig(
      entry.reasoningEfforts,
      entry.defaultReasoningEffort,
    );
    return {
      id: entry.id,
      name: entry.name,
      provider: entry.providerName,
      providerKey: entry.providerId,
      openClawProviderId: entry.providerId,
      isDshPluginModel: true,
      ...(entry.badge ? { dshPluginBadge: entry.badge } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      ...(thinkingConfig ? { supportsThinking: true, thinkingConfig } : {}),
    };
  });
}

export const dshHostService = {
  getStatus(): Promise<DshHostStatusSnapshot | null> {
    return window.electron.dshHost.getStatus();
  },

  onConnectionChanged(listener: () => void): () => void {
    const subscribe = window.electron?.dshHost?.onConnectionChanged;
    if (typeof subscribe !== 'function') {
      return () => undefined;
    }
    return subscribe(listener);
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

  listPluginModels(options?: { forceRefresh?: boolean }): Promise<DshPluginModelsResult> {
    const invoke = window.electron?.dshHost?.listPluginModels;
    if (typeof invoke !== 'function') {
      return Promise.resolve({
        ok: false,
        groups: [],
        models: [],
        failures: [],
        fetchedAt: Date.now(),
      });
    }
    return invoke(options);
  },

  listAgentPresets(): Promise<DshAgentPresetsResult> {
    const invoke = window.electron?.dshHost?.listAgentPresets;
    if (typeof invoke !== 'function') {
      return Promise.resolve({
        ok: false,
        presets: [],
        usablePresets: [],
        hasThirdPartyPresets: false,
        defaultPresetId: 'lobsterai',
      });
    }
    return invoke();
  },

  listPluginSkills(options?: { cwd?: string }): Promise<DshPluginSkillsResult> {
    const invoke = window.electron?.dshHost?.listPluginSkills;
    if (typeof invoke !== 'function') {
      return Promise.resolve({
        ok: false,
        skills: [],
      });
    }
    return invoke(options);
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

  onPluginInstallState(listener: (progress: DshPluginInstallProgress) => void): () => void {
    const subscribe = window.electron?.dshHost?.onPluginInstallState;
    if (typeof subscribe !== 'function') {
      return () => undefined;
    }
    return subscribe(listener);
  },

  onPluginInstallLog(listener: (chunk: DshPluginInstallLogChunk) => void): () => void {
    const subscribe = window.electron?.dshHost?.onPluginInstallLog;
    if (typeof subscribe !== 'function') {
      return () => undefined;
    }
    return subscribe(listener);
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
