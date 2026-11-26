import type { CoworkTurnUsageStatus } from '../cowork/llmTurnUsage';

export const RemoteTaskCredits = {
  Capability: 'task_credits_v1', ReaderProjectionVersion: 6, SchemaVersion: 1,
  Source: 'desktop_ledger_snapshot', Scope: 'local_session_turns',
  MaximumAmount: 999999999999.99, MaximumTurns: 10000,
  MetadataBytes: 128 * 1024, ScanBytes: 4 * 1024 * 1024,
} as const;
export const RemoteUsageScope = { Personal: 'personal', Enterprise: 'enterprise', Unknown: 'unknown' } as const;
export const RemoteUsageCoverage = { Complete: 'complete', Partial: 'partial', Unavailable: 'unavailable' } as const;
export const RemoteUsageReason = {
  Missing: 'missing_usage', Pending: 'pending_usage', Duplicate: 'duplicate_attribution',
  ScanLimit: 'scan_limit', UnknownScope: 'unknown_scope', Invalid: 'invalid_usage',
} as const;
export type RemoteUsageReason = typeof RemoteUsageReason[keyof typeof RemoteUsageReason];
export interface RemoteTurnUsage {
  schemaVersion: 1; source: typeof RemoteTaskCredits.Source; status: CoworkTurnUsageStatus;
  billingScope: typeof RemoteUsageScope[keyof typeof RemoteUsageScope]; displayCreditsUsed: string | null;
  requestCount: number; failedRequestCount: number; mediaPending: boolean; updatedAt: string;
}
export interface RemoteTaskUsage {
  schemaVersion: 1; source: typeof RemoteTaskCredits.Source; scope: typeof RemoteTaskCredits.Scope;
  sourceVersion: string; coverage: typeof RemoteUsageCoverage[keyof typeof RemoteUsageCoverage];
  totals: Array<{ billingScope: typeof RemoteUsageScope.Personal | typeof RemoteUsageScope.Enterprise; displayCreditsUsed: string }>;
  totalTurnCount: number; knownTurnCount: number; pendingTurnCount: number; unavailableTurnCount: number;
  updatedAt: string; reasons: RemoteUsageReason[];
}
