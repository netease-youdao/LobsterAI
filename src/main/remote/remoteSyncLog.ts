import { createHash } from 'crypto';

import { RemoteSyncConflict } from '../../shared/remote/constants';
import { enqueueRemoteLog } from './remoteLogSink';
import { remoteTransportErrorMetadata } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';

/** Diagnostic metadata only. Never pass raw requests, responses or errors to the logger. */
export const REMOTE_SYNC_REQUEST_ID_HEADER = 'X-Remote-Request-Id';

const SyncOperation = {
  Batch: 'batch', Begin: 'import.begin', Status: 'import.status', Part: 'import.part',
  Commit: 'import.commit', Abort: 'import.abort',
} as const;
const eventTypes = new Set(['session.upsert', 'session.deleted', 'message.upsert', 'message.delta', 'message.deleted', 'tool.upsert', 'run.updated', 'approval.updated']);
const lifecycleStates = new Set(['starting', 'running', 'waiting_approval', 'waiting_local', 'cancelling', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'pending', 'approved', 'rejected', 'expired', 'streaming', 'complete', 'error', 'queued', 'waiting_user', 'unavailable', 'uploading', 'committed', 'aborted']);
const validationMessages = new Set([
  ...Object.values(RemoteNetworkFailure),
  'Remote ACK outside durable local bounds', 'Remote batch ACK identity mismatch',
  'Remote import receipt identity mismatch', 'Import receipt identity mismatch', 'Import abortion is not confirmed',
  'REMOTE_IMPORT_BUDGET', 'REMOTE_IMPORT_RECORD_LIMIT', 'REMOTE_IMPORT_PART_UNAVAILABLE', 'REMOTE_IMPORT_CONTEXT_CHANGED',
  'Import changed the fixed remote session mapping', 'Remote response is too large',
  'Invalid remote response', 'Remote payload must contain finite JSON values',
  'Account changed during remote request', 'Account changed during remote response',
  'Object version has different content', 'Message identity and ordinal cannot change',
  'Deleted message cannot be resurrected', RemoteSyncConflict.RunMapping,
  'A source sequence cannot change content', 'Event hash mismatch',
]);
const object = (value: unknown): Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const id = (value: unknown): string | null => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
const sequence = (value: unknown): string | null => typeof value === 'string' && /^\d{1,19}$/u.test(value) ? value : null;
const reason = (value: unknown): string | null => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function remoteSyncRequestId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value) ? value : null;
}

export function remoteSyncEventMetadata(raw: unknown, index: number): Record<string, unknown> {
  const event = object(raw), payload = object(event.payload);
  const entity = object(payload.message ?? payload.tool ?? payload.run ?? payload.approval ?? payload.session);
  const run = object(entity.run);
  return { index, eventType: eventTypes.has(event.eventType) ? event.eventType : 'unknown', eventId: id(event.eventId),
    sourceSeq: sequence(event.sourceSeq), objectId: id(entity.messageId ?? entity.toolCallId ?? entity.approvalId ?? entity.runId ?? entity.sessionId ?? payload.messageId),
    revision: sequence(entity.revision ?? entity.statusVersion ?? entity.approvalVersion),
    runId: id(entity.runId ?? run.runId), runStatusVersion: sequence(run.statusVersion),
    status: lifecycleStates.has(entity.status) ? entity.status : lifecycleStates.has(run.status) ? run.status : null,
    controlVersion: sequence(payload.controlVersion ?? entity.controlVersion), ordinal: sequence(entity.ordinal) };
}

export function remoteSyncRequestMetadata(pathname: string, raw: unknown): Record<string, unknown> | null {
  const route = /^\/sync\/imports\/([A-Za-z0-9_-]{1,64})(?:\/(parts\/\d+|commit|abort))?$/u.exec(pathname);
  const operation = pathname === '/sync/batches' ? SyncOperation.Batch : pathname === '/sync/imports' ? SyncOperation.Begin
    : route ? route[2]?.startsWith('parts/') ? SyncOperation.Part : route[2] === 'commit' ? SyncOperation.Commit
      : route[2] === 'abort' ? SyncOperation.Abort : SyncOperation.Status : null;
  if (!operation) return remoteOperationMetadata(pathname, raw);
  const body = object(raw), manifest = object(body.manifest);
  const records = Array.isArray(body.events) ? body.events : object(body.payload).records;
  const items = Array.isArray(records) ? records : [];
  const types: Record<string, number> = {};
  for (const record of items.slice(0, 1000)) {
    const type = object(record).eventType;
    const key = eventTypes.has(type) ? type : 'unknown';
    types[key] = (types[key] || 0) + 1;
  }
  return { operation, batchId: id(body.batchId), importId: id(body.importId ?? route?.[1]),
    localSessionId: id(body.localSessionId), sessionId: id(body.sessionId), deviceId: id(body.deviceId),
    mode: body.mode === 'online' || body.mode === 'recovery' ? body.mode : null,
    connectionGeneration: sequence(body.connectionGeneration), baseSourceSeq: sequence(body.baseSourceSeq),
    expectedSourceSeq: sequence(body.expectedSourceSeq), expectedServerSeq: sequence(body.expectedServerSeq),
    expectedStateVersion: sequence(body.expectedStateVersion), partNo: route?.[2]?.startsWith('parts/') ? count(Number(route[2].slice(6))) : null,
    partCount: count(manifest.partCount), recordCount: items.length, eventTypes: types,
    firstSourceSeq: sequence(object(items[0]).sourceSeq), lastSourceSeq: sequence(object(items.at(-1)).sourceSeq),
    ...(Array.isArray(body.events) ? { events: items.slice(0, 100).map(remoteSyncEventMetadata) } : {}) };
}

