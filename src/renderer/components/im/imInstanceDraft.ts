import type { Platform } from '@shared/platform';

import type { IMGatewayConfig } from '../../types/im';

export interface ActiveIMInstanceKey {
  platform: Platform;
  instanceId: string;
}

/**
 * Normalizes an object recursively with sorted keys so dirty checks are
 * deterministic regardless of key insertion order.
 */
const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalizeValue(v)]));
  }
  return value;
};

export const areIMConfigsEqual = (left: unknown, right: unknown): boolean => (
  JSON.stringify(canonicalizeValue(left)) === JSON.stringify(canonicalizeValue(right))
);

export const hasFeishuCredentials = (appId: unknown, appSecret: unknown): boolean => (
  typeof appId === 'string' && appId.trim().length > 0
  && typeof appSecret === 'string' && appSecret.trim().length > 0
);

/**
 * Detects whether an `onSave(override)` payload from an instance sub-form came
 * from a one-click bot creation or QR login flow that delivered complete fresh
 * credentials and requested immediate enablement.
 */
export const isIMAutoBindCredentialOverride = (
  platform: Platform,
  override?: Record<string, unknown>,
): boolean => {
  if (!override || override.enabled !== true) {
    return false;
  }
  switch (platform) {
    case 'dingtalk':
      return Boolean(override.clientId && override.clientSecret);
    case 'feishu':
      return hasFeishuCredentials(override.appId, override.appSecret);
    case 'popo':
      return Boolean(override.appKey && override.appSecret && override.aesKey);
    case 'nim':
      return Boolean(
        override.nimToken
        || (override.appKey && override.account && override.token),
      );
    default:
      return false;
  }
};

/**
 * Replaces a single instance inside a multi-instance platform config with the
 * local unsaved draft so connectivity tests probe the draft without writing to
 * SQLite first.
 */
export const buildIMTestConfigWithDraft = <T extends { instanceId: string }>(
  instances: readonly T[],
  draft: T | null | undefined,
): T[] => {
  if (!draft) {
    return [...instances];
  }
  const hasExisting = instances.some(item => item.instanceId === draft.instanceId);
  if (!hasExisting) {
    return [...instances, draft];
  }
  return instances.map(item => (item.instanceId === draft.instanceId ? draft : item));
};

/**
 * Builds the `configOverride` payload for `imService.testGateway` using the
 * local draft of the active instance (or single-instance platform config).
 */
export const resolveIMConnectivityOverride = (
  platform: Platform,
  config: IMGatewayConfig,
  activeInstanceId: string | null,
  draftRecord: Record<string, unknown> | null,
): Partial<IMGatewayConfig> => {
  if (platform === 'netease-bee') {
    return {
      'netease-bee': (draftRecord ?? config['netease-bee']) as IMGatewayConfig['netease-bee'],
    };
  }
  if (platform === 'weixin') {
    return { weixin: config.weixin };
  }
  if (platform === 'popo' && activeInstanceId) {
    const selected = (draftRecord as IMGatewayConfig['popo']['instances'][number] | null)
      ?? config.popo.instances.find(instance => instance.instanceId === activeInstanceId);
    return { popo: { instances: selected ? [selected] : [] } };
  }
  if (platform === 'email') {
    const instances = buildIMTestConfigWithDraft(
      config.email.instances,
      draftRecord as IMGatewayConfig['email']['instances'][number] | null,
    );
    const activeInstance = activeInstanceId
      ? instances.find(item => item.instanceId === activeInstanceId)
      : instances.find(item => item.enabled) || instances[0];
    return { email: { instances: activeInstance ? [activeInstance] : [] } };
  }

  const multiPlatformKey = platform as
    | 'dingtalk'
    | 'feishu'
    | 'qq'
    | 'wecom'
    | 'telegram'
    | 'discord'
    | 'nim';
  const currentGroup = config[multiPlatformKey] as { instances?: Array<{ instanceId: string }> } | undefined;
  const instances = Array.isArray(currentGroup?.instances)
    ? buildIMTestConfigWithDraft(
        currentGroup.instances,
        draftRecord as { instanceId: string } | null,
      )
    : [];
  return {
    [multiPlatformKey]: {
      ...currentGroup,
      instances: activeInstanceId ? instances.filter(item => item.instanceId === activeInstanceId) : instances,
    },
  } as Partial<IMGatewayConfig>;
};
