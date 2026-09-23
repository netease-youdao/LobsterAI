import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { afterEach, describe, expect, test } from 'vitest';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteEnvironment } from '../../shared/remote/environment';
import { RemoteRetention, type RetentionState } from '../../shared/remote/retention';
import { RemoteSyncTarget, type RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { stableJson } from './canonical';
import { RemoteStore } from './remoteStore';
import { RemoteSyncAdmissionBudgetError } from './remoteSyncAdmission';
import { archivedRemoteSyncReferences, RemoteSyncTargetActivationKind, remoteSyncTargetId, RemoteSyncTargetStore } from './remoteSyncTargetStore';

const owner = { userId: 'user', scopeKey: 'personal' }, other = { userId: 'other', scopeKey: 'personal' };
const spaceA: RemoteSyncTargetIdentity = { version: RemoteSyncTarget.Version, dataSpaceId: 'a', dataGeneration: '1' };
const spaceB: RemoteSyncTargetIdentity = { ...spaceA, dataSpaceId: 'b' };
const input = (syncTarget = spaceA, actor = owner) => ({ syncTarget, owner: actor, deviceId: `device-${syncTarget.dataSpaceId}` });
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT,thinking_level TEXT);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, restoreRuns: false });
  const targets = new RemoteSyncTargetStore(store);
  const add = (id = 's', actor: RemoteOwner = owner) => store.transaction(() => {
    db.prepare("INSERT INTO cowork_sessions(id,title,created_at,updated_at,status) VALUES (?,?,1,1,'idle')").run(id, id); store.assignNew(id, actor, 'local_create');
  });
  const activate = (target = spaceA, options: { bootstrap?: boolean; legacyStates?: RetentionState[]; allowPartialLegacy?: boolean } = {}) => {
    const result = targets.activate({ ...input(target), ...options });
    store.setProjectionIdentity(result.targetId, owner, result.deviceId); store.setEnabledOwner(owner);
    return result;
  };
  const bind = (id = 's', environment = 'https://former.example') => db.prepare(`UPDATE remote_sync SET device_id='device-a',source_seq=8,ack_seq=5,server_seq='12',
    sync_environment=?,sync_protocol_version=?,stream_epoch='epoch-a',source_purge_seq='2',event_purge_seq='3',needs_snapshot=0 WHERE local_id=?`)
    .run(environment, RemoteRetention.Version, id);
  const proof = (id = 's'): RetentionState => {
    const row = store.sync(id)!;
    return { localSessionId: id, deviceId: row.device_id, sessionId: row.session_id, syncProtocolVersion: row.sync_protocol_version,
      streamEpoch: row.stream_epoch, lastSourceSeq: String(row.ack_seq), lastSeq: row.server_seq, sourcePurgeSeq: row.source_purge_seq, eventPurgeSeq: row.event_purge_seq };
  };
  return { db, store, targets, add, activate, bind, proof };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe('active synchronization target working sets', () => {
  test('claims published legacy state only after continuity proof and never turns GET state into an ACK', () => {
    const f = fixture(); f.add(); f.bind();
    f.store.put('import:s', { importId: 'immutable-import', environment: 'https://former.example', owner, manifest: { manifestHash: 'immutable' } });
    f.store.put('inbox:command', { owner, localSessionId: 's', remoteSessionId: f.store.sync('s')!.session_id, state: 'executing', command: { commandId: 'command' } });
    f.store.put('settings:user:personal', { enabled: true, settingsVersion: '8' });
    f.store.put('controlQueue:user:personal', { id: 'original-control' });
    const rawImport = f.db.prepare("SELECT value FROM remote_state WHERE key='import:s'").get();
    expect(() => f.activate()).toThrow('verified state');
    expect(f.targets.active(owner)).toBeNull();
    const result = f.activate(spaceA, { legacyStates: [{ ...f.proof(), lastSourceSeq: '7' }] });
    expect(result.kind).toBe(RemoteSyncTargetActivationKind.Claimed);
    expect(f.store.sync('s')!.ack_seq).toBe(5);
    expect(f.store.sync('s')!.sync_environment).toBe(result.targetId);
    expect(f.targets.matchesEnvironment(result.targetId, 'https://former.example')).toBe(true);
    expect(f.db.prepare("SELECT value FROM remote_state WHERE key='import:s'").get()).toEqual(rawImport);
    expect(f.store.get<any>('inbox:command').targetId).toBe(result.targetId);
    expect(f.store.get(`settings:${result.targetId}:user:personal`)).toEqual({ enabled: true, settingsVersion: '8' });
    expect(f.store.get(`controlQueue:${result.targetId}:user:personal`)).toEqual({ id: 'original-control' });
  });

  test('inherits only persisted owner and device aliases and preserves pending protocol metadata', () => {
    const f = fixture(); f.add(); f.bind('s', RemoteEnvironment.Test);
    const alias = 'https://old-entry.example';
    f.store.put(`remoteEnvironmentAliases:${JSON.stringify([RemoteEnvironment.Test, owner.userId, owner.scopeKey, 'device-a'])}`, [alias]);
    f.store.put(`remoteEnvironmentAliases:${JSON.stringify([RemoteEnvironment.Test, other.userId, owner.scopeKey, 'device-a'])}`, ['https://other-owner.example']);
    f.store.put(`remoteEnvironmentAliases:${JSON.stringify([RemoteEnvironment.Test, owner.userId, owner.scopeKey, 'another-device'])}`, ['https://other-device.example']);
    for (const prefix of ['projectionMode:', 'questionProjectionMode:projectionMode:', 'retentionFence:']) {
      f.store.put(`${prefix}${JSON.stringify([RemoteEnvironment.Test, owner.userId, owner.scopeKey, 'device-a'])}`, prefix === 'retentionFence:' ? { requestId: 'original-fence', expectedFenceVersion: '5' } : true);
    }
    const target = f.activate(spaceA, { legacyStates: [f.proof()] });
    expect(f.targets.matchesEnvironment(target.targetId, alias)).toBe(true);
    expect(f.targets.matchesEnvironment(target.targetId, 'https://other-owner.example')).toBe(false);
    expect(f.targets.matchesEnvironment(target.targetId, 'https://other-device.example')).toBe(false);
    expect(f.targets.matchesEnvironment(target.targetId, 'https://lobsterai-server-dev.inner.youdao.com')).toBe(false);
    for (const prefix of ['projectionMode:', 'questionProjectionMode:projectionMode:', 'retentionFence:']) expect(f.store.get(`${prefix}${JSON.stringify([target.targetId, owner.userId, owner.scopeKey, 'device-a'])}`))
      .toEqual(prefix === 'retentionFence:' ? { requestId: 'original-fence', expectedFenceVersion: '5' } : true);
  });

  test('does not require proofs for quarantined sessions or move their persisted work', () => {
    const f = fixture(); f.add(); f.bind(); f.add('quarantined'); f.bind('quarantined');
    f.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined' WHERE session_id='quarantined'").run();
    const original = f.store.sync('quarantined'); f.store.put('import:quarantined', { importId: 'do-not-touch' });
    f.activate(spaceA, { legacyStates: [f.proof()] }); f.activate(spaceB, { bootstrap: true });
    expect(f.store.sync('quarantined')).toEqual(original); expect(f.store.get('import:quarantined')).toEqual({ importId: 'do-not-touch' });
  });

  test('uses exact original sequences, event bytes and pending imports after A to B to A', () => {
    const f = fixture(); f.add(); const first = f.activate(); f.bind('s', first.targetId);
    const original = f.store.sync('s')!;
    const event = '{ "eventId": "original", "sourceSeq": "6", "payload": {"text":"first"} }';
    f.db.prepare('INSERT INTO remote_outbox VALUES (?,?,?)').run('s', 6, event);
    f.store.put('import:s', { importId: 'pending', fileSet: 'spool-a', expectedStreamEpoch: 'epoch-a', parts: [{ payloadHash: 'sealed' }], environment: first.targetId });
    f.store.put('desktopAsset:m:0', { localSessionId: 's', owner, environment: first.targetId, uploadRequestId: 'upload-a', snapshot: { path: '/cache/a' } });
    f.store.put('sessionDeletion:operation', { target: { serviceScope: first.targetId }, receiptDigest: 'immutable-deletion' });
    f.store.put('inbox:old', { owner, state: 'executing', targetId: first.targetId });
    const rawImport = f.db.prepare("SELECT value FROM remote_state WHERE key='import:s'").get();
    const second = f.activate(spaceB, { bootstrap: true });
    expect(second.kind).toBe(RemoteSyncTargetActivationKind.Created);
    expect(f.store.sync('s')).toMatchObject({ source_seq: 0, ack_seq: 0, server_seq: '0', stream_epoch: null, device_id: 'device-b' });
    expect(f.store.sync('s')!.session_id).not.toBe(original.session_id);
    expect(f.store.pending('s')).toEqual([]); expect(f.store.get('import:s')).toBeNull();
    expect(f.store.get('desktopAsset:m:0')).toBeNull();
    expect(f.store.get<any>('inbox:old').targetId).toBe(first.targetId);
    expect(f.store.get('sessionDeletion:operation')).toEqual({ target: { serviceScope: first.targetId }, receiptDigest: 'immutable-deletion' });
    expect(archivedRemoteSyncReferences(f.store)).toEqual({ paths: new Set(['/cache/a']), importFileSets: new Set(['spool-a']) });
    f.store.put('import:s', { importId: 'pending-b', fileSet: 'spool-b' });
    const restored = f.activate(spaceA);
    expect(restored.kind).toBe(RemoteSyncTargetActivationKind.Restored);
    expect(f.store.sync('s')).toEqual({ ...original, needs_snapshot: 1 });
    expect(f.db.prepare('SELECT event_json FROM remote_outbox').get()).toEqual({ event_json: event });
    expect(f.db.prepare("SELECT value FROM remote_state WHERE key='import:s'").get()).toEqual(rawImport);
    expect(f.store.get<any>('desktopAsset:m:0').uploadRequestId).toBe('upload-a');
    expect(archivedRemoteSyncReferences(f.store).importFileSets).toEqual(new Set(['spool-b']));
  });

  test('keeps aliases on one target without replacing mappings or requiring a fresh snapshot', () => {
    const f = fixture(); f.add(); const first = f.activate(); f.bind('s', first.targetId);
    const previous = f.store.sync('s');
    expect(f.activate().kind).toBe(RemoteSyncTargetActivationKind.Unchanged);
    expect(f.store.sync('s')).toEqual(previous);
    expect(f.targets.active(owner)!.epoch).toBe(first.epoch);
  });

  test('restores reply bodies and sha256 columns byte for byte after switching A to B to A', () => {
    const f = fixture(); f.add(); f.activate();
    const body = '完整回复正文 🦞\r\n```json\n{"message":"保留空白  和引号"}\n```\n';
    const bodyBytes = Buffer.from(body, 'utf8');
    const sha256 = createHash('sha256').update(bodyBytes).digest('hex');
    const chunks = `[{ "sha256": "${sha256}", "sizeBytes": "${bodyBytes.length}" }]`;
    f.db.prepare('INSERT INTO remote_reply_contents VALUES (?,?,?,?,?,?,?,?,?)')
      .run('s', 'content-a', 3, 'message-a', 'block-a', 'markdown', sha256, chunks, bodyBytes.length);
    f.db.prepare('INSERT INTO remote_reply_chunks VALUES (?,?,?,?)').run('s', sha256, body, bodyBytes.length);
    const contents = f.db.prepare('SELECT * FROM remote_reply_contents').all();
    const storedChunks = f.db.prepare('SELECT * FROM remote_reply_chunks').all();

    f.activate(spaceB, { bootstrap: true });
    expect(f.db.prepare('SELECT * FROM remote_reply_contents').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM remote_reply_chunks').all()).toEqual([]);
    f.activate(spaceA);

    expect(f.db.prepare('SELECT * FROM remote_reply_contents').all()).toEqual(contents);
    expect(f.db.prepare('SELECT * FROM remote_reply_chunks').all()).toEqual(storedChunks);
    const restored = f.db.prepare('SELECT content,sha256,size_bytes FROM remote_reply_chunks').get() as { content: string; sha256: string; size_bytes: number };
    expect(Buffer.from(restored.content, 'utf8')).toEqual(bodyBytes);
    expect(createHash('sha256').update(Buffer.from(restored.content, 'utf8')).digest('hex')).toBe(restored.sha256);
    expect(restored.size_bytes).toBe(bodyBytes.length);
  });

  test('cannot bootstrap unknown legacy history even when a new registration returns a different device', () => {
    const f = fixture(); f.add(); f.bind();
    f.store.put('import:s', { importId: 'old-unknown', fileSet: 'old-parts' });
    f.store.put('inbox:old', { owner, state: 'unknown' });
    const old = f.store.sync('s')!;
    expect(() => f.activate(spaceB, { bootstrap: true })).toThrow('verified state');
    expect(f.store.sync('s')).toEqual(old); expect(f.targets.active(owner)).toBeNull();
    expect(f.store.get('import:s')).toEqual({ importId: 'old-unknown', fileSet: 'old-parts' });
    expect(f.store.get('inbox:old')).toEqual({ owner, state: 'unknown' });
  });

  test('legacy servers require state proof and may upgrade without rewriting pending imports', () => {
    const f = fixture(); f.add(); f.bind();
    const legacy = f.targets.activateLegacy({ owner, deviceId: 'device-a', legacyStates: [f.proof()] });
    expect(legacy.targetId).toMatch(/^legacy:/u);
    f.store.put('inbox:c', { owner, targetId: legacy.targetId });
    f.store.put('import:s', { environment: legacy.targetId, importId: 'pending' });
    const upgraded = f.activate(spaceA, { legacyStates: [f.proof()] });
    expect(upgraded.kind).toBe(RemoteSyncTargetActivationKind.Claimed);
    expect(f.targets.matchesEnvironment(upgraded.targetId, legacy.targetId)).toBe(true);
    expect(f.store.get<any>('import:s').environment).toBe(legacy.targetId);
    expect(f.store.get<any>('inbox:c').targetId).toBe(upgraded.targetId);
    expect(() => f.targets.activateLegacy({ owner, deviceId: 'device-a', legacyStates: [f.proof()] })).toThrow('downgraded');
  });

  test('upgrades the latest legacy settings and operation routing without reviving stale account defaults', () => {
    const f = fixture(); f.add(); f.bind();
    f.store.put('settings:user:personal', { enabled: true, settingsVersion: '1' });
    const legacy = f.targets.activateLegacy({ owner, deviceId: 'device-a', legacyStates: [f.proof()] });
    f.store.put(`settings:${legacy.targetId}:user:personal`, { enabled: false, settingsVersion: '9' });
    f.store.put(`agentCatalogFailure:${legacy.targetId}:user:personal:device-a`, { code: 47019 });
    const entry = { owner, targetId: legacy.targetId, localSessionId: 's', remoteSessionId: f.store.sync('s')!.session_id,
      command: { commandId: 'command', claimId: 'claim', request: { payload: { text: 'original' } } }, state: 'unknown' };
    f.store.put(`inbox:${legacy.targetId}:command`, entry);
    f.store.put(`inputOperation:${legacy.targetId}:command`, { phase: 'model_applied', afterVersion: '3' });
    f.store.put('inputFence:s', { operationId: 'command', syncTargetId: legacy.targetId, target: { inputModel: 'original-model' } });
    const upgraded = f.activate(spaceA, { legacyStates: [f.proof()] });
    expect(f.store.get(`settings:${upgraded.targetId}:user:personal`)).toEqual({ enabled: false, settingsVersion: '9' });
    expect(f.store.get(`agentCatalogFailure:${upgraded.targetId}:user:personal:device-a`)).toEqual({ code: 47019 });
    expect(f.store.get(`inbox:${legacy.targetId}:command`)).toBeNull();
    expect(f.store.get(`inbox:${upgraded.targetId}:command`)).toEqual({ ...entry, targetId: upgraded.targetId });
    expect(f.store.get(`inputOperation:${legacy.targetId}:command`)).toBeNull();
    expect(f.store.get(`inputOperation:${upgraded.targetId}:command`)).toEqual({ phase: 'model_applied', afterVersion: '3' });
    expect(f.store.get<any>('inputFence:s')).toMatchObject({ syncTargetId: upgraded.targetId, target: { inputModel: 'original-model' } });
  });

  test('rejects regressed, ahead, wrong-device and wrong-epoch legacy state', () => {
    const f = fixture(); f.add(); f.bind();
    for (const change of [{ lastSourceSeq: '4' }, { lastSourceSeq: '9' }, { lastSeq: '11' }, { deviceId: 'wrong' }, { streamEpoch: 'wrong' }]) {
      expect(() => f.activate(spaceA, { legacyStates: [{ ...f.proof(), ...change }] })).toThrow('verified state');
      expect(f.targets.active(owner)).toBeNull();
    }
  });

  test('does not attach orphaned or differently mapped legacy commands to a newly verified target', () => {
    const f = fixture(); f.add(); f.bind();
    const orphan = { owner, localSessionId: null, remoteSessionId: null, state: 'unknown', command: { commandId: 'create' } };
    const mismatch = { ...orphan, localSessionId: 's', remoteSessionId: 'another-remote-session' };
    f.store.put('inbox:orphan', orphan); f.store.put('inbox:mismatch', mismatch);
    f.activate(spaceA, { legacyStates: [f.proof()] });
    expect(f.store.get('inbox:orphan')).toEqual(orphan); expect(f.store.get('inbox:mismatch')).toEqual(mismatch);
    const empty = fixture(); empty.store.put('inbox:orphan', orphan); empty.activate();
    expect(empty.store.get('inbox:orphan')).toEqual(orphan);
  });

  test('does not reinterpret a restored data generation as an independently empty service', () => {
    const f = fixture(); f.add(); f.activate();
    expect(() => f.activate({ ...spaceA, dataGeneration: '2' }, { bootstrap: true })).toThrow('generation requires recovery');
    expect(f.targets.active(owner)!.targetId).toBe(remoteSyncTargetId(spaceA, owner));
  });

  test('switches only the current owner and never creates a fresh mapping for a local deletion', () => {
    const f = fixture(); f.add(); f.add('other', other); f.activate();
    const unrelated = f.store.sync('other');
    f.store.put('localGcDeleted:s', { owner, localSessionId: 's', completionReceipt: { receiptDigest: 'keep' } });
    f.activate(spaceB, { bootstrap: true });
    expect(f.store.sync('other')).toEqual(unrelated); expect(f.store.sync('s')).toBeNull();
    expect(f.store.get<any>('localGcDeleted:s').completionReceipt.receiptDigest).toBe('keep');
  });

  test('rolls back archives, working sets, execution tags and active identity together on disk failure', () => {
    const f = fixture(); f.add(); const first = f.activate(); f.bind('s', first.targetId);
    f.store.put('import:s', { importId: 'keep' }); const original = f.store.sync('s');
    f.db.exec("CREATE TRIGGER fail_target BEFORE INSERT ON remote_sync WHEN NEW.device_id='device-b' BEGIN SELECT RAISE(ABORT,'disk unavailable'); END;");
    expect(() => f.activate(spaceB, { bootstrap: true })).toThrow('disk unavailable');
    expect(f.targets.active(owner)!.targetId).toBe(first.targetId); expect(f.store.sync('s')).toEqual(original);
    expect(f.store.get('import:s')).toEqual({ importId: 'keep' });
    expect(f.db.prepare('SELECT count(*) AS n FROM remote_sync_target_archives').get()).toEqual({ n: 0 });
  });

  test('new target preserves history text without old execution, input or attachment identities', () => {
    const f = fixture(); f.add(); const first = f.activate();
    const run = f.store.beginRun('s', 'old-run', 'old-command');
    f.store.put(`inputRun:${run.runId}`, { input: { text: 'original input', attachments: [{ assetId: 'old-asset', version: '1', fileName: 'source.pdf' }] }, inputModel: { candidateId: 'old-model' } });
    f.store.put('workspace:s', 'old-workspace'); f.store.put('inputModel:s', { candidateId: 'old-model' });
    f.store.put(`approval:s:approval`, { approvalId: 'approval', runId: run.runId, status: 'pending', remoteAllowed: true });
    f.store.transaction(() => f.db.prepare("INSERT INTO cowork_messages VALUES ('m','s','user','raw prompt',?,2,1)")
      .run(stableJson({ remoteRunId: run.runId, remoteCommandId: 'old-command' })));
    f.store.transaction(() => f.db.prepare("INSERT INTO cowork_messages VALUES ('orphan','s','assistant','orphan history',?,3,2)")
      .run(stableJson({ remoteCommandId: 'old-command-without-run' })));
    f.activate(spaceB, { bootstrap: true });
    f.store.setInputProjectionSupported(true); f.store.project('s');
    const snapshot = f.store.snapshot('s');
    const message = snapshot.records.find(record => record.eventType === 'message.upsert')!.payload.message;
    expect(message.blocks[0].text).toBe('original input');
    expect(message.blocks[1].text).toContain('source.pdf');
    expect(message.runId).toBeNull(); expect(message.commandId).toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/old-asset|old-model|old-workspace|old-command/u);
    expect(snapshot.records.some(record => ['run.updated', 'approval.updated'].includes(record.eventType))).toBe(false);
    expect(snapshot.records.find(record => record.payload.message?.messageId === 'orphan')!.payload.message.commandId).toBeNull();
    expect(f.store.run('s')!.runId).toBe(run.runId);
    expect(f.store.get(`syncRunTarget:${run.runId}`)).toBe(first.targetId);
    expect(f.store.get<any>(`approval:s:approval`).remoteAllowed).toBe(true);
  });

  test('does not publish an old worker after A to B to A even when the target and source position match again', () => {
    const f = fixture(); f.add(); f.activate();
    const work = f.store.nextProjectionWork()!; expect(work).not.toBeNull();
    f.activate(spaceB, { bootstrap: true }); f.activate(spaceA);
    expect(f.store.projectionWorkCurrent(work)).toBe(false);
  });

  test('synchronizes the local deletion back to A without applying the closing receipt or ACK from B', () => {
    const f = fixture(); f.add(); const first = f.activate(); f.bind('s', first.targetId);
    const before = f.store.sync('s')!;
    f.store.put('import:s', { importId: 'pending-a', expectedStreamEpoch: before.stream_epoch, environment: first.targetId });
    f.db.prepare('INSERT INTO remote_projection VALUES (?,?,?,?,?)').run('s', 'session', 'old', 1, stableJson({ eventType: 'session.upsert', payload: { session: { title: 'historical' } } }));
    f.activate(spaceB, { bootstrap: true });
    const second = f.store.sync('s')!;
    const closed = { receiptId: 'b-receipt', receiptDigest: 'b-hash', ackSourceSeq: 0 };
    f.store.put('deletionClosed:s', closed);
    f.store.put('localGcDeleted:s', { owner, localSessionId: 's', sessionId: second.session_id, deviceId: second.device_id,
      environment: second.sync_environment, streamEpoch: second.stream_epoch, completionReceipt: { receiptDigest: 'b-hash' } });
    f.store.transaction(() => f.db.prepare("DELETE FROM cowork_sessions WHERE id='s'").run());
    expect(f.store.isSyncClosed('s')).toBe(true);
    f.activate(spaceA);
    expect(f.store.isSyncClosed('s')).toBe(false);
    expect(f.store.nextProjectionWork()?.sessionId).toBe('s');
    f.store.project('s');
    expect(f.store.snapshot('s').records.map(record => record.eventType)).toEqual(['session.deleted']);
    expect(f.store.sync('s')!.ack_seq).toBe(before.ack_seq);
    expect(f.store.sync('s')!.stream_epoch).toBe(before.stream_epoch);
    expect(f.store.get<any>('import:s').importId).toBe('pending-a');
    expect(f.store.get('deletionClosed:s')).toEqual(closed);
    expect(() => f.store.assertNoDeletionEffect('s')).toThrow('DELETION_IN_PROGRESS');
  });

  test('never restores an archived mapping into a session now owned by another account', () => {
    const f = fixture(); f.add(); f.activate(); f.activate(spaceB, { bootstrap: true });
    f.db.prepare("UPDATE cowork_session_ownership SET owner_user_id=? WHERE session_id='s'").run(other.userId);
    const mapping = f.store.sync('s');
    expect(() => f.activate(spaceA)).toThrow('ownership changed');
    expect(f.targets.active(owner)!.targetId).toBe(remoteSyncTargetId(spaceB, owner));
    expect(f.store.sync('s')).toEqual(mapping);
  });

  test('refuses missing or damaged recovery archives instead of assigning replacement session ids', () => {
    for (const damage of ['manifest', 'row', 'content']) {
      const f = fixture(); f.add(); const first = f.activate(); f.activate(spaceB, { bootstrap: true });
      const active = f.store.sync('s');
      if (damage === 'manifest') f.db.prepare('DELETE FROM remote_sync_target_archive_manifests WHERE target_id=?').run(first.targetId);
      else if (damage === 'row') f.db.prepare("DELETE FROM remote_sync_target_archives WHERE target_id=? AND table_name='remote_sync'").run(first.targetId);
      else f.db.prepare("UPDATE remote_sync_target_archives SET row_json='{}' WHERE target_id=? AND table_name='remote_sync'").run(first.targetId);
      expect(() => f.activate(spaceA)).toThrow('archive is missing or damaged');
      expect(f.store.sync('s')).toEqual(active); expect(f.targets.active(owner)!.targetId).toBe(remoteSyncTargetId(spaceB, owner));
    }
  });

  test('distinguishes a valid empty archive from missing recovery evidence and initializes only later local sessions', () => {
    const f = fixture(); const first = f.activate(); f.activate(spaceB, { bootstrap: true });
    expect(f.db.prepare('SELECT row_count FROM remote_sync_target_archive_manifests WHERE target_id=?').get(first.targetId)).toEqual({ row_count: 0 });
    f.add('later');
    expect(f.activate(spaceA).kind).toBe(RemoteSyncTargetActivationKind.Restored);
    expect(f.store.sync('later')).toMatchObject({ device_id: 'device-a', source_seq: 0, ack_seq: 0, sync_environment: first.targetId });
  });
});


