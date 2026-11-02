/**
 * sessions_spawn lets the model pass any `model`, and OpenClaw v2026.8.1 starts
 * same-agent children on the agent's configured model instead of the session's
 * active one. LobsterAI never lets the model choose: same-agent children run on
 * the requesting run's model, other agents on their own configured model.
 */
export const SESSIONS_SPAWN_TOOL_NAME = 'sessions_spawn';
// OpenClaw's normalizeToolModelOverride treats "default" as an omitted override.
export const SPAWN_MODEL_DEFAULT = 'default';
const ACP_RUNTIME = 'acp';

const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The `model` a sessions_spawn call must carry, or undefined when it already does. */
export function resolveSpawnModel(params: {
  spawnParams: Record<string, unknown>;
  requesterAgentId?: string;
  requesterModel?: string;
}): string | undefined {
  const { spawnParams } = params;
  // ACP harnesses own their model catalog.
  if (spawnParams.runtime === ACP_RUNTIME) return undefined;
  const targetAgentId = normalize(spawnParams.agentId).toLowerCase();
  const sameAgent = !targetAgentId || targetAgentId === normalize(params.requesterAgentId).toLowerCase();
  const model = sameAgent && params.requesterModel ? params.requesterModel : SPAWN_MODEL_DEFAULT;
  const requested = normalize(spawnParams.model);
  if (model === SPAWN_MODEL_DEFAULT) {
    return !requested || requested.toLowerCase() === SPAWN_MODEL_DEFAULT ? undefined : model;
  }
  return requested === model ? undefined : model;
}
