import { createHash } from 'node:crypto';

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
 * Derive a deterministic W3C 32-hex trace ID for an externally initiated DSH
 * turn (`dsh-pocket`, `dsh-media-desk`, `dsh` CLI). Shared identically with
 * LobsterAI's `dshExternalEventTranslator` so `OpenClawTokenProxy`,
 * `lobsterai-server` credit ledger, and `CoworkTurnUsageService` correlate
 * without a synchronous round-trip before the first LLM request.
 */
export function deriveExternalTurnTraceId(dshSessionId, seq) {
  const sid = typeof dshSessionId === 'string' ? dshSessionId.trim() : '';
  if (!sid || !Number.isInteger(seq) || seq < 0) return undefined;
  const hex = createHash('sha256')
    .update(`lobsterai:dsh-external-trace:${sid}:${seq}`)
    .digest('hex')
    .slice(0, 32);
  return /^0+$/.test(hex) ? `1${hex.slice(1)}` : hex;
}

/**
 * Extract plain user prompt text from a DSH `user/message` content payload
 * (trimmed and bounded to 200 code points for usage-ledger metadata headers).
 */
export function extractExternalUserMessageText(content) {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  }
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return Array.from(trimmed).slice(0, 200).join('');
}

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

  const hasExplicitLocalTurnBinding =
    (typeof p.traceId === 'string' && p.traceId.length > 0)
    || (typeof p.requestId === 'string' && p.requestId.trim().length > 0);

  const context = {
    ...base,
    ...(typeof p.userQuestionsDisabled === 'boolean' ? { userQuestionsDisabled: p.userQuestionsDisabled } : {}),
    ...goalToolsEnabledPatch,
    ...(typeof p.agentId === 'string' ? { agentId: p.agentId } : {}),
    ...(typeof p.coworkSessionId === 'string' ? { coworkSessionId: p.coworkSessionId } : {}),
    ...(typeof p.traceId === 'string' && p.traceId.length > 0 ? { traceId: p.traceId } : {}),
    ...(typeof p.requestId === 'string' && p.requestId.trim().length > 0 ? { requestId: p.requestId.trim() } : {}),
    ...(hasExplicitLocalTurnBinding
      ? {
          externalTurnActive: false,
          externalTurnTraceId: undefined,
          externalTurnUserText: undefined,
        }
      : {}),
    ...(typeof p.workspaceDir === 'string' ? { workspaceDir: p.workspaceDir } : {}),
    ...(Array.isArray(p.allowedSkillIds) || p.allowedSkillIds === null
      ? { allowedSkillIds: p.allowedSkillIds }
      : {}),
    ...(Array.isArray(p.selectedSkillIds)
      ? {
          selectedSkillIds: p.selectedSkillIds
            .filter((s) => typeof s === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        }
      : p.selectedSkillIds === null
        ? { selectedSkillIds: [] }
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

function normalizeDirPath(raw, platform = process.platform) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Build a fallback session context for top-level sessions created directly in
 * DSH (e.g. via `dsh-pocket` mobile or another DSH plugin) before LobsterAI's
 * main process issues an explicit `bindSessionContext` RPC.
 *
 * Matches the session `cwd` to a synced LobsterAI agent working directory
 * (exact match first, then deepest containing directory), falling back to
 * `'main'` so external turns inherit LobsterAI persona, skills, memory, and
 * permission defaults.
 */
export function resolveFallbackAgentContextForExternalSession(
  state,
  cwd,
  platform = process.platform,
) {
  const agents = state?.agents instanceof Map ? state.agents : new Map();
  const normalizedCwd = normalizeDirPath(cwd, platform);
  const sep = platform === 'win32' ? '\\' : '/';

  let matchedSpec = null;
  let bestLen = -1;
  if (normalizedCwd) {
    for (const spec of agents.values()) {
      if (!spec || typeof spec !== 'object') continue;
      const specDir = normalizeDirPath(spec.workingDirectory, platform);
      if (!specDir) continue;
      if (normalizedCwd === specDir) {
        if (spec.id !== 'main' || matchedSpec === null) {
          matchedSpec = spec;
          bestLen = Number.MAX_SAFE_INTEGER;
        }
        continue;
      }
      const prefix = specDir.endsWith(sep) ? specDir : `${specDir}${sep}`;
      if (normalizedCwd.startsWith(prefix) && specDir.length > bestLen) {
        matchedSpec = spec;
        bestLen = specDir.length;
      }
    }
  }

  if (!matchedSpec) {
    matchedSpec = agents.get('main') ?? null;
  }

  const agentId = typeof matchedSpec?.id === 'string' && matchedSpec.id.trim().length > 0
    ? matchedSpec.id.trim()
    : 'main';
  const workspaceDir = (typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : '')
    || (typeof matchedSpec?.workingDirectory === 'string' ? matchedSpec.workingDirectory.trim() : '');
  const allowedSkillIds = Array.isArray(matchedSpec?.allowedSkillIds)
    ? matchedSpec.allowedSkillIds.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : null;
  const unlockedCapabilities = Array.isArray(matchedSpec?.hostCapabilities)
    ? matchedSpec.hostCapabilities.filter((c) => typeof c === 'string' && c.trim().length > 0)
    : [];
  const customSystemPrompt = typeof matchedSpec?.systemPrompt === 'string' && matchedSpec.systemPrompt.trim().length > 0
    ? matchedSpec.systemPrompt
    : '';
  const permissionPreset =
    typeof state?.defaultPermissionPreset === 'string' && VALID_PERMISSION_PRESETS.has(state.defaultPermissionPreset)
      ? state.defaultPermissionPreset
      : 'workspace-write';

  return {
    agentId,
    ...(workspaceDir ? { workspaceDir } : {}),
    allowedSkillIds,
    ...(customSystemPrompt ? { customSystemPrompt } : {}),
    ...(unlockedCapabilities.length > 0 ? { unlockedCapabilities } : {}),
    permissionPreset,
    permissionPresetExplicit: false,
    memoryEnabled: state?.memoryEnabled !== false,
    externalDefaultFallback: true,
  };
}
