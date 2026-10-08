import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteRunStatus } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteInputCapability, RemoteInputReason, RemoteInputRecovery } from '../../shared/remote/input';
import { RemoteAttachmentError } from './inputPreparationService';
import { RemoteBridge } from './remoteBridge';
import { RemoteInputError } from './remoteModelCatalog';
import { RemoteStore } from './remoteStore';
import * as syncLog from './remoteSyncLog';

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
  const request = vi.fn(async (_owner, path: string, _init?: RequestInit) => {
    if (path.endsWith('/connection-tickets')) return response({ wsUrl: 'wss://example.com/api/remote/v1/ws?ticket=test' });
    if (path.includes('/v1/devices/pc/input-preparations?')) return response({ items: [], nextCursor: null });
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
  it('keeps a deferred terminal reply deadline ahead of the real idle polling cycle', async () => {
    const { bridge, store, sync, count } = await fixture();
    store.setWake(() => {});
    bridge.targetId = bridge.targets.activateLegacy({ owner: initialOwner, deviceId: 'pc', allowPartialLegacy: true }).targetId;
    store.setProjectionIdentity(bridge.targetId, initialOwner, 'pc'); store.setFileEnvironment(bridge.targetId);
    startOwnedRun(store); store.updateRun('running', RemoteRunStatus.Succeeded);
    const now = Date.now();
    sync.mockClear();
    sync.mockImplementationOnce(async () => { bridge.taskSync.defer(bridge.taskContext(), 'running', 5000); })
      .mockImplementation(async () => {
        const snapshot = store.snapshot('running'), row = store.sync('running')!;
        store.bindRemote('running', row.session_id, 'pc');
        store.acknowledge('running', 'pc', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
        bridge.taskSync.progress(bridge.taskContext(), 'running', true);
      });
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledOnce(); expect(bridge.scheduledAt).toBe(now + 5000);
    await vi.advanceTimersByTimeAsync(4999); expect(sync).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(sync).toHaveBeenCalledTimes(2);
    expect(bridge.taskSync.candidates(bridge.taskContext())).toEqual([]);
    expect(count('/commands/claim')).toBe(1);
    await vi.advanceTimersByTimeAsync(24999); expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(count('/commands/claim')).toBe(2);
  });
  it('continues claiming commands while optional input model publication is stalled', async () => {
    const { bridge,count } = await fixture();
    let release!: () => void;
    bridge.deps.input.models.publish.mockImplementation(() => new Promise<void>(resolve => { release=resolve; }));
    bridge.lastInputPublish = 0;
    bridge.schedule(0); await vi.advanceTimersByTimeAsync(1);
    const before = count('/commands/claim');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count('/commands/claim')).toBe(before + 1);
    release(); await vi.advanceTimersByTimeAsync(0);
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
    for (const item of items) store.put(`inbox:${item.commandId}`, { owner: initialOwner, state: 'applied', command: { commandId: item.commandId } });
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
    store.put('inbox:other-owner', { owner: { userId: 'other-user', scopeKey: 'personal' }, state: 'unknown', command: { commandId: 'other-owner' } });
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

describe('poisoned control records', () => {
  it('continues claiming commands with a corrupt local inbox row and approval cleanup failure', async () => {
    const { bridge, store, count } = await fixture();
    store.db.prepare("INSERT INTO remote_state(key,value) VALUES('inbox:bad','{')").run();
    vi.spyOn(store, 'expireApprovals').mockImplementation(() => { throw new Error('bad approval'); });
    Socket.latest.frame({ type: 'commands.available' }); await vi.advanceTimersByTimeAsync(1);
    expect(count('/commands/claim')).toBe(2);
    expect(bridge.generation).toBe('1');
    expect(store.db.prepare("SELECT value FROM remote_state WHERE key='inbox:bad'").get()).toEqual({ value: '{' });
  });
  it('advances unresolved pages across rounds so a bad command cannot starve claim', async () => {
    const { bridge, store, request, count } = await fixture(); const original = request.getMockImplementation()!;
    store.db.prepare("INSERT INTO remote_state(key,value) VALUES('inbox:bad-command','{')").run();
    request.mockImplementation(async (owner,path) => {
      if (path.includes('/commands?')) return response({ items: [{ commandId: 'bad-command', status: 'received' }], nextCursor: path.includes('cursor=') ? null : 'next' });
      return original(owner,path);
    });
    Socket.latest.frame({ type: 'commands.available' }); await vi.advanceTimersByTimeAsync(2);
    expect(count('/commands/claim')).toBeGreaterThanOrEqual(3);
    expect(request.mock.calls.some(([,path]) => path.includes('cursor=next'))).toBe(true);
    expect(bridge.generation).toBe('1');
    expect(store.db.prepare("SELECT value FROM remote_state WHERE key='inbox:bad-command'").get()).toEqual({ value: '{' });
  });
});

it('keeps input claims and commands progressing while isolated recovery is stalled, then preserves unresolved identity', async () => {
  const { bridge, request, count } = await fixture();
  const original = request.getMockImplementation()!;
  let release!: (value: Response) => void;
  bridge.capabilitySnapshot = { capabilities: [RemoteInputRecovery.Capability] };
  bridge.deps.input.preparations.retainRecoveryDiagnostic = vi.fn();
  bridge.deps.input.preparations.recoverReceipt = vi.fn();
  request.mockImplementation((owner, path) => path.includes('/v2/devices/pc/input-preparations?')
    ? new Promise<Response>(resolve => { release = resolve; }) : original(owner, path));
  bridge.schedule(0); await vi.advanceTimersByTimeAsync(0);
  const inputBefore = count('/input-preparations/claim'), commandBefore = count('/commands/claim');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(count('/input-preparations/claim')).toBeGreaterThan(inputBefore);
  expect(count('/commands/claim')).toBeGreaterThan(commandBefore);
  release(response({ items: [{ preparationId: 'healthy', status: 'ready' }], unresolvedItems: [
    { preparationId: 'bad', diagnostic: { kind: RemoteInputRecovery.Unavailable, retryAfterMs: 30_000 } }], nextCursor: null, scanComplete: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.deps.input.preparations.retainRecoveryDiagnostic).toHaveBeenCalledWith('bad', initialOwner, 'pc');
  expect(bridge.deps.input.preparations.recoverReceipt).toHaveBeenCalledWith({ preparationId: 'healthy', status: 'ready' }, initialOwner, 'pc');
});
it('never calls recovery v2 without capability negotiation', async () => {
  const { request } = await fixture();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(request.mock.calls.some(([, path]) => path.includes('/v2/devices/'))).toBe(false);
  expect(request.mock.calls.some(([, path]) => path.includes('/v1/devices/pc/input-preparations?'))).toBe(true);
});

it('restarts an expired v2 cursor without treating its error as an empty recovery page', async () => {
  const { bridge, request } = await fixture();
  const original = request.getMockImplementation()!;
  bridge.capabilitySnapshot = { capabilities: [RemoteInputRecovery.Capability] };
  bridge.deps.input.preparations.retainRecoveryDiagnostic = vi.fn();
  bridge.deps.input.preparations.recoverReceipt = vi.fn();
  let pages = 0;
  request.mockImplementation((owner, path) => {
    if (!path.includes('/v2/devices/pc/input-preparations?')) return original(owner, path);
    pages++;
    return Promise.resolve(pages === 1 ? response({ items: [], unresolvedItems: [], nextCursor: 'continuation', scanComplete: false })
      : new Response(JSON.stringify({ code: 47008, message: 'CURSOR_EXPIRED' }), { status: 410 }));
  });
  bridge.schedule(0); await vi.advanceTimersByTimeAsync(251);
  expect(pages).toBe(2);
  expect(bridge.inputRecoveryCursor).toBeNull();
  expect(bridge.deps.input.preparations.retainRecoveryDiagnostic).not.toHaveBeenCalled();
  expect(bridge.deps.input.preparations.recoverReceipt).not.toHaveBeenCalled();
});

it.each([404, 47017, 47000])('falls back to an independent v1 cursor only after explicit unsupported %s', async code => {
  const { bridge, request } = await fixture();
  const original = request.getMockImplementation()!;
  bridge.capabilitySnapshot = { capabilities: [RemoteInputRecovery.Capability] };
  bridge.deps.input.preparations.retainRecoveryDiagnostic = vi.fn();
  bridge.deps.input.preparations.recoverReceipt = vi.fn();
  request.mockClear();
  request.mockImplementation((owner, path) => {
    if (path.includes('/v2/devices/pc/input-preparations?'))
      return Promise.resolve(new Response(JSON.stringify({ code, message: 'unsupported' }), { status: code === 47017 ? 409 : 404 }));
    if (path.includes('/v1/devices/pc/input-preparations?')) return Promise.resolve(response({
      items: [{ preparationId: 'healthy', status: 'ready' }], nextCursor: null }));
    return original(owner, path);
  });
  bridge.schedule(0); await vi.advanceTimersByTimeAsync(1);
  const recovery = request.mock.calls.filter(([, path]) => path.includes('/input-preparations?'));
  expect(recovery.map(([, path]) => path.match(/\/v[12]\//u)?.[0])).toEqual(['/v2/', '/v1/']);
  expect(recovery[1][1]).not.toContain('cursor=');
  expect(bridge.deps.input.preparations.recoverReceipt).toHaveBeenCalledWith({ preparationId: 'healthy', status: 'ready' }, initialOwner, 'pc');
  expect(bridge.deps.input.preparations.retainRecoveryDiagnostic).not.toHaveBeenCalled();
});
it.each([500, 403])('retains the v2 recovery context on shared or authentication HTTP %s failure', async status => {
  const { bridge, request, count } = await fixture();
  const original = request.getMockImplementation()!;
  bridge.capabilitySnapshot = { capabilities: [RemoteInputRecovery.Capability] };
  request.mockClear();
  request.mockImplementation((owner, path) => path.includes('/v2/devices/pc/input-preparations?')
    ? Promise.resolve(new Response(JSON.stringify({ code: status, message: 'failed' }), { status })) : original(owner, path));
  bridge.schedule(0); await vi.advanceTimersByTimeAsync(30_001);
  expect(request.mock.calls.some(([, path]) => path.includes('/v2/devices/pc/input-preparations?'))).toBe(true);
  expect(request.mock.calls.some(([, path]) => path.includes('/v1/devices/pc/input-preparations?'))).toBe(false);
  expect(count('/commands/claim')).toBeGreaterThan(0);
});


describe('input preparation failure boundaries', () => {
  it.each([
    [new RemoteInputError(RemoteInputReason.Asset), 'ASSET_UNAVAILABLE'],
    [new RemoteAttachmentError(), 'ATTACHMENT_INVALID'],
    [new RemoteInputError(RemoteInputReason.Invalid), 'PREPARATION_FAILED'],
    [new RemoteInputError(RemoteInputReason.ModelUnavailable), RemoteInputReason.ModelUnavailable],
  ])('reports only existing server reasons for %s', async (error, expectedReason) => {
    const { bridge, request } = await fixture();
    bridge.deps.input.preparations.prepare.mockRejectedValue(error);
    const original = request.getMockImplementation()!;
    let submitted: any;
    request.mockImplementation(async (owner, path, init) => {
      if (path.endsWith('/input-preparations/claim')) return response({ items: [{ preparationId: 'prep', claimId: 'claim',
        claimToken: 'token', statusVersion: '1', claimUntil: new Date(Date.now() + 60000).toISOString() }] });
      if (path.endsWith('/input-preparations/prep/result')) { submitted = JSON.parse(String(init!.body)); return response({}); }
      return original(owner, path, init);
    });
    await expect(bridge.prepareInputs()).resolves.toBe(true);
    expect(submitted).toMatchObject({ status: 'failed', reason: expectedReason, claimId: 'claim', claimToken: 'token', connectionGeneration: '1' });
  });
  it.each([false, true])('cancels a returned asset stream before rejecting stale preparation context (cancel fails: %s)', async cancelFails => {
    const { bridge, request } = await fixture();
    const requestId = 'b3f873cc-d277-4a4a-a6a9-af7a508e53ad';
    const cancel = vi.fn(async () => { if (cancelFails) throw new Error('cancel failed'); });
    const assetResponse = new Response(new ReadableStream({ cancel }));
    bridge.deps.input.preparations.prepare.mockImplementation(async (_owner: unknown, _device: string, _claim: unknown, download: (id: string, requestId: string) => Promise<Response>) => {
      await expect(download('asset', requestId)).rejects.toThrow(RemoteInputReason.Account);
      throw new RemoteInputError(RemoteInputReason.Account);
    });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (owner, path, init) => {
      if (path.endsWith('/input-preparations/claim')) return response({ items: [{ preparationId: 'prep', claimId: 'claim',
        claimToken: 'token', statusVersion: '1', claimUntil: new Date(Date.now() + 60000).toISOString() }] });
      if (path.includes('/input-assets/asset/content')) {
        expect(new Headers(init!.headers).get(syncLog.REMOTE_SYNC_REQUEST_ID_HEADER)).toBe(requestId);
        bridge.generation = '2'; return assetResponse;
      }
      return original(owner, path, init);
    });
    await expect(bridge.prepareInputs()).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([, path]) => path.endsWith('/input-preparations/prep/result'))).toBe(false);
  });
  it('retains a local failure checkpoint when server ready reporting fails', async () => {
    const { bridge, request } = await fixture();
    const diagnostic = vi.spyOn(syncLog, 'remoteDiagnosticLog').mockImplementation(() => {});
    bridge.deps.input.preparations.prepare.mockResolvedValue({ preparationId: 'prep', resolvedInput: {}, inputDigest: 'digest' });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (owner, path, init) => {
      if (path.endsWith('/input-preparations/claim')) return response({ items: [{ preparationId: 'prep', claimId: 'claim',
        claimToken: 'token', statusVersion: '1', claimUntil: new Date(Date.now() + 60000).toISOString() }] });
      if (path.endsWith('/input-preparations/prep/result')) return new Response(JSON.stringify({ code: 503, message: 'private failure' }), { status: 503 });
      return original(owner, path, init);
    });
    await expect(bridge.prepareInputs()).rejects.toThrow();
    expect(diagnostic).toHaveBeenCalledWith(syncLog.RemoteInputDiagnostic.Event, expect.objectContaining({ preparationId: 'prep',
      stage: 'server_ready', result: 'failed', reason: 'REQUEST_FAILED', elapsedMs: expect.any(Number) }), 'warn');
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/input-preparations/prep/result'))).toHaveLength(1);
  });
});


it('does not misclassify a local ready commit failure as a failed server report', async () => {
  const { bridge, request } = await fixture();
  const diagnostic = vi.spyOn(syncLog, 'remoteDiagnosticLog').mockImplementation(() => {});
  bridge.deps.input.preparations.prepare.mockResolvedValue({ preparationId: 'prep', resolvedInput: {}, inputDigest: 'digest' });
  const commitFailure = new Error('private local failure');
  bridge.deps.input.preparations.confirmReady = vi.fn(() => { throw commitFailure; });
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (owner, path, init) => {
    if (path.endsWith('/input-preparations/claim')) return response({ items: [{ preparationId: 'prep', claimId: 'claim',
      claimToken: 'token', statusVersion: '1', claimUntil: new Date(Date.now() + 60000).toISOString() }] });
    if (path.endsWith('/input-preparations/prep/result')) return response({ readyExpiresAt: new Date(Date.now() + 60000).toISOString() });
    return original(owner, path, init);
  });
  await expect(bridge.prepareInputs()).rejects.toBe(commitFailure);
  expect(diagnostic).toHaveBeenCalledWith(syncLog.RemoteInputDiagnostic.Event, expect.objectContaining({ preparationId: 'prep',
    stage: 'server_ready', result: 'success', transportRequestId: expect.any(String) }));
  expect(diagnostic).toHaveBeenCalledWith(syncLog.RemoteInputDiagnostic.Event, expect.objectContaining({ preparationId: 'prep',
    stage: 'local_commit', result: 'failed', reason: 'STORAGE_UNAVAILABLE' }), 'warn');
  expect(request.mock.calls.filter(([, path]) => path.endsWith('/input-preparations/prep/result'))).toHaveLength(1);
});
