export const OwnershipIpc = {
  GetDetail: 'ownership:getDetail', Preview: 'ownership:preview', Commit: 'ownership:commit',
  GetResult: 'ownership:getResult', Changed: 'ownership:changed',
} as const;

export const OwnershipTargetKind = { Task: 'task', Agent: 'agent' } as const;
export type OwnershipTargetKind = typeof OwnershipTargetKind[keyof typeof OwnershipTargetKind];

export const OwnershipErrorCode = {
  AuthRequired: 'AUTH_REQUIRED', AccountChanged: 'ACCOUNT_CHANGED', PlanExpired: 'PLAN_EXPIRED',
  PlanChanged: 'PLAN_CHANGED', ResourceBusy: 'RESOURCE_BUSY', NotAssociable: 'NOT_ASSOCIABLE',
  NotAvailable: 'NOT_AVAILABLE', RequestConflict: 'REQUEST_CONFLICT', LocalCommitFailed: 'LOCAL_COMMIT_FAILED',
} as const;
export type OwnershipErrorCode = typeof OwnershipErrorCode[keyof typeof OwnershipErrorCode];

export const OwnershipSyncState = {
  Local: 'local', Pending: 'pending', Synced: 'synced', WaitingService: 'waiting_service',
  Failed: 'failed', Partial: 'partial',
} as const;
export type OwnershipSyncState = typeof OwnershipSyncState[keyof typeof OwnershipSyncState];

export const OwnershipContentSyncState = {
  Unknown: 'unknown', Failed: 'failed', Partial: 'partial', Pending: 'pending', Synced: 'synced', Local: 'local', Waiting: 'waiting',
} as const;
export type OwnershipContentSyncState = typeof OwnershipContentSyncState[keyof typeof OwnershipContentSyncState];
export const OwnershipContentSyncReason = { Content: 'content', History: 'history', Connection: 'connection', Unavailable: 'unavailable' } as const;
export type OwnershipContentSyncReason = typeof OwnershipContentSyncReason[keyof typeof OwnershipContentSyncReason];

export const OwnershipResultStatus = {
  Associated: 'associated', AlreadyAssociated: 'already_associated', NotCommitted: 'not_committed',
} as const;

export const OWNERSHIP_MANUAL_SOURCE = 'manual_claim';
export const OWNERSHIP_PLAN_TTL_MS = 5 * 60 * 1000;
