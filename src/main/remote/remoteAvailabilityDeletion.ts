import { randomUUID } from 'crypto';

import { payloadHash, sameOwner } from './canonical';
import type { AvailabilityContext } from './remoteAvailabilityPublisher';
import type { AvailabilityRequest, AvailabilitySession } from './remoteAvailabilityStore';
import { samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import type { Tombstone } from './remoteLocalGc';
import type { RemoteStore } from './remoteStore';

export const AvailabilityDeletion = { Prefix: 'localGcDeleted:', Binding: 'availabilityDeletionBinding:', Protocol: 'control_facts_v1' } as const;
export interface AvailabilityDeletionBinding {
  scope: string; sessionId: string; deviceId: string; writerGeneration: string; controlEpoch: string;
}
export interface AvailabilityDeletionAck extends AvailabilityDeletionBinding {
  protocol: typeof AvailabilityDeletion.Protocol; eventId: string; batchId: string; factSeq: string; serverSeq: string;
  requestHash: string; receiptDigest: string; confirmedAt: number; receipt: Record<string, any>;
}
const digits = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/u.test(value);
const binding = (context: AvailabilityContext, state: AvailabilitySession): AvailabilityDeletionBinding => ({
  scope: context.scope, sessionId: state.sessionId, deviceId: context.deviceId, writerGeneration: state.writerGeneration, controlEpoch: state.controlEpoch,
});

/** Optional publication mirrors identity while the original session exists; deletion never opens a sidecar. */
export function rememberAvailabilityDeletionBinding(store: RemoteStore, context: AvailabilityContext, state: AvailabilitySession): void {
  if (state.phase === 'activating' || !store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(state.localId)) return;
  const sync = store.sync(state.localId);
  if (!sync || sync.migration_frozen || !sameOwner(store.owner(state.localId), context.owner)
    || sync.session_id !== state.sessionId || sync.device_id !== context.deviceId || !sync.sync_environment || !context.environment
    || !samePersistedRemoteEnvironment(store, context, sync.sync_environment, context.environment)) return;
  const value = binding(context, state);
  if (payloadHash(store.get(`${AvailabilityDeletion.Binding}${state.localId}`)) !== payloadHash(value))
    store.put(`${AvailabilityDeletion.Binding}${state.localId}`, value);
}

/** Reconcile only the original lifecycle. Missing rows alone never create a deletion. */
export function availabilityDeletion(store: RemoteStore, context: AvailabilityContext, state: AvailabilitySession,
  originalCheckpoint?: Record<string, any> | null): Tombstone | null {
  const key = `${AvailabilityDeletion.Prefix}${state.localId}`, saved = store.get<Tombstone>(key);
  if (!saved) return null;
  const sync = store.sync(state.localId);
  if (!sync || sync.migration_frozen || !sameOwner(saved.owner, context.owner) || !sameOwner(saved.owner, store.owner(state.localId))
    || saved.localSessionId !== state.localId || saved.sessionId !== state.sessionId || saved.sessionId !== sync.session_id
    || saved.deviceId !== context.deviceId || saved.deviceId !== sync.device_id || saved.streamEpoch !== sync.stream_epoch
    || !saved.environment || !context.environment
    || !samePersistedRemoteEnvironment(store, context, saved.environment, context.environment)
    || !sync.sync_environment || !samePersistedRemoteEnvironment(store, context, saved.environment, sync.sync_environment)
    || !Number.isSafeInteger(saved.sourceHighWatermark) || sync.source_seq !== saved.sourceHighWatermark
    || !Number.isFinite(saved.deletedAt) || !Number.isSafeInteger(saved.deleteRevision)
    || store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(state.localId)) throw new Error('REMOTE_DELETION_BINDING_UNRESOLVED');
  const expected = binding(context, state);
  let changed = false;
  if (!saved.availabilityBinding) {
    // Old tombstones require the original frozen core writer manifest AND its committed checkpoint.
    const migration = store.db.prepare('SELECT manifest_json,manifest_hash FROM remote_history_migrations WHERE scope=? AND local_id=? AND writer_generation=?')
      .get(context.scope, state.localId, state.writerGeneration) as { manifest_json: string; manifest_hash: string } | undefined;
    if (!migration || Buffer.byteLength(migration.manifest_json) > 16384) throw new Error('REMOTE_DELETION_BINDING_UNRESOLVED');
    const manifest = JSON.parse(migration.manifest_json);
    if (payloadHash(manifest) !== migration.manifest_hash || manifest.context?.scope !== context.scope
      || manifest.context?.localId !== state.localId || manifest.context?.writerGeneration !== state.writerGeneration || !sameOwner(manifest.context?.owner ?? null, saved.owner)
      || manifest.context?.sessionId !== saved.sessionId || manifest.context?.deviceId !== saved.deviceId
      || manifest.legacy?.source_seq !== saved.sourceHighWatermark || manifest.legacy?.stream_epoch !== saved.streamEpoch
      || originalCheckpoint?.state !== 'committed' || originalCheckpoint.operationId !== state.operationId
      || originalCheckpoint.sessionId !== state.sessionId || originalCheckpoint.writerGeneration !== state.writerGeneration
      || originalCheckpoint.controlEpoch !== state.controlEpoch) throw new Error('REMOTE_DELETION_BINDING_UNRESOLVED');
    saved.availabilityBinding = expected; changed = true;
  }
  if (payloadHash(saved.availabilityBinding) !== payloadHash(expected)) throw new Error('REMOTE_DELETION_BINDING_UNRESOLVED');
  if (!saved.deleteEventId) { saved.deleteEventId = randomUUID(); changed = true; }
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(saved.deleteEventId)) throw new Error('REMOTE_DELETION_EVIDENCE_INVALID');
  if (changed) store.put(key, saved); // Synchronous core write; a retry never generates a second event identity.
  return saved;
}

