import { describe, expect, it } from 'vitest';

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
