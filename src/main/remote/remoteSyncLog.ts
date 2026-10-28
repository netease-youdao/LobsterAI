import { createHash } from 'crypto';

import { RemoteSyncConflict } from '../../shared/remote/constants';
import { RemoteInputReason } from '../../shared/remote/input';
import { RemoteQuestion } from '../../shared/remote/questions';
import { RemoteReply } from '../../shared/remote/reply';
import { RemoteImportValidation } from '../../shared/remote/retention';
import { RemoteDeletionReason } from './remoteDeletionSyncPolicy';
import { RemoteLiveEncodingError } from './remoteLiveMetadata';
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
const manifestEventTypes = [...eventTypes].filter(type => type !== RemoteReply.DeltaEvent).concat(RemoteQuestion.Event);
const lifecycleStates = new Set(['starting', 'running', 'waiting_approval', 'waiting_local', 'cancelling', 'reconciling', 'succeeded', 'failed', 'cancelled', 'interrupted', 'pending', 'approved', 'rejected', 'expired', 'streaming', 'complete', 'error', 'queued', 'waiting_user', 'unavailable', 'uploading', 'committed', 'aborted']);
const validationMessages = new Set([
  ...Object.values(RemoteDeletionReason),
  ...Object.values(RemoteNetworkFailure), ...Object.values(RemoteLiveEncodingError),
  'Unverified legacy session has no original mapping', 'Persisted synchronization safety block requires task review',
  'Remote ACK outside durable local bounds', 'Remote batch ACK identity mismatch',
  'Remote import receipt identity mismatch', 'Import receipt identity mismatch', 'Import abortion is not confirmed',
  'REMOTE_IMPORT_BUDGET', 'REMOTE_IMPORT_RECORD_LIMIT', 'REMOTE_IMPORT_PART_UNAVAILABLE', 'REMOTE_IMPORT_CONTEXT_CHANGED',
  RemoteImportValidation.MissingSummary,
  'Import changed the fixed remote session mapping', 'Remote response is too large',
  'Invalid remote response', 'Remote payload must contain finite JSON values',
  'Account changed during remote request', 'Account changed during remote response',
  'Object version has different content', 'Message identity and ordinal cannot change',
  'Deleted message cannot be resurrected', RemoteSyncConflict.RunMapping,
  'A source sequence cannot change content', 'Event hash mismatch',
  'REMOTE_DELETION_BINDING_UNRESOLVED',
  'REMOTE_CONTROL_ADOPTION_EVIDENCE_MISSING',
  'REMOTE_CONTROL_RECONCILIATION_INVALID',
  'REMOTE_CONTROL_DELETION_EVIDENCE_MISSING',
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
  const manifestCounts = object(manifest.recordCounts), recordCounts: Record<string, number> = {};
  for (const type of manifestEventTypes) {
    const value = count(manifestCounts[type]);
    if (Object.hasOwn(manifestCounts, type) && value !== null) recordCounts[type] = value;
  }
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
    partCount: count(manifest.partCount), recordCounts, recordCount: items.length, eventTypes: types,
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
  [/^\/devices\/[A-Za-z0-9_-]{1,64}\/commands(?:\/(?:claim|unresolved))?$/u, 'command_poll'],
  [/^\/sessions(?:\/[A-Za-z0-9_-]{1,64}(?:\/(?:snapshot|messages|events|tools|contents)(?:\/[A-Za-z0-9_-]{1,64})?)?)?$/u, 'session_read'],
  [/^\/(?:connection-tickets|capabilities|devices\/register)$/u, 'connection'],
  [/^\/devices\/[A-Za-z0-9_-]{1,64}\/connections(?:\/[A-Za-z0-9_-]{1,64})?$/u, 'connection'],
];
const diagnosticRoutes: Array<[RegExp, string]> = [
  [/^\/devices\/[^/]+\/commands\/unresolved$/u, '/devices/:deviceId/commands/unresolved'],
  [/^\/devices\/[^/]+\/commands\/claim$/u, '/devices/:deviceId/commands/claim'],
  [/^\/devices\/[^/]+\/commands$/u, '/devices/:deviceId/commands'],
  [/^\/devices\/[^/]+\/settings$/u, '/devices/:deviceId/settings'],
  [/^\/sync\/imports\/[^/]+\/parts\/\d+$/u, '/sync/imports/:importId/parts/:partNo'],
  [/^\/sync\/imports\/[^/]+\/commit$/u, '/sync/imports/:importId/commit'],
  [/^\/sync\/imports\/[^/]+\/abort$/u, '/sync/imports/:importId/abort'],
  [/^\/sync\/imports\/[^/]+$/u, '/sync/imports/:importId'],
  [/^\/control\/operations\/[^/]+$/u, '/control/operations/:operationId'],
  [/^\/sync\/mode-activations\/[^/]+$/u, '/sync/mode-activations/:operationId'],
  [/^\/sync\/live-projections\/[^/]+$/u, '/sync/live-projections/:publicationId'],
];
const diagnosticExactRoutes = new Set(['/capabilities', '/devices/register', '/connection-tickets', '/sync/state', '/sync/batches',
  '/sync/imports', '/sync/mode-activations', '/sync/live-projections', '/sync/recoveries', '/control/bootstrap', '/control/facts/batches']);
const diagnosticRouteTemplates = new Set([...diagnosticExactRoutes, ...diagnosticRoutes.map(([, template]) => template)]);
/** Fixed route templates only: URL queries and identifiers never enter this field. */
export function remoteDiagnosticRoute(pathname: string): string | null {
  const path = pathname.split('?')[0];
  return diagnosticExactRoutes.has(path) ? path : diagnosticRoutes.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}
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

export const RemoteInputDiagnostic = {
  Event: 'remote.input.preparation',
  SizeMismatch: 'CONTENT_SIZE_MISMATCH', HashMismatch: 'CONTENT_HASH_MISMATCH',
  DownloadRejected: 'ASSET_DOWNLOAD_REJECTED', ImageInvalid: 'IMAGE_DECODE_INVALID',
} as const;
const inputStages = new Set(['download', 'validate', 'decode', 'write', 'local_commit', 'local_ready', 'server_ready', 'prepare', 'transport', 'response', 'local_classification', 'persist']);
const diagnosticEvents = new Set([
  RemoteInputDiagnostic.Event,
  'remote.connection.changed', 'remote.request.completed', 'remote.record.quarantined', 'remote.record.probe', 'remote.record.recovered',
  'remote.publication.sealed', 'remote.publication.acknowledged', 'remote.publication.unknown',
  'remote.sync.round', 'remote.sync.task_deferred', 'remote.history.recovery_started', 'remote.history.committed', 'remote.history.deferred',
  'remote.worker.exit', 'remote.worker.restart', 'remote.worker.circuit_changed',
  'desktop.command.prepared', 'desktop.command.duplicate', 'desktop.command.unknown',
  'desktop.run.dispatch_started', 'desktop.run.dispatched', 'desktop.run.outcome_unknown', 'desktop.run.terminal',
  'desktop.message.persisted', 'desktop.message.persist_failed', 'desktop.action.decided', 'desktop.action.dispatched',
  'desktop.action.reconciled', 'desktop.account_transition.changed',
]);
const diagnosticIds = new Set(['requestId','connectionId','connectionGeneration','generation','targetId','deviceId','localSessionId','sessionId','commandId','runId','operationId','writerGeneration','objectId','revision','jobId','transitionId','preparationId','assetId','transportRequestId']);
const diagnosticEncodingNumbers = new Set(['encoderVersion','rawMetadataBytes','normalizedMetadataBytes']);
const diagnosticNumbers = new Set(['routeEpoch','apiVersion','httpStatus','durationMs','elapsedMs','count','bytes','retryAttempt','nextRetryAt','retryAfterMs','scanned','processed','isolated','firstSeenAt','lastSeenAt','actualBytes','expectedBytes']);
const diagnosticValues = new Set(['desktop','mobile','im','cron','control','live','history','files','transport','success','failed','unknown','deferred','corrupt','active','ready','blocked','fencing','stopping','validating','recovery_required','prepared','executing','applied','rejected','accepted','superseded','starting','running','waiting_approval','waiting_local','waiting_user','succeeded','cancelled','interrupted','complete','error']);
const diagnosticReasons = new Set([...Object.values(RemoteDeletionReason), ...Object.values(RemoteInputReason), RemoteInputDiagnostic.SizeMismatch, RemoteInputDiagnostic.HashMismatch, RemoteInputDiagnostic.DownloadRejected, RemoteInputDiagnostic.ImageInvalid, 'LOCAL_IO_FAILED', 'FILE_OPERATION_FAILED','RECORD_INVALID','ENCODING_FAILED','STORAGE_UNAVAILABLE','REQUEST_FAILED','CONTEXT_CHANGED','EXECUTION_UNKNOWN','DEPENDENCY_UNAVAILABLE','STATE_CHANGED','REMOTE_AVAILABILITY_RECORD_INVALID']);
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
    if (diagnosticIds.has(key)) { const safe = key === 'requestId' || key === 'transportRequestId' ? remoteSyncRequestId(value) : id(value); if (safe) clean[key] = safe; }
    else if (diagnosticEncodingNumbers.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1024 * 1024 * 1024) clean[key] = value;
    else if (diagnosticNumbers.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
    else if (['origin','lane','status','result'].includes(key) && typeof value === 'string' && diagnosticValues.has(value)) clean[key] = value;
    else if (key === 'stage' && typeof value === 'string' && inputStages.has(value)) clean[key] = value;
    else if (key === 'reason' && typeof value === 'string' && diagnosticReasons.has(value)) clean[key] = value;
    else if (key === 'routeTemplate' && typeof value === 'string' && diagnosticRouteTemplates.has(value)) clean[key] = value;
    else if (key === 'method' && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(value))) clean[key] = value;
    else if (key === 'error') clean.error = remoteSyncErrorMetadata(value);
  }
  if (level === 'warn' || event === 'remote.record.quarantined') {
    const key = createHash('sha256').update(JSON.stringify({ event, routeEpoch: clean.routeEpoch, targetId: clean.targetId, deviceId: clean.deviceId,
      lane: clean.lane, routeTemplate: clean.routeTemplate, method: clean.method, apiVersion: clean.apiVersion, error: clean.error && {
        code: object(clean.error).code, httpStatus: object(clean.error).httpStatus, validation: object(clean.error).validation,
        reason: object(clean.error).reason, authFailureKind: object(clean.error).authFailureKind }, sessionId: clean.localSessionId ?? clean.sessionId,
      preparationId: clean.preparationId, assetId: clean.assetId, stage: clean.stage,
      objectId: clean.objectId, operationId: clean.operationId, commandId: clean.commandId, reason: clean.reason })).digest('hex');
    const previous = diagnosticWindows.get(key), now = Date.now();
    if (previous && now - previous.at < 60000) { previous.count++; return; }
    if (diagnosticWindows.size >= 1024) diagnosticWindows.delete(diagnosticWindows.keys().next().value!);
    diagnosticWindows.set(key, { at: now, count: 1 });
    if (previous) clean.suppressedCount = previous.count - 1;
  }
  remoteLogMessage(level, '[RemoteDiagnostic]', clean);
}
