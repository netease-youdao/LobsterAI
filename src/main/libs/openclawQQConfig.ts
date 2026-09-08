import type { QQInstanceConfig } from '../im/types';

export const OpenClawQQPlugin = {
  PackageId: 'qqbot',
  Id: 'openclaw-qqbot',
  Channel: 'qqbot',
} as const;

export const OpenClawQQPolicy = {
  Open: 'open',
  Allowlist: 'allowlist',
  Pairing: 'pairing',
  Disabled: 'disabled',
} as const;

// Matches the v2026.8.1 official QQ migration. Tencent 2.0 uses allowFrom
// for native approvals too, so empty/wildcard lists must never reach it.
export const QQ_APPROVALS_DISABLED = 'openclaw:approval-disabled';

function normalizeQQIds(values: readonly string[] = []): string[] {
  return [...new Set(values.map(value => {
    const id = value.trim().replace(/^qqbot:/i, '');
    return id === QQ_APPROVALS_DISABLED ? id : id.toUpperCase();
  }).filter(id => id && id !== '*'))];
}

export function buildQQAccountConfig(
  instance: QQInstanceConfig,
  secretEnvVar: string,
): Record<string, unknown> {
  const allowFrom = normalizeQQIds(instance.allowFrom);
  const groupAllowFrom = normalizeQQIds(instance.groupAllowFrom);
  const dmPolicy = instance.dmPolicy || OpenClawQQPolicy.Open;
  const legacyOpenAllowlist = dmPolicy === OpenClawQQPolicy.Allowlist
    && instance.allowFrom?.some(id => id.trim().replace(/^qqbot:/i, '') === '*');
  const groupPolicy = instance.groupPolicy || OpenClawQQPolicy.Open;
  const legacyOpenGroups = groupPolicy === OpenClawQQPolicy.Allowlist
    && instance.groupAllowFrom?.some(id => id.trim() === '*');
  return {
    enabled: true,
    name: instance.instanceName,
    appId: instance.appId,
    clientSecret: `\${${secretEnvVar}}`,
    dmPolicy: legacyOpenAllowlist ? OpenClawQQPolicy.Open : dmPolicy,
    allowFrom: allowFrom.length > 0 ? allowFrom : [QQ_APPROVALS_DISABLED],
    groupPolicy: legacyOpenGroups ? OpenClawQQPolicy.Open : groupPolicy,
    // Tencent's middleware treats an empty allowlist as open. Preserve a
    // restrictive policy with no configured IDs using a non-matching marker.
    groupAllowFrom: groupAllowFrom.length > 0 ? groupAllowFrom : [QQ_APPROVALS_DISABLED],
    markdownSupport: instance.markdownSupport ?? true,
    ...(instance.imageServerBaseUrl ? { imageServerBaseUrl: instance.imageServerBaseUrl } : {}),
  };
}
