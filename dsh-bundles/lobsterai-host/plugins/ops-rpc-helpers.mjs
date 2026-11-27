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
  const mediaTurnInstructionPatch = typeof p.mediaTurnInstruction === 'string'
    ? { mediaTurnInstruction: p.mediaTurnInstruction }
    : p.mediaTurnInstruction === null
      ? { mediaTurnInstruction: '' }
      : {};

  const goalToolsEnabledPatch = base.goalToolsEnabled === true || p.goalToolsEnabled === true
    ? { goalToolsEnabled: true }
    : typeof p.goalToolsEnabled === 'boolean'
      ? { goalToolsEnabled: p.goalToolsEnabled }
      : {};

  const context = {
    ...base,
    ...(typeof p.userQuestionsDisabled === 'boolean' ? { userQuestionsDisabled: p.userQuestionsDisabled } : {}),
    ...goalToolsEnabledPatch,
    ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
    ...(typeof p.coworkSessionId === 'string' ? { coworkSessionId: p.coworkSessionId } : {}),
    ...(typeof p.traceId === 'string' && p.traceId.length > 0 ? { traceId: p.traceId } : {}),
    ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
    ...(Array.isArray(p.allowedSkillIds) || p.allowedSkillIds === null
      ? { allowedSkillIds: p.allowedSkillIds }
      : {}),
    ...customSystemPromptPatch,
    ...(typeof p.officeAgentPrompt === 'string' && p.officeAgentPrompt.trim().length > 0
      ? { officeAgentPrompt: p.officeAgentPrompt }
      : {}),
    ...mediaTurnInstructionPatch,
    ...(typeof p.executionMode === 'string' ? { executionMode: p.executionMode } : {}),
    ...(typeof p.memoryEnabled === 'boolean' ? { memoryEnabled: p.memoryEnabled } : {}),
    ...(typeof p.sideChat === 'boolean' ? { sideChat: p.sideChat } : {}),
    ...(nextPreset ? { permissionPreset: nextPreset } : {}),
    permissionPresetExplicit,
    ...(mergedUnlocked.size > 0 ? { unlockedCapabilities: [...mergedUnlocked] } : {}),
  };

  if (p.contextWindowSelection === null) {
    delete context.contextWindowSelection;
  } else if (typeof p.contextWindowSelection === 'string' && p.contextWindowSelection.trim().length > 0) {
    context.contextWindowSelection = p.contextWindowSelection.trim();
  }
  if (p.contextWindowOverride === null) {
    delete context.contextWindowOverride;
  } else if (
    typeof p.contextWindowOverride === 'number'
    && Number.isInteger(p.contextWindowOverride)
    && p.contextWindowOverride > 0
  ) {
    context.contextWindowOverride = p.contextWindowOverride;
  }

  return {
    nextPreset,
    context,
  };
}
