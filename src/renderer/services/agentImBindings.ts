import { AgentId } from '@shared/agent';
import { RetainedImPlatform } from '@shared/dshEngine/hostConstants';
import { DEFAULT_IM_INSTANCE_ID, getConfiguredImAgent, resolveImAgentBinding } from '@shared/im/agentBinding';

import type { IMGatewayConfig } from '../types/im';
import { getVisibleIMPlatforms } from '../utils/regionFilter';

export interface AgentImChannel {
  key: string;
  name?: string;
  configuredAgentId?: string;
}

export interface AgentImPlatform {
  platform: RetainedImPlatform;
  channels: AgentImChannel[];
}

export function getAgentImPlatforms(config: IMGatewayConfig | null, language: 'zh' | 'en'): AgentImPlatform[] {
  const bindings = config?.settings?.platformAgentBindings;
  return getVisibleIMPlatforms(language).map(platform => {
    if (platform === RetainedImPlatform.Weixin) {
      const channels = config?.weixin?.enabled
        ? [{ key: platform, configuredAgentId: getConfiguredImAgent(bindings, platform, DEFAULT_IM_INSTANCE_ID) }]
        : [];
      return { platform, channels };
    }
    const channels = (config?.[platform]?.instances ?? [])
      .filter(instance => instance.enabled)
      .map(({ instanceId, instanceName }) => ({
        key: `${platform}:${instanceId}`,
        name: instanceName,
        configuredAgentId: getConfiguredImAgent(bindings, platform, instanceId),
      }));
    return { platform, channels };
  });
}

export function getBoundImKeys(platforms: AgentImPlatform[], agentId: string): Set<string> {
  return new Set(platforms.flatMap(({ channels }) =>
    channels.filter(channel => (channel.configuredAgentId || AgentId.Main) === agentId).map(channel => channel.key),
  ));
}

/** Apply only the visible switches that changed. A missing binding normally routes to main. */
export function applyImBindingChanges(
  bindings: Record<string, string> | undefined,
  agentId: string,
  initial: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): Record<string, string> {
  const next = { ...bindings };
  for (const key of new Set([...initial, ...selected])) {
    if (initial.has(key) === selected.has(key)) continue;
    const [platform, instanceId] = key.split(':');
    const accountId = platform === RetainedImPlatform.Weixin ? DEFAULT_IM_INSTANCE_ID : instanceId;
    if (!selected.has(key) && resolveImAgentBinding(next, platform, accountId) !== agentId) continue;
    delete next[key];
    if (platform === RetainedImPlatform.Weixin) delete next[`${platform}:${DEFAULT_IM_INSTANCE_ID}`];
    const inherited = resolveImAgentBinding(next, platform, instanceId);
    if (selected.has(key)) {
      if (inherited !== agentId) next[key] = agentId;
    } else if (inherited === agentId && agentId !== AgentId.Main) {
      // Releasing one inherited bot must leave its sibling bots with their owner.
      next[key] = AgentId.Main;
    }
  }
  return next;
}
