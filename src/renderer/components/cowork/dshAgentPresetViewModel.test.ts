import { describe, expect, test } from 'vitest';

import {
  DEFAULT_DSH_AGENT_PRESET_SETTINGS,
  type DshAgentPresetInfo,
} from '../../services/dshHost';
import {
  filterVisibleDshAgentPresets,
  getDshAgentPresetDisplayName,
  getUsableDshAgentPresets,
  hasSelectableDshAgentPresets,
  hasThirdPartyDshAgentPresets,
  isBuiltinDeveloperDshAgentPreset,
  resolveDshAgentPresetCopy,
  resolveEffectiveDshAgentPresetId,
  resolveEffectiveNewSessionDshAgentPresetId,
  shouldShowLockedDshAgentPresetBadge,
} from './dshAgentPresetViewModel';

const BUILTIN_ONLY_PRESETS: DshAgentPresetInfo[] = [
  { id: 'lobsterai', name: 'LobsterAI', order: 0, isDefault: true },
  { id: 'standard', name: 'standard', order: 1, isDefault: false },
  { id: 'ptc', name: 'ptc', order: 2, isDefault: false },
  { id: 'minimal', name: 'minimal', order: 3, isDefault: false },
  { id: 'cordis', name: 'cordis', order: 4, isDefault: false },
];

const SAMPLE_PRESETS: DshAgentPresetInfo[] = [
  ...BUILTIN_ONLY_PRESETS,
  { id: 'pi-plus', name: 'Pi+模式', description: 'Code Mode', order: 6, isDefault: false },
  { id: 'broken-preset', name: 'Broken', order: 2, broken: 'missing dep', isDefault: false },
  { id: 'pi', name: 'Pi 模式', description: 'Minimal', order: 5, isDefault: false },
];

