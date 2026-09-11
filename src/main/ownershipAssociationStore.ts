import type { OwnershipTargetKind } from '../shared/ownership/constants';
import { RemoteCapability, type RemoteOwner } from '../shared/remote/constants';
import { payloadHash, stableJson } from './remote/canonical';
import type { RemoteStore } from './remote/remoteStore';

export interface OwnershipManifest {
  kind: OwnershipTargetKind; targetId: string; agentId: string | null; agentVersion: string | null;
  associatedSessionIds: string[]; retainedSessionIds: string[]; affectedAgentIds: string[];
}
export interface OwnershipAssociationReceipt {
  operation_id: string; owner_user_id: string; owner_scope_key: string; request_id: string;
  commit_request_hash: string; manifest_hash: string; target_kind: OwnershipTargetKind; target_id: string;
  manifest_json: string; associated_at: number; remote_admissions_json: string;
}
export interface OwnershipRemoteContext { owner: RemoteOwner; environment: string; deviceId: string }
export interface OwnershipClaimBlocks { blockedAgentIds: Set<string>; blockedSessionIds: Set<string> }

/** Receipts are data, never credentials. All readers scope them to the current trusted actor. */
export class OwnershipAssociationStore {
  constructor(private readonly remote: RemoteStore) {
    remote.db.exec(`CREATE TABLE IF NOT EXISTS ownership_association_operations (
      operation_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, owner_scope_key TEXT NOT NULL,
      request_id TEXT NOT NULL, commit_request_hash TEXT NOT NULL, manifest_hash TEXT NOT NULL,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, manifest_json TEXT NOT NULL,
      associated_at INTEGER NOT NULL, remote_admissions_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(owner_user_id,owner_scope_key,request_id));
      CREATE INDEX IF NOT EXISTS idx_ownership_association_target
        ON ownership_association_operations(target_kind,target_id);`);
  }

  find(owner: RemoteOwner, requestId: string): OwnershipAssociationReceipt | null {
    return this.remote.db.prepare(`SELECT * FROM ownership_association_operations
      WHERE owner_user_id=? AND owner_scope_key=? AND request_id=?`)
      .get(owner.userId, owner.scopeKey, requestId) as OwnershipAssociationReceipt | undefined ?? null;
  }

  list(owner: RemoteOwner): OwnershipAssociationReceipt[] {
    return this.remote.db.prepare(`SELECT * FROM ownership_association_operations
      WHERE owner_user_id=? AND owner_scope_key=? ORDER BY associated_at,operation_id`)
      .all(owner.userId, owner.scopeKey) as OwnershipAssociationReceipt[];
  }

  save(receipt: OwnershipAssociationReceipt): void {
    if (!this.remote.db.inTransaction) throw new Error('Association receipts require the ownership transaction');
    this.remote.db.prepare(`INSERT INTO ownership_association_operations
      (operation_id,owner_user_id,owner_scope_key,request_id,commit_request_hash,manifest_hash,target_kind,target_id,
       manifest_json,associated_at,remote_admissions_json)
      VALUES (@operation_id,@owner_user_id,@owner_scope_key,@request_id,@commit_request_hash,@manifest_hash,@target_kind,
              @target_id,@manifest_json,@associated_at,@remote_admissions_json)`).run(receipt);
  }

  /** Persist admission for the whole original group BEFORE any first remote request. */
  prepareRemoteAdmission(context: OwnershipRemoteContext, capabilityAvailable: boolean): OwnershipClaimBlocks {
    if (!context.environment || !context.deviceId) throw new Error('Remote admission requires an environment and device');
    const contextKey = payloadHash(context);
    const blocked: OwnershipClaimBlocks = { blockedAgentIds: new Set(), blockedSessionIds: new Set() };
    this.remote.transaction(() => {
      for (const receipt of this.list(context.owner)) {
        const manifest = JSON.parse(receipt.manifest_json) as OwnershipManifest;
        if (!manifest.agentId) continue;
        const admissions = JSON.parse(receipt.remote_admissions_json) as Record<string, { admittedAt: number; capability: string }>;
        if (admissions[contextKey]) continue;
        if (capabilityAvailable) {
          admissions[contextKey] = { admittedAt: Date.now(), capability: RemoteCapability.AgentOwnershipClaim };
          this.remote.db.prepare('UPDATE ownership_association_operations SET remote_admissions_json=? WHERE operation_id=?')
            .run(stableJson(admissions), receipt.operation_id);
        } else {
          blocked.blockedAgentIds.add(manifest.agentId);
          for (const id of [...manifest.associatedSessionIds, ...manifest.retainedSessionIds]) blocked.blockedSessionIds.add(id);
        }
      }
    });
    return blocked;
  }
}
