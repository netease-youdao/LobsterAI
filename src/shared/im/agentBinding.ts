import { AgentId } from '../agent/constants';

export const DEFAULT_IM_INSTANCE_ID = 'default';

export function getConfiguredImAgent(
  bindings: Record<string, string> | undefined,
  platform: string,
  instanceId?: string,
): string | undefined {
  if (bindings && instanceId) {
    const prefix = `${platform}:`;
    const exact = bindings[prefix + instanceId];
    if (exact) return exact;
    // Imported OpenClaw configurations can key an instance by its short account ID.
    const legacyKey = Object.keys(bindings).find(key =>
      key.startsWith(prefix) && key.length > prefix.length && instanceId.startsWith(key.slice(prefix.length)),
    );
    if (legacyKey && bindings[legacyKey]) return bindings[legacyKey];
  }
  return bindings?.[platform];
}

export function resolveImAgentBinding(
  bindings: Record<string, string> | undefined,
  platform: string,
  instanceId?: string,
): string {
  return getConfiguredImAgent(bindings, platform, instanceId) || AgentId.Main;
}
