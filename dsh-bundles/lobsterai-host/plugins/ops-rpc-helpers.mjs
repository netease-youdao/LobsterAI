/**
 * Pure helpers for `@lobsterai/dsh-bundle` ops RPC session context binding.
 * Zero DSH peer imports so Vitest can test them directly.
 */

export const VALID_PERMISSION_PRESETS = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/**
 * Merge a `bindSessionContext` payload into an existing session context entry.
 * Explicit `customSystemPrompt` strings (including `""`) or `null` overwrite
 * any prior turn's custom system prompt so turn-scoped prompts such as
 * `# Plan Mode` never stick into subsequent execution turns.
 */
export function mergeBoundSessionContext(prev, payload, validPermissionPresets = VALID_PERMISSION_PRESETS) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const p = payload && typeof payload === 'object' ? payload : {};
  const nextPreset = typeof p.permissionPreset === 'string' && validPermissionPresets.has(p.permissionPreset)
    ? p.permissionPreset
    : undefined;
  const permissionPresetExplicit = p.permissionPresetExplicit === true
    ? true
    : p.permissionPresetExplicit === false
      ? false
      : Boolean(base.permissionPresetExplicit);
  const mergedUnlocked = new Set([
    ...(Array.isArray(base.unlockedCapabilities) ? base.unlockedCapabilities : []),
    ...(Array.isArray(p.unlockedCapabilities)
      ? p.unlockedCapabilities.filter((c) => typeof c === 'string' && c.trim().length > 0)
      : []),
  ]);

  const customSystemPromptPatch = typeof p.customSystemPrompt === 'string'
    ? { customSystemPrompt: p.customSystemPrompt }
    : p.customSystemPrompt === null
      ? { customSystemPrompt: '' }
      : {};

  return {
    nextPreset,
    context: {
      ...base,
      ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
      ...(typeof p.coworkSessionId === 'string' ? { coworkSessionId: p.coworkSessionId } : {}),
      ...(typeof p.traceId === 'string' && p.traceId.length > 0 ? { traceId: p.traceId } : {}),
      ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
      ...(Array.isArray(p.allowedSkillIds) || p.allowedSkillIds === null
        ? { allowedSkillIds: p.allowedSkillIds }
        : {}),
      ...customSystemPromptPatch,
      ...(typeof p.executionMode === 'string' ? { executionMode: p.executionMode } : {}),
      ...(nextPreset ? { permissionPreset: nextPreset } : {}),
      permissionPresetExplicit,
      ...(mergedUnlocked.size > 0 ? { unlockedCapabilities: [...mergedUnlocked] } : {}),
    },
  };
}
