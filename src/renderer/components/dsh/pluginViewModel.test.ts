import { describe, expect, test } from 'vitest';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DshHostPhase,
  DshPluginSurface,
} from '../../../shared/dshEngine/hostConstants';
import { type DshPluginEntry, sanitizeDshPluginOrder } from '../../services/dshHost';
import {
  buildDshEmbeddedPluginHash,
  buildDshEmbeddedPluginUrl,
  formatPluginVersion,
  formatRegistryDisplayName,
  getSidebarPluginPanels,
  isHostPhaseHealthy,
  isWebOnlyOrThemeInspection,
  MAX_VISIBLE_SIDEBAR_PLUGIN_PANELS,
  NPMMIRROR_REGISTRY,
  OFFICIAL_NPM_REGISTRY,
  partitionPlugins,
  partitionSidebarPluginPanels,
  RegistryPreset,
  resolveEffectiveRegistryUrl,
  resolveHostPhaseLabelKey,
  resolveInspectProblemMessage,
  resolveMutationErrorMessage,
  resolvePluginDisplayDescription,
  resolvePluginDisplayTitle,
  resolveSidebarPluginPlacement,
  SidebarPluginPlacement,
  sortPluginsByDisplayOrder,
} from './pluginViewModel';

const identityT = (key: string) => key;

