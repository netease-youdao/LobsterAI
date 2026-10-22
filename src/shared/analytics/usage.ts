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
export const UsageFailureCode = {
  EngineNotReady: 'engine_not_ready', Quota: 'quota', Subscription: 'subscription', Auth: 'auth',
  RateLimit: 'rate_limit', Timeout: 'timeout', Cancelled: 'cancelled', Permission: 'permission',
  Network: 'network', Model: 'model', Unknown: 'unknown', ApiUnavailable: 'api_unavailable',
  Http: 'http_error', ToolArguments: 'tool_arguments', TargetUnavailable: 'target_unavailable',
  Script: 'script_error', BrowserBridge: 'browser_bridge', Policy: 'policy_blocked',
} as const;
export type UsageFailureCode = typeof UsageFailureCode[keyof typeof UsageFailureCode];

const TOOL_ERROR_STATUS = { Error: 'error' } as const;
const MAX_ERROR_ENVELOPE_LENGTH = 256 * 1024;
const MAX_ERROR_PREFIX_LENGTH = 512;

function usageErrorText(error: unknown): string {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (text.trimStart().startsWith('{')) {
    if (text.length > MAX_ERROR_ENVELOPE_LENGTH) return '';
    try {
      const envelope: unknown = JSON.parse(text);
      if (!envelope || typeof envelope !== 'object') return '';
      const record = envelope as Record<string, unknown>;
      // OpenClaw's tool-error envelope is trusted framing. Arbitrary result
      // bodies must not become evidence of product auth, quota or engine state.
      if (record.status !== TOOL_ERROR_STATUS.Error || typeof record.error !== 'string') return '';
      text = record.error;
    } catch {
      return '';
    }
  }
  if (text.startsWith('SECURITY NOTICE:')) {
    // OpenClaw wraps tool errors as an API result. Strip only that outer
    // framing, never a nested Web Fetch/Browser response body.
    const wrapper = /^SECURITY NOTICE:[\s\S]{0,2048}?\n<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\nSource: API\n---\n/.exec(text);
    if (!wrapper) return '';
    const end = text.lastIndexOf(`\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${wrapper[1]}">>>`);
    if (end < wrapper[0].length) return '';
    text = text.slice(wrapper[0].length, end);
  }
  return text.slice(0, MAX_ERROR_PREFIX_LENGTH).trim().replace(/^(?:Error:\s*)+/i, '');
}

function classifyUsageErrorText(text: string): UsageFailureCode {
  if (text === UsageFailureCode.ApiUnavailable) return UsageFailureCode.ApiUnavailable;
  if (/^Chrome MCP (?:subprocess|process|existing-session attach failed)/i.test(text))
    return UsageFailureCode.BrowserBridge;
  if (/^(?:Command|Browser navigation|Request|Connection) timed out\b/i.test(text))
    return UsageFailureCode.Timeout;
  if (/^ERR_CONNECTION_REFUSED\b/i.test(text))
    return UsageFailureCode.Network;
  if (/^(?:tab not found:|Element .+ not found or not visible|Unknown (?:ref|uid)|Stale (?:ref|uid)|Browser (?:page .+ does not exist|element .+ (?:is stale|has no visible box)))/i.test(text))
    return UsageFailureCode.TargetUnavailable;
  if (/^(?:click requires ref or selector|fill requires fields|Browser element reference is missing|(?:Invalid|Missing|required) (?:argument|parameter))/i.test(text))
    return UsageFailureCode.ToolArguments;
  if (/^(?:page\.evaluate:\s*(?:Error:\s*)?)?Invalid evaluate function:/i.test(text))
    return UsageFailureCode.Script;
  if (/^(?:Navigation (?:was )?blocked|Blocked(?::| hostname\b)|Domain policy: Blocked hostname\b|Invalid path: must stay within)/i.test(text))
    return UsageFailureCode.Policy;
  // Match the failure itself; recovery advice may mention a gateway followed
  // much later by "browser is unavailable" on the same line.
  if (/^(?:ENGINE_NOT_READY\b|(?:OpenClaw\s+)?gateway\s+(?:is\s+)?(?:not\s+ready|unavailable))/i.test(text))
    return UsageFailureCode.EngineNotReady;
  if (/40204|quota|insufficient.*credit|余额|额度/i.test(text)) return UsageFailureCode.Quota;
  if (/40203|subscription|订阅/i.test(text)) return UsageFailureCode.Subscription;
  if (/401|unauthorized|not.*logged|登录/i.test(text)) return UsageFailureCode.Auth;
  if (/429|rate.?limit/i.test(text)) return UsageFailureCode.RateLimit;
  if (/timeout|timed?\s*out|超时/i.test(text)) return UsageFailureCode.Timeout;
  if (/cancel|abort|取消/i.test(text)) return UsageFailureCode.Cancelled;
  if (/permission|denied|forbidden|权限/i.test(text)) return UsageFailureCode.Permission;
  if (/network|fetch|ECONN|ENOTFOUND|网络/i.test(text)) return UsageFailureCode.Network;
  if (/model|provider|模型/i.test(text)) return UsageFailureCode.Model;
  return UsageFailureCode.Unknown;
}

export function usageFailureDetails(error: unknown): { failureCode: UsageFailureCode; httpStatus?: number } {
  const text = usageErrorText(error);
  const httpFailure = /^Web fetch failed \(([45]\d{2})\):/i.exec(text);
  if (httpFailure) {
    // Never inspect an external error page for our account or engine status.
    return { failureCode: UsageFailureCode.Http, httpStatus: Number(httpFailure[1]) };
  }
  return { failureCode: classifyUsageErrorText(text) };
}

export function usageFailureCode(error: unknown): UsageFailureCode {
  return usageFailureDetails(error).failureCode;
}
