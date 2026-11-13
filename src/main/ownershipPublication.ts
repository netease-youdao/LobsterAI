import { OWNERSHIP_MANUAL_SOURCE, OwnershipAction } from '../shared/ownership/constants';
import type { RemoteOwner } from '../shared/remote/constants';
import type { OwnershipAssociationStore, OwnershipManifest } from './ownershipAssociationStore';
import { payloadHash, sameOwner } from './remote/canonical';
import { hasNoRemotePublicationAuthority } from './remote/remotePublicationEvidence';
import { RemotePublicationKind } from './remote/remotePublicationOrigins';
import type { RemoteStore } from './remote/remoteStore';

/** Main-process-only identity. Renderer receives the display route, never authority. */
export interface PublicationTarget {
  owner: RemoteOwner; route: string; targetId: string; dataSpaceId: string; deviceId: string;
  epoch: number; routeEpoch: number; accountGeneration: number;
}
export interface PublicationConfirmation {
  target: PublicationTarget; originalOperationId: string; sessionIds: string[]; hash: string;
}
interface Origin { route: string | null; data_space_id: string | null; owner_user_id: string | null; owner_scope_key: string | null }
const validTarget = (target: PublicationTarget, owner: RemoteOwner): boolean => {
  if (!sameOwner(target.owner, owner) || [target.targetId, target.dataSpaceId, target.deviceId].some(value => typeof value !== 'string' || !value || value.length > 256)
    || [target.epoch, target.routeEpoch, target.accountGeneration].some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  const url = new URL(target.route);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    && `${url.origin}${url.pathname.replace(/\/+$/u, '')}` === target.route;
};

/** Cheap detail-page guard before traversing the execution tree. */
export function isPublicationConfirmationCandidate(remote: RemoteStore, id: string, owner: RemoteOwner): boolean {
  const ownership = remote.ownershipRecord(id);
  return !!ownership && ownership.ownership_status === 'confirmed' && ownership.source === OWNERSHIP_MANUAL_SOURCE
    && ownership.owner_user_id === owner.userId && ownership.owner_scope_key === owner.scopeKey
    && !!remote.db.prepare(`SELECT 1 FROM remote_publication_origins WHERE kind=? AND local_id=? AND route IS NULL
      AND data_space_id IS NULL AND owner_user_id=? AND owner_scope_key=?`)
      .get(RemotePublicationKind.Session, id, owner.userId, owner.scopeKey);
}

/** A prior association proves only account ownership. This is a new, explicit destination authorization. */
export function readPublicationConfirmation(remote: RemoteStore, receipts: OwnershipAssociationStore, ids: string[], owner: RemoteOwner,
  target: PublicationTarget | null): PublicationConfirmation | null {
  try {
    if (!target || !validTarget(target, owner) || !ids.length || ids.length > 2000) return null;
    const sessionIds = [...new Set(ids)].sort();
    const states = sessionIds.map(id => {
      const ownership = remote.ownershipRecord(id);
      const origin = remote.db.prepare('SELECT route,data_space_id,owner_user_id,owner_scope_key FROM remote_publication_origins WHERE kind=? AND local_id=?')
        .get(RemotePublicationKind.Session, id) as Origin | undefined;
      if (!ownership || ownership.ownership_status !== 'confirmed' || ownership.source !== OWNERSHIP_MANUAL_SOURCE
        || ownership.owner_user_id !== owner.userId || ownership.owner_scope_key !== owner.scopeKey
        || !origin || origin.route !== null || origin.data_space_id !== null || origin.owner_user_id !== owner.userId || origin.owner_scope_key !== owner.scopeKey
        || !remote.sync(id) || !hasNoRemotePublicationAuthority(remote.db, id)) throw new Error('Publication source is not confirmable');
      return { id, ownership, origin, sync: remote.sync(id) };
    });
    const original = receipts.list(owner).find(receipt => {
      const manifest = JSON.parse(receipt.manifest_json) as OwnershipManifest;
      return (!manifest.action || manifest.action === OwnershipAction.Associate)
        && Array.isArray(manifest.associatedSessionIds) && manifest.associatedSessionIds.every(id => typeof id === 'string')
        && states.every(state => state.ownership.created_at === receipt.associated_at && manifest.associatedSessionIds.includes(state.id));
    });
    if (!original) return null;
    return { target, sessionIds, originalOperationId: original.operation_id,
      hash: payloadHash({ target, states, operation: original.operation_id, manifest: original.manifest_json }) };
  } catch { return null; }
}

export function applyPublicationConfirmation(remote: RemoteStore, proof: PublicationConfirmation): void {
  if (!remote.db.inTransaction) throw new Error('Publication confirmation requires the ownership transaction');
  for (const id of proof.sessionIds) {
    const changed = remote.db.prepare(`UPDATE remote_publication_origins SET route=?,data_space_id=?
      WHERE kind=? AND local_id=? AND route IS NULL AND data_space_id IS NULL AND owner_user_id=? AND owner_scope_key=?`)
      .run(proof.target.route, proof.target.dataSpaceId, RemotePublicationKind.Session, id, proof.target.owner.userId, proof.target.owner.scopeKey).changes;
    if (changed !== 1) throw new Error('Publication source changed during confirmation');
  }
}

export function dirtyPublicationConfirmation(remote: RemoteStore, proof: PublicationConfirmation, now: number): void {
  if (!remote.db.inTransaction) throw new Error('Publication confirmation requires the ownership transaction');
  for (const id of proof.sessionIds) remote.db.prepare(`INSERT INTO remote_session_revisions(session_id,revision,dirty_at) VALUES (?,1,?)
    ON CONFLICT(session_id) DO UPDATE SET revision=revision+1,dirty_at=excluded.dirty_at`).run(id, now);
}
