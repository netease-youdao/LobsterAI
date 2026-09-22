import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { afterEach, describe, expect, test } from 'vitest';

import { RemoteCapability, type RemoteOwner } from '../../shared/remote/constants';
import { legacyRemoteEnvironments, RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteRetention } from '../../shared/remote/retention';
import { payloadHash, stableJson } from './canonical';
import { migrateRemoteEnvironment, migrateVerifiedRemoteTargetCatalogRouting, migrateVerifiedRemoteTargetFileRouting, samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import { RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: 'user', scopeKey: 'enterprise:42' };
const other = { userId: 'other', scopeKey: owner.scopeKey };
const legacy = 'https://lobsterai-server-dev.inner.youdao.com';
const production = 'https://lobsterai-server.youdao.com';
const context = { owner, deviceId: 'desktop', environment: RemoteEnvironment.Test,
  legacyEnvironments: legacyRemoteEnvironments(RemoteEnvironment.Test, legacy) };
const databases: Database.Database[] = [];

function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE remote_sync(local_id TEXT PRIMARY KEY,session_id TEXT,device_id TEXT,sync_environment TEXT,
    source_seq INTEGER,ack_seq INTEGER,server_seq TEXT,stream_epoch TEXT,needs_snapshot INTEGER);
    CREATE TABLE cowork_session_ownership(session_id TEXT PRIMARY KEY,owner_user_id TEXT,owner_scope_key TEXT,ownership_status TEXT);
    CREATE TABLE remote_state(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE remote_outbox(session_id TEXT,source_seq INTEGER,event_json TEXT);
    CREATE TABLE ownership_association_operations(operation_id TEXT PRIMARY KEY,owner_user_id TEXT,owner_scope_key TEXT,
      remote_admissions_json TEXT,manifest_hash TEXT,commit_request_hash TEXT,manifest_json TEXT);`);
  const put = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run(key, stableJson(value));
  const raw = (key: string) => (db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const get = (key: string): any => raw(key) ? JSON.parse(raw(key)!) : null;
  const add = (id: string, environment: string | null = legacy, actor: RemoteOwner = owner, device = context.deviceId, status = 'confirmed') => {
    db.prepare('INSERT INTO remote_sync VALUES (?,?,?,?,8,7,?, ?,0)').run(id, `remote-${id}`, device, environment, '12', 'epoch');
    db.prepare('INSERT INTO cowork_session_ownership VALUES (?,?,?,?)').run(id, actor.userId, actor.scopeKey, status);
  };
  const sync = (id: string): any => db.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(id);
  return { db, put, get, raw, add, sync };
}

const scoped = (prefix: string, environment: string, actor = owner, device = context.deviceId) =>
  `${prefix}${JSON.stringify([environment, actor.userId, actor.scopeKey, device])}`;
const fileKey = (environment: string, id = 'task', actor = owner) =>
  `fileOutput:${createHash('sha256').update(JSON.stringify([environment, actor, context.deviceId])).digest('hex')}:${id}:artifact`;

afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('remote environment migration', () => {
  test('accepts target aliases only after verified owner and device registration', () => {
    const f = fixture(), targetId = 'a'.repeat(64), secondTarget = 'b'.repeat(64);
    expect(samePersistedRemoteEnvironment(f, context, targetId, legacy)).toBe(false);
    new RemoteSyncTargetStore(f);
    f.db.prepare('INSERT INTO remote_sync_targets VALUES (?,?,?,?,?)').run(targetId, owner.userId, owner.scopeKey, context.deviceId, null);
    f.db.prepare('INSERT INTO remote_sync_target_aliases VALUES (?,?)').run(targetId, legacy);
    expect(samePersistedRemoteEnvironment(f, context, targetId, legacy)).toBe(true);
    expect(samePersistedRemoteEnvironment(f, context, legacy, targetId)).toBe(true);
    expect(samePersistedRemoteEnvironment(f, context, targetId, targetId)).toBe(true);
    expect(samePersistedRemoteEnvironment(f, context, targetId, secondTarget)).toBe(false);
    // A known legacy domain's mode is not evidence for the newly identified target.
    expect(samePersistedRemoteEnvironment(f, context, targetId, RemoteEnvironment.Test)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, { ...context, owner: other }, targetId, legacy)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, { ...context, deviceId: 'other-device' }, targetId, legacy)).toBe(false);
  });
  test('moves only verified file routing while preserving pending publications and immutable imports', () => {
    const f = fixture(), targetId = 'a'.repeat(64); f.add('task'); f.add('other-task', legacy, other);
    const queue = [{ publicationId: 'original-publication', requestHash: 'sealed-hash', snapshot: { path: '/cache/file', sha256: 'sealed-bytes' } }];
    const job = { owner, deviceId: context.deviceId, environment: legacy, localSessionId: 'task', sessionId: 'remote-task', localArtifactId: 'artifact', queue };
    f.put(fileKey(legacy), job);
    f.put('desktopAsset:message:0', { ...job, uploadRequestId: 'original-upload', uploadedAsset: { assetId: 'original-asset' } });
    f.put('desktopAsset:other:0', { ...job, owner: other, localSessionId: 'other-task', sessionId: 'remote-other-task' });
    f.put('fileTerminalBoundary:task:run', { owner, deviceId: context.deviceId, environment: legacy, ordinal: '3' });
    f.put('import:task', { ...job, importId: 'original-import', parts: [{ payloadHash: 'part-hash' }] });
    const imported = f.raw('import:task');
    migrateVerifiedRemoteTargetFileRouting(f, { owner, deviceId: context.deviceId, targetId, legacyEnvironments: [legacy] });
    expect(f.get(fileKey(targetId))).toEqual({ ...job, environment: targetId });
    expect(f.get(fileKey(legacy))).toBeNull();
    expect(f.get('desktopAsset:message:0')).toMatchObject({ environment: targetId, queue, uploadedAsset: { assetId: 'original-asset' } });
    expect(f.get('fileTerminalBoundary:task:run')).toMatchObject({ environment: targetId, ordinal: '3' });
    expect(f.get('desktopAsset:other:0').environment).toBe(legacy);
    expect(f.raw('import:task')).toBe(imported);
  });
  test('rolls back verified file routing when a target already has different pending work', () => {
    const f = fixture(), targetId = 'a'.repeat(64); f.add('task');
    const job = { owner, deviceId: context.deviceId, environment: legacy, localSessionId: 'task', sessionId: 'remote-task', localArtifactId: 'artifact', queue: ['original'] };
    f.put(fileKey(legacy), job); f.put(fileKey(targetId), { ...job, environment: targetId, queue: ['other'] });
    expect(() => migrateVerifiedRemoteTargetFileRouting(f, { owner, deviceId: context.deviceId, targetId, legacyEnvironments: [legacy] })).toThrow('Remote target file routing conflict');
    expect(f.get(fileKey(legacy))).toEqual(job);
    expect(f.get(fileKey(targetId)).queue).toEqual(['other']);
  });
  test('preserves exact model and Agent publication IDs and workspace aliases after a verified claim', () => {
    const f = fixture(), targetId = 'a'.repeat(64);
    const model = { bindings: [{ identity: 'model', modelRef: 'original-model-ref', version: '3' }], catalogVersion: '2',
      pending: { publicationId: 'original-model-publication', expectedCatalogVersion: '2', items: [{ modelRef: 'original-model-ref' }] } };
    const catalog = { catalogVersion: '4', pending: { publicationId: 'original-agent-publication', expectedCatalogVersion: '4', items: [] } };
    const oldModelKey = `inputModels:${JSON.stringify([owner.userId, owner.scopeKey, context.deviceId])}`;
    const oldCatalogKey = scoped('agentCatalog:', legacy);
    const workspaceKey = `agentWorkspaces:${JSON.stringify([legacy, owner.userId, owner.scopeKey, context.deviceId, 'main'])}`;
    f.put(oldModelKey, model); f.put(oldCatalogKey, catalog); f.put(workspaceKey, [{ workspaceId: 'original-workspace', path: '/project' }]);
    f.put(scoped('inputModels:', legacy, other), { bindings: ['other-owner'] });
    f.put(scoped('inputModels:', production), { bindings: ['different-target'] });
    const modelBytes = f.raw(oldModelKey), catalogBytes = f.raw(oldCatalogKey), workspaceBytes = f.raw(workspaceKey);
    migrateVerifiedRemoteTargetCatalogRouting(f, { owner, deviceId: context.deviceId, targetId, legacyEnvironments: [legacy] });
    expect(f.raw(scoped('inputModels:', targetId))).toBe(modelBytes);
    expect(f.raw(scoped('agentCatalog:', targetId))).toBe(catalogBytes);
    expect(f.raw(`agentWorkspaces:${JSON.stringify([targetId, owner.userId, owner.scopeKey, context.deviceId, 'main'])}`)).toBe(workspaceBytes);
    expect(f.raw(oldModelKey)).toBe(modelBytes); expect(f.raw(oldCatalogKey)).toBe(catalogBytes);
    expect(f.get(scoped('inputModels:', targetId, other))).toBeNull();
  });
  test('routes consumed preparations only with the original command digest and keeps the immutable source', () => {
    const f = fixture(), targetId = 'a'.repeat(64);
    const resolvedInput = { text: 'original', attachments: [{ assetId: 'original-asset' }], model: { modelRef: 'original-ref', version: '3' } };
    const prepared = { owner, deviceId: context.deviceId, preparationId: 'consumed', environment: legacy, boundCommandId: 'command',
      requestHash: 'original-request', inputDigest: payloadHash(resolvedInput), resolvedInput, files: [{ path: '/private/input' }] };
    f.put('inputPreparation:consumed', prepared);
    f.put('inputPreparation:unused', { ...prepared, preparationId: 'unused', boundCommandId: null });
    f.put('inputPreparation:wrong', { ...prepared, preparationId: 'wrong', inputDigest: 'different-digest' });
    f.put('inbox:command', { owner, targetId, command: { commandId: 'command', request: {
      payload: { inputPreparationId: 'consumed', inputDigest: prepared.inputDigest, resolvedInput } } } });
    const original = f.raw('inputPreparation:consumed');
    migrateVerifiedRemoteTargetCatalogRouting(f, { owner, deviceId: context.deviceId, targetId, legacyEnvironments: [legacy] });
    expect(f.get(`inputPreparation:${JSON.stringify([targetId, 'consumed'])}`)).toEqual({ ...prepared, targetId });
    expect(f.raw('inputPreparation:consumed')).toBe(original);
    expect(f.get(`inputPreparation:${JSON.stringify([targetId, 'unused'])}`)).toBeNull();
    expect(f.get(`inputPreparation:${JSON.stringify([targetId, 'wrong'])}`)).toBeNull();
  });
  test('does not overwrite a target catalog that already has a different immutable publication', () => {
    const f = fixture(), targetId = 'a'.repeat(64);
    f.put(scoped('inputModels:', legacy), { bindings: ['legacy-reference'] });
    f.put(scoped('agentCatalog:', legacy), { pending: { publicationId: 'legacy' } });
    f.put(scoped('agentCatalog:', targetId), { pending: { publicationId: 'target' } });
    expect(() => migrateVerifiedRemoteTargetCatalogRouting(f, { owner, deviceId: context.deviceId, targetId, legacyEnvironments: [legacy] }))
      .toThrow('Remote target catalog routing conflict');
    expect(f.get(scoped('inputModels:', targetId))).toBeNull();
    expect(f.get(scoped('agentCatalog:', targetId)).pending.publicationId).toBe('target');
  });
  test('migrates only confirmed same-owner, same-device sessions in the chosen mode without changing ACKs', () => {
    const f = fixture();
    f.add('task'); f.add('alias', context.legacyEnvironments[0]); f.add('production', production);
    f.add('other-owner', legacy, other); f.add('other-scope', legacy, { ...owner, scopeKey: 'personal' });
    f.add('other-device', legacy, owner, 'other-desktop'); f.add('quarantined', legacy, owner, context.deviceId, 'quarantined');
    f.add('unbound', null);
    const before = f.sync('task');
    f.db.prepare('INSERT INTO remote_outbox VALUES (?,?,?)').run('task', 8, '{"eventId":"immutable","sourceSeq":"8"}');
    const outbox = f.db.prepare('SELECT * FROM remote_outbox').all();
    f.put('syncFailure:task', { blocked: true, reason: RemoteRetention.StateConflict });
    f.put('syncFailure:alias', { blocked: true, reason: 'SESSION_DELETED' });
    f.put('syncFailure:production', { blocked: true, reason: RemoteRetention.StateConflict });

    expect(migrateRemoteEnvironment(f, context).sessions).toBe(2);
    expect(f.sync('task')).toEqual({ ...before, sync_environment: RemoteEnvironment.Test });
    expect(f.sync('alias').sync_environment).toBe(RemoteEnvironment.Test);
    expect(f.sync('production').sync_environment).toBe(production);
    for (const id of ['other-owner', 'other-scope', 'other-device', 'quarantined']) expect(f.sync(id).sync_environment).toBe(legacy);
    expect(f.sync('unbound').sync_environment).toBeNull();
    expect(f.db.prepare('SELECT * FROM remote_outbox').all()).toEqual(outbox);
    expect(f.get('syncFailure:task')).toBeNull();
    expect(f.get('syncFailure:alias')).toEqual({ blocked: true, reason: 'SESSION_DELETED' });
    expect(f.get('syncFailure:production')).toEqual({ blocked: true, reason: RemoteRetention.StateConflict });
    expect(migrateRemoteEnvironment(f, context)).toEqual({ sessions: 0, stateRecords: 0, admissions: 0, collisions: 0 });
  });

  test('preserves queued file identities while moving projection, connection and file routing keys', () => {
    const f = fixture(); f.add('task'); f.add('other-task', legacy, other);
    const job = { owner, environment: legacy, deviceId: context.deviceId, localSessionId: 'task', sessionId: 'remote-task', localArtifactId: 'artifact',
      queue: [{ publicationId: 'pending-publication', snapshot: { sha256: 'sealed-hash' } }], references: {}, revision: '4' };
    f.put(fileKey(legacy), job);
    f.put('desktopAsset:message:0', { ...job, uploadRequestId: 'same-upload', assetId: 'same-asset' });
    f.put('desktopAsset:other:0', { ...job, owner: other, localSessionId: 'other-task', sessionId: 'remote-other-task' });
    const boundary = { owner, environment: legacy, deviceId: context.deviceId, ordinal: '3', finishedAt: '2026-09-22T00:00:00Z' };
    f.put('fileTerminalBoundary:task:run', boundary);
    for (const prefix of ['projectionMode:', 'questionProjectionMode:projectionMode:', 'retentionFence:']) {
      f.put(scoped(prefix, legacy), prefix === 'retentionFence:' ? { requestId: 'same-fence', expectedFenceVersion: '2' } : true);
    }
    f.put(scoped('projectionMode:', legacy, other), false);
    const ownerSuffix = `${owner.userId}:${owner.scopeKey}`;
    f.put(`deviceConnection:${legacy}:${ownerSuffix}`, { state: 'removed', version: '5' });
    f.put(`deviceConnection:${legacy}:${ownerSuffix}:supported`, true);
    f.put(`deletionCapability:${legacy}:${ownerSuffix}`, true);

    migrateRemoteEnvironment(f, context);
    expect(f.get(fileKey(RemoteEnvironment.Test))).toEqual({ ...job, environment: RemoteEnvironment.Test });
    expect(f.get(fileKey(legacy))).toBeNull();
    expect(f.get('desktopAsset:message:0')).toEqual({ ...job, environment: RemoteEnvironment.Test, uploadRequestId: 'same-upload', assetId: 'same-asset' });
    expect(f.get('desktopAsset:other:0').environment).toBe(legacy);
    expect(f.get('fileTerminalBoundary:task:run')).toEqual({ ...boundary, environment: RemoteEnvironment.Test });
    expect(f.get(scoped('projectionMode:', RemoteEnvironment.Test))).toBe(true);
    expect(f.get(scoped('questionProjectionMode:projectionMode:', RemoteEnvironment.Test))).toBe(true);
    expect(f.get(scoped('retentionFence:', RemoteEnvironment.Test))).toEqual({ requestId: 'same-fence', expectedFenceVersion: '2' });
    expect(f.get(scoped('projectionMode:', legacy, other))).toBe(false);
    expect(f.get(`deviceConnection:${RemoteEnvironment.Test}:${ownerSuffix}`)).toEqual({ state: 'removed', version: '5' });
    expect(f.get(`deviceConnection:${RemoteEnvironment.Test}:${ownerSuffix}:supported`)).toBe(true);
    expect(f.get(`deletionCapability:${RemoteEnvironment.Test}:${ownerSuffix}`)).toBe(true);
    expect(migrateRemoteEnvironment(f, context).stateRecords).toBe(0);
  });

  test('changes only local import and tombstone routing fields, preserving immutable evidence verbatim', () => {
    const f = fixture(); f.add('task');
    const savedImport = { owner, environment: legacy, deviceId: context.deviceId, sessionId: 'remote-task', importId: 'same-import',
      beginAttempted: true, baseSourceSeq: '8', fileSet: 'same-spool', expectedStreamEpoch: 'epoch',
      parts: [{ partNo: 0, payloadHash: 'same-payload-hash', byteSize: 27 }], manifest: { manifestHash: 'same-manifest-hash' } };
    const claim = { target: { ...owner, serviceScope: legacy, localSessionId: 'task' }, requestHash: 'immutable-request-hash',
      receipt: { receiptDigest: 'immutable-receipt' }, permit: { permitId: 'same-permit' } };
    const completion = { owner, serviceScope: legacy, receiptDigest: 'immutable-receipt', sourceSeq: '7' };
    f.put('import:task', savedImport);
    f.put('sessionDeletion:operation:1:claim', claim);
    f.put('localGcDeleted:task', { ...savedImport, localSessionId: 'task', completionReceipt: completion, ackAt: 100, ackSourceSeq: 7 });
    f.put('inputPreparation:pending', { owner, deviceId: context.deviceId, requestHash: 'sealed-input', directoryIdentity: { path: '/old/cache' } });
    f.put('localGcReceipt:proof', { payloadHash: 'sealed-gc-receipt', environment: legacy });
    const unchanged = ['sessionDeletion:operation:1:claim', 'inputPreparation:pending', 'localGcReceipt:proof'].map(key => [key, f.raw(key)]);

    migrateRemoteEnvironment(f, context);
    expect(f.get('import:task')).toEqual({ ...savedImport, environment: RemoteEnvironment.Test });
    expect(f.get('localGcDeleted:task')).toEqual({ ...savedImport, localSessionId: 'task', environment: RemoteEnvironment.Test,
      completionReceipt: completion, ackAt: 100, ackSourceSeq: 7 });
    for (const [key, value] of unchanged) expect(f.raw(key!)).toBe(value);
  });

  test('adds the canonical admission lookup without rewriting association receipts or other accounts', () => {
    const f = fixture();
    const oldKey = payloadHash({ owner, environment: legacy, deviceId: context.deviceId });
    const nextKey = payloadHash({ owner, environment: RemoteEnvironment.Test, deviceId: context.deviceId });
    const admission = { admittedAt: 123, capability: RemoteCapability.AgentOwnershipClaim };
    const admissions = stableJson({ [oldKey]: admission });
    for (const [id, actor] of [['mine', owner], ['other', other]] as const) f.db.prepare('INSERT INTO ownership_association_operations VALUES (?,?,?,?,?,?,?)')
      .run(id, actor.userId, actor.scopeKey, admissions, 'same-manifest', 'same-request', '{"associatedSessionIds":["task"]}');
    const before = f.db.prepare('SELECT * FROM ownership_association_operations WHERE operation_id=?').get('mine') as Record<string, unknown>;

    expect(migrateRemoteEnvironment(f, context).admissions).toBe(1);
    const after = f.db.prepare('SELECT * FROM ownership_association_operations WHERE operation_id=?').get('mine') as Record<string, unknown>;
    expect(after).toEqual({ ...before, remote_admissions_json: stableJson({ [oldKey]: admission, [nextKey]: admission }) });
    expect((f.db.prepare('SELECT remote_admissions_json FROM ownership_association_operations WHERE operation_id=?').get('other') as any).remote_admissions_json).toBe(admissions);
    expect(migrateRemoteEnvironment(f, context).admissions).toBe(0);
  });

  test('retains both records when a canonical key already has different durable work', () => {
    const f = fixture(); f.add('task');
    const job = { owner, environment: legacy, deviceId: context.deviceId, localSessionId: 'task', localArtifactId: 'artifact', queue: ['old-work'] };
    f.put(fileKey(legacy), job);
    f.put(fileKey(RemoteEnvironment.Test), { ...job, environment: RemoteEnvironment.Test, queue: ['current-work'] });
    f.put(scoped('retentionFence:', legacy), { requestId: 'old-request' });
    f.put(scoped('retentionFence:', RemoteEnvironment.Test), { requestId: 'current-request' });
    expect(migrateRemoteEnvironment(f, context).collisions).toBe(2);
    expect(f.get(fileKey(legacy))).toEqual(job);
    expect(f.get(fileKey(RemoteEnvironment.Test)).queue).toEqual(['current-work']);
    expect(f.get(scoped('retentionFence:', legacy))).toEqual({ requestId: 'old-request' });
    expect(f.get(scoped('retentionFence:', RemoteEnvironment.Test))).toEqual({ requestId: 'current-request' });
  });

  test('rolls back the entire migration if a metadata write fails', () => {
    const f = fixture(); f.add('task');
    f.put(scoped('projectionMode:', legacy), true);
    f.put('syncFailure:task', { blocked: true, reason: RemoteRetention.StateConflict });
    f.db.exec("CREATE TRIGGER deny_migration BEFORE INSERT ON remote_state BEGIN SELECT RAISE(ABORT,'storage unavailable'); END;");
    expect(() => migrateRemoteEnvironment(f, context)).toThrow('storage unavailable');
    expect(f.sync('task').sync_environment).toBe(legacy);
    expect(f.get('syncFailure:task')).toEqual({ blocked: true, reason: RemoteRetention.StateConflict });
    expect(f.get(scoped('projectionMode:', legacy))).toBe(true);
    expect(f.get(scoped('projectionMode:', RemoteEnvironment.Test))).toBeNull();
  });

  test('retains accepted custom aliases so immutable proof scopes remain comparable only for their identity and mode', () => {
    const f = fixture();
    const custom = 'https://test-api.example.net', secondAlias = 'http://127.0.0.1:8080';
    f.add('task', custom);
    const proof = { target: { ...owner, deviceId: context.deviceId, serviceScope: custom }, receiptDigest: 'unchanged-proof' };
    f.put('sessionDeletion:proof', proof);
    const before = f.raw('sessionDeletion:proof');
    expect(samePersistedRemoteEnvironment(f, context, custom, RemoteEnvironment.Test)).toBe(false);

    migrateRemoteEnvironment(f, { ...context, legacyEnvironments: [custom] });
    migrateRemoteEnvironment(f, { ...context, legacyEnvironments: [secondAlias] });
    expect(f.raw('sessionDeletion:proof')).toBe(before);
    expect(samePersistedRemoteEnvironment(f, context, custom, RemoteEnvironment.Test)).toBe(true);
    expect(samePersistedRemoteEnvironment(f, context, custom, secondAlias)).toBe(true);
    expect(samePersistedRemoteEnvironment(f, context, custom, RemoteEnvironment.Production)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, context, custom, production)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, { ...context, owner: other }, custom, RemoteEnvironment.Test)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, { ...context, deviceId: 'other-desktop' }, custom, RemoteEnvironment.Test)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, context, legacy, RemoteEnvironment.Test)).toBe(true);
    expect(migrateRemoteEnvironment(f, { ...context, legacyEnvironments: [custom, secondAlias] }).stateRecords).toBe(0);
  });

  test('does not conflate modes when the same custom URL has been accepted separately in each mode', () => {
    const f = fixture(), custom = 'https://shared-address.example.net';
    migrateRemoteEnvironment(f, { ...context, legacyEnvironments: [custom] });
    migrateRemoteEnvironment(f, { ...context, environment: RemoteEnvironment.Production, legacyEnvironments: [custom] });
    expect(samePersistedRemoteEnvironment(f, context, custom, RemoteEnvironment.Test)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, context, custom, RemoteEnvironment.Production)).toBe(false);
    expect(samePersistedRemoteEnvironment(f, context, RemoteEnvironment.Test, RemoteEnvironment.Production)).toBe(false);
  });
});
