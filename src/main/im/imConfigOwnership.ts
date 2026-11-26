import { isDeepStrictEqual } from 'node:util';

import type { IMGatewayConfig, IMGatewayStatus } from './types';
import { DEFAULT_IM_CONFIG, DEFAULT_IM_STATUS } from './types';

export type MultiPlatform = { [K in keyof IMGatewayConfig]: IMGatewayConfig[K] extends { instances: unknown[] } ? K : never }[keyof IMGatewayConfig];
const multiPlatforms = ['dingtalk', 'feishu', 'telegram', 'qq', 'discord', 'nim', 'wecom', 'popo', 'email'] as const satisfies readonly MultiPlatform[];
const singlePlatforms = ['weixin', 'netease-bee'] as const;
export type ImInstanceAccess = (platform: string, instanceId?: string) => boolean;

function bindingVisible(key: string, allowed: ImInstanceAccess): boolean {
  const split = key.indexOf(':');
  return split < 0 ? allowed(key) : allowed(key.slice(0, split), key.slice(split + 1));
}

export function assertImInstanceAccess(allowed: ImInstanceAccess, platform: string, id: string, patch?: { instanceId?: unknown }): void {
  if (typeof id !== 'string' || !id || !allowed(platform, id) || patch?.instanceId !== undefined && patch.instanceId !== id) {
    throw new Error('IM instance is unavailable');
  }
}

/** Older settings use a shortened instance ID for Agent bindings. Resolve it against the stored catalog. */
function bindingAccess(config: IMGatewayConfig, allowed: ImInstanceAccess): ImInstanceAccess {
  return (platform, id) => {
    if (id && multiPlatforms.includes(platform as MultiPlatform)) {
      const instances = config[platform as MultiPlatform].instances;
      const match = instances.find(item => item.instanceId === id);
      if (match) return allowed(platform, id);
      const candidates = instances.filter(item => item.instanceId.startsWith(id));
      if (candidates.length) return candidates.every(item => allowed(platform, item.instanceId));
    }
    return allowed(platform, id);
  };
}

function visiblePlatforms<T extends IMGatewayConfig | IMGatewayStatus>(all: T, defaults: T, allowed: ImInstanceAccess): T {
  const view = { ...all };
  for (const platform of multiPlatforms) {
    const instances = all[platform].instances.filter(item => allowed(platform, item.instanceId));
    Object.assign(view, { [platform]: { instances } });
  }
  for (const platform of singlePlatforms) {
    if (!allowed(platform)) Object.assign(view, { [platform]: defaults[platform] });
  }
  return view;
}

export function visibleImStatus(status: IMGatewayStatus, allowed: ImInstanceAccess): IMGatewayStatus {
  return visiblePlatforms(status, DEFAULT_IM_STATUS, allowed);
}

export function visibleImConfig(config: IMGatewayConfig, allowed: ImInstanceAccess): IMGatewayConfig {
  const view = visiblePlatforms(config, DEFAULT_IM_CONFIG, allowed);
  const checkBinding = bindingAccess(config, allowed);
  if (config.settings.platformAgentBindings) {
    view.settings = { ...config.settings, platformAgentBindings: Object.fromEntries(
      Object.entries(config.settings.platformAgentBindings).filter(([key]) => bindingVisible(key, checkBinding))) };
  }
  return view;
}

/** Bind only rows or single-account credentials genuinely introduced by this explicit local save. */
export function newImInstances(current: IMGatewayConfig, changes: Partial<IMGatewayConfig>): Array<[string, string?]> {
  const created: Array<[string, string?]> = [];
  for (const platform of multiPlatforms) {
    if (!changes[platform]) continue;
    const before = new Set(current[platform].instances.map(item => item.instanceId));
    for (const item of changes[platform].instances) if (!before.has(item.instanceId)) created.push([platform, item.instanceId]);
  }
  if (!current.weixin.accountId && !current.weixin.botToken && changes.weixin?.accountId && changes.weixin.botToken) created.push(['weixin']);
  if (!current['netease-bee'].clientId && !current['netease-bee'].secret && changes['netease-bee']?.clientId && changes['netease-bee'].secret) created.push(['netease-bee']);
  return created;
}

/** A renderer saves its visible catalog. Keep hidden records when the backing setter replaces the whole collection. */
export function mergeVisibleImConfig(current: IMGatewayConfig, changes: Partial<IMGatewayConfig>, allowed: ImInstanceAccess): Partial<IMGatewayConfig> {
  const merged = { ...changes };
  for (const platform of multiPlatforms) {
    const proposed = changes[platform];
    if (!proposed) continue;
    if (!Array.isArray(proposed.instances)) throw new Error('Invalid IM instance list');
    for (const item of proposed.instances) assertImInstanceAccess(allowed, platform, item.instanceId);
    if (platform === 'nim' || platform === 'email') {
      const hidden = current[platform].instances.filter(item => !allowed(platform, item.instanceId));
      Object.assign(merged, { [platform]: { instances: [...proposed.instances, ...hidden] } });
    }
  }
  for (const platform of singlePlatforms) {
    if (changes[platform] && !allowed(platform)) {
      // The renderer includes the redacted defaults when saving the entire form.
      if (!isDeepStrictEqual(changes[platform], DEFAULT_IM_CONFIG[platform])) throw new Error('IM instance is unavailable');
      delete merged[platform];
    }
  }
  const bindings = changes.settings?.platformAgentBindings;
  if (bindings) {
    const checkBinding = bindingAccess(current, allowed);
    if (Object.keys(bindings).some(key => !bindingVisible(key, checkBinding))) throw new Error('IM instance is unavailable');
    const hidden = Object.entries(current.settings.platformAgentBindings ?? {}).filter(([key]) => !bindingVisible(key, checkBinding));
    merged.settings = { ...changes.settings, platformAgentBindings: { ...bindings, ...Object.fromEntries(hidden) } };
  }
  return merged;
}

/** Legacy platform-wide pairing and switches have no per-instance proof. */
export function canManageImPlatform(config: IMGatewayConfig, platform: string, allowed: ImInstanceAccess): boolean {
  const [channel, id, ...rest] = platform.split(':');
  if (!(multiPlatforms.includes(channel as MultiPlatform) || singlePlatforms.some(candidate => candidate === channel)) || rest.length) return false;
  if (id !== undefined) {
    return multiPlatforms.includes(channel as MultiPlatform) && config[channel as MultiPlatform].instances.some(item => item.instanceId === id)
      && allowed(channel, id);
  }
  return allowed(channel) && (!multiPlatforms.includes(channel as MultiPlatform) ||
    config[channel as MultiPlatform].instances.every(instance => allowed(channel, instance.instanceId)));
}