describe('per-session synchronization admission', () => {
  test('keeps unverified legacy bytes while independently admitting a verified task', () => {
    const f = fixture(); f.add('good'); f.add('bad'); f.bind('good'); f.bind('bad');
    f.store.put('import:bad', { importId: 'original', fileSet: 'bad-spool' });
    f.db.prepare('INSERT INTO remote_projection_publications VALUES (?,?,?,?,?)').run('bad', '/private/bad-publication', 5, 1, 'hash');
    const before = f.store.sync('bad');
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof('good')] });
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'good')).toBe(true);
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'bad')).toBe(false);
    expect(f.store.sync('bad')).toEqual(before); expect(f.store.sync('good')!.ack_seq).toBe(5);
    expect(f.targets.hasPendingAdmissions(owner, target.targetId)).toBe(true);
    expect(archivedRemoteSyncReferences(f.store).importFileSets.has('bad-spool')).toBe(true);
    expect(archivedRemoteSyncReferences(f.store).paths.has('/private/bad-publication')).toBe(true);
    expect(archivedRemoteSyncReferences(f.store, true).paths.has('/private/bad-publication')).toBe(true);
    expect(archivedRemoteSyncReferences(f.store, true).importFileSets.size).toBe(0);
    const evidence = f.db.prepare('SELECT row_json FROM remote_sync_admission_evidence WHERE table_name=? AND row_key=?').get('remote_state', 'import:bad');
    f.targets.admitLegacySession(owner, 'device-a', target.targetId, f.proof('bad'));
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'bad')).toBe(true);
    expect(f.store.sync('bad')!.ack_seq).toBe(5); expect(f.store.get('import:bad')).toEqual({ importId: 'original', fileSet: 'bad-spool' });
    expect(f.db.prepare('SELECT row_json FROM remote_sync_admission_evidence WHERE table_name=? AND row_key=?').get('remote_state', 'import:bad')).toEqual(evidence);
    expect(f.targets.hasPendingAdmissions(owner, target.targetId)).toBe(false);
  });

  test('quarantines malformed task evidence without retagging its run or stopping another task', () => {
    const f = fixture(); f.add('good'); f.add('bad'); f.bind('good'); f.bind('bad');
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run('run:bad', '{damaged');
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof('bad'), f.proof('good')] });
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'good')).toBe(true);
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'bad')).toBe(false);
    expect(f.store.sync('bad')!.sync_environment).toBe('https://former.example');
    expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get('run:bad')).toEqual({ value: '{damaged' });
    expect(f.db.prepare('SELECT admission FROM remote_sync_session_admissions WHERE local_session_id=?').get('bad')).toEqual({ admission: 'quarantined' });
  });

  test('transfers only the verified task inbox and file routing with the admission transaction', () => {
    const f = fixture(); f.add('good'); f.add('bad'); f.bind('good'); f.bind('bad');
    for (const localSessionId of ['good', 'bad']) {
      f.store.put(`inbox:${localSessionId}`, { owner, localSessionId, remoteSessionId: f.store.sync(localSessionId)!.session_id,
        state: 'unknown', command: { commandId: localSessionId } });
      f.store.put(`desktopAsset:${localSessionId}:0`, { owner, localSessionId, deviceId: 'device-a', environment: 'https://former.example', uploadRequestId: `original-${localSessionId}` });
    }
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof('good')] });
    expect(f.store.get<any>('inbox:good').targetId).toBe(target.targetId);
    expect(f.store.get<any>('inbox:bad').targetId).toBeUndefined();
    expect(f.store.get<any>('desktopAsset:good:0').environment).toBe(target.targetId);
    expect(f.store.get<any>('desktopAsset:bad:0').environment).toBe('https://former.example');
  });

  test('an unattributable malformed inbox closes the control dependency without stopping verified content', () => {
    const f = fixture(); f.add(); f.bind();
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run('inbox:unattributable', '{damaged');
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof()] });
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 's')).toBe(true);
    expect(f.targets.controlAdmissionBlocked(owner, target.targetId)).toBe(true);
    expect(() => archivedRemoteSyncReferences(f.store)).toThrow();
    expect(() => archivedRemoteSyncReferences(f.store, true)).not.toThrow();
    expect(f.db.prepare('SELECT value FROM remote_state WHERE key=?').get('inbox:unattributable')).toEqual({ value: '{damaged' });
  });

  test('does not archive or impose control barriers from another identified account target', () => {
    const f = fixture(); f.add(); f.bind();
    const otherTarget = f.targets.activate({ ...input(spaceA, other), allowPartialLegacy: true });
    const key = `inbox:${otherTarget.targetId}:other`;
    f.db.prepare('INSERT INTO remote_state VALUES (?,?)').run(key, '{damaged');
    f.store.put('inbox:other-owner', { owner: other, localSessionId: null, command: { commandId: 'other' } });
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof()] });
    expect(f.targets.controlAdmissionBlocked(owner, target.targetId)).toBe(false);
    expect(f.db.prepare('SELECT 1 FROM remote_sync_admission_evidence WHERE archive_id=? AND row_key=?').get(`admission:${target.targetId}`, key)).toBeUndefined();
  });

  test('missing admission evidence is not interpreted as a successful legacy verification', () => {
    const f = fixture(); f.add(); f.bind();
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof()] });
    f.db.prepare('DELETE FROM remote_sync_session_admissions WHERE local_session_id=?').run('s');
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 's')).toBe(false);
    expect(f.targets.hasPendingAdmissions(owner, target.targetId)).toBe(true);
    f.add('new-local');
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 'new-local')).toBe(true);
  });

  test('pages pending admissions without hiding clean legacy tasks or losing missing ledger rows', () => {
    const f = fixture();
    for (let i = 0; i < 55; i++) { const id = `task-${String(i).padStart(2, '0')}`; f.add(id); f.bind(id); }
    const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof('task-01')] });
    f.db.prepare('DELETE FROM remote_sync_session_admissions WHERE local_session_id=?').run('task-00');
    const first = f.targets.pendingAdmissionSessionIds(owner, target.targetId, '', 1000);
    expect(first).toHaveLength(50); expect(first[0]).toBe('task-00'); expect(first).not.toContain('task-01');
    const second = f.targets.pendingAdmissionSessionIds(owner, target.targetId, first[first.length - 1]);
    expect(second).toEqual(['task-51', 'task-52', 'task-53', 'task-54']);
    expect(f.targets.pendingAdmissionSessionIds(other, target.targetId)).toEqual([]);
  });

  test('never admits a service active import without its original local operation', () => {
    for (const known of [false, true]) {
      const f = fixture(); f.add(); f.bind();
      const proof = { ...f.proof(), activeImport: { importId: 'original' } };
      if (known) f.store.put('import:s', { importId: 'original', beginAttempted: true });
      const target = f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [proof] });
      expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 's')).toBe(known);
      expect(f.store.sync('s')!.ack_seq).toBe(5);
    }
  });

  test.each(['rows', 'bytes'])('defers oversized legacy admission before changing original evidence (%s)', mode => {
    const f = fixture(); f.add(); f.bind(); const before = f.store.sync('s');
    if (mode === 'rows') f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2001)
      INSERT INTO remote_state SELECT 'budget:'||x, '{}' FROM n`);
    else f.store.put('import:s', { original: 'x'.repeat(1024 * 1024) });
    const originalCount = f.db.prepare('SELECT count(*) AS n FROM remote_state').get();
    let failure: unknown;
    try { f.activate(spaceA, { allowPartialLegacy: true }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(RemoteSyncAdmissionBudgetError);
    expect((failure as RemoteSyncAdmissionBudgetError).targetId).toBe(remoteSyncTargetId(spaceA, owner));
    expect(f.targets.active(owner)).toBeNull(); expect(f.store.sync('s')).toEqual(before);
    expect(f.db.prepare('SELECT count(*) AS n FROM remote_state').get()).toEqual(originalCount);
    expect(f.db.prepare('SELECT count(*) AS n FROM remote_sync_admission_evidence').get()).toEqual({ n: 0 });
  });

  test.each(['remote_sync_target_archives', 'remote_sync_admission_evidence'])('does not treat malformed archived publication paths as unreferenced (%s)', table => {
    const f = fixture();
    for (const path of [undefined, null, 42, 'relative/staging']) {
      const row = path === undefined ? { session_id: 's' } : { session_id: 's', path };
      f.db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?,?,?,?)`).run('target', 'remote_projection_publications', 1, stableJson(row));
      expect(() => archivedRemoteSyncReferences(f.store)).toThrow('publication path is invalid');
    }
  });

  test('partial admission rolls back evidence, mapping and target together on persistence failure', () => {
    const f = fixture(); f.add(); f.bind(); const before = f.store.sync('s');
    f.db.exec("CREATE TRIGGER fail_admission BEFORE UPDATE ON remote_sync_session_admissions BEGIN SELECT RAISE(ABORT,'disk unavailable'); END;");
    expect(() => f.activate(spaceA, { allowPartialLegacy: true, legacyStates: [f.proof()] })).toThrow('disk unavailable');
    expect(f.targets.active(owner)).toBeNull(); expect(f.store.sync('s')).toEqual(before);
    expect(f.db.prepare('SELECT count(*) AS n FROM remote_sync_admission_evidence').get()).toEqual({ n: 0 });
  });

  test('does not reinterpret unverified legacy history during a target switch', () => {
    const f = fixture(); f.add(); f.bind(); const before = f.store.sync('s');
    const target = f.activate(spaceA, { allowPartialLegacy: true });
    expect(() => f.activate(spaceB, { bootstrap: true, allowPartialLegacy: true })).toThrow('Unverified synchronization history');
    expect(f.targets.active(owner)!.targetId).toBe(target.targetId); expect(f.store.sync('s')).toEqual(before);
    expect(f.activate(spaceA, { allowPartialLegacy: true }).kind).toBe(RemoteSyncTargetActivationKind.Unchanged);
  });

  test('admits truly local execution without inventing a remote receipt', () => {
    const f = fixture(); f.add(); f.store.beginRun('s', 'local-run');
    const target = f.activate(spaceA, { allowPartialLegacy: true });
    expect(f.targets.isAdmitted(owner, 'device-a', target.targetId, 's')).toBe(true);
    expect(f.store.sync('s')!.ack_seq).toBe(0);
    expect(f.store.get('syncRunTarget:local-run')).toBe(target.targetId);
  });
});
