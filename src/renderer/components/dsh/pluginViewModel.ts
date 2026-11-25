// Pure presentation helpers for the LobsterAI Plugins settings view.
// Kept React- and DOM-free so Vitest can test every rule under Node.

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
  DshHostPhase,
  DshPluginSurface,
} from '../../../shared/dshEngine/hostConstants';
import type {
  DshPluginEntry,
  DshPluginInspectResult,
  DshPluginLocalizedText,
  DshPluginMutationResult,
  DshPluginRegistriesResult,
} from '../../services/dshHost';

export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/';

export const RegistryPreset = {
  Auto: 'auto',
  NpmMirror: 'npmmirror',
  Official: 'official',
  Custom: 'custom',
} as const;
export type RegistryPreset = typeof RegistryPreset[keyof typeof RegistryPreset];

export interface PartitionedPlugins {
  userPlugins: DshPluginEntry[];
  coreComponents: DshPluginEntry[];
}

export function partitionPlugins(plugins: readonly DshPluginEntry[]): PartitionedPlugins {
  const userPlugins: DshPluginEntry[] = [];
  const coreComponents: DshPluginEntry[] = [];
  for (const plugin of plugins) {
    if (plugin.managed) {
      coreComponents.push(plugin);
    } else {
      userPlugins.push(plugin);
    }
  }
  return { userPlugins, coreComponents };
}

export function pickLocalizedText(
  text: DshPluginLocalizedText | undefined,
  language: 'zh' | 'en',
): string | undefined {
  if (!text) return undefined;
  if (language === 'zh') {
    return text.zh?.trim() || text.en?.trim() || undefined;
  }
  return text.en?.trim() || text.zh?.trim() || undefined;
}

const CORE_COMPONENT_LABEL_KEYS: Record<string, string> = {
  [DSH_BASE_BUNDLE_NAME]: 'dshPluginsCoreBase',
  [DSH_WEB_APP_BUNDLE_NAME]: 'dshPluginsCoreWebApp',
  [DSH_HOST_BUNDLE_NAME]: 'dshPluginsCoreHostBridge',
  [DSH_CHANNELS_BUNDLE_NAME]: 'dshPluginsCoreChannels',
};

export function resolveCoreComponentLabelKey(packageName: string): string | null {
  return CORE_COMPONENT_LABEL_KEYS[packageName] ?? null;
}

export function resolvePluginDisplayTitle(
  plugin: DshPluginEntry,
  language: 'zh' | 'en',
  t: (key: string) => string,
): string {
  const localized = pickLocalizedText(plugin.title, language);
  if (localized && localized !== plugin.name) return localized;
  const panelLabel = pickLocalizedText(plugin.panelLabel, language);
  if (panelLabel) return panelLabel;
  if (localized) return localized;
  if (plugin.managed) {
    const coreKey = resolveCoreComponentLabelKey(plugin.name);
    if (coreKey) return t(coreKey);
  }
  return plugin.name;
}

export interface SidebarPluginPanelItem {
  name: string;
  panelId: string;
  title: string;
  icon?: string;
  description?: string;
}

export function getSidebarPluginPanels(
  plugins: readonly DshPluginEntry[],
  language: 'zh' | 'en',
  t: (key: string) => string,
): SidebarPluginPanelItem[] {
  const result: SidebarPluginPanelItem[] = [];
  const seenPanelIds = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.managed || !plugin.enabled || plugin.isThemePlugin) continue;
    const panelId = plugin.panelId?.trim();
    if (!panelId || seenPanelIds.has(panelId)) continue;
    seenPanelIds.add(panelId);
    result.push({
      name: plugin.name,
      panelId,
      title: resolvePluginDisplayTitle(plugin, language, t),
      ...(plugin.icon ? { icon: plugin.icon } : {}),
      ...(resolvePluginDisplayDescription(plugin, language)
        ? { description: resolvePluginDisplayDescription(plugin, language) }
        : {}),
    });
  }
  return result;
}

export function buildDshEmbeddedPluginHash(options: {
  panelId: string;
  theme: 'light' | 'dark';
  language: 'zh' | 'en';
}): string {
  const params = new URLSearchParams({
    'lobster-embed': '1',
    panel: options.panelId,
    theme: options.theme,
    lang: options.language,
  });
  return params.toString();
}