describe('pluginViewModel', () => {
  test('partitions user plugins and managed core components cleanly', () => {
    const plugins: DshPluginEntry[] = [
      { name: DSH_BASE_BUNDLE_NAME, specifier: 'bundled', managed: true, enabled: true },
      { name: '@acme/tools', specifier: '^1.0.0', managed: false, enabled: true },
      { name: DSH_HOST_BUNDLE_NAME, specifier: 'file:/app/host', managed: true, enabled: true },
      { name: '@acme/disabled', specifier: '^2.0.0', managed: false, enabled: false },
    ];

    const { userPlugins, coreComponents } = partitionPlugins(plugins);
    expect(userPlugins.map((p) => p.name)).toEqual(['@acme/tools', '@acme/disabled']);
    expect(coreComponents.map((p) => p.name)).toEqual([DSH_BASE_BUNDLE_NAME, DSH_HOST_BUNDLE_NAME]);
  });

  test('resolves localized titles, descriptions, and core component friendly names', () => {
    const plugin: DshPluginEntry = {
      name: '@acme/demo',
      specifier: '^1.0.0',
      managed: false,
      enabled: true,
      title: { en: 'Demo Tool', zh: '演示工具' },
      description: { en: 'English desc', zh: '中文描述' },
    };

    expect(resolvePluginDisplayTitle(plugin, 'zh', identityT)).toBe('演示工具');
    expect(resolvePluginDisplayTitle(plugin, 'en', identityT)).toBe('Demo Tool');
    expect(resolvePluginDisplayDescription(plugin, 'zh')).toBe('中文描述');
    expect(resolvePluginDisplayDescription(plugin, 'en')).toBe('English desc');

    const coreBundle: DshPluginEntry = {
      name: DSH_HOST_BUNDLE_NAME,
      specifier: 'file:/Users/dev/lobsterai-host',
      managed: true,
      enabled: true,
    };
    expect(resolvePluginDisplayTitle(coreBundle, 'zh', identityT)).toBe('dshPluginsCoreHostBridge');
  });

  test('formats versions and resolves host phase health', () => {
    expect(formatPluginVersion('1.2.3')).toBe('v1.2.3');
    expect(formatPluginVersion('v0.2.2-rc.5')).toBe('v0.2.2-rc.5');
    expect(formatPluginVersion('  ')).toBeNull();

    expect(isHostPhaseHealthy(DshHostPhase.Ready)).toBe(true);
    expect(isHostPhaseHealthy(DshHostPhase.Failed)).toBe(false);
    expect(resolveHostPhaseLabelKey(DshHostPhase.Restarting)).toBe('dshPluginsEngineRestarting');
    expect(resolveHostPhaseLabelKey(DshHostPhase.Failed)).toBe('dshPluginsEngineFailed');
  });

  test('identifies web-only and theme inspection warnings', () => {
    expect(
      isWebOnlyOrThemeInspection({
        ok: true,
        status: 'accepted',
        surface: DshPluginSurface.WebOnly,
        isThemePlugin: false,
      }),
    ).toBe(true);
    expect(
      isWebOnlyOrThemeInspection({
        ok: true,
        status: 'accepted',
        surface: DshPluginSurface.Native,
        isThemePlugin: true,
      }),
    ).toBe(true);
    expect(
      isWebOnlyOrThemeInspection({
        ok: true,
        status: 'accepted',
        surface: DshPluginSurface.Hybrid,
        isThemePlugin: false,
      }),
    ).toBe(false);
    expect(
      isWebOnlyOrThemeInspection({
        ok: true,
        status: 'refused',
        problem: 'not-found',
      }),
    ).toBe(false);
  });

  test('resolves effective registry URL and friendly registry labels', () => {
    expect(
      resolveEffectiveRegistryUrl(RegistryPreset.Auto, '', {
        ok: true,
        fastest: NPMMIRROR_REGISTRY,
      }),
    ).toBe(NPMMIRROR_REGISTRY);
    expect(resolveEffectiveRegistryUrl(RegistryPreset.NpmMirror, '', null)).toBe(NPMMIRROR_REGISTRY);
    expect(resolveEffectiveRegistryUrl(RegistryPreset.Official, '', null)).toBe(OFFICIAL_NPM_REGISTRY);
    expect(resolveEffectiveRegistryUrl(RegistryPreset.Custom, ' https://reg.internal/ ', null)).toBe(
      'https://reg.internal/',
    );

    expect(formatRegistryDisplayName(NPMMIRROR_REGISTRY, identityT)).toBe('dshPluginsRegistryNpmMirror');
    expect(formatRegistryDisplayName(OFFICIAL_NPM_REGISTRY, identityT)).toBe('dshPluginsRegistryOfficial');
    expect(formatRegistryDisplayName('https://npm.corp.example/repo', identityT)).toBe('npm.corp.example');
    expect(formatRegistryDisplayName(null, identityT)).toBe('dshPluginsRegistryDefault');
  });

  test('maps inspect problems and mutation error codes to localized keys', () => {
    expect(
      resolveInspectProblemMessage({ ok: true, status: 'refused', problem: 'already-installed' }, identityT),
    ).toBe('dshPluginsProblemAlreadyInstalled');
    expect(
      resolveInspectProblemMessage({ ok: true, status: 'refused', problem: 'not-a-bundle' }, identityT),
    ).toBe('dshPluginsProblemNotBundle');
    expect(
      resolveMutationErrorMessage({ ok: false, errorCode: 'incompatible-version' }, 'fallback', identityT),
    ).toBe('dshPluginsErrorIncompatible');
    expect(
      resolveMutationErrorMessage({ ok: false, failureKind: 'network' }, 'fallback', identityT),
    ).toBe('dshPluginsProblemNetwork');
    expect(
      resolveMutationErrorMessage({ ok: false, error: 'Custom error text' }, 'fallback', identityT),
    ).toBe('Custom error text');
  });

  test('resolves panelLabel fallback titles and builds sidebar plugin panel entries', () => {
    const plugins: DshPluginEntry[] = [
      {
        name: DSH_HOST_BUNDLE_NAME,
        specifier: 'file:/app/host',
        managed: true,
        enabled: true,
        panelId: 'ignored-managed',
      },
      {
        name: 'dsh-media-desk',
        specifier: '^2.7.2',
        managed: false,
        enabled: true,
        title: { en: 'dsh-media-desk', zh: 'dsh-media-desk' },
        surface: DshPluginSurface.Hybrid,
        isThemePlugin: false,
        panelId: 'media-desk',
        panelLabel: { en: '自媒体工作台', zh: '自媒体工作台' },
      },
      {
        name: 'disabled-panel',
        specifier: '^1.0.0',
        managed: false,
        enabled: false,
        surface: DshPluginSurface.Hybrid,
        isThemePlugin: false,
        panelId: 'disabled-one',
      },
      {
        name: 'web-skin-theme',
        specifier: '^1.0.0',
        managed: false,
        enabled: true,
        surface: DshPluginSurface.WebOnly,
        isThemePlugin: true,
        panelId: 'skin-panel',
      },
      {
        name: 'native-cli-tool',
        specifier: '^1.0.0',
        managed: false,
        enabled: true,
        surface: DshPluginSurface.Native,
        isThemePlugin: false,
      },
    ];

    expect(resolvePluginDisplayTitle(plugins[1], 'zh', identityT)).toBe('自媒体工作台');
    expect(getSidebarPluginPanels(plugins, 'zh', identityT)).toEqual([
      {
        name: 'dsh-media-desk',
        panelId: 'media-desk',
        title: '自媒体工作台',
      },
    ]);
  });

  test('partitions sidebar plugin panels when count exceeds the visible cap', () => {
    const panels = [
      { name: 'plugin-a', panelId: 'panel-a', title: 'Plugin A' },
      { name: 'plugin-b', panelId: 'panel-b', title: 'Plugin B' },
      { name: 'plugin-c', panelId: 'panel-c', title: 'Plugin C' },
      { name: 'plugin-d', panelId: 'panel-d', title: 'Plugin D' },
    ];

    expect(MAX_VISIBLE_SIDEBAR_PLUGIN_PANELS).toBe(2);
    expect(partitionSidebarPluginPanels([])).toEqual({
      visiblePanels: [],
      overflowPanels: [],
    });
    expect(partitionSidebarPluginPanels(panels.slice(0, 1))).toEqual({
      visiblePanels: panels.slice(0, 1),
      overflowPanels: [],
    });
    expect(partitionSidebarPluginPanels(panels.slice(0, 2))).toEqual({
      visiblePanels: panels.slice(0, 2),
      overflowPanels: [],
    });
    expect(partitionSidebarPluginPanels(panels.slice(0, 3))).toEqual({
      visiblePanels: panels.slice(0, 2),
      overflowPanels: panels.slice(2, 3),
    });
    expect(partitionSidebarPluginPanels(panels)).toEqual({
      visiblePanels: panels.slice(0, 2),
      overflowPanels: panels.slice(2),
    });
    expect(partitionSidebarPluginPanels(panels, 0)).toEqual({
      visiblePanels: [],
      overflowPanels: panels,
    });
    expect(partitionSidebarPluginPanels(panels, -3)).toEqual({
      visiblePanels: [],
      overflowPanels: panels,
    });
  });

  test('sanitizes saved plugin order and sorts plugins stably with new entries appended', () => {
    expect(sanitizeDshPluginOrder([' a ', '', 'b', 'a', 123, null, 'c'])).toEqual(['a', 'b', 'c']);
    expect(sanitizeDshPluginOrder('not-an-array')).toEqual([]);

    const plugins: DshPluginEntry[] = [
      { name: 'plugin-a', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'a' },
      { name: 'plugin-b', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'b' },
      { name: 'plugin-c', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'c' },
      { name: 'plugin-d', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'd' },
    ];

    expect(
      sortPluginsByDisplayOrder(plugins, ['plugin-c', 'removed-plugin', 'plugin-a']).map((p) => p.name),
    ).toEqual(['plugin-c', 'plugin-a', 'plugin-b', 'plugin-d']);

    expect(sortPluginsByDisplayOrder(plugins, []).map((p) => p.name)).toEqual([
      'plugin-a',
      'plugin-b',
      'plugin-c',
      'plugin-d',
    ]);
  });

  test('resolves sidebar pinned vs overflow placement ignoring non-panel, theme, disabled, and managed plugins', () => {
    const orderedPlugins: DshPluginEntry[] = [
      { name: 'cli-tool', specifier: '^1.0.0', managed: false, enabled: true },
      { name: 'disabled-panel', specifier: '^1.0.0', managed: false, enabled: false, panelId: 'disabled' },
      { name: 'theme-plugin', specifier: '^1.0.0', managed: false, enabled: true, isThemePlugin: true, panelId: 'theme' },
      { name: 'panel-1', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'p1' },
      { name: 'managed-core', specifier: 'bundled', managed: true, enabled: true, panelId: 'core' },
      { name: 'panel-2', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'p2' },
      { name: 'panel-3', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'p3' },
      { name: 'panel-4', specifier: '^1.0.0', managed: false, enabled: true, panelId: 'p4' },
    ];

    expect(resolveSidebarPluginPlacement(orderedPlugins)).toEqual({
      'panel-1': SidebarPluginPlacement.Pinned,
      'panel-2': SidebarPluginPlacement.Pinned,
      'panel-3': SidebarPluginPlacement.Overflow,
      'panel-4': SidebarPluginPlacement.Overflow,
    });
  });

  test('builds chromeless embed hashes and URLs preserving auth token query', () => {
    expect(
      buildDshEmbeddedPluginHash({ panelId: 'media-desk', theme: 'dark', language: 'zh' }),
    ).toBe('lobster-embed=1&panel=media-desk&theme=dark&lang=zh');

    expect(
      buildDshEmbeddedPluginUrl('http://127.0.0.1:4321/?token=abc123', {
        panelId: 'media-desk',
        theme: 'light',
        language: 'en',
      }),
    ).toBe('http://127.0.0.1:4321/?token=abc123#lobster-embed=1&panel=media-desk&theme=light&lang=en');

    expect(
      buildDshEmbeddedPluginUrl('http://127.0.0.1:4321/?token=abc123#old', {
        panelId: 'media-desk',
        theme: 'dark',
        language: 'zh',
        stripQuery: true,
      }),
    ).toBe('http://127.0.0.1:4321/#lobster-embed=1&panel=media-desk&theme=dark&lang=zh');
  });
});
