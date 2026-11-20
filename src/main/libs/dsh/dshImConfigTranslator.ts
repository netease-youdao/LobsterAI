// Pure translator mapping LobsterAI's SQLite IMGatewayConfig into the
// 7 retained channel instance configs consumed by `@lobsterai/dsh-channels`.
// Retired platforms (`popo`, `nim`, `netease-bee`, `email`) are excluded.

import { RetainedImPlatform } from '../../../shared/dshEngine/hostConstants';
import type { DshChannelInstanceConfig } from '../../im/dshChannelsBridge';

const MULTI_INSTANCE_PLATFORMS: readonly RetainedImPlatform[] = [
  RetainedImPlatform.Feishu,
  RetainedImPlatform.DingTalk,
  RetainedImPlatform.WeCom,
  RetainedImPlatform.QQ,
  RetainedImPlatform.Telegram,
  RetainedImPlatform.Discord,
];

function resolveBindingAgentId(
  bindings: Record<string, string> | undefined,
  platform: string,
  instanceId?: string,
): string {
  if (!bindings) return 'main';
  if (instanceId) {
    const exact = bindings[`${platform}:${instanceId}`];
    if (exact) return exact;
    const prefix = `${platform}:`;
    for (const [key, value] of Object.entries(bindings)) {
      if (key.startsWith(prefix)) {
        const suffix = key.slice(prefix.length);
        if (suffix === instanceId || instanceId.startsWith(suffix)) {
          return value;
        }
      }
    }
  }
  return bindings[platform] || 'main';
}

export function buildDshImChannelInstances(options: {
  imConfig: Record<string, unknown>;
  getDefaultCwd?: (agentId?: string) => string;
}): DshChannelInstanceConfig[] {
  const { imConfig, getDefaultCwd } = options;
  const settings = (imConfig.settings && typeof imConfig.settings === 'object'
    ? imConfig.settings
    : {}) as { platformAgentBindings?: Record<string, string> };
  const bindings = settings.platformAgentBindings;
  const result: DshChannelInstanceConfig[] = [];

  for (const platform of MULTI_INSTANCE_PLATFORMS) {
    const section = imConfig[platform];
    if (!section || typeof section !== 'object') continue;
    const instances = (section as { instances?: unknown[] }).instances;
    if (!Array.isArray(instances)) continue;
    for (const raw of instances) {
      if (!raw || typeof raw !== 'object') continue;
      const inst = raw as Record<string, unknown>;
      const instanceId = typeof inst.instanceId === 'string' && inst.instanceId.trim()
        ? inst.instanceId.trim()
        : 'default';
      const agentId = resolveBindingAgentId(bindings, platform, instanceId);
      result.push({
        platform,
        instanceId,
        enabled: inst.enabled === true,
        agentId,
        cwd: getDefaultCwd?.(agentId),
        config: { ...inst },
      });
    }
  }

  // Weixin (single-instance or accounts-based)
  const weixin = imConfig[RetainedImPlatform.Weixin];
  if (weixin && typeof weixin === 'object') {
    const rec = weixin as Record<string, unknown>;
    const agentId = resolveBindingAgentId(bindings, RetainedImPlatform.Weixin, 'default');
    result.push({
      platform: RetainedImPlatform.Weixin,
      instanceId: 'default',
      enabled: rec.enabled === true,
      agentId,
      cwd: getDefaultCwd?.(agentId),
      config: { ...rec },
    });
  }

  return result;
}