export function remoteSyncResultMetadata(raw: unknown): Record<string, unknown> {
  const result = object(raw);
  return { sessionId: id(result.sessionId), deviceId: id(result.deviceId), batchId: id(result.batchId), importId: id(result.importId),
    state: lifecycleStates.has(result.state) ? result.state : null, stateVersion: sequence(result.stateVersion),
    committedSourceSeq: sequence(result.committedSourceSeq), committedSeq: sequence(result.committedSeq) };
}

export function remoteSyncErrorMetadata(error: unknown): Record<string, any> {
  const value = object(error), details = object(value.data);
  return { code: count(value.code), httpStatus: count(value.httpStatus), reason: reason(details.reason), reasonDetail: reason(details.reasonDetail),
    requestId: remoteSyncRequestId(value.requestId) ?? remoteSyncRequestId(details.requestId),
    validation: validationMessages.has(value.message) ? value.message : null,
    errorType: ['Error', 'RemoteApiError', 'AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'SqliteError', 'AuthSessionRequestError', 'RemoteNetworkError'].includes(value.name) ? value.name : 'Error',
    expectedSourceSeq: sequence(details.expectedSourceSeq), currentSourceSeq: sequence(details.currentSourceSeq),
    currentServerSeq: sequence(details.currentServerSeq), activeImportId: id(details.activeImportId), ...remoteTransportErrorMetadata(error) };
}

const operationRoutes: Array<[RegExp, string]> = [
  [/^\/sync\/mode-activations(?:\/[A-Za-z0-9_-]{1,64})?$/u, 'mode_activation'],
  [/^\/sync\/live-projections(?:\/[A-Za-z0-9_-]{1,64})?$/u, 'live_projection'],
  [/^\/sync\/recoveries(?:\/[A-Za-z0-9_-]{1,64}(?:\/(?:parts\/\d+|commit|abort))?)?$/u, 'history_recovery'],
  [/^\/sync\/state$/u, 'sync_state'],
  [/^\/control\/bootstrap(?:\/[A-Za-z0-9_-]{1,64}(?:\/(?:parts\/\d+|commit|abort))?)?$/u, 'control_bootstrap'],
  [/^\/control\/facts\/batches$/u, 'control_facts'],
  [/^\/control\/operations\/[A-Za-z0-9_-]{1,64}$/u, 'control_operation'],
  [/^\/commands(?:\/[A-Za-z0-9_-]{1,64}(?:\/(?:ack|reconcile))?)?$/u, 'command'],
  [/^\/devices\/[A-Za-z0-9_-]{1,64}\/commands(?:\/claim)?$/u, 'command_poll'],
  [/^\/sessions(?:\/[A-Za-z0-9_-]{1,64}(?:\/(?:snapshot|messages|events|tools|contents)(?:\/[A-Za-z0-9_-]{1,64})?)?)?$/u, 'session_read'],
  [/^\/(?:connection-tickets|capabilities|devices\/register)$/u, 'connection'],
  [/^\/devices\/[A-Za-z0-9_-]{1,64}\/connections(?:\/[A-Za-z0-9_-]{1,64})?$/u, 'connection'],
];
function remoteOperationMetadata(pathname: string, raw: unknown): Record<string, unknown> | null {
  const route = pathname.split('?')[0], operation = operationRoutes.find(([pattern]) => pattern.test(route))?.[1];
  if (!operation) return null;
  const body = object(raw), command = /^\/commands\/([A-Za-z0-9_-]{1,64})/u.exec(route);
  const operationPath = /^\/(?:sync\/(?:mode-activations|live-projections|recoveries)|control\/(?:bootstrap|operations))\/([A-Za-z0-9_-]{1,64})/u.exec(route);
  return { operation, commandId: id(body.commandId ?? command?.[1]), operationId: id(body.operationId ?? body.publicationId ?? body.recoveryId ?? body.batchId ?? operationPath?.[1]),
    localSessionId: id(body.localSessionId), sessionId: id(body.sessionId), runId: id(body.runId), deviceId: id(body.deviceId),
    writerGeneration: id(body.writerGeneration), connectionGeneration: sequence(body.connectionGeneration),
    sourceObjectRevision: sequence(body.sourceObjectRevision), objectId: id(body.objectId),
    firstFactSeq: sequence(body.firstFactSeq), lastFactSeq: sequence(body.lastFactSeq),
    exactSourcePrefix: sequence(body.exactSourcePrefix), resolvedSourceSeq: sequence(body.resolvedSourceSeq) };
}

const diagnosticEvents = new Set([
  'remote.connection.changed', 'remote.request.completed', 'remote.record.quarantined', 'remote.record.probe', 'remote.record.recovered',
  'remote.publication.sealed', 'remote.publication.acknowledged', 'remote.publication.unknown',
  'remote.sync.round', 'remote.sync.task_deferred', 'remote.history.recovery_started', 'remote.history.committed', 'remote.history.deferred',
  'remote.worker.exit', 'remote.worker.restart', 'remote.worker.circuit_changed',
  'desktop.command.prepared', 'desktop.command.duplicate', 'desktop.command.unknown',
  'desktop.run.dispatch_started', 'desktop.run.dispatched', 'desktop.run.outcome_unknown', 'desktop.run.terminal',
  'desktop.message.persisted', 'desktop.message.persist_failed', 'desktop.action.decided', 'desktop.action.dispatched',
  'desktop.action.reconciled', 'desktop.account_transition.changed',
]);
const diagnosticIds = new Set(['requestId','connectionId','connectionGeneration','generation','localSessionId','sessionId','commandId','runId','operationId','writerGeneration','objectId','revision','jobId','transitionId']);
const diagnosticNumbers = new Set(['durationMs','elapsedMs','count','bytes','retryAttempt','nextRetryAt','retryAfterMs','scanned','processed','isolated','firstSeenAt','lastSeenAt']);
const diagnosticValues = new Set(['desktop','mobile','im','cron','control','live','history','files','transport','success','failed','unknown','deferred','corrupt','active','ready','blocked','fencing','stopping','validating','recovery_required','prepared','executing','applied','rejected','accepted','superseded','starting','running','waiting_approval','waiting_local','waiting_user','succeeded','cancelled','interrupted','complete','error']);
const diagnosticReasons = new Set(['RECORD_INVALID','ENCODING_FAILED','STORAGE_UNAVAILABLE','REQUEST_FAILED','CONTEXT_CHANGED','EXECUTION_UNKNOWN','DEPENDENCY_UNAVAILABLE','STATE_CHANGED','REMOTE_AVAILABILITY_RECORD_INVALID']);
const diagnosticWindows = new Map<string, { at: number; count: number }>();
/** Never let diagnostic output or an injected logger change a committed business result. */
export function remoteLogMessage(level: 'debug' | 'warn' | 'error' | 'info', message: string, fields: Record<string, unknown>): void {
  try {
    let value = fields;
    if (Buffer.byteLength(JSON.stringify(value)) > 3900) {
      const { events: _events, ...bounded } = value;
      value = bounded;
      if (Buffer.byteLength(JSON.stringify(value)) > 3900) value = { truncated: true };
    }
    enqueueRemoteLog(level, message, value);
  } catch { /* Logs are best effort and never execution evidence. */ }
}
export function remoteDiagnosticLog(event: string, fields: Record<string, unknown>, level: 'debug' | 'warn' | 'error' | 'info' = 'debug'): void {
  if (!diagnosticEvents.has(event)) return;
  const clean: Record<string, unknown> = { event, timestamp: new Date().toISOString(), component: 'desktop' };
  for (const [key, value] of Object.entries(fields)) {
    if (diagnosticIds.has(key)) { const safe = key === 'requestId' ? remoteSyncRequestId(value) : id(value); if (safe) clean[key] = safe; }
    else if (diagnosticNumbers.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
    else if (['origin','lane','status','result'].includes(key) && typeof value === 'string' && diagnosticValues.has(value)) clean[key] = value;
    else if (key === 'reason' && typeof value === 'string' && diagnosticReasons.has(value)) clean[key] = value;
    else if (key === 'error') clean.error = remoteSyncErrorMetadata(value);
  }
  if (level === 'warn' || event === 'remote.record.quarantined') {
    const key = createHash('sha256').update(JSON.stringify({ event, lane: clean.lane, sessionId: clean.localSessionId ?? clean.sessionId,
      objectId: clean.objectId, operationId: clean.operationId, commandId: clean.commandId, reason: clean.reason })).digest('hex');
    const previous = diagnosticWindows.get(key), now = Date.now();
    if (previous && now - previous.at < 60000) { previous.count++; return; }
    if (diagnosticWindows.size >= 1024) diagnosticWindows.delete(diagnosticWindows.keys().next().value!);
    diagnosticWindows.set(key, { at: now, count: 1 });
    if (previous) clean.suppressedCount = previous.count - 1;
  }
  remoteLogMessage(level, '[RemoteDiagnostic]', clean);
}
