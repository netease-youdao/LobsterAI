import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthRefreshFailureKind, AuthSessionStatus } from '../../shared/auth/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteInputReason } from '../../shared/remote/input';
import { RemoteTelemetryEvent as E, remoteTelemetryHasRequired, sanitizeRemoteTelemetryFields } from '../../shared/remote/telemetry';
import { AuthSessionRequestError } from '../libs/authSessionManager';
import { captureRemoteFileTelemetry, remoteFileRequestBytes, remoteFileRequestFailure, remoteFileRequestFailureFields, remoteFileRequestOperation, RemoteFileTelemetry,remoteFileTelemetryReason } from './remoteFileTelemetry';
import { RemoteNetworkError } from './remoteNetworkError';
import { RemoteNetworkFailure } from './remoteNetworkProtocol';
import { configureRemoteTelemetry, type RemoteTelemetryContext,shutdownRemoteTelemetry } from './remoteTelemetry';

const owner = { userId: 'server-a', scopeKey: 'personal' };
const context: RemoteTelemetryContext = { epoch: 'owner-a-personal-test', enabled: true, installationId: 'installation-a',
  appVersion: '1.2.3', environment: 'test', userId: 'user-a', identityNamespace: 'yid', remoteOwnerId: owner.userId,
  ownerScopeId: owner.scopeKey, scopeKind: 'personal', deviceId: 'device-a' };
afterEach(async () => { await shutdownRemoteTelemetry(); });

describe('remote file telemetry metadata', () => {
  it('only accepts finite reason codes, never arbitrary errors, filenames or tokens', () => {
    expect(remoteFileTelemetryReason(new Error('token=secret /private/report.txt'))).toBe(RemoteFileTelemetry.FileOperation);
    expect(remoteFileTelemetryReason(new Error(RemoteFileReason.Source))).toBe(RemoteFileReason.Source);
    expect(remoteFileTelemetryReason(Object.assign(new Error('/private/file'), { code: 'ENOSPC' }))).toBe(RemoteFileTelemetry.LocalIo);
    expect(remoteFileRequestFailure({ reason: RemoteInputReason.Account })).toBe('context_changed');
  });
  it('uses fixed route names without retaining object IDs or query strings', () => {
    expect(remoteFileRequestOperation('/api/remote/v1/input-assets/private-id/parts/123?token=secret')).toBe('file_part');
    expect(remoteFileRequestOperation('/file-policy?deviceId=private-id')).toBe('file_policy');
    expect(remoteFileRequestOperation('/artifacts/private-id/versions/1/publish')).toBe('file_publish');
  });
});


describe('file telemetry producer contract', () => {
  it('retains required lifecycle metadata for file, preparation, deletion and worker details', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [E.File, { direction: 'artifact_upload', phase: 'retry', outcome: 'deferred', operation_id: 'publication-a', reason: 'FILE_SOURCE_CHANGED', retry_phase: 'waiting_dependency' }],
      [E.File, { direction: 'desktop_input_upload', phase: 'snapshot', outcome: 'succeeded', operation_id: 'upload-a' }],
      [E.Preparation, { direction: 'input_download', phase: 'validate', outcome: 'failed', preparation_id: 'preparation-a', reason: RemoteInputReason.Invalid }],
      [E.SyncStage, { stage: 'local_commit', outcome: 'failed', operation_kind: 'file_publication', reason: 'LOCAL_IO_FAILED' }],
      [E.SyncStage, { stage: 'server_confirmed', outcome: 'succeeded', operation_kind: 'deletion' }],
      [E.WorkerExit, { role: 'network', phase: 'exit', reason: 'WORKER_DISPOSE', worker_instance_id: '00000000-0000-4000-8000-000000000001' }],
    ];
    for (const [event, fields] of cases) {
      const clean = sanitizeRemoteTelemetryFields(fields);
      expect(clean).toEqual(fields);
      expect(remoteTelemetryHasRequired(event, clean)).toBe(true);
    }
  });

  it('accepts real file details under the captured owner and rejects stale owner and epoch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const reporter = configureRemoteTelemetry({ context, fetch, autoStart: false })!;
    const captured = captureRemoteFileTelemetry(owner, { device_id: 'device-a', direction: 'artifact_upload', operation_id: 'publication-a' });
    const failure = { phase: 'retry', outcome: 'deferred', reason: 'FILE_SOURCE_CHANGED' };
    captured.emit(E.File, failure);
    expect(reporter.snapshot().stats.invalid_event ?? 0).toBe(0);
    expect(reporter.snapshot().queued).toBe(1);
    await reporter.pump();
    const params = new URL(fetch.mock.calls[0][0]).searchParams;
    expect(params.get('event_name')).toBe(E.File);
    expect(params.get('remote_owner_id')).toBe(owner.userId);
    expect(params.get('operation_id')).toBe('publication-a');
    expect(params.get('reason')).toBe('FILE_SOURCE_CHANGED');
    reporter.updateContext({ ...context, epoch: 'owner-b', remoteOwnerId: 'server-b' });
    captured.emit(E.File, failure);
    captureRemoteFileTelemetry(owner, { direction: 'artifact_upload', operation_id: 'publication-a' }).emit(E.File, failure);
    expect(reporter.snapshot().queued).toBe(0);
    expect(reporter.snapshot().windows).toBe(0);
  });
});


it('retains finite auth refresh failures and classifies them before remote transport', () => {
  const error = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'private refresh details', { failureKind: AuthRefreshFailureKind.Timeout });
  const result = remoteFileRequestFailure(error);
  expect(result).toBe('preflight_failed');
  const fields = remoteFileRequestFailureFields(result, error);
  expect(fields).toMatchObject({ failure_stage: 'auth', authStatus: AuthSessionStatus.TemporarilyUnavailable, authFailureKind: AuthRefreshFailureKind.Timeout });
  expect(JSON.stringify(fields)).not.toContain('private refresh details');
});
it('preserves a wrapped request transport cause instead of misclassifying it as token refresh', () => {
  const error = new AuthSessionRequestError(AuthSessionStatus.TemporarilyUnavailable, 'private token details', {
    failureKind: AuthRefreshFailureKind.Network, originalError: new RemoteNetworkError(RemoteNetworkFailure.Failed),
  });
  const result = remoteFileRequestFailure(error);
  expect(result).toBe('transport_failed');
  expect(remoteFileRequestFailureFields(result, error)).toMatchObject({ failure_stage: 'transport',
    authStatus: AuthSessionStatus.TemporarilyUnavailable, authFailureKind: AuthRefreshFailureKind.Network,
    transportFailure: RemoteNetworkFailure.Failed, transportErrorType: 'RemoteNetworkError' });
});


it('counts only known request body bytes without retaining content', () => {
  expect(remoteFileRequestBytes('你好')).toBe(6);
  expect(remoteFileRequestBytes(new Uint8Array([1, 2, 3]).buffer)).toBe(3);
  expect(remoteFileRequestBytes(undefined)).toBeUndefined();
});
