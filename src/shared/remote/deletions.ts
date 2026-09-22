import type { RemoteOwner } from './constants';
import type { RemoteSyncTargetIdentity } from './syncTarget';

export const RemoteDeletion = {
  Capability: 'session_delete_v1', Inbox: 'sessionDeletion:', Pending: 'sessionDeletionPending:', Fence: 'deletionFence:', Closed: 'deletionClosed:',
  Guard: 'deletionGuard:', Completed: 'completed', Cancelled: 'cancelled',
  Prepared: 'prepared', EffectStarted: 'effect_started', Stopped: 'stopped', Deleted: 'local_deleted',
  Reconciling: 'reconciling', Available: 'deletions.available', Changed: 'deletion.changed',
  Delete: 'delete', StopAndDelete: 'stop_and_delete', Execute: 'execute', DeleteOnly: 'delete_only',
} as const;
export interface DeletionGuard { version: string; runId: string | null }
export interface DeletionOperation {
  operationId: string; sessionId: string; deviceId: string; deletionVersion: string; stateVersion: string;
  state: string; action: string; approvedGuard: DeletionGuard; reason?: string | null;
  resume?: { phase: 'delete_only'; localFenceId: string; previousPermitId: string; settlementReportId: string };
}
export interface DeletionTarget extends RemoteOwner {
  serviceScope: string; deviceId: string; sessionId: string; localSessionId: string; streamEpoch: string;
  syncTarget?: RemoteSyncTargetIdentity;
}
export interface DeletionClaim {
  operation: DeletionOperation; target: DeletionTarget;
  claim: { claimId: string; claimToken: string; leaseUntil: string; deletionVersion: string; observationOnly?: boolean };
}
export interface DeletionPermit { permitId: string; permitToken: string; permitUntil: string; serverTime: string; executionAllowed: boolean; connectionGeneration?: string; stateVersion?: string }
export interface DeletionReceipt {
  kind: 'local_deleted'; permitId: string; permitToken: string; localReceiptId: string; localFenceId: string;
  sessionId: string; localSessionId: string; deviceId: string; streamEpoch: string; guard: DeletionGuard;
  localDeletionRevision: string; closedSourceHighWatermark: string; lastAcknowledgedSourceSeq: string;
  deletedAt: string; executionSettlementDigest: string; receiptDigest: string;
}
export interface DeletionCompletion {
  operationId: string; deletionVersion: string; proofKind: string; owner: RemoteOwner; serviceScope: string;
  localReceiptId?: string; receiptDigest?: string; deviceId: string; sessionId: string; localSessionId: string;
  streamEpoch: string; guard?: DeletionGuard; localDeletionRevision?: string; closedSourceHighWatermark?: string;
  committedDeletionSeq: string; completedAt: string; sourceEventId?: string; sourceSeq?: string;
}
