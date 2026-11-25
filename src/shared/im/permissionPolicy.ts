// Shared constants and pure resolution helpers for IM channel-level default
// DSH permission presets (`IMSettings.platformPermissionPresets`).

import {
  DshPermissionPreset,
  parseDshPermissionPreset,
  RetainedImPlatform,
} from '../dshEngine/hostConstants';

export const ImChannelPermissionMode = {
  FollowGlobal: 'follow-global',
  ReadOnly: DshPermissionPreset.ReadOnly,
  WorkspaceWrite: DshPermissionPreset.WorkspaceWrite,
  FullAccess: DshPermissionPreset.FullAccess,
} as const;
export type ImChannelPermissionMode =
  typeof ImChannelPermissionMode[keyof typeof ImChannelPermissionMode];

/**
 * Build the storage key inside `IMSettings.platformPermissionPresets`.
 * Matches `im_session_mappings.platform` and `platformAgentBindings` key shapes:
 * - `weixin` (single-instance) -> `'weixin'`
 * - multi-instance channel with instanceId -> `'feishu:<instanceId>'`
 */
export function buildImChannelPermissionKey(platform: string, instanceId?: string): string {
  const normalizedPlatform = platform.trim().toLowerCase();
  if (!normalizedPlatform) return '';
  if (normalizedPlatform.includes(':')) {
    return normalizedPlatform;
  }
  const normalizedInstance = instanceId?.trim() ?? '';
  if (
    !normalizedInstance
    || normalizedInstance === 'default'
    || normalizedPlatform === RetainedImPlatform.Weixin
  ) {
    return normalizedPlatform;
  }
  return `${normalizedPlatform}:${normalizedInstance}`;
}

/**
 * Resolve the configured channel-level default permission preset for an IM
 * platform/instance (or an `im_session_mappings.platform` string like `'feishu:bot-1'`).
 * Returns `null` when the channel is set to follow the global default preset.
 */
export function resolveImChannelPermissionPreset(
  platformPermissionPresets: Record<string, string | undefined> | null | undefined,
  platform: string | null | undefined,
  instanceId?: string,
): DshPermissionPreset | null {
  if (!platformPermissionPresets || !platform) return null;
  const scopedKey = buildImChannelPermissionKey(platform, instanceId);
  if (!scopedKey) return null;

  const exactMatch = parseDshPermissionPreset(platformPermissionPresets[scopedKey]);
  if (exactMatch) return exactMatch;

  const colonIdx = scopedKey.indexOf(':');
  if (colonIdx > 0) {
    const basePlatform = scopedKey.slice(0, colonIdx);
    const baseMatch = parseDshPermissionPreset(platformPermissionPresets[basePlatform]);
    if (baseMatch) return baseMatch;
  }
  return null;
}

/**
 * Produce an immutable copy of `platformPermissionPresets` with `scopeKey`
 * updated to `nextPreset` (or deleted when `nextPreset` is `null` / follow-global).
 */
export function updateImChannelPermissionPresets(
  current: Record<string, DshPermissionPreset> | null | undefined,
  scopeKey: string,
  nextPreset: DshPermissionPreset | null,
): Record<string, DshPermissionPreset> {
  const next: Record<string, DshPermissionPreset> = { ...(current ?? {}) };
  const normalizedKey = scopeKey.trim();
  if (!normalizedKey) return next;
  if (nextPreset === null) {
    delete next[normalizedKey];
  } else {
    next[normalizedKey] = nextPreset;
  }
  return next;
}