export function deletionRequestHash(request: AvailabilityRequest): string {
  const { mode: _mode, connectionGeneration: _connection, coreRevision: _core, ackCoreRevision: _ack, knownCheckpointId: _checkpoint, ...business } = request.body;
  return payloadHash(business);
}
export function validAvailabilityDeletionAck(tombstone: Tombstone): boolean {
  try { return validateAvailabilityDeletionAck(tombstone); } catch { return false; }
}
function validateAvailabilityDeletionAck(tombstone: Tombstone): boolean {
  const ack = tombstone.availabilityAck, saved = tombstone.availabilityBinding, receipt = ack?.receipt;
  const deletion = Array.isArray(receipt?.deletionReceipts) ? receipt.deletionReceipts.find((item: any) => item?.eventId === tombstone.deleteEventId) : null;
  return !!ack && !!saved && ack.protocol === AvailabilityDeletion.Protocol && ack.eventId === tombstone.deleteEventId
    && ['scope', 'sessionId', 'deviceId', 'writerGeneration', 'controlEpoch'].every(key => (ack as any)[key] === (saved as any)[key])
    && !!receipt && Number.isFinite(ack.confirmedAt) && ack.receiptDigest === payloadHash(receipt) && receipt.state === 'committed'
    && receipt.operationId === ack.batchId && receipt.batchId === ack.batchId && receipt.sessionId === saved.sessionId && receipt.writerGeneration === saved.writerGeneration
    && receipt.controlEpoch === saved.controlEpoch && receipt.requestHash === ack.requestHash
    && digits(ack.factSeq) && digits(ack.serverSeq) && receipt.firstFactSeq === ack.factSeq && receipt.lastFactSeq === ack.factSeq
    && receipt.committedSeq === ack.serverSeq && deletion?.factSeq === ack.factSeq && deletion.serverSeq === ack.serverSeq
    && deletion.deletedAt === new Date(tombstone.deletedAt).toISOString();
}
export function acknowledgeAvailabilityDeletion(store: RemoteStore, context: AvailabilityContext, state: AvailabilitySession,
  request: AvailabilityRequest, receipt: Record<string, any>): void {
  const saved = availabilityDeletion(store, context, state);
  if (!saved || !saved.deleteEventId || request.body.facts.length !== 1) throw new Error('REMOTE_DELETION_RECEIPT_INVALID');
  const fact = request.body.facts[0], proof = Array.isArray(receipt.deletionReceipts) ? receipt.deletionReceipts.find((item: any) => item?.eventId === saved.deleteEventId) : null;
  const ack: AvailabilityDeletionAck = { ...saved.availabilityBinding!, protocol: AvailabilityDeletion.Protocol,
    eventId: saved.deleteEventId, batchId: request.body.batchId, factSeq: fact.factSeq, serverSeq: proof?.serverSeq,
    requestHash: deletionRequestHash(request), receipt, receiptDigest: payloadHash(receipt), confirmedAt: Date.now() };
  if (fact.eventType !== 'session.deleted' || fact.eventId !== saved.deleteEventId
    || fact.payload.deletedAt !== new Date(saved.deletedAt).toISOString() || !validAvailabilityDeletionAck({ ...saved, availabilityAck: ack }))
    throw new Error('REMOTE_DELETION_RECEIPT_INVALID');
  store.put(`${AvailabilityDeletion.Prefix}${state.localId}`, { ...saved, availabilityAck: ack, ackAt: saved.ackAt ?? ack.confirmedAt });
  // Legacy source_seq/ack_seq/ackSourceSeq are deliberately untouched.
}
