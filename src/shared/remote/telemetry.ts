import { AuthRefreshFailureKind, AuthSessionStatus } from '../auth/constants';
import { RemoteConnectionReason, RemoteSyncHealthReason } from './constants';
import { RemoteFileReason } from './files';
import { RemoteInputReason } from './input';
import { RemoteQuestion } from './questions';

export const RemoteTelemetryAction = { Runtime: 'lobsterai_remote_runtime', Summary: 'lobsterai_remote_summary', Ui: 'lobsterai_remote_ui' } as const;
export const RemoteTelemetryIpc = { Ui: 'remote:telemetry:ui' } as const;
export const RemoteTelemetryLimit = { Queue: 1024, Ordinary: 768, QueueBytes: 2 * 1024 * 1024, EventBytes: 4096, UrlBytes: 2048,
  SpoolBytes: 4 * 1024 * 1024, TtlMs: 86400000, WindowMs: 60000, HealthMs: 300000, Groups: 512, TimeoutMs: 10000 } as const;
export const RemoteTelemetryResult = {
  Deferred: 'local_deferred', Preflight: 'preflight_failed', Transport: 'transport_failed', Processing: 'local_processing_failed',
  Rejected: 'response_rejected', Invalid: 'response_invalid', ApiOk: 'api_ok', TransferOk: 'transfer_http_ok',
  Cancelled: 'cancelled', ContextChanged: 'context_changed', Unknown: 'unknown',
} as const;
export const RemoteTelemetryEvent = {
  Connection: 'remote.connection.changed', Capability: 'remote.capability.changed', Admission: 'remote.admission.changed', Runtime: 'remote.runtime.changed',
  Request: 'remote.request.completed', CommandPrepared: 'desktop.command.prepared', CommandDuplicate: 'desktop.command.duplicate',
  CommandUnknown: 'desktop.command.unknown', CommandReceipt: 'desktop.command.receipt_confirmed', Dispatch: 'desktop.run.dispatch_attempted',
  EngineAccepted: 'desktop.run.engine_accepted', Terminal: 'desktop.run.terminal', OutcomeUnknown: 'desktop.run.outcome_unknown',
  MessagePersisted: 'desktop.message.persisted', PersistFailed: 'desktop.message.persist_failed', FinalPersisted: 'desktop.message.final_persisted',
  ActionDecided: 'desktop.action.decided', ActionDispatched: 'desktop.action.dispatched', ActionReconciled: 'desktop.action.reconciled',
  Sealed: 'remote.publication.sealed', Acknowledged: 'remote.publication.acknowledged', PublicationUnknown: 'remote.publication.unknown',
  Quarantined: 'remote.record.quarantined', Recovered: 'remote.record.recovered', Deferred: 'remote.sync.task_deferred',
  WorkerExit: 'remote.worker.exit', WorkerRestart: 'remote.worker.restart', HistoryStarted: 'remote.history.started',
  HistoryCommitted: 'remote.history.committed', HistoryDeferred: 'remote.history.deferred', File: 'remote.file.state_changed',
  Preparation: 'remote.input_preparation.state_changed', SyncStage: 'remote.sync.stage_changed', Reconciled: 'remote.sync.reconciled',
  Content: 'remote.sync.content_changed', Health: 'remote.sync.health', Ui: 'remote.ui',
} as const;
export const RemoteTelemetrySummary = { Request: 'request_window', Execution: 'execution_window', Publication: 'publication_window',
  SyncStage: 'sync_stage_window', File: 'file_window', SyncHealth: 'sync_health', Telemetry: 'telemetry_health', Resource: 'resource_window' } as const;
export type TelemetryScalar = string | number | boolean;
export type TelemetryFields = Record<string, TelemetryScalar>;
export const telemetryEvents = new Set<string>(Object.values(RemoteTelemetryEvent));
export const telemetryResults = new Set<string>(Object.values(RemoteTelemetryResult));
export const telemetrySummaries = new Set<string>(Object.values(RemoteTelemetrySummary));

