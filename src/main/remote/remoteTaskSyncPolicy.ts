import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteImportSnapshotError } from './remoteImportSnapshots';
import { remoteNetworkFailureCode, remoteTransportCause } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';
import { RemoteSyncStateError } from './remoteRetention';
import { RemoteTaskDataError, type TaskSyncFailure, TaskSyncFailureReason } from './remoteTaskSyncState';

export function isSharedSyncFailure(error: unknown): boolean {
  if (error instanceof AuthSessionRequestError && [AuthSessionStatus.Expired, AuthSessionStatus.Unauthenticated].some(status => status === error.status)) return true;
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
  const network = remoteNetworkFailureCode(error);
  if (network === RemoteNetworkFailure.AdmissionBusy || network === RemoteNetworkFailure.Busy)
    return { phase: 'backoff', scope: 'session', reason: RemoteNetworkFailure.AdmissionBusy, deferMs: 500 };
  if (network && [RemoteNetworkFailure.RequestInvalid, RemoteNetworkFailure.RequestBudget,
    RemoteNetworkFailure.ResponseInvalid, RemoteNetworkFailure.ResponseBudget].some(value => value === network))
    return { phase: 'isolated', scope: 'session', reason: network };
  if (network) return { phase: 'backoff', scope: 'service', reason: network, retryAfterMs };
  if (error instanceof AuthSessionRequestError && error.status === AuthSessionStatus.TemporarilyUnavailable && !error.originalError
    && [AuthRefreshFailureKind.Network, AuthRefreshFailureKind.Timeout, AuthRefreshFailureKind.Http].some(value => value === error.failureKind))
    return { phase: 'backoff', scope: 'service', reason: 'REMOTE_AUTH_REFRESH_UNAVAILABLE', retryAfterMs };
  if (error instanceof RemoteSyncStateError) return { phase: 'isolated', scope: 'session', reason: 'REMOTE_SYNC_STATE_CONFLICT' };
  if (error instanceof RemoteTaskDataError) return { phase: 'isolated', scope: 'session', reason, repairable: error.repairable };
  // Retry the existing snapshot checks on the next turn. This does not clear or replace
  // immutable evidence, grant admission, or bypass the caller's current-owner fence.
  if (error instanceof RemoteImportSnapshotError && error.message === 'REMOTE_IMPORT_CONTEXT_CHANGED')
    return { phase: 'backoff', scope: 'session', reason: error.message, deferMs: 1000 };
  if (error instanceof RemoteImportSnapshotError) return { phase: 'isolated', scope: 'session', reason: error.message };
  const cause = remoteTransportCause(error) as { name?: string; message?: string } | null;
  const transportError = !(status > 0 || code > 0) && (['AbortError', 'TimeoutError'].includes(cause?.name || '')
    || /(?:fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|net::ERR_)/iu.test(cause?.message || ''));
  if (status === 429 || code === 429 || status >= 500 || code >= 500 && code < 600 || transportError) {
    return { phase: 'backoff', scope: 'service', reason: 'REMOTE_TRANSPORT_UNAVAILABLE', retryAfterMs };
  }
  // Unknown data/ACK/permission errors are isolated, never presumed safe to rewrite.
  return { phase: 'isolated', scope: 'session', reason };
}
