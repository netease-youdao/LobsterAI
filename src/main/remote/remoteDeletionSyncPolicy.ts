import type { RemoteOwner } from '../../shared/remote/constants';
import { sameOwner } from './canonical';

export const RemoteDeletionSyncKind = {
  Live: 'live', Settled: 'settled', LegacyDelete: 'legacy_delete', ControlDelete: 'control_delete',
  Blocked: 'blocked', NotApplicable: 'not_applicable',
} as const;
export const RemoteDeletionProtocol = { Legacy: 'legacy_sync', Control: 'control_facts', Execution: 'remote_execution', Unknown: 'unknown' } as const;
export const RemoteDeletionSyncState = { Pending: 'pending', Reconciling: 'reconciling', Acknowledged: 'acknowledged', Blocked: 'blocked' } as const;
export const RemoteDeletionReason = {
  None: 'REMOTE_DELETION_NONE', Confirmed: 'REMOTE_DELETION_CONFIRMED', Pending: 'REMOTE_DELETION_PENDING',
  Binding: 'REMOTE_DELETION_BINDING_UNRESOLVED', Evidence: 'REMOTE_DELETION_EVIDENCE_INVALID',
  MissingProjection: 'REMOTE_DELETION_PROJECTION_MISSING', PendingOperation: 'REMOTE_DELETION_OPERATION_PENDING',
  Budget: 'REMOTE_DELETION_EVIDENCE_BUDGET', NotApplicable: 'REMOTE_DELETION_NOT_APPLICABLE',
  Admission: 'REMOTE_DELETION_ADMISSION_REQUIRED',
} as const;
export const RemoteDeletionProof = { LegacyAck: 'legacy_ack_compat', Control: 'control_facts', Execution: 'remote_execution' } as const;
export type RemoteDeletionProtocol = typeof RemoteDeletionProtocol[keyof typeof RemoteDeletionProtocol];
export interface RemoteDeletionClassification {
  kind: typeof RemoteDeletionSyncKind[keyof typeof RemoteDeletionSyncKind]; protocol: RemoteDeletionProtocol;
  reason: typeof RemoteDeletionReason[keyof typeof RemoteDeletionReason]; bindingKey?: string;
}
export interface RemoteDeletionPolicyEvidence {
  applicable: boolean; admitted: boolean; localExists: boolean; deleted: boolean; validTombstone: boolean;
  owner: RemoteOwner | null; deletionOwner: RemoteOwner | null; bindingMatches: boolean;
  adopted: boolean; controlBindingValid: boolean; controlProofPresent: boolean; controlProofValid: boolean;
  executionProofPresent: boolean; executionProofValid: boolean; persistedProofValid: boolean;
  sourceSeq: number; ackSeq: number; preDeleteSourceSeq: number; ackSourceSeq: number | null; ackAt: number | null;
  deletedProjectionValid: boolean; pendingOperation: boolean; invalidEvidence: boolean;
}
/** Pure classification: snapshot flags and wall-clock ordering never establish or invalidate an ACK. */
export function classifyRemoteDeletionSync(e: RemoteDeletionPolicyEvidence): RemoteDeletionClassification {
  const result = (kind: RemoteDeletionClassification['kind'], protocol: RemoteDeletionProtocol, reason: RemoteDeletionClassification['reason']): RemoteDeletionClassification => ({ kind, protocol, reason });
  const K = RemoteDeletionSyncKind, P = RemoteDeletionProtocol, R = RemoteDeletionReason;
  if (!e.applicable) return result(K.NotApplicable, P.Unknown, R.NotApplicable);
  if (!e.deleted) return result(e.localExists ? K.Live : K.Blocked, P.Unknown, e.localExists ? R.None : R.Evidence);
  if (!e.admitted) return result(K.Blocked, P.Unknown, R.Admission);
  if (!e.validTombstone || e.localExists || !sameOwner(e.owner, e.deletionOwner) || e.invalidEvidence)
    return result(K.Blocked, P.Unknown, R.Evidence);
  if (!e.bindingMatches) return result(K.Blocked, P.Unknown, R.Binding);
  if (e.executionProofPresent) return result(e.executionProofValid ? K.Settled : K.Blocked, P.Execution, e.executionProofValid ? R.Confirmed : R.Evidence);
  if (e.controlProofPresent) return result(e.controlProofValid ? K.Settled : K.Blocked, P.Control, e.controlProofValid ? R.Confirmed : R.Evidence);
  if (e.adopted) return result(e.controlBindingValid ? K.ControlDelete : K.Blocked, P.Control, e.controlBindingValid ? R.Pending : R.Binding);
  if (e.persistedProofValid) return result(K.Settled, P.Legacy, R.Confirmed);
  const sequences = [e.sourceSeq, e.ackSeq, e.preDeleteSourceSeq];
  if (!sequences.every(n => Number.isSafeInteger(n) && n >= 0) || e.ackSeq > e.sourceSeq)
    return result(K.Blocked, P.Legacy, R.Evidence);
  if (e.ackAt !== null || e.ackSourceSeq !== null) {
    if (!Number.isFinite(e.ackAt) || e.ackAt === null || !Number.isSafeInteger(e.ackSourceSeq) || e.ackSourceSeq === null
      || e.sourceSeq !== e.ackSeq || e.ackSeq !== e.ackSourceSeq || e.ackSourceSeq <= e.preDeleteSourceSeq)
      return result(K.Blocked, P.Legacy, R.Evidence);
    if (e.pendingOperation) return result(K.LegacyDelete, P.Legacy, R.PendingOperation);
    if (!e.deletedProjectionValid) return result(K.Blocked, P.Legacy, R.MissingProjection);
    return result(K.Settled, P.Legacy, R.Confirmed);
  }
  return result(K.LegacyDelete, P.Legacy, e.pendingOperation ? R.PendingOperation : R.Pending);
}
