// Pure ViewModel helpers for DSH Agent Preset selection in Cowork.
// Zero React/DOM imports — directly unit-testable under Node Vitest.

import {
  DEFAULT_DSH_AGENT_PRESET_ID,
  DSH_BUILTIN_DEVELOPER_AGENT_PRESET_IDS,
} from '../../../shared/dshEngine/hostConstants';
import type { DshAgentPresetInfo, DshAgentPresetSettings } from '../../services/dshHost';

const BUILTIN_DEVELOPER_PRESET_SET = new Set<string>(DSH_BUILTIN_DEVELOPER_AGENT_PRESET_IDS);

export interface DshAgentPresetResolvedCopy {
  name: string;
  description: string;
}

const KNOWN_PRESET_I18N_KEYS: Record<string, { nameKey: string; descriptionKey: string }> = {
  [DEFAULT_DSH_AGENT_PRESET_ID]: {
    nameKey: 'dshAgentPresetDefault',
    descriptionKey: 'dshAgentPresetDefaultDesc',
  },
  standard: {
    nameKey: 'dshAgentPresetStandardName',
    descriptionKey: 'dshAgentPresetStandardDesc',
  },
  ptc: {
    nameKey: 'dshAgentPresetPtcName',
    descriptionKey: 'dshAgentPresetPtcDesc',
  },
  minimal: {
    nameKey: 'dshAgentPresetMinimalName',
    descriptionKey: 'dshAgentPresetMinimalDesc',
  },
  cordis: {
    nameKey: 'dshAgentPresetCordisName',
    descriptionKey: 'dshAgentPresetCordisDesc',
  },
};

export function resolveDshAgentPresetCopy(
  presetId: string | null | undefined,
  presets: readonly DshAgentPresetInfo[],
  translate: (key: string) => string,
): DshAgentPresetResolvedCopy {
  const trimmed = typeof presetId === 'string' ? presetId.trim() : '';
  const effectiveId = trimmed || DEFAULT_DSH_AGENT_PRESET_ID;
  const knownKeys = KNOWN_PRESET_I18N_KEYS[effectiveId.toLowerCase()];
  const matched = presets.find((preset) => preset.id === effectiveId);
  const rawName = matched?.name?.trim() || '';
  const rawDesc = matched?.description?.trim() || '';

  if (knownKeys) {
    // LobsterAI's default preset and DSH built-in modes prefer localized app copy
    // (DSH built-in presets omit name/description from server responses and localize them on the client).
    const useLocalizedName =
      effectiveId === DEFAULT_DSH_AGENT_PRESET_ID
      || !rawName
      || rawName.toLowerCase() === effectiveId.toLowerCase();
    const useLocalizedDesc = effectiveId === DEFAULT_DSH_AGENT_PRESET_ID || !rawDesc;
    return {
      name: useLocalizedName ? translate(knownKeys.nameKey) : rawName,
      description: useLocalizedDesc ? translate(knownKeys.descriptionKey) : rawDesc,
    };
  }

  return {
    name: rawName || effectiveId,
    description: rawDesc,
  };
}

export function isBuiltinDeveloperDshAgentPreset(presetId: string | null | undefined): boolean {
  if (typeof presetId !== 'string') return false;
  return BUILTIN_DEVELOPER_PRESET_SET.has(presetId.trim().toLowerCase());
}

export function getUsableDshAgentPresets(
  presets: readonly DshAgentPresetInfo[],
): DshAgentPresetInfo[] {
  return [...presets]
    .filter((preset) => !preset.broken && typeof preset.id === 'string' && preset.id.trim().length > 0)
    .sort((a, b) => {
      const orderA = typeof a.order === 'number' ? a.order : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.order === 'number' ? b.order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });
}

export function filterVisibleDshAgentPresets(
  presets: readonly DshAgentPresetInfo[],
  options?: { showBuiltinDeveloperPresets?: boolean },
): DshAgentPresetInfo[] {
  const showBuiltin = options?.showBuiltinDeveloperPresets !== false;
  return getUsableDshAgentPresets(presets).filter((preset) => {
    const id = preset.id.trim();
    if (id === DEFAULT_DSH_AGENT_PRESET_ID) return true;
    if (!showBuiltin && isBuiltinDeveloperDshAgentPreset(id)) return false;
    return true;
  });
}

export function hasThirdPartyDshAgentPresets(
  presets: readonly DshAgentPresetInfo[],
): boolean {
  return filterVisibleDshAgentPresets(presets, { showBuiltinDeveloperPresets: false }).some(
    (preset) => preset.id.trim() !== DEFAULT_DSH_AGENT_PRESET_ID,
  );
}

export function hasSelectableDshAgentPresets(
  presets: readonly DshAgentPresetInfo[],
): boolean {
  return getUsableDshAgentPresets(presets).some(
    (preset) => preset.id.trim() !== DEFAULT_DSH_AGENT_PRESET_ID,
  );
}

export function resolveEffectiveDshAgentPresetId(
  selectedId: string | null | undefined,
  presets: readonly DshAgentPresetInfo[],
): string {
  const usable = getUsableDshAgentPresets(presets);
  const trimmed = typeof selectedId === 'string' ? selectedId.trim() : '';
  if (trimmed && usable.some((preset) => preset.id === trimmed)) {
    return trimmed;
  }
  const defaultEntry = usable.find((preset) => preset.isDefault);
  return defaultEntry?.id ?? DEFAULT_DSH_AGENT_PRESET_ID;
}

export function resolveEffectiveNewSessionDshAgentPresetId(params: {
  settings: DshAgentPresetSettings;
  draftPresetId: string | null | undefined;
  presets: readonly DshAgentPresetInfo[];
}): string {
  const { settings, draftPresetId, presets } = params;
  if (!settings.enabled) {
    return DEFAULT_DSH_AGENT_PRESET_ID;
  }
  const usable = getUsableDshAgentPresets(presets);
  const trimmedDraft = typeof draftPresetId === 'string' ? draftPresetId.trim() : '';
  if (trimmedDraft) {
    if (trimmedDraft === DEFAULT_DSH_AGENT_PRESET_ID) {
      return DEFAULT_DSH_AGENT_PRESET_ID;
    }
    if (usable.some((preset) => preset.id === trimmedDraft)) {
      return trimmedDraft;
    }
  }
  const trimmedDefault = typeof settings.defaultPresetId === 'string' ? settings.defaultPresetId.trim() : '';
  if (trimmedDefault && trimmedDefault !== DEFAULT_DSH_AGENT_PRESET_ID) {
    if (usable.some((preset) => preset.id === trimmedDefault)) {
      return trimmedDefault;
    }
  }
  return DEFAULT_DSH_AGENT_PRESET_ID;
}

export function getDshAgentPresetDisplayName(
  presetId: string | null | undefined,
  presets: readonly DshAgentPresetInfo[],
  defaultLabel: string,
): string {
  const trimmed = typeof presetId === 'string' ? presetId.trim() : '';
  if (!trimmed || trimmed === DEFAULT_DSH_AGENT_PRESET_ID) {
    return defaultLabel;
  }
  const matched = presets.find((preset) => preset.id === trimmed);
  const label = matched?.name?.trim();
  return label || trimmed;
}

export function shouldShowLockedDshAgentPresetBadge(
  sessionPresetId: string | null | undefined,
): boolean {
  const trimmed = typeof sessionPresetId === 'string' ? sessionPresetId.trim() : '';
  return trimmed.length > 0 && trimmed !== DEFAULT_DSH_AGENT_PRESET_ID;
}
