import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OwnershipSyncState, OwnershipTargetKind } from '../../shared/ownership/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteApiError, RemoteBridge } from './remoteBridge';
import { RemoteStore } from './remoteStore';

const owner = { userId: '10001', scopeKey: 'personal' };
const target = { kind: OwnershipTargetKind.Task, id: 'task' };
const cleanup: Array<() => void> = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); });

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db);
  let route = 'https://service.example';
  let account = owner;
  const bridge: any = new RemoteBridge({ store, identity: { installationId: 'instance', deviceKey: 'key', databaseId: 'db' },
    runSessionTransaction: <T>(operation: () => T) => store.transaction(operation),
    getOwner: () => account, getEnvironment: () => RemoteEnvironment.Test, getApiBaseUrl: () => route,
    request: vi.fn(), metadata: { name: 'Desktop', hostName: 'host', platform: 'macos', appVersion: '1', instanceLabel: 'default' },
    prepare: () => ({ localSessionId: 'task', remoteSessionId: 'remote', runId: null }), execute: vi.fn(), onAccountChange: vi.fn(),
  });
  cleanup.push(() => { bridge.stop(); db.close(); });
  bridge.owner = owner;
  bridge.registration = { deviceId: 'desktop', ...owner, metadataVersion: '1' };
  bridge.targetId = RemoteEnvironment.Test;
  store.put('settings:10001:personal', { enabled: true, name: 'Desktop', settingsVersion: '1', workspaces: [] });
  store.setEnabledOwner(owner);
  store.setProjectionIdentity(RemoteEnvironment.Test, owner, 'desktop');
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('task','Task',1,1,'completed')");
    store.assignNew('task', owner, 'local_create');
  });
  const ack = () => {
    const snapshot = store.snapshot('task'), row = store.sync('task')!;
    store.bindRemote('task', row.session_id, 'desktop');
    store.acknowledge('task', 'desktop', row.session_id, snapshot.baseSourceSeq, '1', true, snapshot.snapshotEpoch);
  };
  const unavailable = () => bridge.recordConnectionFailure(new RemoteApiError(47003, 'Service not ready', { reason: 'DEVICE_NOT_READY' }, 503));
  return { bridge, store, ack, unavailable, route: (value: string) => { route = value; }, account: (value: typeof owner) => { account = value; } };
}

describe('task detail synchronization state', () => {
  it('distinguishes initial registration from an unavailable service without changing persisted work', () => {
    const f = fixture(); f.bridge.registration = null;
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    const before = f.store.sync('task');
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
    expect(f.store.sync('task')).toEqual(before);
  });
  it('keeps an ACK for the verified target synced during a temporary connection failure', () => {
    const f = fixture(); f.ack(); f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Synced);
  });
  it('reports a pending upload blocked by service failure instead of ordinary pending', () => {
    const f = fixture(); f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an old ACK when current registration is unknown', () => {
    const f = fixture(); f.ack(); f.bridge.registration = null; f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an ACK after registration but before target verification completes', () => {
    const f = fixture(); f.ack(); f.bridge.targetId = null;
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('does not reuse an old ACK or connection error while the API route is changing', () => {
    const f = fixture(); f.ack(); f.unavailable(); f.route('https://new-service.example');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
  });
  it('does not present another target ACK or failure as the current target state', () => {
    const f = fixture(); f.ack(); f.bridge.targetId = 'other-target';
    f.store.put('syncFailure:task', { code: 47019 });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
    f.unavailable();
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.WaitingService);
  });
  it('reports a local projection failure and returns to synced after recovery', () => {
    const f = fixture(); f.ack();
    f.store.db.prepare('INSERT INTO remote_projection_failures VALUES(?,?,?,?)').run('task', 'REMOTE_PROJECTION_BUDGET', Number.MAX_SAFE_INTEGER, 1);
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Failed);
    f.store.db.prepare('DELETE FROM remote_projection_failures WHERE session_id=?').run('task');
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Synced);
  });
  it('does not expose a different account or scope synchronization state', () => {
    const f = fixture(); f.ack(); f.unavailable();
    f.account({ ...owner, scopeKey: 'team:another' });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Local);
    f.account({ userId: 'another-user', scopeKey: 'personal' });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Local);
  });
  it('does not label intentionally disabled synchronization as a service outage', () => {
    const f = fixture(); f.bridge.registration = null; f.unavailable();
    f.store.put(f.bridge.settingsKey(), { enabled: false, name: 'Desktop', settingsVersion: '1', workspaces: [] });
    expect(f.bridge.associationSyncState(target)).toBe(OwnershipSyncState.Pending);
  });
});