describe('dshAgentPresetViewModel', () => {
  test('filters broken presets and sorts by order ascending', () => {
    expect(getUsableDshAgentPresets(SAMPLE_PRESETS).map((p) => p.id)).toEqual([
      'lobsterai',
      'standard',
      'ptc',
      'minimal',
      'cordis',
      'pi',
      'pi-plus',
    ]);
  });

  test('includes DSH native modes by default and distinguishes third-party presets', () => {
    expect(isBuiltinDeveloperDshAgentPreset('standard')).toBe(true);
    expect(isBuiltinDeveloperDshAgentPreset('cordis')).toBe(true);
    expect(isBuiltinDeveloperDshAgentPreset('pi')).toBe(false);
    expect(isBuiltinDeveloperDshAgentPreset('lobsterai')).toBe(false);

    expect(filterVisibleDshAgentPresets(SAMPLE_PRESETS).map((p) => p.id)).toEqual([
      'lobsterai',
      'standard',
      'ptc',
      'minimal',
      'cordis',
      'pi',
      'pi-plus',
    ]);
    expect(
      filterVisibleDshAgentPresets(SAMPLE_PRESETS, { showBuiltinDeveloperPresets: false }).map((p) => p.id),
    ).toEqual(['lobsterai', 'pi', 'pi-plus']);

    expect(hasThirdPartyDshAgentPresets(BUILTIN_ONLY_PRESETS)).toBe(false);
    expect(hasThirdPartyDshAgentPresets(SAMPLE_PRESETS)).toBe(true);
    expect(hasSelectableDshAgentPresets(BUILTIN_ONLY_PRESETS)).toBe(true);
    expect(hasSelectableDshAgentPresets([{ id: 'lobsterai', name: 'LobsterAI', order: 0, isDefault: true }])).toBe(false);
  });

  test('resolves effective new-session preset respecting master switch, default preset, and draft reset', () => {
    // Master switch off always forces default lobsterai preset even if draft/default is set.
    expect(
      resolveEffectiveNewSessionDshAgentPresetId({
        settings: { ...DEFAULT_DSH_AGENT_PRESET_SETTINGS, enabled: false, defaultPresetId: 'pi-plus' },
        draftPresetId: 'pi',
        presets: SAMPLE_PRESETS,
      }),
    ).toBe('lobsterai');

    // Enabled with configured default preset inherits default when draft override is null.
    const enabledWithDefault = {
      enabled: true,
      defaultPresetId: 'pi-plus',
    };
    expect(
      resolveEffectiveNewSessionDshAgentPresetId({
        settings: enabledWithDefault,
        draftPresetId: null,
        presets: SAMPLE_PRESETS,
      }),
    ).toBe('pi-plus');

    // Explicit per-draft reset to lobsterai overrides configured default for that draft.
    expect(
      resolveEffectiveNewSessionDshAgentPresetId({
        settings: enabledWithDefault,
        draftPresetId: 'lobsterai',
        presets: SAMPLE_PRESETS,
      }),
    ).toBe('lobsterai');

    // Native DSH modes (such as standard) work immediately once runtime mode switching is enabled.
    expect(
      resolveEffectiveNewSessionDshAgentPresetId({
        settings: { enabled: true, defaultPresetId: 'standard' },
        draftPresetId: null,
        presets: BUILTIN_ONLY_PRESETS,
      }),
    ).toBe('standard');
  });

  test('resolves effective preset ID and falls back to default when selection is invalid or broken', () => {
    expect(resolveEffectiveDshAgentPresetId('pi-plus', SAMPLE_PRESETS)).toBe('pi-plus');
    expect(resolveEffectiveDshAgentPresetId('broken-preset', SAMPLE_PRESETS)).toBe('lobsterai');
    expect(resolveEffectiveDshAgentPresetId('unknown', SAMPLE_PRESETS)).toBe('lobsterai');
    expect(resolveEffectiveDshAgentPresetId(undefined, SAMPLE_PRESETS)).toBe('lobsterai');
  });

  test('formats display names and locked-badge visibility', () => {
    expect(getDshAgentPresetDisplayName('lobsterai', SAMPLE_PRESETS, 'LobsterAI')).toBe('LobsterAI');
    expect(getDshAgentPresetDisplayName('pi', SAMPLE_PRESETS, 'LobsterAI')).toBe('Pi 模式');
    expect(getDshAgentPresetDisplayName('custom-id', SAMPLE_PRESETS, 'LobsterAI')).toBe('custom-id');

    expect(shouldShowLockedDshAgentPresetBadge(undefined)).toBe(false);
    expect(shouldShowLockedDshAgentPresetBadge('')).toBe(false);
    expect(shouldShowLockedDshAgentPresetBadge('lobsterai')).toBe(false);
    expect(shouldShowLockedDshAgentPresetBadge('pi-plus')).toBe(true);
  });

  test('resolves localized names and descriptions for LobsterAI and DSH built-in modes while preserving plugin copy', () => {
    const dict: Record<string, string> = {
      dshAgentPresetDefault: 'LobsterAI',
      dshAgentPresetDefaultDesc: 'Default LobsterAI mode',
      dshAgentPresetStandardName: '标准模式',
      dshAgentPresetStandardDesc: '处理代码、文件和资料',
      dshAgentPresetPtcName: 'PTC 模式',
      dshAgentPresetPtcDesc: '适合批量调用工具',
      dshAgentPresetMinimalName: '极简模式',
      dshAgentPresetMinimalDesc: '仅终端与图片读取',
      dshAgentPresetCordisName: '创造模式',
      dshAgentPresetCordisDesc: '用对话定制 DSH',
    };
    const t = (key: string) => dict[key] ?? key;

    expect(resolveDshAgentPresetCopy('lobsterai', SAMPLE_PRESETS, t)).toEqual({
      name: 'LobsterAI',
      description: 'Default LobsterAI mode',
    });
    expect(resolveDshAgentPresetCopy('standard', SAMPLE_PRESETS, t)).toEqual({
      name: '标准模式',
      description: '处理代码、文件和资料',
    });
    expect(resolveDshAgentPresetCopy('cordis', SAMPLE_PRESETS, t)).toEqual({
      name: '创造模式',
      description: '用对话定制 DSH',
    });
    expect(resolveDshAgentPresetCopy('pi-plus', SAMPLE_PRESETS, t)).toEqual({
      name: 'Pi+模式',
      description: 'Code Mode',
    });
  });
});