const words = (value: string): Set<string> => new Set(value.split(/\s+/u));
const states = words('unknown not_applicable unsupported idle starting ready connecting connected online reconnecting disabled blocked offline running waiting_approval waiting_local waiting_user cancelling reconciling succeeded failed cancelled interrupted pending approved rejected expired streaming complete error queued unavailable uploading committed aborted active stopped stopping fenced degraded syncing paused recovering valid invalid clean dirty enabled prepared applied received dispatched confirmed known_not_applied outcome_unknown accepted superseded covered_by_checkpoint sealed retired healthy recovery_required disposed initializing bootstrap activating backoff cooldown waiting_dependency repairing closed');
const phases = words('unknown final starting ready exit spawn alive dispose discovery snapshot upload complete publish reference local_commit download validate write local_ready server_ready cleanup retry received prepared server_confirmed reconcile decided dispatched reconciled attempted engine_accepted terminal final stream dirty queued started completed failed deferred isolated recovered cancelled sealed acknowledged pending begin part parts commit abort status poll activation bootstrap facts checkpoint materialize projection candidate outbox catalog local_ack_commit lease resync retention tombstone deleted input_preparation content_dependency encoding source_scan claim dispatch persist awaiting_receipt interrupted suspended resumed shutdown projection_queue projection_publish content_validation content_chunk content_manifest history_migration history_recovery repair manual_retry task_state replay');
const operations = words('unknown batch import.begin import.status import.part import.commit import.abort mode_activation live_projection history_recovery sync_state control_bootstrap control_facts control_operation command command_poll session_read connection file_policy file_begin file_part file_complete file_status file_publish file_download file_manifest input_claim input_ready input_status input_preparation agent_catalog model_catalog deletion delete_session legacy_batch legacy_import history_batch live file_publication file_asset session projection catalog control_fence checkpoint retention local_gc prepared_input reply_transport remote_json remote_binary file_reference file_resume file_version file_sync_state input_asset artifact_upload artifact_manifest input_asset_content reply_content task_repair cleanup');
const reasons = words('unknown none STATE_CHANGED RECORD_INVALID ENCODING_FAILED STORAGE_UNAVAILABLE REQUEST_FAILED CONTEXT_CHANGED EXECUTION_UNKNOWN DEPENDENCY_UNAVAILABLE REMOTE_AVAILABILITY_RECORD_INVALID FILE_OPERATION_FAILED LOCAL_IO_FAILED RESPONSE_INVALID REQUEST_REJECTED POLICY_UNAVAILABLE RETRY_SCHEDULED DISCOVERY_UNAVAILABLE WORKER_SPAWN_ERROR WORKER_EXIT WORKER_WATCHDOG WORKER_MEMORY_LIMIT WORKER_IPC_FAILURE WORKER_RESTART_BUDGET WORKER_DISPOSE REMOTE_IMPORT_CONTEXT_CHANGED REMOTE_PROJECTION_CONTEXT_CHANGED REMOTE_PROJECTION_WORKER_EXIT REMOTE_IMPORT_BUDGET REMOTE_IMPORT_RECORD_LIMIT REMOTE_IMPORT_PART_UNAVAILABLE REMOTE_AUTH_REFRESH_UNAVAILABLE REMOTE_SYNC_STATE_CONFLICT REMOTE_TRANSPORT_UNAVAILABLE REMOTE_TASK_SYNC_FAILED REMOTE_NETWORK_ADMISSION_BUSY REMOTE_NETWORK_BUSY REMOTE_NETWORK_CANCELLED REMOTE_NETWORK_IPC_FAILED REMOTE_NETWORK_REQUEST_FAILED REMOTE_NETWORK_FAILED REMOTE_NETWORK_REQUEST_INVALID REMOTE_NETWORK_REQUEST_BUDGET REMOTE_NETWORK_RESPONSE_INVALID REMOTE_NETWORK_RESPONSE_BUDGET REMOTE_NETWORK_WORKER_EXIT REMOTE_NETWORK_WORKER_UNAVAILABLE REMOTE_NETWORK_RESTART_BUDGET REMOTE_NETWORK_SOCKET_NOT_READY ASSET_NOT_FOUND ASSET_NOT_READY ASSET_EXPIRED ASSET_ACCESS_DENIED ASSET_VERSION_CONFLICT AUTH_UNAVAILABLE PERMISSION_DENIED ACCESS_DENIED INVALID_ACK ACCOUNT_CHANGED TARGET_CHANGED DISABLED NOT_SUPPORTED BUDGET_EXCEEDED SOURCE_CHANGED SESSION_DELETED JOURNAL_UNAVAILABLE DATABASE_UNAVAILABLE MANUAL_RETRY ASSET_FILE_CHANGED ASSET_MISSING ASSET_UPLOAD_FAILED INPUT_TOTAL_TOO_LARGE ACCOUNT_FILE_COUNT_LIMIT UNBOUND_FILE_QUOTA_EXCEEDED ACCOUNT_FILE_QUOTA_EXCEEDED TASK_FILE_QUOTA_EXCEEDED FILE_QUOTA_INCONSISTENT PRIVATE_INPUT_STORAGE_UNAVAILABLE NONE RECEIPT_INVALID CONTENT_LIMIT_EXCEEDED CONTENT_UNAVAILABLE LOCAL_ONLY RESOURCE_BUDGET REPAIR_BUDGET_OR_GUARD RETRY_DEFERRED GUARD_BLOCKED OPERATION_PENDING SECURITY_EVIDENCE_UNKNOWN DATABASE_HEALTH_UNKNOWN TIMEOUT WORKER_FAILED SYSTEM_RESUME SYSTEM_SUSPEND');
for (const value of [...Object.values(RemoteConnectionReason), ...Object.values(RemoteSyncHealthReason), ...Object.values(RemoteFileReason), ...Object.values(RemoteInputReason)]) reasons.add(value);
const enums: Record<string, Set<string>> = {
  lane: words('control live history files transport background unknown'), origin: words('remote mobile desktop im cron unknown'),
  remote_client_kind: words('mobile web unknown'), phase: phases, stage: phases, from_state: states, to_state: states, status: states,
  business_status: states, run_status: states, result: new Set([...telemetryResults, ...states, 'success', 'deferred']),
  outcome: new Set([...states, 'started', 'deferred', 'success', 'confirmed_committed', 'confirmed_covered', 'confirmed_superseded', 'confirmed_aborted', 'completed', 'skipped', 'confirmed_result']),
  operation: operations, operation_kind: operations, publication_kind: operations,
  failure_stage: words('none before_send local_admission auth transport http api protocol local_processing context'),
  failure_scope: words('service session object command device owner account target storage installation unknown'),
  request_family: words('remote_json remote_binary'), method: words('GET POST PUT PATCH DELETE HEAD'),
  persist_outcome: words('committed succeeded success failed pending unknown not_applicable'),
  coverage: words('complete partial unsupported'), clock_quality: words('normal jumped unknown'),
  role: words('network projection file security_journal database_health'), domain: words('network projection file security_journal database_health control live history files runtime security storage history_storage unknown'),
  representation: words('full summary desktop_only not_applicable unknown'),
  direction: words('input_download desktop_input_upload artifact_upload output_upload unknown'),
  reason: reasons, blocked_reason: reasons, transport_failure: reasons, content_unavailable_reason: reasons,
  transport_system_code: words('ECONNRESET ECONNREFUSED ENOTFOUND EAI_AGAIN ETIMEDOUT ENETUNREACH EHOSTUNREACH EPIPE EACCES EPERM ENOSPC ECONNABORTED ERR_INVALID_URL UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_SOCKET'),
  auth_status: new Set<string>(Object.values(AuthSessionStatus)),
  auth_failure_kind: new Set<string>(Object.values(AuthRefreshFailureKind)),
  error_type: words('Error RemoteApiError AbortError TimeoutError TypeError SyntaxError SqliteError AuthSessionRequestError RemoteNetworkError'),
  transport_error_type: words('Error TypeError AbortError TimeoutError RemoteNetworkError'),
  sync_mode: words('legacy legacy_batch availability availability_v3 live online recovery unknown not_supported not_applicable'),
  retry_phase: words('backoff cooldown dependency isolated ready waiting pending waiting_dependency'),
  trigger: words('timeout restart reconnect manual_retry receipt_missing context_change automatic user startup periodic'),
  reconcile_trigger: words('timeout restart reconnect manual_retry receipt_missing context_change'),
  write_kind: words('message final stream delta tool session insert update unknown'), object_kind: words('session message tool run approval question artifact file unknown'),
  command_type: words('create_session send_message stop_run approve_permission reject_permission answer_question delete_session delete_sessions cancel_run session.create message.send run.stop approval.respond question.answer session.delete unknown'),
  server_correlation: words('available unavailable'), abort_origin: words('user budget timeout context shutdown unknown'),
  ui_action: words('open entry device_page enable disable reconnect retry_connection retry_task close rename remove restore refresh keep_awake configure'),
  ui_stage: words('open click result'), surface: words('sidebar remote_popover remote_devices account_menu settings'),
  receipt_state: states,
  capability: words('legacy availability_v3 file_sync_v1 input_schema_v2 unknown not_supported'),
  coverage_profile: words('desktop_remote_v1 partial'),
};
enums.command_type.add('approval_response');
enums.command_type.add(RemoteQuestion.Command);
const ids = words('writer_generation control_epoch stream_epoch content_id remote_owner_id owner_scope_id device_id data_space_id request_id logical_attempt_id connection_attempt_id connection_id command_id run_id local_session_id session_id operation_id object_id message_id asset_id preparation_id publication_id delivery_id claim_id worker_instance_id ui_interaction_id transition_id job_id');
const sequences = words('connection_generation revision object_revision source_object_revision source_seq ack_seq ack_source_seq first_fact_seq last_fact_seq resolved_source_seq exact_source_prefix server_status_version status_version control_version input_version catalog_version history_generation api_version sync_protocol_version projection_version');
const numbers = words('duration_ms elapsed_ms count bytes request_bytes response_bytes retry_attempt retry_after_ms failure_count repair_attempt restart_attempt attachment_count part_count part_index record_count scanned processed isolated eligible_pending_count dirty_count pending_count retrying_count degraded_count gap_count oldest_pending_age_ms no_progress_age_ms unknown_operation_count oldest_unknown_age_ms affected_count queue_size queue_bytes oldest_queue_age_ms first_ts_ms last_ts_ms http_status business_code close_code skipped_count skipped valid_count invalid_count projection_queue files_queue files_cache_bytes cache_bytes event_loop_p99_ms event_loop_max_ms');
export const telemetryCounterNames = words('observed_count command_prepared command_duplicate command_unknown command_receipt_confirmed isolated blocked pending uploading aborted expired attempt_started transport_started transport_attempt_count inflight_start inflight_end local_deferred preflight_failed transport_failed local_processing_failed response_rejected response_invalid api_ok transfer_http_ok cancelled context_changed unknown dispatch_attempted engine_accepted run_succeeded run_failed run_cancelled run_interrupted run_unknown persisted persist_failed sealed accepted superseded rejected committed covered_by_checkpoint protocol_failed started succeeded failed deferred discovered skipped downloaded uploaded validated published referenced written local_ready server_ready reconciled degraded recovered deleted dirty queued completed scanned eligible acknowledged aggregated sampled_out dropped critical_dropped expired oversized invalid_event upload_ok upload_failed cache_failed cache_corrupt cached_recovered overflow summary_merged');
const aliases: Record<string, string> = { duration: 'duration_ms', httpStatus: 'http_status', code: 'business_code', state: 'status', scope: 'failure_scope', objectRevision: 'object_revision', phaseFrom: 'from_state', phaseTo: 'to_state' };
export function sanitizeRemoteTelemetryFields(raw: Record<string, unknown>): TelemetryFields {
  const clean: TelemetryFields = {};
  for (const key of Object.keys(raw).slice(0, 128)) {
    const name = aliases[key] ?? key.replace(/[A-Z]/gu, c => `_${c.toLowerCase()}`);
    const rawValue = raw[key];
    const value = name === 'representation' && rawValue === 'complete' ? 'full'
      : name === 'failure_stage' && (rawValue === 'preflight' || rawValue === 'prepare') ? 'before_send'
      : name === 'failure_stage' && rawValue === 'response' ? 'http' : rawValue;
    if (['request_id', 'logical_attempt_id', 'connection_attempt_id', 'ui_interaction_id', 'worker_instance_id'].includes(name) && typeof value === 'string') {
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) clean[name] = value;
    }
    else if (enums[name] && typeof value === 'string' && enums[name].has(value)) clean[name] = value;
    else if (ids.has(name) && typeof value === 'string' && (name === 'owner_scope_id' ? /^[A-Za-z0-9_:-]{1,96}$/u : /^[A-Za-z0-9_-]{1,64}$/u).test(value)) clean[name] = value;
    else if (sequences.has(name) && typeof value === 'string' && /^[0-9]{1,20}$/u.test(value)) clean[name] = value;
    else if (sequences.has(name) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) clean[name] = String(value);
    else if (numbers.has(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0
      && (['duration_ms', 'elapsed_ms', 'event_loop_p99_ms', 'event_loop_max_ms'].includes(name) || Number.isInteger(value))
      && (name !== 'http_status' || value >= 100 && value <= 599)) clean[name] = Math.min(value, Number.MAX_SAFE_INTEGER);
    else if (telemetryCounterNames.has(name) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) clean[name] = value;
  }
  return clean;
}

