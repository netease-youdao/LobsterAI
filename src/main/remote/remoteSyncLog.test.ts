import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteNetworkError } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';
import {
  remoteDiagnosticLog,
  RemoteInputDiagnostic,
  remoteSyncErrorMetadata,
  remoteSyncEventMetadata,
  remoteSyncRequestId,
  remoteSyncRequestMetadata,
  remoteSyncResultMetadata,
} from './remoteSyncLog';

const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: (_level: string, _message: string, fields: Record<string, unknown>) => { logged.push(fields); } }));
beforeEach(() => { logged.length = 0; });

const requestId = '6dac1fc3-8d89-40f0-98c5-eb753c18062c';
const privateText = 'private conversation /Users/test/private.txt Bearer secret-token';

function messageEvent() {
  return { eventId: 'event-1', sourceSeq: '17', eventType: 'message.upsert', occurredAt: '2026-09-14T01:00:00Z',
    payload: { message: { messageId: 'message-1', revision: '3', ordinal: '4', runId: 'run-2', status: 'streaming',
      content: privateText, attachments: [{ path: privateText }], input: { token: privateText } } } };
}

describe('remote sync diagnostic metadata', () => {
  it('keeps event identities and versions while excluding conversation and tool contents', () => {
    expect(remoteSyncEventMetadata(messageEvent(), 0)).toEqual({ index: 0, eventType: 'message.upsert', eventId: 'event-1',
      sourceSeq: '17', objectId: 'message-1', revision: '3', runId: 'run-2', runStatusVersion: null,
      status: 'streaming', controlVersion: null, ordinal: '4' });
    const tool = remoteSyncEventMetadata({ eventId: 'event-2', sourceSeq: '18', eventType: 'tool.upsert',
      payload: { tool: { toolCallId: 'tool-1', revision: '2', runId: 'run-2', status: 'succeeded',
        name: privateText, input: privateText, output: privateText, path: privateText } } }, 1);
    expect(tool).toMatchObject({ eventId: 'event-2', sourceSeq: '18', objectId: 'tool-1', revision: '2', status: 'succeeded' });
    expect(JSON.stringify(tool)).not.toContain(privateText);
    expect(remoteSyncEventMetadata({ eventType: 'run.updated', payload: { run: { runId: 'run-2',
      statusVersion: '8', status: 'running', controlVersion: '9', title: privateText } } }, 2))
      .toMatchObject({ objectId: 'run-2', revision: '8', status: 'running', controlVersion: '9' });
    expect(remoteSyncEventMetadata({ eventType: 'session.upsert', payload: { session: { sessionId: 'session-1',
      title: privateText, run: { runId: 'run-2', statusVersion: '8', status: 'running' }, controlVersion: '9' } } }, 3))
      .toMatchObject({ objectId: 'session-1', runId: 'run-2', runStatusVersion: '8', controlVersion: '9' });
  });

  it('uses a bounded request field allowlist and never includes owner, tokens, bodies or paths', () => {
    const raw = { batchId: 'b'.repeat(64), deviceId: 'desktop', localSessionId: 'local', sessionId: 'session',
      mode: 'online', connectionGeneration: '12', expectedSourceSeq: '16', expectedServerSeq: '24',
      events: [messageEvent()], owner: { userId: privateText, scopeKey: privateText },
      token: privateText, credential: privateText, path: privateText, arbitrary: privateText };
    const metadata = remoteSyncRequestMetadata('/sync/batches', raw);
    expect(metadata).toMatchObject({ operation: 'batch', batchId: raw.batchId, deviceId: 'desktop',
      connectionGeneration: '12', firstSourceSeq: '17', lastSourceSeq: '17', recordCount: 1,
      eventTypes: { 'message.upsert': 1 } });
    expect(Object.keys(metadata!).sort()).toEqual(['operation', 'batchId', 'importId', 'localSessionId', 'sessionId', 'deviceId',
      'mode', 'connectionGeneration', 'baseSourceSeq', 'expectedSourceSeq', 'expectedServerSeq', 'expectedStateVersion',
      'partNo', 'partCount', 'recordCount', 'eventTypes', 'firstSourceSeq', 'lastSourceSeq', 'events'].sort());
    expect(JSON.stringify(metadata)).not.toContain(privateText);
    expect(remoteSyncRequestMetadata('/sync/imports/import-1/parts/2', { payload: { records: [messageEvent()] }, token: privateText }))
      .toMatchObject({ operation: 'import.part', importId: 'import-1', partNo: 2, recordCount: 1 });
    expect(remoteSyncRequestMetadata('/sync/imports/import-1/commit', { expectedStateVersion: '3' }))
      .toMatchObject({ operation: 'import.commit', importId: 'import-1', expectedStateVersion: '3' });
    expect(remoteSyncRequestMetadata('/devices/private-host/settings', raw)).toBeNull();
  });

  it('rejects malformed and excessive metadata and caps per-event detail', () => {
    const metadata = remoteSyncRequestMetadata('/sync/batches', { batchId: 'b'.repeat(65), sessionId: privateText,
      deviceId: 'desktop\nforged log', connectionGeneration: '1'.repeat(20), expectedSourceSeq: '-1',
      manifest: { partCount: Number.MAX_SAFE_INTEGER + 1 }, events: Array.from({ length: 1001 }, () => messageEvent()) });
    expect(metadata).toMatchObject({ batchId: null, sessionId: null, deviceId: null, connectionGeneration: null,
      expectedSourceSeq: null, partCount: null, recordCount: 1001, eventTypes: { 'message.upsert': 1000 } });
    expect(metadata!.events).toHaveLength(100);
    expect(remoteSyncEventMetadata({ eventId: 'e'.repeat(65), sourceSeq: '1'.repeat(20), eventType: privateText,
      payload: { message: { messageId: privateText, status: privateText, revision: '1.5', ordinal: '-1' } } }, 0))
      .toMatchObject({ eventType: 'unknown', eventId: null, sourceSeq: null, objectId: null, status: null, revision: null, ordinal: null });
    expect(remoteSyncRequestId(requestId)).toBe(requestId);
    for (const invalid of [null, 123, privateText, `${requestId}\n`, 'a'.repeat(128)]) expect(remoteSyncRequestId(invalid)).toBeNull();
  });

  it('logs only known validation messages and safe error codes, watermarks and request IDs', () => {
    const error = Object.assign(new Error(privateText), { code: 47025, httpStatus: 409, requestId, stack: privateText,
      data: { reason: 'RESYNC_REQUIRED', reasonDetail: 'GAP', currentSourceSeq: '16', currentServerSeq: '24',
        expectedSourceSeq: '17', activeImportId: 'import-1', request: privateText, token: privateText, message: privateText } });
    const metadata = remoteSyncErrorMetadata(error);
    expect(metadata).toEqual({ code: 47025, httpStatus: 409, reason: 'RESYNC_REQUIRED', reasonDetail: 'GAP', requestId,
      validation: null, errorType: 'Error', expectedSourceSeq: '17', currentSourceSeq: '16', currentServerSeq: '24', activeImportId: 'import-1' });
    expect(JSON.stringify(metadata)).not.toContain(privateText);
    expect(remoteSyncErrorMetadata(new Error('Remote ACK outside durable local bounds')).validation)
      .toBe('Remote ACK outside durable local bounds');
    expect(remoteSyncErrorMetadata({ message: privateText, name: privateText, code: -1, httpStatus: Infinity,
      requestId: privateText, data: { requestId, reason: 'R'.repeat(81), reasonDetail: privateText, currentSourceSeq: privateText } }))
      .toMatchObject({ code: null, httpStatus: null, validation: null, requestId, reason: null, reasonDetail: null, currentSourceSeq: null, errorType: 'Error' });
  });

  it('summarizes ACK results without serializing arbitrary response data', () => {
    expect(remoteSyncResultMetadata({ sessionId: 'session', deviceId: 'desktop', importId: 'import', batchId: 'batch',
      state: 'committed', stateVersion: '2', committedSourceSeq: '17', committedSeq: '24', body: privateText, token: privateText }))
      .toEqual({ sessionId: 'session', deviceId: 'desktop', importId: 'import', batchId: 'batch', state: 'committed',
        stateVersion: '2', committedSourceSeq: '17', committedSeq: '24' });
    expect(remoteSyncResultMetadata({ sessionId: privateText, state: privateText, committedSeq: '9'.repeat(20) }))
      .toMatchObject({ sessionId: null, state: null, committedSeq: null });
  });
});