export function buildDshEmbeddedPluginUrl(
  baseUrl: string,
  options: {
    panelId: string;
    theme: 'light' | 'dark';
    language: 'zh' | 'en';
    stripQuery?: boolean;
  },
): string {
  const hash = buildDshEmbeddedPluginHash(options);
  try {
    const parsed = new URL(baseUrl);
    if (options.stripQuery) {
      parsed.search = '';
    }
    parsed.hash = hash;
    return parsed.href;
  } catch {
    const withoutHash = baseUrl.split('#')[0];
    const cleanBase = options.stripQuery ? withoutHash.split('?')[0] : withoutHash;
    return `${cleanBase}#${hash}`;
  }
}

export function resolvePluginDisplayDescription(
  plugin: DshPluginEntry,
  language: 'zh' | 'en',
): string | undefined {
  return pickLocalizedText(plugin.description, language);
}

export function formatPluginVersion(version: string | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

export function isHostPhaseHealthy(phase: string | undefined): boolean {
  return phase === DshHostPhase.Ready;
}

export function resolveHostPhaseLabelKey(phase: string | undefined): string {
  switch (phase) {
    case DshHostPhase.Ready:
      return 'dshPluginsEngineReady';
    case DshHostPhase.Starting:
      return 'dshPluginsEngineStarting';
    case DshHostPhase.Restarting:
      return 'dshPluginsEngineRestarting';
    case DshHostPhase.Failed:
      return 'dshPluginsEngineFailed';
    default:
      return 'dshPluginsEngineStopped';
  }
}

export function isWebOnlyOrThemeInspection(result: DshPluginInspectResult | null): boolean {
  if (!result || result.status !== 'accepted') return false;
  return result.surface === DshPluginSurface.WebOnly || result.isThemePlugin === true;
}

export function normalizeRegistryHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function resolveEffectiveRegistryUrl(
  preset: RegistryPreset,
  customUrl: string,
  registries: DshPluginRegistriesResult | null,
): string | null | undefined {
  switch (preset) {
    case RegistryPreset.Auto:
      return registries?.fastest ?? undefined;
    case RegistryPreset.NpmMirror:
      return NPMMIRROR_REGISTRY;
    case RegistryPreset.Official:
      return OFFICIAL_NPM_REGISTRY;
    case RegistryPreset.Custom: {
      const trimmed = customUrl.trim();
      return trimmed || undefined;
    }
  }
}

export function formatRegistryDisplayName(
  url: string | null | undefined,
  t: (key: string) => string,
): string {
  const host = normalizeRegistryHost(url);
  if (!host) return t('dshPluginsRegistryDefault');
  if (host === 'registry.npmmirror.com') return t('dshPluginsRegistryNpmMirror');
  if (host === 'registry.npmjs.org') return t('dshPluginsRegistryOfficial');
  return host;
}

export function resolveInspectProblemMessage(
  result: DshPluginInspectResult,
  t: (key: string) => string,
): string {
  if (!result.ok) {
    return result.error || t('dshPluginsInspectFailed');
  }
  switch (result.problem) {
    case 'already-installed':
      return t('dshPluginsProblemAlreadyInstalled');
    case 'not-found':
      return t('dshPluginsProblemNotFound');
    case 'not-a-bundle':
      return t('dshPluginsProblemNotBundle');
    case 'not-a-package':
      return t('dshPluginsProblemNotPackage');
    case 'invalid-spec':
      return t('dshPluginsProblemInvalidSpec');
    case 'network':
      return t('dshPluginsProblemNetwork');
    default:
      return result.reason || t('dshPluginsInspectFailed');
  }
}

export function resolveMutationErrorMessage(
  result: DshPluginMutationResult,
  fallbackKey: string,
  t: (key: string) => string,
): string {
  if (result.errorCode === 'already-installed') {
    return t('dshPluginsProblemAlreadyInstalled');
  }
  if (result.errorCode === 'not-bundle') {
    return t('dshPluginsProblemNotBundle');
  }
  if (result.errorCode === 'incompatible-version') {
    return t('dshPluginsErrorIncompatible');
  }
  if (result.errorCode === 'unsupported-platform') {
    return t('dshPluginsErrorUnsupportedPlatform');
  }
  if (result.failureKind === 'network' || result.failureKind === 'timeout') {
    return t('dshPluginsProblemNetwork');
  }
  if (result.failureKind === 'not-found') {
    return t('dshPluginsProblemNotFound');
  }
  if (result.failureKind === 'build-blocked') {
    return t('dshPluginsBuildBlockedTitle');
  }
  return result.error || result.stderr || t(fallbackKey);
}
