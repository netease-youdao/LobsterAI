import type { OwnershipErrorCode, OwnershipResultStatus, OwnershipSyncState, OwnershipTargetKind } from './constants';

export interface OwnershipTarget { kind: OwnershipTargetKind; id: string }
export interface OwnershipResources { agentIds: string[]; sessionIds: string[] }
export interface OwnershipAccount { label: string; scopeLabel: string; partition: string }
export interface OwnershipDisplay {
  kind: 'anonymous' | 'owned' | 'default'; label: string; scopeLabel: string; associatedAt?: number;
}
export interface OwnershipDetail extends OwnershipTarget {
  title: string; ownership: OwnershipDisplay;
  agent?: { id: string; name: string; ownership: OwnershipDisplay };
  deviceName: string; syncState: OwnershipSyncState; canAssociate: boolean; accountPartition: string | null;
  status?: string; updatedAt?: number;
  description?: string; visibleTaskCount?: number; latestTaskTitle?: string;
}
export interface OwnershipPreview {
  planId: string; planVersion: string; accountGeneration: string; expiresAt: number;
  account: OwnershipAccount | null; eligible: boolean; reason?: OwnershipErrorCode;
  kind: OwnershipTargetKind; targetId: string; targetTitle: string; agentId: string;
  anonymousTaskCount: number; subtaskCount: number; existingOwnedTaskCount: number;
  tasks: Array<{ id: string; title: string; isSubtask: boolean }>; agentWillAssociate: boolean;
}
export interface OwnershipCommitRequest {
  planId: string; planVersion: string; accountGeneration: string; requestId: string;
}
export interface OwnershipCommitResult {
  status: typeof OwnershipResultStatus.Associated | typeof OwnershipResultStatus.AlreadyAssociated;
  operationId: string; requestId: string; agentIds: string[]; sessionIds: string[];
  syncState: OwnershipSyncState; accountPartition: string;
}
export type OwnershipResult = OwnershipCommitResult | { status: typeof OwnershipResultStatus.NotCommitted };
export type OwnershipResponse<T> = { success: true; data: T } | { success: false; error: { code: OwnershipErrorCode } };
export interface OwnershipApi {
  getDetail(target: OwnershipTarget): Promise<OwnershipResponse<OwnershipDetail>>;
  preview(target: OwnershipTarget): Promise<OwnershipResponse<OwnershipPreview>>;
  commit(input: OwnershipCommitRequest): Promise<OwnershipResponse<OwnershipCommitResult>>;
  getResult(input: { requestId: string }): Promise<OwnershipResponse<OwnershipResult>>;
  onChanged(listener: () => void): () => void;
}
