import type Database from 'better-sqlite3';

import { RemoteTelemetryEvent } from '../../shared/remote/telemetry';
import type { captureRemoteTelemetry } from './remoteTelemetry';

/** Fixed vocabulary for local synchronization boundaries; never carries source content. */
export const SyncTelemetry = {
  Event: {
    Stage: RemoteTelemetryEvent.SyncStage, Reconciled: RemoteTelemetryEvent.Reconciled, Content: RemoteTelemetryEvent.Content,
    Sealed: RemoteTelemetryEvent.Sealed, Acknowledged: RemoteTelemetryEvent.Acknowledged, Unknown: RemoteTelemetryEvent.PublicationUnknown,
    HistoryStarted: RemoteTelemetryEvent.HistoryStarted, HistoryCommitted: RemoteTelemetryEvent.HistoryCommitted, HistoryDeferred: RemoteTelemetryEvent.HistoryDeferred,
    Quarantined: RemoteTelemetryEvent.Quarantined, Recovered: RemoteTelemetryEvent.Recovered, Deferred: RemoteTelemetryEvent.Deferred,
    Admission: RemoteTelemetryEvent.Admission,
  },
  Stage: {
    Sealed: 'sealed', Reconcile: 'reconcile', Replay: 'replay', Activation: 'activation', Bootstrap: 'bootstrap', Facts: 'facts',
    Projection: 'projection', ProjectionQueue: 'projection_queue', ProjectionPublish: 'projection_publish',
    LocalAck: 'local_ack_commit', Catalog: 'catalog', ContentValidation: 'content_validation', ContentChunk: 'content_chunk',
    ContentManifest: 'content_manifest', HistoryMigration: 'history_migration', HistoryRecovery: 'history_recovery',
    Repair: 'repair', ManualRetry: 'manual_retry', TaskState: 'task_state', Cleanup: 'cleanup',
  },
  Outcome: {
    Started: 'started', Completed: 'completed', Failed: 'failed', Deferred: 'deferred', Skipped: 'skipped',
    Confirmed: 'confirmed_result', Pending: 'pending', Unknown: 'unknown', Degraded: 'degraded', Recovered: 'recovered', Blocked: 'blocked',
  },
  Reason: {
    None: 'NONE', ContextChanged: 'CONTEXT_CHANGED', RequestFailed: 'REQUEST_FAILED', StorageUnavailable: 'STORAGE_UNAVAILABLE',
    InvalidReceipt: 'RECEIPT_INVALID', EncodingFailed: 'ENCODING_FAILED', RecordInvalid: 'RECORD_INVALID',
    ContentLimit: 'CONTENT_LIMIT_EXCEEDED', ContentUnavailable: 'CONTENT_UNAVAILABLE', LocalOnly: 'LOCAL_ONLY',
    Budget: 'RESOURCE_BUDGET', RetryBudget: 'REPAIR_BUDGET_OR_GUARD', RetryDeferred: 'RETRY_DEFERRED',
    Guard: 'GUARD_BLOCKED', Pending: 'OPERATION_PENDING', EvidenceUnknown: 'SECURITY_EVIDENCE_UNKNOWN',
    DatabaseUnknown: 'DATABASE_HEALTH_UNKNOWN', Timeout: 'TIMEOUT', WorkerFailed: 'WORKER_FAILED',
  },
  Kind: {
    Activation: 'mode_activation', Bootstrap: 'control_bootstrap', Facts: 'control_facts', Live: 'live',
    History: 'history_recovery', HistoryBatch: 'history_batch', AgentCatalog: 'agent_catalog', ModelCatalog: 'model_catalog',
    Projection: 'projection', Reply: 'reply_content', Repair: 'task_repair', Cleanup: 'cleanup',
  },
} as const;

type Captured = ReturnType<typeof captureRemoteTelemetry>;
type Fields = NonNullable<Parameters<Captured['emit']>[1]>;
/** Only announce durable state outside a transaction or through its owner's commit callback. */
export function emitCommittedTelemetry(db: Database.Database, captured: Captured, event: string, fields: Fields, committed: () => boolean, afterCommit?: (observer: () => void) => void): void {
  const emit = (): void => {
    try { if (db.open && !db.inTransaction && committed()) captured.emit(event, fields); }
    catch { /* Diagnostics must never change a transaction's result. */ }
  };
  try { if (db.inTransaction) afterCommit?.(emit); else emit(); }
  catch { /* A closed or damaged database only loses its diagnostic. */ }
}

/** Observe a failed local ACK separately from the already received HTTP result. */
export function observeSyncCommit<T>(captured: Captured, commit: () => T, fields: Fields = {}): T {
  try { return commit(); }
  catch (error) {
    try { captured.emit(SyncTelemetry.Event.Stage, { ...fields, stage: SyncTelemetry.Stage.LocalAck,
      outcome: SyncTelemetry.Outcome.Failed, reason: SyncTelemetry.Reason.StorageUnavailable, persistOutcome: 'failed' }); }
    catch { /* Preserve the original business failure even if a test/custom sink throws. */ }
    throw error;
  }
}