describe('safe authenticated transport diagnostics', () => {
  it('retains a finite local reason hidden by the authenticated wrapper without logging its message or cause', () => {
    const cause = new RemoteNetworkError(RemoteNetworkFailure.AdmissionBusy);
    Object.assign(cause, { stack: privateText, url: privateText, token: privateText });
    const error = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, privateText,
      { failureKind: AuthRefreshFailureKind.Network, originalError: cause });
    const metadata = remoteSyncErrorMetadata(error);
    expect(metadata).toMatchObject({ errorType: 'AuthSessionRequestError', authStatus: AuthSessionStatus.TemporarilyUnavailable,
      authFailureKind: AuthRefreshFailureKind.Network, transportFailure: RemoteNetworkFailure.AdmissionBusy, transportErrorType: 'RemoteNetworkError' });
    expect(JSON.stringify(metadata)).not.toContain(privateText);
    expect(metadata).not.toHaveProperty('originalError'); expect(metadata).not.toHaveProperty('stack');
  });
  it('reports only known native error codes and never prints unknown nested properties', () => {
    const cause = Object.assign(new TypeError(privateText), { cause: { code: 'ENOTFOUND', hostname: privateText } });
    const error = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, privateText,
      { failureKind: AuthRefreshFailureKind.Network, originalError: cause });
    expect(remoteSyncErrorMetadata(error)).toMatchObject({ transportSystemCode: 'ENOTFOUND', transportErrorType: 'TypeError' });
    cause.cause.code = privateText;
    expect(remoteSyncErrorMetadata(error)).not.toHaveProperty('transportSystemCode');
    expect(JSON.stringify(remoteSyncErrorMetadata(error))).not.toContain(privateText);
  });
});


