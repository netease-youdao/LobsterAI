// Pure session/agent thinking-level resolution for DSH model selection.
// Zero Electron imports — directly unit-testable under Node Vitest.

import {
  OpenClawProviderId,
} from '../../../shared/providers/constants';
import {
  type LobsterAIRequestCapability,
  supportsLobsterAIRequestOptionsV1,
} from '../../../shared/providers/lobsterAIRequestOptions';
import {
  ModelRuntimeProfile,
  type ModelRuntimeProfile as ModelRuntimeProfileType,
} from '../../../shared/providers/modelRuntimeProfiles';
import {
  type ModelThinkingConfig,
  ModelThinkingLevel,
  parseModelThinkingConfig,
  parseModelThinkingLevel,
} from '../../../shared/providers/modelThinking';

export interface DshModelThinkingMetadata {
  supportsThinking?: boolean;
  thinkingConfig?: ModelThinkingConfig;
  requestCapabilities?: readonly LobsterAIRequestCapability[];
  runtimeProfile?: ModelRuntimeProfileType;
}

export interface ResolveEffectiveDshReasoningEffortInput {
  providerId: string;
  modelMetadata?: DshModelThinkingMetadata | null;
  /**
   * Explicit override from `patchSession` (`undefined` = keep stored selection,
   * `null` / `''` = reset to model default).
   */
  overrideThinkingLevel?: string | null;
  sessionThinkingLevel?: string | null;
  agentThinkingLevel?: string | null;
  /**
   * Whether an empty session thinking level may inherit `agentThinkingLevel`.
   * Defaults to `true`. Pass `false` when the session overrides the agent's model.
   */
  inheritAgentThinkingLevel?: boolean;
}

function matchConfiguredThinkingLevel(
  config: ModelThinkingConfig,
  rawLevel: string | null | undefined,
): ModelThinkingLevel | undefined {
  const parsed = parseModelThinkingLevel(rawLevel?.trim());
  if (!parsed) return undefined;
  return config.options.some((option) => option.level === parsed)
    ? parsed
    : undefined;
}

/**
 * Resolve the effective DSH `reasoningEffort` for a turn or session patch.
 *
 * Rules:
 * - For `lobsterai-server` Kimi K3 (`runtimeProfile === 'moonshot-kimi-k3'`),
 *   always resolves to `max` (K3 is always-thinking).
 * - For `lobsterai-server` models with a valid `thinkingConfig` and
 *   `lobsterai-options-v1`, validates the requested/stored product level against
 *   `thinkingConfig.options` and falls back to `thinkingConfig.defaultLevel`.
 * - For `lobsterai-server` models without `lobsterai-options-v1` thinking config,
 *   returns `undefined` so stale levels from other models never leak onto them.
 * - For non-server providers, returns the explicit/stored `ModelThinkingLevel`
 *   when present, or `undefined`.
 */
export function resolveEffectiveDshReasoningEffort(
  input: ResolveEffectiveDshReasoningEffortInput,
): ModelThinkingLevel | undefined {
  const {
    providerId,
    modelMetadata,
    overrideThinkingLevel,
    sessionThinkingLevel,
    agentThinkingLevel,
    inheritAgentThinkingLevel = true,
  } = input;

  if (providerId === OpenClawProviderId.LobsteraiServer) {
    if (modelMetadata?.runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3) {
      return ModelThinkingLevel.Max;
    }

    const thinkingConfig = modelMetadata?.supportsThinking === true
      ? parseModelThinkingConfig(modelMetadata.thinkingConfig)
      : undefined;
    if (
      !thinkingConfig
      || !supportsLobsterAIRequestOptionsV1(modelMetadata?.requestCapabilities)
    ) {
      return undefined;
    }

    if (overrideThinkingLevel !== undefined) {
      const trimmedOverride = overrideThinkingLevel?.trim() ?? '';
      if (!trimmedOverride) {
        return thinkingConfig.defaultLevel;
      }
      return matchConfiguredThinkingLevel(thinkingConfig, trimmedOverride)
        ?? thinkingConfig.defaultLevel;
    }

    const trimmedSession = sessionThinkingLevel?.trim() ?? '';
    if (trimmedSession) {
      return matchConfiguredThinkingLevel(thinkingConfig, trimmedSession)
        ?? thinkingConfig.defaultLevel;
    }

    if (inheritAgentThinkingLevel) {
      const trimmedAgent = agentThinkingLevel?.trim() ?? '';
      if (trimmedAgent) {
        return matchConfiguredThinkingLevel(thinkingConfig, trimmedAgent)
          ?? thinkingConfig.defaultLevel;
      }
    }

    return thinkingConfig.defaultLevel;
  }

  if (overrideThinkingLevel !== undefined) {
    return parseModelThinkingLevel(overrideThinkingLevel?.trim());
  }

  const trimmedSession = sessionThinkingLevel?.trim() ?? '';
  if (trimmedSession) {
    return parseModelThinkingLevel(trimmedSession);
  }

  if (inheritAgentThinkingLevel) {
    const trimmedAgent = agentThinkingLevel?.trim() ?? '';
    if (trimmedAgent) {
      return parseModelThinkingLevel(trimmedAgent);
    }
  }

  return undefined;
}
