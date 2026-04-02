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

/**
 * List notification channels for scheduled tasks.
 *
 * Data source: IM Gateway config (same as Settings → IM 机器人).
 * Channel-to-config-key mapping is resolved automatically via PlatformRegistry,
 * so adding a new IM platform only requires updating PlatformRegistry — no
 * changes needed here.
 */
export function listScheduledTaskChannels(): Array<{ value: string; label: string }> {
  const manager = deps?.getIMGatewayManager();
  const config = manager?.getConfig();
  if (!config) {
    return [...PlatformRegistry.channelOptions()];
  }

  // Collect enabled platform IDs from IM config
  const enabledConfigKeys = new Set<string>();
  const configEntries: Array<[string, unknown]> = Object.entries(
    config as unknown as Record<string, unknown>,
  );
  for (const [key, value] of configEntries) {
    if (value && typeof value === 'object' && (value as { enabled?: boolean }).enabled) {
      enabledConfigKeys.add(key);
    }
  }

  // Filter channels by resolving channel → platform ID via PlatformRegistry
  return PlatformRegistry.channelOptions().filter((option) => {
    const platform = PlatformRegistry.platformOfChannel(option.value);
    if (platform) {
      return enabledConfigKeys.has(platform);
    }
    // Unknown channel: keep if its value directly matches a config key
    return enabledConfigKeys.has(option.value);
  });
}