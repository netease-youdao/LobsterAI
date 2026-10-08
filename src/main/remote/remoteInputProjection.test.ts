import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'A', scopeKey: 'personal' };
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(): RemoteStore {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setInputProjectionSupported(true);
  store.transaction(() => { db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle','provider/model','low')"); store.assignNew('s', owner, 'local_create'); });
  return store;
}
function userMessage(store: RemoteStore): void {
  store.transaction(() => store.db.prepare("INSERT INTO cowork_messages VALUES('m','s','user',?, ?,2,1)").run('Analyze\nFile: /private/secret/report.txt', JSON.stringify({ remoteRunId: 'run' })));
}
it('projects mobile attachment references and original text without generated local file paths', () => {
  const store = fixture();
  store.put('inputRun:run', { input: { text: 'Analyze', attachments: [{ assetId: 'asset', version: '1', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file' }] }, inputModel: null });
  userMessage(store);
  const projection = store.snapshot('s');
  expect(JSON.stringify(projection)).not.toContain('/private/secret');
  expect(projection.records.find(row => row.eventType === 'message.upsert')?.payload.message.blocks[1]).toMatchObject({ type: 'attachment', assetId: 'asset', availability: 'ready' });
});
it('creates one stable desktop placeholder and uses completed server MIME at a higher revision', () => {
  const store = fixture();
  store.put('desktopInputRun:run', { owner, text: 'Analyze', attachments: [{ path: '/private/secret/report.txt', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file' }] });
  userMessage(store);
  const before = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(before.blocks[1]).toMatchObject({ type: 'artifact', availability: 'desktop_only' });
  const job = store.get<any>('desktopAsset:m:0');
  store.put('desktopAsset:m:0', { ...job, availability: 'ready', uploadedAsset: { assetId: 'asset', version: '1', fileName: 'report.txt', mimeType: 'application/octet-stream', sizeBytes: '12', intent: 'file' } });
  const after = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(after.blocks[1]).toMatchObject({ type: 'attachment', mimeType: 'application/octet-stream' });
  expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  expect(store.entries('desktopAsset:')).toHaveLength(1);
  expect(JSON.stringify(after)).not.toContain('/private/secret');
});
it('does not expose attachment metadata from a different account run', () => {
  const store = fixture();
  store.put('desktopInputRun:run', { owner: { userId: 'B', scopeKey: 'personal' }, text: 'private text', attachments: [{ path: '/b', fileName: 'private.txt' }] });
  userMessage(store);
  const projection = store.snapshot('s');
  expect(JSON.stringify(projection)).not.toContain('private.txt'); expect(store.entries('desktopAsset:')).toHaveLength(0);
});

it.each([
  { jobReason: RemoteFileReason.Size, snapshot: true, expected: RemoteFileReason.Size },
  { jobReason: 'ASSET_MISSING', snapshot: true, expected: 'FILE_MISSING' },
  { jobReason: 'ASSET_FILE_CHANGED', snapshot: true, expected: RemoteFileReason.Source },
  { jobReason: 'https://private.example/upload?token=secret', snapshot: true, expected: RemoteFileReason.Transfer },
  { jobReason: undefined, snapshot: true, expected: RemoteFileReason.Transfer },
  { jobReason: undefined, snapshot: false, expected: RemoteFileReason.Source },
])('projects only compatible safe pending input reasons ($jobReason/$snapshot)', ({ jobReason, snapshot, expected }) => {
  const store = fixture(); store.setFileProjectionSupported(true);
  store.put('desktopInputRun:run', { owner, text: 'Analyze', attachments: [{ path: '/private/secret/report.txt', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file', ...(snapshot ? { snapshot: { path: '/private/snapshot/report.txt' } } : {}) }] });
  userMessage(store);
  const before = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  const job = store.get<any>('desktopAsset:m:0');
  store.put('desktopAsset:m:0', { ...job, ...(jobReason ? { reason: jobReason } : {}) });
  const message = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(message.blocks[1]).toMatchObject({ type: 'artifact', availability: 'desktop_only', reason: expected });
  expect(message.blocks[1]).not.toHaveProperty('assetId');
  expect(message.blocks[1].artifactId).toBe(before.blocks[1].artifactId);
  if (expected !== before.blocks[1].reason) expect(BigInt(message.revision)).toBeGreaterThan(BigInt(before.revision));
  expect(JSON.stringify(message)).not.toContain('/private/');
  expect(JSON.stringify(message)).not.toContain('token=secret');
});

it('keeps safe capture failure diagnostics and removes them when an input becomes ready', () => {
  const store = fixture(); store.setFileProjectionSupported(true);
  store.put('desktopInputRun:run', { owner, text: 'Analyze', attachments: [{ path: '/private/report.txt', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file', captureReason: RemoteFileReason.Type }] });
  userMessage(store);
  const before = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(before.blocks[1].reason).toBe(RemoteFileReason.Type);
  const job = store.get<any>('desktopAsset:m:0');
  store.put('desktopAsset:m:0', { ...job, reason: RemoteFileReason.Size });
  expect(store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message.blocks[1].reason).toBe(RemoteFileReason.Size);
  store.put('desktopAsset:m:0', { ...job, availability: 'ready', uploadedAsset: { assetId: 'asset', version: '1', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file' } });
  const ready = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(ready.blocks[1]).toMatchObject({ type: 'attachment', availability: 'ready', assetId: 'asset' });
  expect(ready.blocks[1]).not.toHaveProperty('reason');
});

it('does not add reasons to legacy file projections or expose another account capture failure', () => {
  const store = fixture();
  store.put('desktopInputRun:run', { owner, text: 'Analyze', attachments: [{ path: '/private/report.txt', fileName: 'report.txt', mimeType: 'text/plain', sizeBytes: '12', intent: 'file', captureReason: RemoteFileReason.Size }] });
  userMessage(store);
  const legacy = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(legacy.blocks[1]).not.toHaveProperty('reason');
  store.setFileProjectionSupported(true);
  store.put('desktopInputRun:run', { owner: { userId: 'B', scopeKey: 'personal' }, text: 'private text', attachments: [{ path: '/b', fileName: 'private.txt', captureReason: RemoteFileReason.Size }] });
  const changed = store.snapshot('s').records.find(row => row.eventType === 'message.upsert')!.payload.message;
  expect(changed.blocks).toHaveLength(1);
  expect(JSON.stringify(changed)).not.toContain(RemoteFileReason.Size);
  expect(JSON.stringify(changed)).not.toContain('private.txt');
});


it('advances model metadata versions without rewriting already sealed history events', () => {
  const store = fixture();
  const model = { modelRef: 'model', version: '4', source: 'subscription', displayName: 'Chat', providerLabel: 'LobsterAI', thinkingLevel: 'low' };
  expect(store.setInputModel('s', model)).toBe('1');
  const sealed = store.pending('s');
  expect(store.setInputModel('s', { ...model, version: '5' })).toBe('2');
  expect(store.get('inputModel:s')).toEqual({ ...model, version: '5' });
  expect(store.pending('s').slice(0, sealed.length)).toEqual(sealed);
  const latest = store.snapshot('s').records.find(record => record.eventType === 'session.upsert')!.payload.session;
  expect(latest).toMatchObject({ inputVersion: '2', inputModel: { version: '5' } });
  expect(store.setInputModel('s', { ...model, version: '5' })).toBe('2');
  expect(store.inputVersion('s')).toBe('2');
});

it('commits a configuration change and its model summary under one input version', () => {
  const store = fixture();
  const model = { modelRef: 'model', version: '4', thinkingLevel: 'low' };
  store.setInputModel('s', model);
  store.transaction(() => {
    store.db.prepare('UPDATE cowork_sessions SET thinking_level=? WHERE id=?').run('high', 's');
    expect(store.setInputModel('s', { ...model, thinkingLevel: 'high' })).toBe('2');
  });
  expect(store.inputVersion('s')).toBe('2');
  expect(store.get('inputModel:s')).toEqual({ ...model, thinkingLevel: 'high' });
});

it('rolls back both input version and summary when persisting the model fails', () => {
  const store = fixture();
  const model = { modelRef: 'model', version: '4' };
  store.setInputModel('s', model);
  const sealed = store.pending('s');
  store.db.exec("CREATE TRIGGER reject_model BEFORE INSERT ON remote_state WHEN NEW.key='inputModel:s' BEGIN SELECT RAISE(ABORT, 'model write failed'); END");
  expect(() => store.setInputModel('s', { ...model, version: '5' })).toThrow('model write failed');
  expect(store.inputVersion('s')).toBe('1');
  expect(store.get('inputModel:s')).toEqual(model);
  expect(store.pending('s')).toEqual(sealed);
});


it('keeps configuration signature, version and previous model together when version refresh fails', () => {
  const store = fixture();
  const model = { modelRef: 'model', version: '4', thinkingLevel: 'low' };
  store.setInputModel('s', model);
  const signature = store.get('inputSignature:s');
  store.db.prepare('UPDATE cowork_sessions SET thinking_level=? WHERE id=?').run('high', 's');
  store.db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON remote_state WHEN NEW.key='inputVersion:s' BEGIN SELECT RAISE(ABORT, 'version write failed'); END");
  expect(() => store.inputVersion('s')).toThrow('version write failed');
  expect(store.get('inputVersion:s')).toBe('1');
  expect(store.get('inputSignature:s')).toBe(signature);
  expect(store.get('inputModel:s')).toEqual(model);
  store.db.exec('DROP TRIGGER reject_version');
  expect(store.inputVersion('s')).toBe('2');
  expect(store.get('inputModel:s')).toBeNull();
});
