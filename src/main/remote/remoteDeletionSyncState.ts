import type Database from 'better-sqlite3';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { type AvailabilityDeletionBinding, validAvailabilityDeletionAck } from './remoteAvailabilityDeletion';
import { classifyRemoteDeletionSync, type RemoteDeletionClassification, type RemoteDeletionPolicyEvidence,RemoteDeletionProof, RemoteDeletionProtocol, RemoteDeletionReason, RemoteDeletionSyncKind,
  RemoteDeletionSyncState } from './remoteDeletionSyncPolicy';
import { readRemoteSessionAdmission } from './remoteDisplayHealthAdmission';
import { samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import type { Tombstone } from './remoteLocalGc';
import type { RemoteStore, SyncRow } from './remoteStore';

const MAX_BYTES = 64 * 1024;
const VERSION = 1;
const Prefix = { Deleted: 'localGcDeleted:', Adoption: 'remoteDeletionAdoption:', Binding: 'availabilityDeletionBinding:' } as const;
type DeletionSyncReader = Pick<RemoteStore, 'db' | 'owner' | 'sync' | 'isTaskAdmitted' | 'projectionPublishing'>;
interface Binding { owner: RemoteOwner; targetId: string; deviceId: string; localId: string; sessionId: string; streamEpoch: string | null; control: AvailabilityDeletionBinding | null }
export interface RemoteDeletionSyncContext {
  owner: RemoteOwner; deviceId: string; targetId: string; scope?: string; adopted?: boolean; controlBinding?: AvailabilityDeletionBinding;
}
interface StoredEvidence {
  version: number; proofKind: string | null; tombstone: Tombstone; projection: unknown; sourceSeq: number; ackSeq: number;
}
interface SavedRow {
  target_id: string; local_session_id: string; binding_key: string; binding_json: string; protocol: RemoteDeletionProtocol;
  schema_version: number; state: string; evidence_json: string; evidence_digest: string; evidence_version: number;
}
interface ReadResult {
  classification: RemoteDeletionClassification; binding: Binding | null; sync: SyncRow | null;
  tombstone: Tombstone | null; projection: unknown; proof: StoredEvidence | null; saved: SavedRow | null;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const table = (db: Database.Database, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const validDate = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
const boundedJson = (value: string | null): unknown => {
  if (value === null || Buffer.byteLength(value) > MAX_BYTES) throw new Error(RemoteDeletionReason.Budget);
  return JSON.parse(value);
};
function readState(store: DeletionSyncReader, key: string): unknown {
  const row = store.db.prepare(`SELECT CASE WHEN length(CAST(value AS BLOB))<=${MAX_BYTES} THEN value END AS value FROM remote_state WHERE key=?`).get(key) as { value: string | null } | undefined;
  return row ? boundedJson(row.value) : null;
}
function contextFor(store: DeletionSyncReader, localId: string, context?: RemoteDeletionSyncContext): RemoteDeletionSyncContext | null {
  if (context) return context;
  const owner = store.owner(localId), row = store.sync(localId);
  return owner && row?.device_id && row.sync_environment ? { owner, deviceId: row.device_id, targetId: row.sync_environment } : null;
}
function adoptionKey(localId: string, context: RemoteDeletionSyncContext): string {
  return `${Prefix.Adoption}${payloadHash([context.targetId, context.owner, context.deviceId, localId])}`;
}
const sameEnvironment = (store: DeletionSyncReader, context: RemoteDeletionSyncContext, environment: string | null): boolean => environment !== null
  && (environment === context.targetId || samePersistedRemoteEnvironment(store, context, environment, context.targetId));
function validTombstone(value: unknown, localId: string): value is Tombstone {
  return record(value) && record(value.owner) && typeof value.owner.userId === 'string' && typeof value.owner.scopeKey === 'string'
    && value.localSessionId === localId && typeof value.sessionId === 'string' && typeof value.deviceId === 'string'
    && (value.environment === null || typeof value.environment === 'string') && (value.streamEpoch === null || typeof value.streamEpoch === 'string')
    && typeof value.deletedAt === 'number' && Number.isFinite(new Date(value.deletedAt).getTime()) && Number.isSafeInteger(value.deleteRevision) && Number.isSafeInteger(value.sourceHighWatermark)
    && Number(value.sourceHighWatermark) >= 0;
}
const validControlBinding = (value: unknown, context: RemoteDeletionSyncContext, sync: SyncRow): value is AvailabilityDeletionBinding => record(value)
  && value.sessionId === sync.session_id && value.deviceId === context.deviceId && typeof value.scope === 'string'
  && (!context.scope || value.scope === context.scope) && typeof value.writerGeneration === 'string' && !!value.writerGeneration
  && typeof value.controlEpoch === 'string' && !!value.controlEpoch;

/** Core-only additive schema; this table is not exchanged with the active target working set. */
export function initializeRemoteDeletionSync(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_session_deletion_sync (
    target_id TEXT NOT NULL,local_session_id TEXT NOT NULL,binding_key TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,device_id TEXT NOT NULL,remote_session_id TEXT NOT NULL,
    binding_json TEXT NOT NULL,protocol TEXT NOT NULL,schema_version INTEGER NOT NULL,state TEXT NOT NULL,
    local_delete_id TEXT,local_delete_revision INTEGER NOT NULL,pre_delete_source_seq INTEGER NOT NULL,
    deletion_source_seq INTEGER,deletion_fact_seq TEXT,evidence_json TEXT NOT NULL,evidence_digest TEXT NOT NULL,evidence_version INTEGER NOT NULL,
    reason TEXT NOT NULL,validated_at INTEGER NOT NULL,PRIMARY KEY(target_id,local_session_id,binding_key));
    CREATE INDEX IF NOT EXISTS idx_remote_deletion_sync_target_state ON remote_session_deletion_sync(target_id,state,local_session_id);
    CREATE INDEX IF NOT EXISTS idx_remote_deletion_sync_session ON remote_session_deletion_sync(local_session_id,state);`);
}

/** A core activation fence is retained independently of the optional sidecar and is never a legacy-writer permit. */
export function hasRemoteDeletionAdoption(store: DeletionSyncReader, localId: string, supplied?: RemoteDeletionSyncContext): boolean {
  const context = contextFor(store, localId, supplied), sync = store.sync(localId);
  if (!context || !sync || !sameOwner(store.owner(localId), context.owner) || !sameEnvironment(store, context, sync.sync_environment)) return false;
  // Even malformed scoped evidence must fail closed; only the original control operation can resolve it.
  if (store.db.prepare('SELECT 1 FROM remote_state WHERE key=?').get(adoptionKey(localId, context))) return true;
  try {
    const mirror = readState(store, `${Prefix.Binding}${localId}`);
    const scopedContext = { ...context, scope: context.scope || `${context.targetId}:${context.owner.userId}:${context.owner.scopeKey}:${context.deviceId}` };
    if (validControlBinding(mirror, scopedContext, sync)) return true;
    if (table(store.db, 'remote_session_deletion_sync') && store.db.prepare(`SELECT 1 FROM remote_session_deletion_sync
      WHERE target_id=? AND local_session_id=? AND device_id=? AND remote_session_id=? AND protocol=? LIMIT 1`)
      .get(context.targetId, localId, context.deviceId, sync.session_id, RemoteDeletionProtocol.Control)) return true;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof Error && error.message === RemoteDeletionReason.Budget) return true;
    throw error;
  }
  return false;
}

/** Recovery needs the exact original binding, unlike the conservative writer-fence existence check. */
export function matchesRemoteDeletionAdoption(store: DeletionSyncReader, localId: string, context: RemoteDeletionSyncContext,
  binding: AvailabilityDeletionBinding): boolean {
  const sync = store.sync(localId);
  if (!sync || !sameOwner(store.owner(localId), context.owner) || !sameEnvironment(store, context, sync.sync_environment)
    || !validControlBinding(binding, context, sync)) return false;
  const saved = readState(store, adoptionKey(localId, context));
  return record(saved) && saved.version === VERSION && stableJson(saved.binding) === stableJson(binding);
}

/** Before the first uncertain activation request, retain a core fence even if a sidecar is subsequently lost. */
export function rememberRemoteDeletionAdoption(store: RemoteStore, localId: string, context: RemoteDeletionSyncContext, binding: AvailabilityDeletionBinding): void {
  const row = store.sync(localId);
  if (!row || !sameOwner(store.owner(localId), context.owner) || !sameEnvironment(store, context, row.sync_environment)
    || !validControlBinding(binding, context, row)) throw new Error(RemoteDeletionReason.Binding);
  const key = adoptionKey(localId, context), value = { version: VERSION, binding };
  if (payloadHash(readState(store, key)) !== payloadHash(value)) store.put(key, value);
}
function executionProofValid(store: DeletionSyncReader, tombstone: Tombstone, sync: SyncRow): boolean {
  const proof = tombstone.completionReceipt;
  const closed = readState(store, `${RemoteDeletion.Closed}${sync.local_id}`);
  return !!proof && record(closed) && proof.proofKind === RemoteDeletionProtocol.Execution && sameOwner(proof.owner, tombstone.owner)
    && proof.localSessionId === sync.local_id && proof.sessionId === sync.session_id && proof.deviceId === sync.device_id
    && proof.streamEpoch === sync.stream_epoch && proof.closedSourceHighWatermark === String(sync.source_seq)
    && closed.receiptId === proof.localReceiptId && closed.receiptDigest === proof.receiptDigest
    && closed.operationId === proof.operationId && closed.deletionVersion === proof.deletionVersion
    && payloadHash(readState(store, `${RemoteDeletion.Guard}${sync.local_id}`)) === payloadHash(proof.guard || null);
}
function read(store: DeletionSyncReader, localId: string, supplied?: RemoteDeletionSyncContext): ReadResult {
  const sync = store.sync(localId), context = contextFor(store, localId, supplied);
  const fallback = (kind: RemoteDeletionClassification['kind'], reason: RemoteDeletionClassification['reason']): ReadResult => ({
    classification: { kind, protocol: RemoteDeletionProtocol.Unknown, reason }, binding: null, sync, tombstone: null, projection: null, proof: null, saved: null,
  });
  const localExists = !!store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(localId);
  if (!context || !sync || !sameOwner(store.owner(localId), context.owner) || sync.device_id !== context.deviceId
    || !sameEnvironment(store, context, sync.sync_environment)) return fallback(RemoteDeletionSyncKind.NotApplicable, RemoteDeletionReason.NotApplicable);
  try {
    const global = readState(store, `${Prefix.Deleted}${localId}`);
    if (!global) return fallback(localExists ? RemoteDeletionSyncKind.Live : RemoteDeletionSyncKind.Blocked, localExists ? RemoteDeletionReason.None : RemoteDeletionReason.Evidence);
    if (!validTombstone(global, localId) || !sameOwner(global.owner, context.owner)) return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Evidence);
    const scope = context.scope || `${context.targetId}:${context.owner.userId}:${context.owner.scopeKey}:${context.deviceId}`;
    const scopedContext = { ...context, scope };
    const marker = readState(store, adoptionKey(localId, context));
    const mirror = readState(store, `${Prefix.Binding}${localId}`);
    const original = global.sessionId === sync.session_id && global.deviceId === context.deviceId && global.streamEpoch === sync.stream_epoch
      && sameEnvironment(store, context, global.environment);
    const priorBindings = table(store.db, 'remote_session_deletion_sync') ? store.db.prepare(`SELECT protocol,
      CASE WHEN length(CAST(binding_json AS BLOB))<=${MAX_BYTES} THEN binding_json END AS binding_json
      FROM remote_session_deletion_sync WHERE target_id=? AND local_session_id=? AND device_id=? AND remote_session_id=? LIMIT 33`)
      .all(context.targetId, localId, context.deviceId, sync.session_id) as Array<{ protocol: string; binding_json: string | null }> : [];
    if (priorBindings.length > 32) throw new Error(RemoteDeletionReason.Budget);
    let retainedControl: AvailabilityDeletionBinding | null = null, retainedAdoption = false;
    for (const prior of priorBindings) {
      const value = boundedJson(prior.binding_json);
      if (!record(value)) return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Evidence);
      if (value.streamEpoch !== sync.stream_epoch) continue;
      if (prior.protocol === RemoteDeletionProtocol.Control || value.control) {
        retainedAdoption = true;
        if (!validControlBinding(value.control, scopedContext, sync)
          || retainedControl && payloadHash(retainedControl) !== payloadHash(value.control))
          return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Binding);
        retainedControl = value.control;
      }
    }
    const candidate = context.controlBinding || (record(marker) ? marker.binding : null)
      || (original && global.availabilityBinding ? global.availabilityBinding : null) || retainedControl
      || (validControlBinding(mirror, scopedContext, sync) ? mirror : null);
    if (candidate && (record(marker) && payloadHash(marker.binding ?? null) !== payloadHash(candidate)
      || retainedControl && payloadHash(retainedControl) !== payloadHash(candidate)))
      return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Binding);
    const control = validControlBinding(candidate, scopedContext, sync) ? candidate : null;
    const migrations = table(store.db, 'remote_history_migrations') ? store.db.prepare(`SELECT CASE WHEN length(CAST(manifest_json AS BLOB))<=${MAX_BYTES} THEN manifest_json END AS manifest_json,manifest_hash
      FROM remote_history_migrations WHERE local_id=? AND scope=? LIMIT 2`).all(localId, scope) as Array<{ manifest_json: string | null; manifest_hash: string }> : [];
    let adopted = !!context.adopted || marker !== null || retainedAdoption || !!control || original && !!global.availabilityBinding;
    for (const migration of migrations) {
      const manifest = boundedJson(migration.manifest_json);
      if (!record(manifest) || payloadHash(manifest) !== migration.manifest_hash) return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Evidence);
      adopted = true;
    }
    const binding: Binding = { owner: context.owner, targetId: context.targetId, deviceId: context.deviceId, localId,
      sessionId: sync.session_id, streamEpoch: sync.stream_epoch, control };
    const bindingKey = payloadHash(binding);
    const saved = table(store.db, 'remote_session_deletion_sync') ? store.db.prepare(`SELECT target_id,local_session_id,binding_key,
      CASE WHEN length(CAST(binding_json AS BLOB))<=${MAX_BYTES} THEN binding_json END AS binding_json,protocol,schema_version,state,
      CASE WHEN length(CAST(evidence_json AS BLOB))<=${MAX_BYTES} THEN evidence_json END AS evidence_json,evidence_digest,evidence_version
      FROM remote_session_deletion_sync WHERE target_id=? AND local_session_id=? AND binding_key=?`).get(context.targetId, localId, bindingKey) as SavedRow | undefined : undefined;
    let proof: StoredEvidence | null = null;
    if (saved) {
      const value = boundedJson(saved.evidence_json), savedBinding = boundedJson(saved.binding_json);
      if (!Object.values(RemoteDeletionProtocol).includes(saved.protocol) || !Object.values(RemoteDeletionSyncState).some(state => state === saved.state)
        || saved.schema_version !== VERSION || saved.evidence_version !== VERSION || payloadHash(value) !== saved.evidence_digest
        || payloadHash(savedBinding) !== bindingKey || stableJson(savedBinding) !== stableJson(binding) || !record(value)
        || value.version !== VERSION || !validTombstone(value.tombstone, localId)) return fallback(RemoteDeletionSyncKind.Blocked, RemoteDeletionReason.Evidence);
      proof = value as unknown as StoredEvidence;
    }
    // Other targets inherit only the global deletion intent, never the original target's ACK or watermark.
    const tombstone: Tombstone = proof?.tombstone || (original ? global : { ...global, sessionId: sync.session_id, deviceId: sync.device_id,
      environment: context.targetId, streamEpoch: sync.stream_epoch, sourceHighWatermark: sync.source_seq, ackAt: null, ackSourceSeq: null,
      availabilityBinding: control || undefined, availabilityAck: undefined, completionReceipt: undefined, phase: 'eligible' });
    const projectionRow = table(store.db, 'remote_projection') ? store.db.prepare(`SELECT CASE WHEN length(CAST(record_json AS BLOB))<=${MAX_BYTES} THEN record_json END AS value
      FROM remote_projection WHERE session_id=? AND object_key='deleted'`).get(localId) as { value: string | null } | undefined : undefined;
    const projection = projectionRow ? boundedJson(projectionRow.value) : null;
    const projectionValid = record(projection) && projection.eventType === 'session.deleted' && record(projection.payload) && validDate(projection.payload.deletedAt);
    const imported = readState(store, `import:${localId}`);
    const pendingOperation = imported !== null && (!record(imported) || !['committed', 'aborted', 'expired'].includes(String(imported.state)))
      || table(store.db, 'remote_outbox') && !!store.db.prepare('SELECT 1 FROM remote_outbox WHERE session_id=? AND source_seq>? LIMIT 1').get(localId, sync.ack_seq)
      || table(store.db, 'remote_projection_publications') && store.projectionPublishing(localId);
    const admitted = !sync.migration_frozen && (table(store.db, 'remote_sync_session_admissions')
      ? readRemoteSessionAdmission(store.db, context.owner, context.deviceId, context.targetId, localId) : store.isTaskAdmitted(localId));
    const e: RemoteDeletionPolicyEvidence = {
      applicable: true, admitted, localExists, deleted: true, validTombstone: validTombstone(tombstone, localId), owner: store.owner(localId), deletionOwner: global.owner,
      bindingMatches: tombstone.sessionId === sync.session_id && tombstone.deviceId === sync.device_id && tombstone.streamEpoch === sync.stream_epoch
        && sameEnvironment(store, context, tombstone.environment),
      adopted, controlBindingValid: !!control, controlProofPresent: !!tombstone.availabilityAck,
      controlProofValid: !!tombstone.availabilityAck && !!control && payloadHash(control) === payloadHash(tombstone.availabilityBinding)
        && validAvailabilityDeletionAck(tombstone) && sync.source_seq === tombstone.sourceHighWatermark,
      executionProofPresent: !!tombstone.completionReceipt, executionProofValid: !!tombstone.completionReceipt && executionProofValid(store, tombstone, sync),
      persistedProofValid: saved?.state === RemoteDeletionSyncState.Acknowledged && proof?.proofKind === RemoteDeletionProof.LegacyAck
        && !pendingOperation && projectionValid && sync.source_seq === proof.sourceSeq && sync.ack_seq === proof.ackSeq
        && sync.source_seq === sync.ack_seq && sync.ack_seq === tombstone.ackSourceSeq && sync.ack_seq > tombstone.sourceHighWatermark,
      sourceSeq: sync.source_seq, ackSeq: sync.ack_seq, preDeleteSourceSeq: tombstone.sourceHighWatermark,
      ackAt: tombstone.ackAt, ackSourceSeq: tombstone.ackSourceSeq, deletedProjectionValid: projectionValid, pendingOperation,
      invalidEvidence: !!candidate && !control || proof !== null && (proof.tombstone.deleteRevision !== global.deleteRevision
        || proof.tombstone.deleteEventId !== global.deleteEventId
        || proof.proofKind === RemoteDeletionProof.LegacyAck && stableJson(proof.projection) !== stableJson(projection)),
    };
    return { classification: { ...classifyRemoteDeletionSync(e), bindingKey }, binding, sync, tombstone, projection, proof, saved: saved || null };
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === RemoteDeletionReason.Budget)) throw error;
    return fallback(RemoteDeletionSyncKind.Blocked, error instanceof SyntaxError ? RemoteDeletionReason.Evidence : RemoteDeletionReason.Budget);
  }
}

export function readRemoteDeletionSync(store: DeletionSyncReader, localId: string, context?: RemoteDeletionSyncContext): RemoteDeletionClassification {
  return read(store, localId, context).classification;
}
/** Only durable, validated records qualify; display and scheduling reads never migrate. */
export function isRemoteDeletionSettled(store: DeletionSyncReader, localId: string, context?: RemoteDeletionSyncContext): boolean {
  const result = read(store, localId, context);
  return result.saved?.state === RemoteDeletionSyncState.Acknowledged && result.classification.kind === RemoteDeletionSyncKind.Settled;
}
/** Read-only adapter for isolated display workers; never constructs a Store or initializes a schema. */
export function readRemoteDeletionDatabaseStatus(db: Database.Database, localId: string, context: RemoteDeletionSyncContext): RemoteDeletionClassification & { settled: boolean } {
  const reader: DeletionSyncReader = {
    db,
    owner: id => {
      const row = db.prepare("SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status='confirmed'")
        .get(id) as { owner_user_id: string; owner_scope_key: string } | undefined;
      return row ? { userId: row.owner_user_id, scopeKey: row.owner_scope_key } : null;
    },
    sync: id => db.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(id) as SyncRow || null,
    isTaskAdmitted: () => false,
    projectionPublishing: id => table(db, 'remote_projection_publications') && !!db.prepare('SELECT 1 FROM remote_projection_publications WHERE session_id=?').get(id),
  };
  const result = read(reader, localId, context);
  return { ...result.classification, settled: result.saved?.state === RemoteDeletionSyncState.Acknowledged && result.classification.kind === RemoteDeletionSyncKind.Settled };
}

function persist(store: RemoteStore, result: ReadResult): void {
  const { binding, tombstone, sync, classification } = result;
  if (!binding || !tombstone || !sync || !classification.bindingKey) return;
  const settled = classification.kind === RemoteDeletionSyncKind.Settled;
  const proofKind = settled ? classification.protocol === RemoteDeletionProtocol.Legacy ? RemoteDeletionProof.LegacyAck : classification.protocol : null;
  const evidence: StoredEvidence = { version: VERSION, proofKind, tombstone: JSON.parse(JSON.stringify(tombstone)) as Tombstone, projection: result.projection, sourceSeq: sync.source_seq, ackSeq: sync.ack_seq };
  const serialized = stableJson(evidence);
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error(RemoteDeletionReason.Budget);
  const digest = payloadHash(evidence), state = settled ? RemoteDeletionSyncState.Acknowledged
    : classification.kind === RemoteDeletionSyncKind.Blocked ? RemoteDeletionSyncState.Blocked : RemoteDeletionSyncState.Pending;
  if (result.saved?.evidence_digest === digest && result.saved.state === state) return;
  store.db.prepare(`INSERT INTO remote_session_deletion_sync VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target_id,local_session_id,binding_key) DO UPDATE SET protocol=excluded.protocol,state=excluded.state,
    deletion_source_seq=excluded.deletion_source_seq,deletion_fact_seq=excluded.deletion_fact_seq,evidence_json=excluded.evidence_json,
    evidence_digest=excluded.evidence_digest,reason=excluded.reason,validated_at=excluded.validated_at`).run(binding.targetId, binding.localId,
    classification.bindingKey, binding.owner.userId, binding.owner.scopeKey, binding.deviceId, binding.sessionId, stableJson(binding), classification.protocol,
    VERSION, state, tombstone.deleteEventId || null, tombstone.deleteRevision, tombstone.sourceHighWatermark,
    tombstone.ackSourceSeq, tombstone.availabilityAck?.factSeq || null, serialized, digest, VERSION, classification.reason, Date.now());
}
/** Capture the active target's immutable boundary inside the local deletion transaction, before removing the session. */
export function recordRemoteDeletionSyncIntent(store: RemoteStore, localId: string): void {
  if (!store.db.inTransaction) throw new Error('Deletion intent requires a core transaction');
  initializeRemoteDeletionSync(store.db);
  const result = read(store, localId);
  if (!result.binding || !result.tombstone || result.saved || !table(store.db, 'remote_sync_targets')
    || !store.db.prepare('SELECT 1 FROM remote_sync_targets WHERE target_id=? AND owner_user_id=? AND owner_scope_key=? AND device_id=?')
      .get(result.binding.targetId, result.binding.owner.userId, result.binding.owner.scopeKey, result.binding.deviceId)) return;
  const control = !!result.binding.control;
  persist(store, { ...result, classification: { ...result.classification,
    kind: control ? RemoteDeletionSyncKind.ControlDelete : RemoteDeletionSyncKind.LegacyDelete,
    protocol: control ? RemoteDeletionProtocol.Control : RemoteDeletionProtocol.Legacy, reason: RemoteDeletionReason.Pending } });
}

/** Bounded single-task migration, atomically validating the current core binding before recording proof. */
export function reconcileRemoteDeletionSync(store: RemoteStore, localId: string, context?: RemoteDeletionSyncContext): RemoteDeletionClassification {
  return store.db.transaction(() => {
    initializeRemoteDeletionSync(store.db);
    const result = read(store, localId, context);
    persist(store, result);
    if (result.classification.kind === RemoteDeletionSyncKind.Settled) {
      store.db.prepare('UPDATE remote_sync SET needs_snapshot=0 WHERE local_id=?').run(localId);
      store.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(localId);
      if (table(store.db, 'remote_content_dirty')) store.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(localId);
    }
    return result.classification;
  })();
}
/** Original protocol handlers receive this target's frozen deletion intent and original proof. */
export function remoteDeletionTombstoneForBinding(store: DeletionSyncReader, localId: string, context?: RemoteDeletionSyncContext): Tombstone | null {
  return read(store, localId, context).tombstone;
}
/** Called inside the original ACK transaction; never modifies a different target's global tombstone. */
export function writeRemoteDeletionTombstone(store: RemoteStore, localId: string, tombstone: Tombstone, context?: RemoteDeletionSyncContext): void {
  if (!store.db.inTransaction) throw new Error('Deletion proof requires a core transaction');
  initializeRemoteDeletionSync(store.db);
  const result = read(store, localId, context);
  if (!result.binding || !result.sync || !result.tombstone || result.tombstone.sourceHighWatermark !== tombstone.sourceHighWatermark
    || result.tombstone.sessionId !== tombstone.sessionId || result.tombstone.deviceId !== tombstone.deviceId
    || result.tombstone.streamEpoch !== tombstone.streamEpoch) throw new Error(RemoteDeletionReason.Binding);
  const original = readState(store, `${Prefix.Deleted}${localId}`);
  if (validTombstone(original, localId) && original.sessionId === tombstone.sessionId && original.deviceId === tombstone.deviceId
    && original.streamEpoch === tombstone.streamEpoch && (original.environment === tombstone.environment
      || original.environment !== null && tombstone.environment !== null && samePersistedRemoteEnvironment(store,
        { owner: tombstone.owner, deviceId: tombstone.deviceId }, original.environment, tombstone.environment))) store.put(`${Prefix.Deleted}${localId}`, tombstone);
  // Save the original protocol proof first, then the shared validator derives its state in the same transaction.
  persist(store, { ...result, tombstone, classification: { ...result.classification, kind: RemoteDeletionSyncKind.ControlDelete } });
  const validated = read(store, localId, context);
  persist(store, validated);
}
