import { type ChildProcess, type fork } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionManager, AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteNetworkBodyEncoding, RemoteNetworkFailure, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message } from './remoteNetworkProtocol';
import { RemoteNetworkTransport, remoteResponseJson } from './remoteNetworkTransport';
import { remoteSyncErrorMetadata } from './remoteSyncLog';
import { classifyTaskSyncFailure } from './remoteTaskSyncPolicy';
import * as telemetryApi from './remoteTelemetry';
import { currentRemoteTelemetryRequest, withRemoteTelemetryRequest } from './remoteTelemetryTransport';

class Child extends EventEmitter {
  connected = true;
  pid = 100;
  exitCode: number | null = null;
  signalCode: string | null = null;
  messages: any[] = [];
  autoExit = true;
  kill = vi.fn(() => { if (this.autoExit) queueMicrotask(() => this.exit()); return true; });
  send = vi.fn((message: any, callback: (error: Error | null) => void) => { this.messages.push(message); callback(null); return false; });
  exit(): void { this.connected = false; this.exitCode = 1; this.emit('exit', 1); }
  reply(message: any): void { this.emit('message', message); }
  request(): any { return this.messages.find(message => message.type === Message.Fetch); }
}
const transports: RemoteNetworkTransport[] = [];
const base = 'https://example.com/api/remote/v1';
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture() {
  const children: Child[] = [];
  const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcess; });
  const transport = new RemoteNetworkTransport(spawn as unknown as typeof fork, '/worker.js'); transports.push(transport);
  return { transport, spawn, children };
}
function request(transport: RemoteNetworkTransport, path = '/capabilities', init?: RequestInit) {
  const pending = transport.fetch(base + path, init); void pending.catch(() => {}); return pending;
}
function success(child: Child, id = child.request().id, extra: Record<string, unknown> = {}) {
  child.reply({ type: Message.Result, id, status: 200, headers: {}, body: '{"code":0}', jsonValid: true, json: { code: 0 }, ...extra });
}
beforeEach(() => { vi.spyOn(process, 'kill').mockReturnValue(true); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { transports.splice(0).forEach(transport => transport.dispose()); await settle(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('supervised remote network transport', () => {
  it.each([
    ['/v3/sync/state', 'GET'], ['/v3/sync/recoveries/original', 'GET'], ['/v3/sync/recoveries/original/abort', 'POST'],
    ['/v1/sync/imports/original', 'GET'], ['/v1/sync/imports/original/abort', 'POST'], ['/v3/sync/live-projections/original', 'GET'],
  ])('reserves a control slot for original receipt %s', async (path, method) => {
    const { transport, children } = fixture();
    const background = transport.fetch(base + '/sync/batches', { method: 'POST' });
    const live = [transport.fetch('https://example.com/api/remote/v3/sync/live-projections', { method: 'POST' }),
      transport.fetch('https://example.com/api/remote/v3/sync/live-projections/original/resolve', { method: 'POST' })];
    const receipt = transport.queuedFetch('https://example.com/api/remote' + path, { method });
    await settle();
    const child = children[0], sent = child.messages.filter(message => message.type === Message.Fetch);
    expect(sent).toHaveLength(4); expect(sent.some(message => message.url.endsWith(path))).toBe(true);
    for (const message of sent) success(child,message.id);
    await Promise.all([background,...live,receipt]);
  });
  it('fairly waits for actual background release while reserved controls proceed', async () => {
    const { transport, children } = fixture();
    const first = transport.queuedFetch(base + '/sync/batches');
    const second = transport.queuedFetch(base + '/sync/state');
    const control = transport.queuedFetch(base + '/commands/claim');
    await settle(); const child = children[0];
    expect(child.messages.filter(message => message.type === Message.Fetch)).toHaveLength(2);
    expect(child.messages.some(message => message.url?.endsWith('/sync/state'))).toBe(false);
    success(child, child.messages.find(message => message.url?.endsWith('/commands/claim')).id); await control;
    success(child, child.messages.find(message => message.url?.endsWith('/sync/batches')).id); await first; await settle();
    success(child, child.messages.find(message => message.url?.endsWith('/sync/state')).id); await second;
  });
  it('starts lazily, shares one child and uses child-parsed response JSON for auth clones and bridge', async () => {
    const { transport, spawn, children } = fixture(); expect(spawn).not.toHaveBeenCalled();
    const first = request(transport), second = request(transport, '/sync/batches'); transport.socket('wss://example.com/api/remote/v1/ws');
    await settle(); expect(spawn).toHaveBeenCalledTimes(1);
    const child = children[0]; const requests = child.messages.filter(message => message.type === Message.Fetch);
    expect(requests).toHaveLength(2); expect(child.messages.some(message => message.type === Message.Socket)).toBe(true);
    success(child, requests[0].id, { body: 'not parsed on the main process' }); success(child, requests[1].id);
    const response = await first; expect(await response.clone().json()).toEqual({ code: 0 });
    expect(remoteResponseJson(response, await response.text())).toEqual({ code: 0 }); await second;
    expect(child.kill).not.toHaveBeenCalled(); // send(false) means enqueued backpressure, not failure.
  });
  it('reserves independent control/live/background capacity and retains an aborted slot until acknowledgement', async () => {
    const { transport, children } = fixture(); const abort = new AbortController();
    const background = request(transport, '/sync/batches', { signal: abort.signal }); await settle();
    abort.abort(); await expect(background).rejects.toThrow('REMOTE_NETWORK_CANCELLED');
    await expect(request(transport, '/sync/batches')).rejects.toThrow('ADMISSION_BUSY');
    const rest = [request(transport), request(transport, '/sync/mode-activations'), request(transport, '/devices/register'), request(transport, '/sessions/a'), request(transport, '/sessions/b')];
    await settle(); expect(children[0].messages.filter(message => message.type === Message.Fetch)).toHaveLength(Limit.Requests);
    await expect(request(transport)).rejects.toThrow('ADMISSION_BUSY');
    success(children[0], children[0].request().id); const next = request(transport, '/sync/batches'); await settle();
    for (const message of children[0].messages.filter(message => message.type === Message.Fetch)) success(children[0], message.id);
    await Promise.all([...rest, next]);
  });
  it.each([
    ['/device-connections', 'GET'],
    ['/device-connection-operations/request-1', 'GET'],
    ['/devices/current/connection/remove', 'POST'],
    ['/devices/current/connection/resume', 'POST'],
  ])('keeps device management %s available while sync lanes are full', async (path, method) => {
    const { transport, children } = fixture();
    const sync = [request(transport, '/sync/batches'), request(transport, '/sessions/a'), request(transport, '/sessions/b')];
    const management = transport.fetch(`https://example.com/api/remote/v2${path}`, { method });
    void management.catch(() => {});
    await settle();
    const child = children[0];
    const sent = child.messages.filter(message => message.type === Message.Fetch);
    expect(sent).toHaveLength(4);
    expect(sent.some(message => message.url.endsWith(path) && message.method === method)).toBe(true);
    const controls = [request(transport), request(transport, '/connection-tickets')];
    await settle();
    expect(child.messages.filter(message => message.type === Message.Fetch)).toHaveLength(Limit.Requests);
    await expect(request(transport)).rejects.toThrow(RemoteNetworkFailure.AdmissionBusy);
    for (const message of child.messages.filter(message => message.type === Message.Fetch)) success(child, message.id);
    await Promise.all([...sync, management, ...controls]);
  });
  it('classifies rapid authenticated sync-state admission rejections without losing their original cause', async () => {
    const { transport, children } = fixture();
    const auth = new AuthSessionManager({ getTokens: () => ({ accessToken: 'test-access', refreshToken: 'test-refresh' }),
      saveTokens: () => {}, fetch: async () => { throw new Error('Unexpected token refresh'); }, getRefreshUrl: () => 'https://example.com/auth',
      buildRefreshRequestBody: () => '{}', onTerminalFailure: () => {} });
    const active = auth.fetchWithAuth(base + '/sync/state', undefined, transport.fetch); void active.catch(() => {}); await settle();
    for (let i = 0; i < 12; i++) {
      const error = await auth.fetchWithAuth(base + '/sync/state', undefined, transport.fetch).catch(error => error);
      expect(error).toBeInstanceOf(AuthSessionRequestError); expect(error.message).toBe('Authenticated request failed');
      expect(classifyTaskSyncFailure(error)).toMatchObject({ scope: 'session', reason: RemoteNetworkFailure.AdmissionBusy, deferMs: 500 });
      expect(remoteSyncErrorMetadata(error)).toMatchObject({ transportFailure: RemoteNetworkFailure.AdmissionBusy });
    }
    expect(children[0].messages.filter(message => message.type === Message.Fetch)).toHaveLength(1);
    success(children[0]); await active;
  });
  it('preserves only finite worker error reasons', async () => {
    const { transport, children } = fixture(); const budget = request(transport); await settle();
    children[0].reply({ type: Message.Result, id: children[0].request().id, error: RemoteNetworkFailure.ResponseBudget });
    await expect(budget).rejects.toMatchObject({ code: RemoteNetworkFailure.ResponseBudget });
    const unknown = request(transport); await settle();
    const id = children[0].messages.filter(message => message.type === Message.Fetch).at(-1).id;
    children[0].reply({ type: Message.Result, id, error: 'private body and token' });
    await expect(unknown).rejects.toMatchObject({ code: RemoteNetworkFailure.RequestFailed, message: RemoteNetworkFailure.RequestFailed });
  });
  it('rejects oversized or invalid replies locally without leaking response content', async () => {
    const { transport, children } = fixture(); const pending = request(transport); await settle();
    success(children[0], undefined, { body: 'secret'.repeat(Limit.BodyBytes) });
    await expect(pending).rejects.toThrow('REMOTE_NETWORK_RESPONSE_INVALID');
    const invalid = request(transport); await settle();
    const id = children[0].messages.filter(message => message.type === Message.Fetch).at(-1).id;
    success(children[0], id, { jsonValid: false, body: '{secret' });
    await expect((await invalid).json()).rejects.toThrow('REMOTE_NETWORK_RESPONSE_INVALID');
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret');
  });
  it('rejects all work on child failure and waits for actual process exit before replacement', async () => {
    const { transport, children, spawn } = fixture(); const first = request(transport); const socket = transport.socket('wss://example.com/api/remote/v1/ws');
    const closed = vi.fn(); socket.addEventListener('close', closed); await settle();
    children[0].autoExit = false; children[0].emit('error', new Error('private error'));
    await expect(first).rejects.toThrow('WORKER_EXIT'); expect(closed).toHaveBeenCalledWith({ code: 1006 });
    await expect(request(transport)).rejects.toThrow('WORKER_UNAVAILABLE'); expect(spawn).toHaveBeenCalledTimes(1);
    children[0].exit(); await settle();
    const next = request(transport); await settle(); expect(spawn).toHaveBeenCalledTimes(2);
    success(children[0]); success(children[1]); expect(await (await next).json()).toEqual({ code: 0 });
  });
  it('does not resurrect disposed work while an earlier process is still retiring', async () => {
    const { transport, children, spawn } = fixture(); const original = request(transport); await settle();
    children[0].autoExit = false; children[0].emit('error', new Error()); await expect(original).rejects.toThrow('WORKER_EXIT');
    const obsolete = request(transport); transport.socket('wss://example.com/api/remote/v1/ws');
    transport.dispose(); await expect(obsolete).rejects.toThrow('CANCELLED'); children[0].exit(); await settle();
    expect(spawn).toHaveBeenCalledTimes(1);
    const current = request(transport); await settle(); expect(spawn).toHaveBeenCalledTimes(2); success(children[1]); await current;
  });
  it('returns promptly while exit is unknown and recovers after OS absence without an exit event', async () => {
    vi.useFakeTimers();
    const { transport, children, spawn } = fixture(); const first = request(transport); await settle();
    children[0].autoExit = false;
    children[0].kill.mockImplementation(() => { throw new Error('Kill unavailable'); });
    children[0].emit('error', new Error()); await expect(first).rejects.toThrow('WORKER_EXIT');
    for (let i = 0; i < 10; i++) await expect(request(transport)).rejects.toThrow('WORKER_UNAVAILABLE');
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
    await vi.advanceTimersByTimeAsync(10000);
    await expect(request(transport)).rejects.toThrow('WORKER_UNAVAILABLE'); expect(spawn).toHaveBeenCalledTimes(1);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    await vi.advanceTimersByTimeAsync(1000);
    const next = request(transport); await settle(); expect(spawn).toHaveBeenCalledTimes(2);
    children[0].exit(); // A late old event cannot retire the new child.
    success(children[1]); await next;
  });
  it('releases a cancelled request before IPC dispatch and does not start a worker for an already aborted request', async () => {
    const { transport, children, spawn } = fixture(); const aborted = new AbortController(); aborted.abort();
    await expect(request(transport, '/sync/batches', { signal: aborted.signal })).rejects.toThrow('CANCELLED');
    expect(spawn).not.toHaveBeenCalled();
    const abort = new AbortController(); const cancelled = request(transport, '/sync/batches', { signal: abort.signal });
    abort.abort(); await expect(cancelled).rejects.toThrow('CANCELLED'); await settle();
    expect(children[0].messages.filter(message => message.type === Message.Fetch)).toHaveLength(0);
    const next = request(transport, '/sync/batches'); await settle(); success(children[0]); await next;
  });
  it('keeps streamed downloads in their background slot until confirmed cancellation', async () => {
    const { transport, children } = fixture(), abort = new AbortController();
    const downloading = request(transport, '/input-assets/asset-1/content', { signal: abort.signal }); await settle();
    const child = children[0], id = child.request().id;
    child.reply({ type: Message.StreamStart, id, status: 200, headers: { 'content-type': 'image/png' } });
    const response = await downloading, reader = response.body!.getReader();
    expect(child.messages.filter(message => message.type === Message.StreamPull)).toHaveLength(0);
    const first = reader.read(); await settle();
    child.reply({ type: Message.StreamChunk, id, seq: 0, body: Buffer.from([137,80,78,71]).toString('base64') });
    expect((await first).value).toEqual(Buffer.from([137,80,78,71]));
    expect(child.messages.filter(message => message.type === Message.StreamPull)).toHaveLength(1);
    const next = reader.read(); abort.abort(); await expect(next).rejects.toThrow('CANCELLED');
    expect(child.messages.some(message => message.type === Message.Cancel && message.id === id)).toBe(true);
    await expect(request(transport, '/sync/batches')).rejects.toThrow('ADMISSION_BUSY');
    child.reply({ type: Message.Result, id, error: RemoteNetworkFailure.Cancelled });
    const normal = request(transport, '/sync/batches'); await settle();
    success(child, child.messages.filter(message => message.type === Message.Fetch).at(-1).id); await normal;
  });
  it.each(['renew', 'result'] as const)('keeps preparation %s independent from its active binary download', async operation => {
    const { transport, children } = fixture();
    const downloading = request(transport, '/input-assets/asset-1/content'); await settle();
    const child = children[0], id = child.request().id;
    child.reply({ type: Message.StreamStart, id, status: 200, headers: {} });
    const response = await downloading;
    const queued = transport.queuedFetch(base + '/sync/batches');
    const control = request(transport, `/input-preparations/prep-1/${operation}`, { method: 'POST' }); await settle();
    expect(child.messages.filter(message => message.type === Message.Fetch)).toHaveLength(2);
    const renewal = child.messages.find(message => message.url?.endsWith(`/${operation}`));
    expect(renewal).toBeDefined(); success(child, renewal.id); await control;
    await response.body!.cancel(); child.reply({ type: Message.Result, id, error: RemoteNetworkFailure.Cancelled }); await settle();
    success(child, child.messages.filter(message => message.type === Message.Fetch).at(-1).id); await queued;
  });
  it('rejects legacy text-encoded binary success while preserving JSON authorization errors', async () => {
    const { transport, children } = fixture();
    const downloading = request(transport, '/input-assets/asset-1/content'); await settle();
    const child = children[0]; success(child, undefined, { body: 'corrupted binary', jsonValid: false });
    await expect(downloading).rejects.toThrow('RESPONSE_INVALID');
    const denied = request(transport, '/input-assets/asset-1/content'); await settle();
    success(child, child.messages.filter(message => message.type === Message.Fetch).at(-1).id, { status: 401, json: { code: 40100 } });
    const response = await denied;
    expect(response.status).toBe(401); expect(await response.clone().json()).toEqual({ code: 40100 });
  });
  it('errors an already returned download body when the child exits', async () => {
    const { transport, children } = fixture();
    const downloading = request(transport, '/input-assets/asset-1/content'); await settle();
    const child = children[0], id = child.request().id;
    child.reply({ type: Message.StreamStart, id, status: 200, headers: {} });
    const reader = (await downloading).body!.getReader(), next = reader.read();
    child.exit(); await expect(next).rejects.toThrow('WORKER_EXIT');
  });
  it.each(['unsolicited', 'oversized', 'invalid-base64', 'wrong-sequence'] as const)('rejects invalid streamed chunks: %s', async failure => {
    const { transport, children } = fixture();
    const downloading = request(transport, '/input-assets/asset-1/content'); await settle();
    const child = children[0], id = child.request().id;
    child.reply({ type: Message.StreamStart, id, status: 200, headers: {} });
    const reader = (await downloading).body!.getReader();
    const read = failure === 'unsolicited' ? undefined : reader.read(); await settle();
    child.reply({ type: Message.StreamChunk, id, seq: failure === 'wrong-sequence' ? 1 : 0,
      body: failure === 'oversized' ? Buffer.alloc(Limit.BinaryChunkBytes + 1).toString('base64') : failure === 'invalid-base64' ? '!!!' : 'YQ==' });
    await expect(read || reader.read()).rejects.toThrow('RESPONSE_INVALID');
    expect(child.messages.some(message => message.type === Message.Cancel)).toBe(true);
  });
  it('rejects binary start on a non-download route and releases cancellation at an EOF race', async () => {
    const { transport, children } = fixture();
    const wrongRoute = request(transport); await settle();
    const child = children[0], wrongId = child.request().id;
    child.reply({ type: Message.StreamStart, id: wrongId, status: 200, headers: {} });
    await expect(wrongRoute).rejects.toThrow('RESPONSE_INVALID');
    child.reply({ type: Message.Result, id: wrongId, error: RemoteNetworkFailure.Cancelled });
    const downloading = request(transport, '/input-assets/asset-1/content'); await settle();
    const id = child.messages.filter(message => message.type === Message.Fetch).at(-1).id;
    child.reply({ type: Message.StreamStart, id, status: 200, headers: {} });
    await (await downloading).body!.cancel();
    child.reply({ type: Message.StreamEnd, id, bytes: 0 });
    const next = request(transport, '/sync/batches'); await settle();
    success(child, child.messages.filter(message => message.type === Message.Fetch).at(-1).id); await next;
  });
  it('fences replaced sockets and acknowledges only current parsed frames', async () => {
    const { transport, children } = fixture(); const first = transport.socket('wss://example.com/api/remote/v1/ws');
    const oldMessage = vi.fn(); first.addEventListener('message', oldMessage); await settle();
    const child = children[0], oldId = child.messages.find(message => message.type === Message.Socket).id;
    const current = transport.socket('wss://example.com/api/remote/v1/ws'); const message = vi.fn(); current.addEventListener('message', message); await settle();
    const id = child.messages.filter(value => value.type === Message.Socket).at(-1).id;
    child.reply({ type: Message.Frame, id: oldId, seq: 1, frame: { type: 'command' } });
    child.reply({ type: Message.SocketOpened, id }); child.reply({ type: Message.Frame, id, seq: 2, frame: { type: 'pong' } });
    expect(oldMessage).not.toHaveBeenCalled(); expect(message).toHaveBeenCalledWith({ data: '', parsedFrame: { type: 'pong' } });
    expect(child.messages.filter(value => value.type === Message.FrameAck)).toEqual([{ type: Message.FrameAck, id, seq: 2 }]);
  });
  it('kills an unresponsive child and enforces the restart budget', async () => {
    vi.useFakeTimers(); const { transport, children, spawn } = fixture(); const hung = request(transport); await settle();
    await vi.advanceTimersByTimeAsync(9000); await expect(hung).rejects.toThrow('WORKER_EXIT'); expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    for (let i = 0; i < 4; i++) { const next = request(transport); await settle(); children.at(-1)!.exit(); await expect(next).rejects.toThrow('WORKER_EXIT'); }
    await expect(request(transport)).rejects.toThrow(RemoteNetworkFailure.RestartBudget); expect(spawn).toHaveBeenCalledTimes(5);
  });
  it('retires a worker that exceeds the observed memory budget and can recover later', async () => {
    const { transport, children } = fixture(); const pending = request(transport); await settle();
    children[0].reply({ type: Message.Alive, rss: 193 * 1024 * 1024 }); await expect(pending).rejects.toThrow('WORKER_EXIT');
    await settle(); const next = request(transport); await settle(); success(children[1]); await next;
  });
});

it('distinguishes spawn from readiness and intentional disposal from a worker crash', async () => {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  vi.spyOn(telemetryApi, 'captureRemoteTelemetry').mockImplementation((base = {}) => ({
    emit: (event, fields = {}) => { events.push({ event, fields: { ...base, ...fields } }); },
    request: () => ({ logicalAttemptId: 'attempt', transportStarted: () => undefined, finish: () => undefined }),
  }));
  const { transport, children } = fixture();
  const pending = request(transport); await settle();
  expect(events.filter(item => item.fields.phase === 'ready')).toHaveLength(0);
  children[0].reply({ type: Message.Alive, rss: 1024 });
  children[0].reply({ type: Message.Alive, rss: 1024 });
  expect(events.filter(item => item.fields.phase === 'ready')).toHaveLength(1);
  success(children[0]); await pending;
  transport.dispose(); await settle();
  expect(events.filter(item => item.event === 'remote.worker.exit')).toEqual([
    expect.objectContaining({ fields: expect.objectContaining({ reason: 'WORKER_DISPOSE', outcome: 'cancelled' }) }),
  ]);
  expect(new Set(events.map(item => item.fields.worker_instance_id)).size).toBe(1);
});

it('counts only worker-confirmed physical sends, including authenticated retransmission', async () => {
  const { transport, children } = fixture();
  const tracker = { logicalAttemptId: 'attempt', transportStarted: vi.fn(), finish: vi.fn() };
  let accessToken = 'first-access';
  const auth = new AuthSessionManager({ getTokens: () => ({ accessToken, refreshToken: 'test-refresh' }),
    saveTokens: () => {}, fetch: async () => { throw new Error('Unexpected refresh'); }, getRefreshUrl: () => 'https://example.com/auth',
    buildRefreshRequestBody: () => '{}', onTerminalFailure: () => {} });
  const pending = withRemoteTelemetryRequest(tracker, () => auth.fetchWithAuth(base + '/capabilities', undefined, transport.fetch));
  await settle();
  const child = children[0], firstId = child.request().id;
  expect(tracker.transportStarted).not.toHaveBeenCalled();
  child.reply({ type: Message.FetchStarted, id: 'unknown' });
  child.reply({ type: Message.FetchStarted, id: firstId });
  child.reply({ type: Message.FetchStarted, id: firstId });
  expect(tracker.transportStarted).toHaveBeenCalledTimes(1);
  accessToken = 'replacement-access';
  success(child, firstId, { status: 401 }); await settle();
  const second = child.messages.filter(message => message.type === Message.Fetch).at(-1);
  expect(second.id).not.toBe(firstId);
  expect(tracker.transportStarted).toHaveBeenCalledTimes(1);
  child.reply({ type: Message.FetchStarted, id: second.id }); success(child, second.id);
  await pending; expect(tracker.transportStarted).toHaveBeenCalledTimes(2);
  expect(tracker.finish).not.toHaveBeenCalled();
});

it('does not count admission rejection or missing authentication as a physical send', async () => {
  const { transport, children } = fixture();
  const tracker = { logicalAttemptId: 'attempt', transportStarted: vi.fn(), finish: vi.fn() };
  const active = request(transport, '/sync/state'); await settle();
  await expect(withRemoteTelemetryRequest(tracker, () => transport.fetch(base + '/sync/state'))).rejects.toThrow('ADMISSION_BUSY');
  const auth = new AuthSessionManager({ getTokens: () => null, saveTokens: () => {},
    fetch: async () => { throw new Error('Unexpected refresh'); }, getRefreshUrl: () => 'https://example.com/auth',
    buildRefreshRequestBody: () => '{}', onTerminalFailure: () => {} });
  await expect(withRemoteTelemetryRequest(tracker, () => auth.fetchWithAuth(base + '/capabilities', undefined, transport.fetch))).rejects.toThrow('No auth tokens');
  expect(tracker.transportStarted).not.toHaveBeenCalled();
  success(children[0]); await active;
});

it('rejects oversized queued headers and URLs before worker admission', async () => {
  const { transport, children } = fixture();
  await expect(transport.queuedFetch(base + '/capabilities', { headers: { test: 'x'.repeat(20000) } })).rejects.toThrow('REQUEST_BUDGET');
  await expect(transport.queuedFetch(base + '/' + 'x'.repeat(20000))).rejects.toThrow('REQUEST_BUDGET');
  await expect(transport.queuedFetch(base + '/capabilities', { body: new Blob(['x']) })).rejects.toThrow('REQUEST_INVALID');
  expect(children).toHaveLength(0);
});

it('keeps simultaneous logical request contexts separate and telemetry callbacks cannot reject requests', async () => {
  const { transport, children } = fixture();
  const first = { logicalAttemptId: 'first', transportStarted: vi.fn(() => { throw new Error('telemetry failed'); }), finish: vi.fn() };
  const second = { logicalAttemptId: 'second', transportStarted: vi.fn(), finish: vi.fn() };
  const a = withRemoteTelemetryRequest(first, () => request(transport, '/capabilities'));
  const b = withRemoteTelemetryRequest(second, async () => { await Promise.resolve(); return request(transport, '/sessions/a'); });
  await settle();
  const child = children[0], sent = child.messages.filter(message => message.type === Message.Fetch);
  for (const item of sent) { child.reply({ type: Message.FetchStarted, id: item.id }); success(child, item.id); }
  await Promise.all([a, b]);
  expect(first.transportStarted).toHaveBeenCalledTimes(1); expect(second.transportStarted).toHaveBeenCalledTimes(1);
  expect(currentRemoteTelemetryRequest()).toBeUndefined();
});


describe('binary upload request isolation', () => {
  const artifact = base + '/artifact-uploads/upload-1/parts/1';
  const asset = base + '/input-assets/asset-1/parts/1';
  it.each(['buffer', 'view', 'data-view', 'array-buffer'])('freezes a queued %s body with its exact offset before caller mutation', async kind => {
    const { transport, children } = fixture();
    const blocker = request(transport, '/sync/batches'); await settle();
    const original = Buffer.from([77, 88, 0, 128, 255, 13, 10, 99]);
    const bytes = kind === 'array-buffer' ? original.subarray(2, 7).buffer.slice(original.byteOffset + 2, original.byteOffset + 7)
      : kind === 'data-view' ? new DataView(original.buffer, original.byteOffset + 2, 5)
      : kind === 'view' ? new Uint8Array(original.buffer, original.byteOffset + 2, 5) : original.subarray(2, 7);
    const pending = transport.queuedFetch(artifact, { method: 'PUT', body: bytes });
    original.fill(0);
    if (bytes instanceof ArrayBuffer) new Uint8Array(bytes).fill(0);
    expect(children[0].messages.filter(value => value.type === Message.Fetch)).toHaveLength(1);
    success(children[0]); await blocker; await settle();
    const message = children[0].messages.find(value => value.url === artifact);
    expect(message.bodyEncoding).toBe(RemoteNetworkBodyEncoding.Base64);
    expect(Buffer.from(message.body, 'base64')).toEqual(Buffer.from([0,128,255,13,10]));
    success(children[0], message.id); await pending;
  });
  it('accepts an eight MiB input part while retaining separate foreground queue bytes', async () => {
    const { transport, children } = fixture();
    const blocker = request(transport, '/sync/batches');
    const controls = [request(transport), request(transport, '/connection-tickets'), request(transport, '/commands/claim')];
    await settle();
    const part = transport.queuedFetch(asset, { method: 'PUT', body: new ArrayBuffer(Limit.InputPartBytes) });
    // Base64 expansion exceeds 8 MiB. A second part must not overrun the new background bound.
    await expect(transport.queuedFetch(asset, { method: 'PUT', body: new ArrayBuffer(Limit.InputPartBytes) })).rejects.toThrow('ADMISSION_BUSY');
    const control = transport.queuedFetch(base + '/devices/register', { method: 'POST', body: '{}' });
    const queued = (transport as any).queue;
    expect(queued.filter((item: any) => item.lane === 'background')[0].bytes).toBeGreaterThan(Limit.InputPartBytes);
    expect(queued.filter((item: any) => item.lane === 'control')).toHaveLength(1);
    const child = children[0];
    for (const message of [...child.messages].filter(value => value.type === Message.Fetch)) success(child, message.id);
    await Promise.all([blocker, ...controls]); await settle();
    for (const message of child.messages.filter(value => value.url === asset || value.url === base + '/devices/register')) success(child, message.id);
    await Promise.all([part, control]);
  });
  it('keeps JSON at two MiB and rejects bodies outside the two bounded PUT routes', async () => {
    const { transport, children } = fixture();
    for (const [url, method, body] of [
      [artifact, 'POST', new ArrayBuffer(1)], [base + '/artifact-uploads/upload-1/complete', 'PUT', new ArrayBuffer(1)],
      [base + '/input-assets/asset-1/content', 'PUT', new ArrayBuffer(1)], [base + '/input-assets/asset-1/parts/0', 'PUT', new ArrayBuffer(1)],
      [base.replace('/v1', '/v2') + '/input-assets/asset-1/parts/1', 'PUT', new ArrayBuffer(1)],
      [asset, 'PUT', new Blob(['x'])], [asset, 'PUT', new Uint8Array(new SharedArrayBuffer(1))],
    ] as const) await expect(transport.queuedFetch(url, { method, body })).rejects.toThrow('REQUEST_INVALID');
    for (const [url, body] of [
      [artifact, new ArrayBuffer(Limit.ArtifactPartBytes + 1)], [asset, new ArrayBuffer(Limit.InputPartBytes + 1)],
      [asset, 'x'.repeat(Limit.BodyBytes + 1)],
    ] as const) {
      await expect(transport.queuedFetch(url, { method: 'PUT', body })).rejects.toThrow('REQUEST_BUDGET');
      await expect(transport.fetch(url, { method: 'PUT', body })).rejects.toThrow('REQUEST_BUDGET');
    }
    expect(children).toHaveLength(0);
  });
  it('discards cancelled queued parts without dispatch and holds active parts until child acknowledgement', async () => {
    const { transport, children } = fixture();
    const blocker = request(transport, '/sync/batches'); await settle();
    const queuedAbort = new AbortController();
    const queued = transport.queuedFetch(artifact, { method: 'PUT', body: new ArrayBuffer(4), signal: queuedAbort.signal });
    queuedAbort.abort(); await expect(queued).rejects.toThrow('CANCELLED');
    success(children[0]); await blocker; await settle();
    expect(children[0].messages.filter(value => value.url === artifact)).toHaveLength(0);
    const activeAbort = new AbortController();
    const active = transport.fetch(artifact, { method: 'PUT', body: new ArrayBuffer(4), signal: activeAbort.signal }); await settle();
    activeAbort.abort(); await expect(active).rejects.toThrow('CANCELLED');
    await expect(transport.fetch(artifact, { method: 'PUT', body: new ArrayBuffer(4) })).rejects.toThrow('ADMISSION_BUSY');
    const message = children[0].messages.find(value => value.url === artifact);
    children[0].reply({ type: Message.Result, id: message.id, error: RemoteNetworkFailure.Cancelled }); await settle();
    const next = transport.fetch(artifact, { method: 'PUT', body: new ArrayBuffer(4) }); await settle();
    success(children[0], children[0].messages.filter(value => value.url === artifact).at(-1).id); await next;
  });
});


it('does not encode a large part after cancellation or direct admission failure', async () => {
  const { transport, children } = fixture();
  const active = request(transport, '/sync/batches'); await settle();
  const encoding = vi.spyOn(Buffer.prototype, 'toString');
  const url = base + '/input-assets/asset-1/parts/1', body = new ArrayBuffer(Limit.InputPartBytes);
  await expect(transport.fetch(url, { method: 'PUT', body })).rejects.toThrow('ADMISSION_BUSY');
  const abort = new AbortController(); abort.abort();
  await expect(transport.fetch(url, { method: 'PUT', body, signal: abort.signal })).rejects.toThrow('CANCELLED');
  await expect(transport.queuedFetch(url, { method: 'PUT', body, signal: abort.signal })).rejects.toThrow('CANCELLED');
  expect(encoding.mock.calls.filter(([format]) => format === 'base64')).toHaveLength(0);
  success(children[0]); await active;
});
