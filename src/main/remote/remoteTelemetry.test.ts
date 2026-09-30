import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { RemoteTelemetryEvent as E, remoteTelemetryHasRequired, RemoteTelemetryResult as R, sanitizeRemoteTelemetryFields } from '../../shared/remote/telemetry';
import { RemoteTelemetry, type RemoteTelemetryContext } from './remoteTelemetry';

const context: RemoteTelemetryContext = { epoch: 'owner-a|personal|test', enabled: true, installationId: 'installation-a',
  appVersion: '1.2.3', environment: 'test', userId: 'user-a', identityNamespace: 'yid', remoteOwnerId: 'server-a',
  ownerScopeId: 'personal', scopeKind: 'personal', deviceId: 'device-a', platform: 'darwin' };
const connection = (index = 1) => ({ fromState: 'offline', toState: 'online', reason: 'STATE_CHANGED',
  connectionAttemptId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
const request = { requestFamily: 'remote_json', operation: 'sync_state', method: 'GET', lane: 'history' };
const temporary: string[] = [];
const reporters: RemoteTelemetry[] = [];
const create = (overrides: Partial<ConstructorParameters<typeof RemoteTelemetry>[0]> = {}) => {
  let now = 100000;
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const instance = new RemoteTelemetry({ context, fetch, now: () => now, monotonicNow: () => now, random: () => 0, autoStart: false, ...overrides });
  reporters.push(instance);
  return { instance, fetch, advance: (ms: number) => { now += ms; }, now: () => now };
};
afterEach(async () => { await Promise.all(reporters.splice(0).map(x => x.shutdown())); for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); vi.useRealTimers(); });

function query(fetch: ReturnType<typeof vi.fn>, index = 0): URLSearchParams { return new URL(fetch.mock.calls[index][0]).searchParams; }

describe('remote telemetry isolation and privacy', () => {
  test('strict allowlist discards content, raw error, credentials and nonfinite data', () => {
    expect(sanitizeRemoteTelemetryFields({ operation: 'sync_state', requestId: 'not-a-uuid', reason: 'my secret',
      message: 'prompt', error: new Error('token-secret'), durationMs: Infinity, requestBytes: -1, ownerScopeId: 'enterprise:42',
      writerGeneration: '00000000-0000-4000-8000-000000000001', httpStatus: null, content: 'private' })).toEqual({
      operation: 'sync_state', owner_scope_id: 'enterprise:42', writer_generation: '00000000-0000-4000-8000-000000000001' });
  });
  test('actual approval and question command types satisfy lifecycle contracts', () => {
    for (const commandType of ['approval_response', 'question_response']) {
      const fields = sanitizeRemoteTelemetryFields({ commandId: 'command', commandType, phase: 'prepared', persistOutcome: 'committed' });
      expect(fields.command_type).toBe(commandType); expect(remoteTelemetryHasRequired(E.CommandPrepared, fields)).toBe(true);
    }
  });
  test('old capture and queued events cannot migrate after an account switch', async () => {
    const { instance, fetch } = create(); const old = instance.capture(); old.emit(E.Connection, connection());
    instance.updateContext({ ...context, epoch: 'owner-b', userId: 'user-b', remoteOwnerId: 'server-b' });
    old.emit(E.Connection, connection(2));
    expect(instance.snapshot().queued).toBe(0);
    instance.capture().emit(E.Connection, connection(3)); await instance.pump();
    expect(query(fetch).get('user_id')).toBe('user-b');
    expect(query(fetch).get('remote_owner_id')).toBe('server-b');
  });
  test('trusted owner mismatch drops before counting requests or messages', () => {
    const { instance } = create();
    const old = instance.capture({ remoteOwnerId: 'other-owner' }); old.request(request).finish(R.Preflight);
    old.emit(E.FinalPersisted, { localSessionId: 'session', writeKind: 'final', persistOutcome: 'committed' });
    expect(instance.snapshot().windows).toBe(0); expect(instance.snapshot().queued).toBe(0);
  });
  test('mismatched finish cannot change frozen identity or count a result', async () => {
    const { instance, fetch, advance } = create(); const t = instance.capture().request(request);
    t.finish(R.ApiOk, { remoteOwnerId: 'other-owner' }); advance(60000); instance.flushWindows(); await instance.pump();
    expect(query(fetch).get('api_ok')).toBe('0'); expect(query(fetch).get('inflight_end')).toBe('1');
  });
  test('local admission remains deferred even if its caller entered the transport wrapper', async () => {
    const { instance, fetch } = create(); const t = instance.capture().request(request); t.transportStarted();
    t.finish(R.Deferred, { failureStage: 'transport', transportFailure: 'REMOTE_NETWORK_ADMISSION_BUSY', httpStatus: null }); await instance.pump();
    expect(query(fetch).get('failure_stage')).toBe('local_admission'); expect(query(fetch).get('http_status')).toBeNull();
  });
  test('disabled telemetry collects nothing and reenable does not resurrect a capture', () => {
    const { instance } = create(); const old = instance.capture();
    instance.updateContext({ ...context, enabled: false }); old.emit(E.Connection, connection());
    instance.capture().request(request).finish(R.Transport); expect(instance.snapshot().queued).toBe(0);
    instance.updateContext(context); old.emit(E.Connection, connection()); expect(instance.snapshot().queued).toBe(0);
  });
  test('optout aborts in-flight upload and clears pending work', async () => {
    let signal: AbortSignal | undefined;
    const { instance } = create({ fetch: (_url, value) => { signal = value; return new Promise(() => undefined); } });
    instance.capture().emit(E.Connection, connection()); const pumping = instance.pump();
    instance.updateContext({ ...context, enabled: false }); await pumping;
    expect(signal?.aborted).toBe(true); expect(instance.snapshot().queued).toBe(0);
  });
  test('failed sender cannot throw into business code or recursively grow the queue', async () => {
    const { instance } = create({ fetch: async () => { throw new Error('token and path'); } });
    expect(() => instance.capture().emit(E.Connection, connection())).not.toThrow(); await instance.pump();
    expect(instance.snapshot().queued).toBe(1); expect(instance.snapshot().stats.upload_failed).toBe(1);
  });
  test('retries keep occurrence ID, account, time and payload when metadata updates', async () => {
    const { instance, fetch, advance } = create(); fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    instance.capture().emit(E.Connection, connection()); await instance.pump();
    instance.updateContext({ ...context, appVersion: '2.0.0' }); advance(5000); await instance.pump();
    expect(fetch.mock.calls[0][0]).toBe(fetch.mock.calls[1][0]); expect(query(fetch).get('app_version')).toBe('1.2.3');
  });
  test('cannot bypass a valid Retry-After; permanent HTTP rejection is not retried', async () => {
    const { instance, fetch, advance } = create(); fetch.mockResolvedValueOnce({ ok: false, status: 429, retryAfter: '120' });
    instance.capture().emit(E.Connection, connection()); await instance.pump(); advance(60000); await instance.pump();
    expect(fetch).toHaveBeenCalledTimes(1); advance(60000); fetch.mockResolvedValueOnce({ ok: false, status: 403 }); await instance.pump();
    expect(instance.snapshot().queued).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('caps memory under critical floods and keeps the final encoded URL bounded', async () => {
    const { instance, fetch } = create(); for (let n = 1; n <= 1200; n++) instance.capture().emit(E.Connection, connection(n));
    expect(instance.snapshot().queued).toBeLessThanOrEqual(1024); expect(instance.snapshot().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(instance.snapshot().stats.critical_dropped).toBeGreaterThan(0);
    await instance.pump(); expect(Buffer.byteLength(fetch.mock.calls[0][0])).toBeLessThanOrEqual(2048);
  });
  test('finite group overflow does not recurse or allocate unbounded maps', () => {
    const { instance } = create();
    for (let n = 0; n < 700; n++) instance.capture().emit(E.Quarantined, { localSessionId: `session-${n}`, failureScope: 'session', reason: 'RECORD_INVALID', phase: 'isolated' });
    expect(instance.snapshot().groups).toBeLessThanOrEqual(512); expect(instance.snapshot().stats.overflow).toBeGreaterThan(0);
  });
});

describe('remote telemetry counters and delivery', () => {
  test('request windows conserve attempts spanning windows and ignore duplicate finish', async () => {
    const { instance, fetch, advance } = create(); const tracker = instance.capture().request(request); tracker.transportStarted();
    advance(60000); instance.flushWindows(); await instance.pump();
    const first = query(fetch); expect(first.get('attempt_started')).toBe('1'); expect(first.get('inflight_start')).toBe('0'); expect(first.get('inflight_end')).toBe('1');
    tracker.finish(R.ApiOk); tracker.finish(R.Transport); advance(60000); instance.flushWindows();
    for (let i = 0; i < 3; i++) { await instance.pump(); advance(3000); }
    const windows = fetch.mock.calls.map(([url]) => new URL(url).searchParams).filter(q => q.get('summary_kind') === 'request_window');
    const last = windows.at(-1)!; expect(last.get('attempt_started')).toBe('0'); expect(last.get('inflight_start')).toBe('1');
    expect(last.get('api_ok')).toBe('1'); expect(last.get('transport_failed')).toBe('0'); expect(last.get('inflight_end')).toBe('0');
  });
  test('file phases remain separate and streaming persistence only contributes counters', async () => {
    const { instance, fetch, advance } = create(); const captured = instance.capture();
    for (const phase of ['download', 'validate', 'write']) captured.emit(E.File, { phase, direction: 'input_download', outcome: 'succeeded', assetId: 'asset' });
    captured.emit(E.MessagePersisted, { localSessionId: 's', writeKind: 'stream', persistOutcome: 'committed' });
    expect(instance.snapshot().queued).toBe(0); advance(60000); instance.flushWindows();
    for (let i = 0; i < 4; i++) { await instance.pump(); advance(3000); }
    const phases = fetch.mock.calls.map(([url]) => new URL(url).searchParams).filter(q => q.get('summary_kind') === 'file_window').map(q => q.get('phase'));
    expect(phases.sort()).toEqual(['download', 'validate', 'write']);
  });
  test('windows distinguish operation kinds and retain only measured quantities', async () => {
    const { instance, fetch, advance } = create(); const captured = instance.capture();
    captured.emit(E.SyncStage, { operationKind: 'catalog', stage: 'validate', outcome: 'completed', recordCount: 3 });
    captured.emit(E.SyncStage, { operationKind: 'catalog', stage: 'validate', outcome: 'completed', recordCount: 4 });
    captured.emit(E.SyncStage, { operationKind: 'projection', stage: 'validate', outcome: 'completed' });
    captured.emit(E.File, { operationKind: 'file_asset', direction: 'input_download', phase: 'download', outcome: 'succeeded', responseBytes: 150, attachmentCount: 1 });
    captured.request(request).finish(R.ApiOk, { requestBytes: 12, responseBytes: 18 });
    advance(60000); instance.flushWindows();
    for (let i = 0; i < 6; i++) { await instance.pump(); advance(3000); }
    const rows = fetch.mock.calls.map(([url]) => new URL(url).searchParams);
    const catalog = rows.find(row => row.get('operation_kind') === 'catalog')!;
    expect(catalog.get('completed')).toBe('2'); expect(catalog.get('record_count')).toBe('7');
    expect(rows.find(row => row.get('operation_kind') === 'projection')!.get('record_count')).toBeNull();
    const file = rows.find(row => row.get('summary_kind') === 'file_window')!;
    expect(file.get('response_bytes')).toBe('150'); expect(file.get('attachment_count')).toBe('1'); expect(file.get('request_bytes')).toBeNull();
    const http = rows.find(row => row.get('summary_kind') === 'request_window')!;
    expect(http.get('request_bytes')).toBe('12'); expect(http.get('response_bytes')).toBe('18');
  });
  test('distinct preflight and API rejections do not suppress each other', async () => {
    const { instance, fetch } = create(); const captured = instance.capture();
    captured.request(request).finish(R.Preflight, { failureStage: 'before_send' });
    captured.request(request).finish(R.Rejected, { failureStage: 'api', httpStatus: 200, businessCode: 403 });
    expect(instance.snapshot().queued).toBe(2); await instance.pump(); await instance.pump();
    expect(query(fetch).get('result')).toBe(R.Preflight); expect(query(fetch, 1).get('business_code')).toBe('403');
  });
  test('summary gets service under a continuous critical flood', async () => {
    const { instance, fetch, advance } = create();
    for (let n = 1; n < 1100; n++) instance.capture().emit(E.Connection, connection(n));
    instance.capture().request(request).finish(R.ApiOk); advance(60000); instance.flushWindows();
    for (let i = 0; i < 7; i++) { await instance.pump(); advance(3000); }
    expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('summary_kind') === 'request_window')).toBe(true);
  });
  test('a valid but rejected publication receipt remains unsampled and counts rejected', async () => {
    const { instance, fetch, advance } = create();
    instance.capture().emit(E.Acknowledged, { operationId: 'publication', publicationKind: 'live', lane: 'live',
      phase: 'acknowledged', outcome: 'completed', businessStatus: 'rejected', representation: 'desktop_only' });
    expect(instance.snapshot().queued).toBe(1); await instance.pump();
    expect(query(fetch).get('sample_probability')).toBe('1'); advance(60000); instance.flushWindows(); await instance.pump();
    const summary = query(fetch, 1); expect(summary.get('summary_kind')).toBe('publication_window');
    expect(summary.get('rejected')).toBe('1'); expect(summary.get('completed')).toBeNull();
    expect(summary.get('representation')).toBe('desktop_only');
  });
  test('TTL expires unsent data instead of retrying it indefinitely', async () => {
    const { instance, fetch, advance } = create(); instance.capture().emit(E.Connection, connection());
    advance(86400001); await instance.pump();
    expect(fetch).not.toHaveBeenCalled(); expect(instance.snapshot().queued).toBe(0); expect(instance.snapshot().stats.expired).toBe(1);
  });
  test('retry budget and circuit share the global request rate', async () => {
    const { instance, fetch, advance } = create(); fetch.mockResolvedValue({ ok: false, status: 503 });
    instance.capture().emit(E.Connection, connection());
    for (const wait of [0, 5000, 30000, 300000, 600000, 1800000]) { advance(wait); await instance.pump(); }
    expect(fetch).toHaveBeenCalledTimes(6); expect(instance.snapshot().queued).toBe(0);
  });
  test('four immediate sends exhaust the burst allowance across repeated pump calls', async () => {
    const { instance, fetch, advance } = create();
    for (let n = 1; n <= 10; n++) instance.capture().emit(E.Connection, connection(n));
    for (let n = 0; n < 10; n++) await instance.pump(); expect(fetch).toHaveBeenCalledTimes(4);
    advance(3000); await instance.pump(); expect(fetch).toHaveBeenCalledTimes(5);
  });
  test('telemetry health is finite while idle and never recurses on failure', async () => {
    const { instance, fetch, advance } = create(); advance(300000); instance.tick(); await instance.pump();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledTimes(1); expect(query(fetch).get('summary_kind')).toBe('telemetry_health');
    expect(query(fetch).get('coverage')).toBe('partial');
  });
  test('unknown target startup cannot erase a verified-target offline cache', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-telemetry-target-')); temporary.push(directory);
    const a = create({ directory }); a.instance.capture().emit(E.Connection, connection()); await a.instance.shutdown();
    const filename = path.join(directory, 'segment-00.jsonl'); const original = await fs.readFile(filename, 'utf8');
    const b = create({ directory, context: { ...context, epoch: 'startup-target-unknown', contextReady: false } });
    b.instance.capture().emit(E.Connection, connection(2));
    await new Promise<void>(resolve => setTimeout(resolve, 10)); expect(await fs.readFile(filename, 'utf8')).toBe(original);
    b.instance.updateContext({ ...context, contextReady: true });
    for (let n = 0; n < 60 && !b.instance.snapshot().queued; n++) await new Promise<void>(resolve => setTimeout(resolve, 2));
    await b.instance.pump(); expect(query(b.fetch).get('eventId')).toBe(JSON.parse(original.trim()).eventId);
  });
  test('optout erases cached data even if the target is not ready', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-telemetry-consent-')); temporary.push(directory);
    const a = create({ directory }); a.instance.capture().emit(E.Connection, connection()); await a.instance.shutdown();
    const b = create({ directory, context: { ...context, epoch: 'unknown', contextReady: false, enabled: false } });
    await b.instance.shutdown(); expect((await fs.readdir(directory)).filter(name => name.endsWith('.jsonl'))).toEqual([]);
  });
  test('offline cache replays same immutable event across app versions and skips corrupt lines', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-telemetry-test-')); temporary.push(directory);
    const a = create({ directory, fetch: async () => ({ ok: false, status: 503 }) });
    await new Promise<void>(resolve => setImmediate(resolve));
    a.instance.capture().emit(E.Connection, connection()); await a.instance.shutdown();
    const original = JSON.parse((await fs.readFile(path.join(directory, 'segment-00.jsonl'), 'utf8')).trim());
    await fs.appendFile(path.join(directory, 'segment-00.jsonl'), '{broken\n');
    const b = create({ directory, context: { ...context, appVersion: '9.0.0' } });
    for (let n = 0; n < 60 && !b.instance.snapshot().queued; n++) await new Promise<void>(resolve => setTimeout(resolve, 2));
    await b.instance.pump(); expect(query(b.fetch).get('eventId')).toBe(original.eventId);
    expect(query(b.fetch).get('app_version')).toBe('1.2.3'); expect(query(b.fetch).get('uts')).toBe(String(original.createdAt));
  });
});


test('a file failure flood cannot starve a queued control event in the same priority', async () => {
  const { instance, fetch, advance } = create();
  for (let n = 0; n < 100; n++) instance.capture().emit(E.Quarantined, { lane: 'files', localSessionId: `s-${n}`,
    failureScope: 'session', reason: 'RECORD_INVALID', phase: 'isolated' });
  instance.capture().emit(E.Connection, { ...connection(), lane: 'control' });
  for (let n = 0; n < 3; n++) { await instance.pump(); advance(3000); }
  expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('event_name') === E.Connection)).toBe(true);
});
