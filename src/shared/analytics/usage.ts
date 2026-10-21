/** Versioned additions to rlog. Existing action names retain their original meaning. */
export const UsageAnalytics = {
  SchemaVersion: 1,
  MediaSchemaVersion: 2,
  ResourceSaltStoreKey: 'usage_analytics_resource_salt',
  MaxTrackedItems: 500,
} as const;

export const UsageStage = {
  View: 'view',
  Load: 'load',
  CatalogRefresh: 'catalog_refresh',
  Prepare: 'prepare',
  Filter: 'filter',
  Impression: 'impression',
  Detail: 'detail',
  Summon: 'summon',
  Draft: 'draft',
  Select: 'select',
  Login: 'login',
  Subscribe: 'subscribe',
  Submit: 'submit',
  Start: 'start',
  FirstResponse: 'first_response',
  Permission: 'permission',
  PermissionDecision: 'permission_decision',
  End: 'end',
  Confirmation: 'confirmation',
  Accepted: 'accepted',
  Generated: 'generated',
  Saved: 'saved',
  DeliveryAttempt: 'delivery_attempt',
  Discovered: 'discovered',
} as const;
export type UsageStage = (typeof UsageStage)[keyof typeof UsageStage];

export const UsageOutcome = {
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Timeout: 'timeout',
  Interrupted: 'interrupted',
  Completed: 'completed',
  CompletedWithToolErrors: 'completed_with_tool_errors',
  Requested: 'requested',
  Resolved: 'resolved',
  Allowed: 'allowed',
  Denied: 'denied',
  Unknown: 'unknown',
} as const;
export type UsageOutcome = (typeof UsageOutcome)[keyof typeof UsageOutcome];

export const UsageEntry = {
  Plaza: 'plaza',
  Featured: 'featured',
  Detail: 'detail',
  Starter: 'starter',
  Picker: 'picker',
  Direct: 'direct',
  Continue: 'continue',
  Runtime: 'runtime',
} as const;
export type UsageEntry = (typeof UsageEntry)[keyof typeof UsageEntry];

export const UsageOrigin = { Desktop: 'desktop', Im: 'im' } as const;
export type UsageOrigin = (typeof UsageOrigin)[keyof typeof UsageOrigin];

export interface UsageContext {
  taskId: string;
  turnId: string;
  journeyId?: string;
  presetId?: string;
  catalogVersion?: string;
  entry: UsageEntry;
}

/** ownerKey is local bookkeeping only; never spread this object into a report. */
export interface StoredUsageContext extends UsageContext {
  ownerKey: string;
  localSessionId: string;
}

export type UsageParams = Record<string, string | number | boolean | null | undefined>;

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const isUsageId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const catalogAnalyticsId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value) ? value : undefined;

/** Allowlist at both the IPC and persisted-metadata boundaries. */
export function readUsageContext(value: unknown): UsageContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (!isUsageId(item.taskId) || !isUsageId(item.turnId)) return undefined;
  return {
    taskId: item.taskId,
    turnId: item.turnId,
    journeyId: isUsageId(item.journeyId) ? item.journeyId : undefined,
    presetId: catalogAnalyticsId(item.presetId),
    catalogVersion: catalogAnalyticsId(item.catalogVersion),
    entry: Object.values(UsageEntry).includes(item.entry as UsageEntry)
      ? (item.entry as UsageEntry)
      : UsageEntry.Runtime,
  };
}

/** Classify locally; raw exceptions, responses and URLs must never enter rlog. */
export function usageFailureCode(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/ENGINE_NOT_READY|gateway.*not.*ready|gateway.*unavailable/i.test(text))
    return 'engine_not_ready';
  if (/40204|quota|insufficient.*credit|余额|额度/i.test(text)) return 'quota';
  if (/40203|subscription|订阅/i.test(text)) return 'subscription';
  if (/401|unauthorized|not.*logged|登录/i.test(text)) return 'auth';
  if (/429|rate.?limit/i.test(text)) return 'rate_limit';
  if (/timeout|timed?\s*out|超时/i.test(text)) return 'timeout';
  if (/cancel|abort|取消/i.test(text)) return 'cancelled';
  if (/permission|denied|forbidden|权限/i.test(text)) return 'permission';
  if (/network|fetch|ECONN|ENOTFOUND|网络/i.test(text)) return 'network';
  if (/model|provider|模型/i.test(text)) return 'model';
  return 'unknown';
}
