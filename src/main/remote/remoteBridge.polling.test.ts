import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteRunStatus } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteInputCapability } from '../../shared/remote/input';
import { RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const initialOwner = { userId: 'poll-user', scopeKey: 'personal' };
const dispose: Array<() => void> = [];
class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = Socket.OPEN;
  private listeners = new Map<string, (event: any) => void>();
  constructor() { Socket.latest = this; }
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, listener); }
  frame(value: unknown): void { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
  send(): void { this.frame({ type: 'pong' }); }
  close(): void { this.readyState = 3; }
}
const response = (data: unknown): Response => new Response(JSON.stringify({ code: 0, data }));
async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
  vi.stubGlobal('WebSocket', Socket);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let owner = initialOwner;
  const request = vi.fn(async (_owner, path: string) => {
    if (path.endsWith('/connection-tickets')) return response({ wsUrl: 'wss://example.com/api/remote/v1/ws?ticket=test' });
    if (path.includes('/commands?') || path.endsWith('/claim')) return response({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${path}`);
  });
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'install', deviceKey: 'test', databaseId: 'db' },
    runSessionTransaction: operation => store.transaction(operation), getOwner: () => owner, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => 'https://example.com', request,
    metadata: { name: 'PC', hostName: 'pc', instanceLabel: 'default', platform: 'macos', appVersion: '1' },
    prepare: vi.fn(), execute: vi.fn(), onAccountChange: vi.fn(),
    input: { models: { publish: vi.fn(async () => {}) } as any, preparations: { prepare: vi.fn() } as any },
  });
  bridge.owner = owner; bridge.registration = { deviceId: 'pc', ...owner, metadataVersion: '1' };
  bridge.sameAccountAccess = true; bridge.inputCapabilities = [RemoteInputCapability.Schema];
  store.put('settings:poll-user:personal', { enabled: true, name: 'PC', settingsVersion: '1', workspaces: [] });
  bridge.writeSettings = vi.fn(async () => {});
  bridge.refreshCapabilities = vi.fn(async () => { bridge.lastCapabilityCheck = Date.now(); });
  bridge.lastCapabilityCheck = Date.now();
  const sync = vi.spyOn(bridge, 'syncSessions').mockResolvedValue(undefined);
  dispose.push(() => { bridge.stop(); db.close(); });
  await bridge.connect();
  Socket.latest.frame({ type: 'hello', protocolVersion: 1, connectionGeneration: '1' });
  await vi.advanceTimersByTimeAsync(0);
  const count = (suffix: string): number => request.mock.calls.filter(([, path]) => path.endsWith(suffix)).length;
  return { bridge, store, request, sync, count, switchOwner: () => { owner = { ...owner, userId: 'next-user' }; bridge.accountChanged(); } };
}
function startOwnedRun(store: RemoteStore): void {
  store.setEnabledOwner(initialOwner);
  store.transaction(() => {
    store.db.exec("INSERT INTO cowork_sessions VALUES('running','Task',1,1,'running')");
    store.assignNew('running', initialOwner, 'local_create'); store.beginRun('running', 'run');
  });
}
afterEach(() => {
  for (const action of dispose.splice(0).reverse()) action();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('remote background polling', () => {
  it('reconciles commands without notifications every thirty seconds but empty input only every minute', async () => {
    const { count, request, sync } = await fixture();
    expect(count('/input-preparations/claim')).toBe(1);
    expect(count('/commands/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(29999);
    expect(count('/input-preparations/claim')).toBe(1);
    expect(count('/commands/claim')).toBe(1);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(2);
    expect(request.mock.calls.filter(([, path]) => path.includes('/commands?'))).toHaveLength(2);
    expect(count('/input-preparations/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(29000);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(count('/input-preparations/claim')).toBe(2);
    expect(count('/commands/claim')).toBe(3);
  });
  it('synchronizes reply changes promptly without polling every command queue', async () => {
    const { bridge, count, sync } = await fixture();
    for (let i = 0; i < 20; i++) {
      bridge.schedule(0);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sync.mock.calls.length).toBeGreaterThan(10);
    expect(count('/input-preparations/claim')).toBe(1);
    expect(count('/commands/claim')).toBe(1);
  });
  it('routes notifications immediately to the corresponding queue', async () => {
    const { count } = await fixture();
    await vi.advanceTimersByTimeAsync(1000);
    Socket.latest.frame({ type: 'commands.available' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'prep' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(2);
  });
  it('drains a full command batch promptly, then returns to idle polling', async () => {
    const { store, request, count } = await fixture();
    const original = request.getMockImplementation()!;
    const items = Array.from({ length: 10 }, (_, i) => ({ commandId: `done-${i}` }));
    for (const item of items) store.put(`inbox:${item.commandId}`, { owner: initialOwner, state: 'applied' });
    let pending = true;
    request.mockImplementation(async (owner, path) => {
      if (pending && path.endsWith('/commands/claim')) { pending = false; return response({ items }); }
      return original(owner, path);
    });
    Socket.latest.frame({ type: 'commands.available' });
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(3);
    await vi.advanceTimersByTimeAsync(29000);
    expect(count('/commands/claim')).toBe(3);
  });
  it('drains prepared input promptly, then stops when the next claim is empty', async () => {
    const { bridge, request, count } = await fixture();
    bridge.deps.input.preparations.prepare.mockResolvedValue({ preparationId: 'prep', resolvedInput: {}, inputDigest: 'digest' });
    const original = request.getMockImplementation()!;
    let pending = true;
    request.mockImplementation(async (owner, path) => {
      if (pending && path.endsWith('/input-preparations/claim')) {
        pending = false;
        return response({ items: [{ preparationId: 'prep', claimId: 'claim', claimToken: 'token', statusVersion: '1',
          claimUntil: new Date(Date.now() + 60000).toISOString() }] });
      }
      if (path.endsWith('/input-preparations/prep/result')) return response({});
      return original(owner, path);
    });
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'prep' });
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/input-preparations/claim')).toBe(3);
    await vi.advanceTimersByTimeAsync(59000);
    expect(count('/input-preparations/claim')).toBe(3);
  });
  it('retains an input notification received during an outstanding claim', async () => {
    const { request, count } = await fixture();
    const original = request.getMockImplementation()!;
    let finish: (value: Response) => void = () => {};
    request.mockImplementationOnce((_owner, path) => {
      expect(path.endsWith('/input-preparations/claim')).toBe(true);
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'prep' });
    await vi.advanceTimersByTimeAsync(0);
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'prep' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/input-preparations/claim')).toBe(2);
    request.mockImplementation(original);
    finish(response({ items: [] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/input-preparations/claim')).toBe(3);
  });
  it('backs off failed input claims despite repeated reply updates', async () => {
    const { bridge, request, count } = await fixture();
    request.mockRejectedValueOnce(new Error('temporary unavailable'));
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'prep' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      bridge.schedule(0);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(count('/input-preparations/claim')).toBe(2);
    await vi.advanceTimersByTimeAsync(50001);
    expect(count('/input-preparations/claim')).toBe(3);
  });
  it('clears failed input backoff when the desktop receives a new preparation notification', async () => {
    const { request, count } = await fixture();
    request.mockRejectedValueOnce(new Error('temporary unavailable'));
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'first-prep' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/input-preparations/claim')).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    Socket.latest.frame({ type: 'input.preparations.available', preparationId: 'next-prep' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/input-preparations/claim')).toBe(3);
    expect(count('/commands/claim')).toBe(1);
  });
  it('retains the legacy input update notification as a compatible wake-up', async () => {
    const { count } = await fixture();
    Socket.latest.frame({ type: 'input.preparation.updated' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/input-preparations/claim')).toBe(2);
    expect(count('/commands/claim')).toBe(1);
  });
  it('backs off failed command reconciliation without blocking reply synchronization', async () => {
    const { bridge, request, count, sync } = await fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    request.mockRejectedValueOnce(new Error('database unavailable'));
    Socket.latest.frame({ type: 'commands.available' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      Socket.latest.frame({ type: 'commands.available' }); bridge.schedule(0);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(count('/commands/claim')).toBe(1);
    expect(request.mock.calls.filter(([, path]) => path.includes('/commands?'))).toHaveLength(2);
    expect(sync.mock.calls.length).toBeGreaterThan(5);
  });
  it.each([RemoteRunStatus.Starting, RemoteRunStatus.Running, RemoteRunStatus.WaitingApproval,
    RemoteRunStatus.WaitingLocal, RemoteRunStatus.Cancelling, RemoteRunStatus.Reconciling])('reconciles %s runs every five seconds', async status => {
    const { bridge, store, count } = await fixture();
    startOwnedRun(store); store.updateRun('running', status);
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4999);
    expect(count('/commands/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
  });
  it.each(['prepared', 'executing', 'unknown'] as const)('keeps an unresolved %s command active without a local run', async state => {
    const { bridge, store, count } = await fixture();
    store.put('inbox:pending', { owner: initialOwner, state });
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4999);
    expect(count('/commands/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
  });
  it.each([
    { requiresLocalAction: false, status: RemoteRunStatus.WaitingApproval },
    { requiresLocalAction: true, status: RemoteRunStatus.WaitingLocal },
    { requiresLocalAction: false, resolution: { phase: 'unknown' }, status: RemoteRunStatus.Reconciling },
  ])('keeps a persisted approval in $status active', async ({ status, ...approval }) => {
    const { bridge, store, count } = await fixture();
    startOwnedRun(store);
    store.updateApproval('running', { approvalId: 'approval', runId: 'run', approvalVersion: '1', status: 'pending',
      remoteAllowed: true, expiresAt: new Date(Date.now() + 300000).toISOString(), ...approval });
    expect(store.run('running')?.status).toBe(status);
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(5000);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
  });
  it('keeps startup-recovered runs active until their outcome is resolved', async () => {
    const { bridge, store, count } = await fixture();
    startOwnedRun(store);
    new RemoteStore(store.db);
    expect(store.run('running')?.status).toBe(RemoteRunStatus.Reconciling);
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(5000);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(1);
  });
  it('does not treat terminal runs or another account unresolved commands as active', async () => {
    const { bridge, store, count } = await fixture();
    startOwnedRun(store); store.updateRun('running', RemoteRunStatus.Succeeded);
    store.put('inbox:other-owner', { owner: { userId: 'other-user', scopeKey: 'personal' }, state: 'unknown' });
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(29999);
    expect(count('/commands/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(2);
  });
  it('resets poll deadlines on reconnect and account changes', async () => {
    const { bridge, count, switchOwner } = await fixture();
    bridge.commandRetryAt = Date.now() + 60000; bridge.inputRetryAt = Date.now() + 60000;
    bridge.disconnect(); await bridge.connect();
    Socket.latest.frame({ type: 'hello', protocolVersion: 1, connectionGeneration: '2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(count('/commands/claim')).toBe(2);
    expect(count('/input-preparations/claim')).toBe(2);
    switchOwner();
    expect(bridge.commandPollAt).toBe(0); expect(bridge.inputPollAt).toBe(0);
    expect(bridge.commandRetryAt).toBe(0); expect(bridge.inputRetryAt).toBe(0);
    expect(bridge.generation).toBeNull();
  });
});