/** The minimum contract is checked after sanitizing. Missing evidence is never fabricated. */
export function remoteTelemetryRequired(event: string): string[][] {
  const E = RemoteTelemetryEvent;
  if (event === E.Request) return [['logical_attempt_id'], ['request_family'], ['operation'], ['method'], ['lane'], ['result'], ['failure_stage'], ['duration_ms']];
  if (event === E.Connection) return [['from_state'], ['to_state'], ['reason'], ['connection_attempt_id']];
  if (event === E.Ui) return [['ui_action'], ['ui_stage'], ['surface'], ['ui_interaction_id']];
  if (event.startsWith('desktop.command.')) return [['command_id'], ['command_type'], ['phase'], ['persist_outcome'], ...(event === E.CommandReceipt ? [['server_status_version'], ['request_id']] : [])];
  if (event.startsWith('desktop.run.')) return [['run_id'], ['phase'], ['origin'], ...(event === E.Terminal ? [['business_status'], ['persist_outcome']] : [])];
  if (event.startsWith('desktop.message.')) return [['local_session_id', 'session_id'], ['write_kind'], ['persist_outcome']];
  if (event.startsWith('desktop.action.')) return [['command_id'], ['command_type'], ['phase']];
  if (event.startsWith('remote.publication.') || event.startsWith('remote.history.')) return [['operation_id'], ['publication_kind'], ['lane'], ['phase'], ['business_status']];
  if (event.startsWith('remote.worker.')) return [['role'], ['phase'], ['reason'], ['worker_instance_id']];
  if (event === E.File || event === E.Preparation) return [['direction'], ['phase'], ['outcome'], ['asset_id', 'preparation_id', 'publication_id', 'operation_id', 'delivery_id']];
  if (event === E.Quarantined || event === E.Recovered) return [['failure_scope'], ['reason'], ['phase']];
  if (event === E.SyncStage || event === E.Reconciled || event === E.Content) return [['stage'], ['outcome'], ['operation_kind']];
  if (event === E.Admission || event === E.Runtime || event === E.Capability) return [['domain'], ['from_state'], ['to_state'], ['reason']];
  return [];
}
export function remoteTelemetryHasRequired(event: string, fields: TelemetryFields): boolean {
  return remoteTelemetryRequired(event).every(group => group.some(key => fields[key] !== undefined));
}
