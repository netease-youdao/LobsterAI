import {
  DEFAULT_DSH_PERMISSION_PRESET,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';

export interface PermissionPresetOptionDescriptor {
  value: DshPermissionPreset;
  labelKey: string;
  shortLabelKey: string;
  descKey: string;
  accentClass: string;
}

export const PERMISSION_PRESET_OPTIONS: readonly PermissionPresetOptionDescriptor[] = [
  {
    value: DshPermissionPreset.ReadOnly,
    labelKey: 'coworkPermissionModeReadOnly',
    shortLabelKey: 'coworkPermissionModeReadOnlyShort',
    descKey: 'coworkPermissionModeReadOnlyDesc',
    accentClass: 'text-secondary',
  },
  {
    value: DshPermissionPreset.WorkspaceWrite,
    labelKey: 'coworkPermissionModeWorkspaceWrite',
    shortLabelKey: 'coworkPermissionModeWorkspaceWriteShort',
    descKey: 'coworkPermissionModeWorkspaceWriteDesc',
    accentClass: 'text-secondary',
  },
  {
    value: DshPermissionPreset.FullAccess,
    labelKey: 'coworkPermissionModeFullAccess',
    shortLabelKey: 'coworkPermissionModeFullAccessShort',
    descKey: 'coworkPermissionModeFullAccessDesc',
    accentClass: 'text-amber-600 dark:text-amber-400',
  },
] as const;

export function getPermissionPresetOption(
  preset: DshPermissionPreset | null | undefined,
): PermissionPresetOptionDescriptor {
  const matched = PERMISSION_PRESET_OPTIONS.find((option) => option.value === preset);
  if (matched) return matched;
  return PERMISSION_PRESET_OPTIONS.find((option) => option.value === DEFAULT_DSH_PERMISSION_PRESET)
    ?? PERMISSION_PRESET_OPTIONS[1];
}

export function requiresPermissionPresetConfirmation(
  currentPreset: DshPermissionPreset,
  nextPreset: DshPermissionPreset,
): boolean {
  return (
    nextPreset === DshPermissionPreset.FullAccess
    && currentPreset !== DshPermissionPreset.FullAccess
  );
}

export const FullAccessRiskItemId = {
  Files: 'files',
  Terminal: 'terminal',
  Network: 'network',
} as const;
export type FullAccessRiskItemId = typeof FullAccessRiskItemId[keyof typeof FullAccessRiskItemId];

export interface FullAccessRiskItemDescriptor {
  id: FullAccessRiskItemId;
  titleKey: string;
  descKey: string;
}

export const FULL_ACCESS_RISK_ITEMS: readonly FullAccessRiskItemDescriptor[] = [
  {
    id: FullAccessRiskItemId.Files,
    titleKey: 'coworkFullAccessRiskFilesTitle',
    descKey: 'coworkFullAccessRiskFilesDesc',
  },
  {
    id: FullAccessRiskItemId.Terminal,
    titleKey: 'coworkFullAccessRiskTerminalTitle',
    descKey: 'coworkFullAccessRiskTerminalDesc',
  },
  {
    id: FullAccessRiskItemId.Network,
    titleKey: 'coworkFullAccessRiskNetworkTitle',
    descKey: 'coworkFullAccessRiskNetworkDesc',
  },
] as const;