describe('local input diagnostics', () => {
  it('allows finite input stages and reasons without admitting raw errors, paths or credentials', () => {
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, { preparationId: 'prep', assetId: 'asset', transportRequestId: requestId,
      stage: 'validate', result: 'failed', reason: RemoteInputDiagnostic.HashMismatch, actualBytes: 5, expectedBytes: 5, elapsedMs: 17,
      path: privateText, claimToken: privateText, body: privateText, sha256: privateText, arbitrary: privateText });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: RemoteInputDiagnostic.Event, preparationId: 'prep', assetId: 'asset', transportRequestId: requestId,
      stage: 'validate', result: 'failed', reason: RemoteInputDiagnostic.HashMismatch, actualBytes: 5, expectedBytes: 5, elapsedMs: 17 });
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, { preparationId: privateText, assetId: privateText, transportRequestId: 'arbitrary-id',
      stage: privateText, reason: privateText, error: new Error(privateText), actualBytes: -1, expectedBytes: Infinity });
    expect(logged[1]).not.toHaveProperty('preparationId'); expect(logged[1]).not.toHaveProperty('assetId');
    expect(logged[1]).not.toHaveProperty('stage'); expect(logged[1]).not.toHaveProperty('reason');
    expect(logged[1]).not.toHaveProperty('transportRequestId'); expect(logged[1]).not.toHaveProperty('actualBytes');
    expect(JSON.stringify(logged)).not.toContain(privateText);
  });
  it('does not suppress failures for a different preparation, asset or stage', () => {
    const fields = { preparationId: 'dedup-prep', assetId: 'dedup-asset', stage: 'download', result: 'failed', reason: 'REQUEST_FAILED' };
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, fields, 'warn');
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, fields, 'warn');
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, { ...fields, preparationId: 'dedup-other-prep' }, 'warn');
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, { ...fields, assetId: 'dedup-other-asset' }, 'warn');
    remoteDiagnosticLog(RemoteInputDiagnostic.Event, { ...fields, stage: 'decode' }, 'warn');
    expect(logged).toHaveLength(4);
  });
});
