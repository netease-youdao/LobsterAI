import { describe, expect, it } from 'vitest';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteImportSnapshotError } from './remoteImportSnapshots';
import { RemoteNetworkError } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';
import { classifyTaskSyncFailure, isSharedSyncFailure } from './remoteTaskSyncPolicy';
import { RemoteTaskDataError, TaskSyncFailureReason, TaskSyncPhase } from './remoteTaskSyncState';

describe('task synchronization failure scopes', () => {
  it('isolates local corruption and permission failures instead of stopping all sessions', () => {
    for (const error of [new SyntaxError('broken JSON'), new RemoteTaskDataError('bad chunk'), { httpStatus: 403, code: 47019 }]) {
      expect(isSharedSyncFailure(error)).toBe(false);
      expect(classifyTaskSyncFailure(error)).toMatchObject({ phase: TaskSyncPhase.Isolated, scope: 'session' });
    }
    expect(isSharedSyncFailure({ code: 'SQLITE_FULL' })).toBe(true);
    expect(isSharedSyncFailure({ httpStatus: 401 })).toBe(true);
  });
  it('distinguishes temporary transport failures from quota dependency failures', () => {
    expect(classifyTaskSyncFailure({ httpStatus: 503, code: 500 })).toMatchObject({ phase: TaskSyncPhase.Backoff, scope: 'service' });
    expect(classifyTaskSyncFailure({ httpStatus: 503, code: 47012, data: { reason: 'REPLY_CONTENT_QUOTA_INCONSISTENT' } }))
      .toMatchObject({ phase: TaskSyncPhase.Waiting, scope: 'owner_scope' });
    expect(classifyTaskSyncFailure({ httpStatus: 413, code: 47012, data: { reason: 'REPLY_CONTENT_QUOTA_EXCEEDED', syncDiagnostic: { version: 1, failureScope: 'session' } } }))
      .toMatchObject({ phase: TaskSyncPhase.Waiting, scope: 'session' });
  });
  it('accepts only supported diagnostic versions and preserves the longest valid retry delay', () => {
    expect(classifyTaskSyncFailure({ httpStatus: 429, retryAfterMs: 10000000, data: { retryAfterMs: 3600000, syncDiagnostic: { version: 1, retryAfterMs: 7200000 } } }).retryAfterMs).toBe(10000000);
    expect(classifyTaskSyncFailure({ httpStatus: 429, data: { syncDiagnostic: { version: 99, retryAfterMs: -1 } } }).phase).toBe(TaskSyncPhase.Backoff);
    for (const retryAfterMs of [-1, Infinity, NaN, '1000', 1.5]) {
      expect(classifyTaskSyncFailure({ httpStatus: 429, data: { retryAfterMs } }))
        .toMatchObject({ phase: TaskSyncPhase.Isolated, reason: TaskSyncFailureReason.RetryHintInvalid });
    }
  });
  it('gives authenticated deletion and credential protections priority over untrusted wait hints', () => {
    expect(classifyTaskSyncFailure({ httpStatus: 410, code: 47010, data: { reason: 'SESSION_DELETED', retryAfterMs: -1 } }).phase).toBe(TaskSyncPhase.Closed);
    expect(classifyTaskSyncFailure({ httpStatus: 401, data: { retryAfterMs: -1 } })).toMatchObject({ phase: TaskSyncPhase.Isolated, scope: 'device' });
  });
});

describe('authenticated transport failure boundaries', () => {
  const wrapped = (originalError?: unknown) => new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable,
    'Authenticated request failed', { failureKind: AuthRefreshFailureKind.Network, originalError });
  it('turns only local admission pressure into a short scheduling deferral', () => {
    for (const code of [RemoteNetworkFailure.AdmissionBusy, RemoteNetworkFailure.Busy]) {
      for (const error of [new RemoteNetworkError(code), wrapped(new RemoteNetworkError(code)), wrapped(new Error(code))])
        expect(classifyTaskSyncFailure(error)).toEqual({ phase: TaskSyncPhase.Backoff, scope: 'session', reason: RemoteNetworkFailure.AdmissionBusy, deferMs: 500 });
    }
  });
  it('preserves wrapped worker and actual network failures as service backoff', () => {
    for (const code of [RemoteNetworkFailure.WorkerExit, RemoteNetworkFailure.WorkerUnavailable,
      RemoteNetworkFailure.RestartBudget, RemoteNetworkFailure.RequestFailed, RemoteNetworkFailure.IpcFailed]) {
      expect(classifyTaskSyncFailure(wrapped(new RemoteNetworkError(code)))).toMatchObject({ phase: TaskSyncPhase.Backoff, scope: 'service', reason: code });
      expect(classifyTaskSyncFailure(wrapped(new RemoteNetworkError(code))).deferMs).toBeUndefined();
    }
    expect(classifyTaskSyncFailure(wrapped(new TypeError('fetch failed')))).toMatchObject({ phase: TaskSyncPhase.Backoff, scope: 'service' });
    expect(classifyTaskSyncFailure(wrapped())).toMatchObject({ phase: TaskSyncPhase.Backoff, reason: 'REMOTE_AUTH_REFRESH_UNAVAILABLE' });
  });
  it('keeps unknown causes, payload validation and permission/ACK errors isolated', () => {
    class BusinessError extends Error { code = 47019; httpStatus = 403; }
    for (const error of [wrapped(new Error('unknown private failure')), new BusinessError(RemoteNetworkFailure.AdmissionBusy),
      { name: 'AuthSessionRequestError', failureKind: 'network', originalError: new RemoteNetworkError(RemoteNetworkFailure.AdmissionBusy) },
      { code: 47006, httpStatus: 409, message: 'network ACK identity mismatch' }])
      expect(classifyTaskSyncFailure(error)).toMatchObject({ phase: TaskSyncPhase.Isolated, scope: 'session' });
    for (const code of [RemoteNetworkFailure.RequestBudget, RemoteNetworkFailure.RequestInvalid, RemoteNetworkFailure.ResponseBudget, RemoteNetworkFailure.ResponseInvalid])
      expect(classifyTaskSyncFailure(wrapped(new RemoteNetworkError(code)))).toMatchObject({ phase: TaskSyncPhase.Isolated, scope: 'session', reason: code });
  });
  it('reschedules only the typed local import cancellation without granting a repair or changing safety evidence', () => {
    expect(classifyTaskSyncFailure(new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED')))
      .toEqual({ phase: TaskSyncPhase.Backoff, scope: 'session', reason: 'REMOTE_IMPORT_CONTEXT_CHANGED', deferMs: 1000 });
    for (const error of [new Error('REMOTE_IMPORT_CONTEXT_CHANGED'), new RemoteImportSnapshotError('REMOTE_IMPORT_BUDGET'),
      new RemoteImportSnapshotError('REMOTE_IMPORT_PART_UNAVAILABLE'), new RemoteTaskDataError('Remote batch ACK identity mismatch')]) {
      expect(classifyTaskSyncFailure(error).phase).toBe(TaskSyncPhase.Isolated);
      expect(classifyTaskSyncFailure(error).deferMs).toBeUndefined();
    }
  });
  it('keeps terminal auth failures at the existing shared authentication boundary', () => {
    for (const status of [AuthSessionStatus.Expired, AuthSessionStatus.Unauthenticated]) {
      const error = new AuthSessionRequestError(status, 'private token error');
      expect(isSharedSyncFailure(error)).toBe(true);
      expect(classifyTaskSyncFailure(error)).toMatchObject({ phase: TaskSyncPhase.Isolated, scope: 'device' });
    }
  });
});
