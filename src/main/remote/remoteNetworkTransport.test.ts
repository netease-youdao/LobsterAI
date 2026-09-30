import { type ChildProcess, type fork } from 'child_process';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionManager, AuthSessionRequestError } from '../libs/authSessionManager';
import { RemoteNetworkFailure, RemoteNetworkLimit as Limit, RemoteNetworkMessage as Message } from './remoteNetworkProtocol';
import { RemoteNetworkTransport, remoteResponseJson } from './remoteNetworkTransport';
import { remoteSyncErrorMetadata } from './remoteSyncLog';
import { classifyTaskSyncFailure } from './remoteTaskSyncPolicy';

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
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { transports.splice(0).forEach(transport => transport.dispose()); await settle(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('supervised remote network transport', () => {
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
    const next = request(transport); await settle(); expect(spawn).toHaveBeenCalledTimes(1);
    children[0].exit(); await settle(); expect(spawn).toHaveBeenCalledTimes(2);
    success(children[0]); success(children[1]); expect(await (await next).json()).toEqual({ code: 0 });
  });
  it('does not resurrect disposed work while an earlier process is still retiring', async () => {
    const { transport, children, spawn } = fixture(); const original = request(transport); await settle();
    children[0].autoExit = false; children[0].emit('error', new Error()); await expect(original).rejects.toThrow('WORKER_EXIT');
    const obsolete = request(transport); transport.socket('wss://example.com/api/remote/v1/ws'); await settle();
    transport.dispose(); await expect(obsolete).rejects.toThrow('CANCELLED'); children[0].exit(); await settle();
    expect(spawn).toHaveBeenCalledTimes(1);
    const current = request(transport); await settle(); expect(spawn).toHaveBeenCalledTimes(2); success(children[1]); await current;
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
