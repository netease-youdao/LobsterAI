import { RemoteImportSnapshotError } from './remoteImportSnapshots';
import { RemoteSyncStateError } from './remoteRetention';
import { RemoteTaskDataError, type TaskSyncFailure, TaskSyncFailureReason } from './remoteTaskSyncState';

export function isSharedSyncFailure(error: unknown): boolean {
  const item = error as { code?: number | string; httpStatus?: number; data?: { reason?: string } } | null;
  return !!item && ([401, 40100, 47000, 47013, 47023, 47039, 47121].includes(Number(item.code))
    || item.httpStatus === 401 || typeof item.code === 'string' && /^(SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR))/u.test(item.code));
}

export function classifyTaskSyncFailure(error: unknown): TaskSyncFailure {
  const item = error as { code?: number | string; httpStatus?: number; retryAfterMs?: number; message?: string; name?: string; data?: { reason?: string; reasonDetail?: string; retryAfterMs?: number; syncDiagnostic?: { version?: number; failureScope?: string; retryAfterMs?: number } } } | null;
  const code = Number(item?.code), status = Number(item?.httpStatus), data = item?.data;
  const reason = typeof data?.reason === 'string' ? data.reason : error instanceof RemoteTaskDataError ? error.message : 'REMOTE_TASK_SYNC_FAILED';
  const hint = data?.syncDiagnostic?.version === 1 ? data.syncDiagnostic : null;
  const hints = [item?.retryAfterMs, data?.retryAfterMs, hint?.retryAfterMs].filter(value => value !== undefined && value !== null);
  const invalidWait = hints.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0);
  const wait = hints.filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  const retryAfterMs = wait.length ? Math.max(...wait) : undefined;
  if (status === 410 && code === 47010 && reason === 'SESSION_DELETED') return { phase: 'closed', scope: 'session', reason };
  if (isSharedSyncFailure(error)) return { phase: 'isolated', scope: 'device', reason };
  if (invalidWait) return { phase: 'isolated', scope: 'session', reason: TaskSyncFailureReason.RetryHintInvalid };
  if (code === 47012) return { phase: 'waiting_dependency', scope: hint?.failureScope === 'session' ? 'session' : 'owner_scope', reason, retryAfterMs };
  if (error instanceof RemoteSyncStateError) return { phase: 'isolated', scope: 'session', reason: 'REMOTE_SYNC_STATE_CONFLICT' };
  if (error instanceof RemoteTaskDataError) return { phase: 'isolated', scope: 'session', reason, repairable: error.repairable };
  if (error instanceof RemoteImportSnapshotError) return { phase: 'isolated', scope: 'session', reason: error.message };
  if (status === 429 || code === 429 || status >= 500 || code >= 500 && code < 600
    || ['AbortError', 'TimeoutError'].includes(item?.name || '') || /(?:fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|net::ERR_)/iu.test(item?.message || '')) {
    return { phase: 'backoff', scope: 'service', reason: 'REMOTE_TRANSPORT_UNAVAILABLE', retryAfterMs };
  }
  // Unknown data/ACK/permission errors are isolated, never presumed safe to rewrite.
  return { phase: 'isolated', scope: 'session', reason };
}
