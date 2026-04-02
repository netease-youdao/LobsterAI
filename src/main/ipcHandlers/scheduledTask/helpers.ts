import { PlatformRegistry } from '../../../shared/platform';

export interface ScheduledTaskHelperDeps {
  getIMGatewayManager: () => {
    getConfig: () => Record<string, unknown> | null;
  } | null;
}

let deps: ScheduledTaskHelperDeps | null = null;

export function initScheduledTaskHelpers(d: ScheduledTaskHelperDeps): void {
  deps = d;
}

export function listScheduledTaskChannels(): Array<{ value: string; label: string }> {
  const manager = deps?.getIMGatewayManager();
  const config = manager?.getConfig();
  if (!config) {
    return [...PlatformRegistry.channelOptions()];
  }

  const enabledConfigKeys = new Set<string>();
  const configEntries: Array<[string, unknown]> = Object.entries(
    config as unknown as Record<string, unknown>,
  );
  for (const [key, value] of configEntries) {
    if (value && typeof value === 'object' && (value as { enabled?: boolean }).enabled) {
      enabledConfigKeys.add(key);
    }
  }

  return PlatformRegistry.channelOptions().filter((option) => {
    if (option.value === 'dingtalk') {
      return enabledConfigKeys.has('dingtalk');
    }
    if (option.value === 'qqbot') {
      return enabledConfigKeys.has('qq');
    }
    if (option.value === 'openclaw-weixin') {
      return enabledConfigKeys.has('weixin');
    }
    return enabledConfigKeys.has(option.value);
  });
}
