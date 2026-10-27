import Database from 'better-sqlite3';
import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { CoworkSystemMessageKind } from '../../common/coworkSystemMessages';
import { payloadHash, stableJson } from './canonical';
import { RemoteLiveEncodingError as ErrorCode, RemoteLiveEncodingLimits as Limits } from './remoteLiveMetadata';
import { type LiveProjectionInput, projectLiveMessage } from './remoteLiveProjection';
import { RemoteLiveProjectionJob } from './remoteLiveProjectionJob';
import { replyBlocks } from './remoteReplyProjection';

const databases: Database.Database[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); cleanup.splice(0).reverse().forEach(dispose => dispose()); });
function fixture(filename = ':memory:') {
  const db = new Database(filename); databases.push(db);
  db.exec(`CREATE TABLE cowork_session_ownership(session_id TEXT,owner_user_id TEXT,owner_scope_key TEXT,ownership_status TEXT);
    CREATE TABLE remote_sync(local_id TEXT,session_id TEXT,device_id TEXT,migration_frozen INTEGER);
    CREATE TABLE remote_live_revisions(session_id TEXT,object_id TEXT,revision INTEGER,deleted INTEGER);
    CREATE TABLE cowork_messages(id TEXT,session_id TEXT,type TEXT,created_at INTEGER,sequence INTEGER,content TEXT,metadata TEXT);
    CREATE TABLE remote_state(key TEXT,value TEXT);
    CREATE TABLE remote_live_tools(session_id TEXT,tool_id TEXT,revision INTEGER);
    CREATE TABLE remote_live_tool_sources(session_id TEXT,message_id TEXT,tool_id TEXT);
    INSERT INTO cowork_session_ownership VALUES('local','owner','personal','confirmed');
    INSERT INTO remote_sync VALUES('local','session','device',0);
    INSERT INTO remote_live_tools VALUES('local','call',2);`);
  const input: LiveProjectionInput = { database: db.name, localId: 'local', sessionId: 'session', deviceId: 'device', owner: { userId: 'owner', scopeKey: 'personal' }, objectId: 'message', revision: '2' };
  const message = (metadata: unknown, type = 'tool_result', content = 'Saved.', id = 'message', sequence = 2) => {
    db.prepare('INSERT INTO cowork_messages VALUES(?,?,?,1,?,?,?)').run(id, 'local', type, sequence, content, JSON.stringify(metadata));
    db.prepare('INSERT INTO remote_live_revisions VALUES(?,?,2,0)').run('local', id);
  };
  const bindTool = (id: string) => db.prepare('INSERT INTO remote_live_tool_sources VALUES(?,?,?)').run('local', id, 'call');
  const state = (key: string, value: unknown) => db.prepare('INSERT INTO remote_state VALUES(?,?)').run(key, JSON.stringify(value));
  return { db, input, message, bindTool, state };
}

describe('live projections with bounded metadata', () => {
  it('publishes a short tool result with large private metadata and returns only local tool-source evidence', () => {
    const f = fixture(); f.message({ toolUseId: 'call', remoteRunId: 'run', isFinal: true, isError: false,
      toolResultDetails: { diff: '中'.repeat(11000), patch: '文'.repeat(11000) } });
    const result = projectLiveMessage(f.db, f.input)!;
    expect(result).toMatchObject({ representation: 'complete', toolSource: { messageId: 'message', toolId: 'call', sourceRevision: '2' },
      payload: { runId: 'run', role: 'tool', status: 'complete', blocks: [{ type: 'tool_output', toolCallId: 'call', text: 'Saved.' }] } });
    expect(result.payload).not.toHaveProperty('toolSource');
    expect(result.payload).not.toHaveProperty('encodingStats');
    const rawBytes = (f.db.prepare('SELECT octet_length(metadata) AS bytes FROM cowork_messages').get() as { bytes: number }).bytes;
    expect(result.encodingStats?.rawMetadataBytes).toBe(rawBytes);
    expect(result.encodingStats?.normalizedMetadataBytes).toBeLessThan(Limits.MetadataBytes);
    expect(result.payloadHash).toBe(payloadHash(result.payload));
    expect(result.payload.originalContentBytes).toBe(String(Buffer.byteLength(stableJson(result.payload.blocks))));
    expect(stableJson(result.payload)).not.toMatch(/diff|patch|中/);
  });

  it('uses exact canonical public-block bytes when public metadata requires desktop-only fallback', () => {
    const f = fixture(), metadata = { toolCallId: 'call', toolInput: { patch: '中'.repeat(12000) } };
    f.message(metadata, 'tool_use', 'Edit');
    const result = projectLiveMessage(f.db, f.input)!;
    const original = replyBlocks({ id: 'message', type: 'tool_use', content: 'Edit' }, metadata);
    expect(result).toMatchObject({ representation: 'desktop_only', payload: { contentState: 'desktop_only', blocks: [], contentUnavailableReason: 'CONTENT_LIMIT_EXCEEDED' } });
    expect(result.payload.originalContentBytes).toBe(String(Buffer.byteLength(stableJson(original))));
    expect(result.payload.originalContentBytes).not.toBe(String(Buffer.byteLength(JSON.stringify(metadata))));
  });

  it('retains the inline block budget and does not invent a size when original content was not loaded', () => {
    const f = fixture(); f.message({}, 'assistant', 'x'.repeat(Limits.InlineBytes));
    const projected = projectLiveMessage(f.db, f.input)!;
    expect(projected.representation).toBe('desktop_only');
    expect(Number(projected.payload.originalContentBytes)).toBeGreaterThan(Limits.InlineBytes);
    f.db.prepare('UPDATE cowork_messages SET content=?').run('x'.repeat(Limits.ContentBytes + 1));
    expect(() => projectLiveMessage(f.db, f.input)).toThrow(ErrorCode.ContentSizeUnknown);
  });

  it.each([0, 1])('enforces raw metadata at exactly 256 KiB plus %i byte before parsing', extra => {
    const f = fixture(), prefix = '中😀"\\\n';
    const baseline = JSON.stringify({ unused: prefix });
    const raw = JSON.stringify({ unused: prefix + 'x'.repeat(Limits.RawMetadataBytes - Buffer.byteLength(baseline) + extra) });
    expect(Buffer.byteLength(raw)).toBe(Limits.RawMetadataBytes + extra);
    f.message({}, 'assistant', 'Visible message');
    f.db.prepare('UPDATE cowork_messages SET metadata=?').run(raw);
    if (extra) expect(() => projectLiveMessage(f.db, f.input)).toThrow(ErrorCode.RawMetadataBudget);
    else {
      const result = projectLiveMessage(f.db, f.input)!;
      expect(result.representation).toBe('complete');
      expect(result.encodingStats?.rawMetadataBytes).toBe(Limits.RawMetadataBytes);
      expect(result.payload.blocks[0].text).toBe('Visible message');
    }
  });

  it.each([0, 1])('uses exact canonical inline-block bytes at 48 KiB plus %i byte with Unicode and escapes', extra => {
    const f = fixture(), prefix = '中😀"\\\n';
    const blocks = (content: string) => replyBlocks({ id: 'message', type: 'assistant', content }, {});
    const baseline = Buffer.byteLength(stableJson(blocks(prefix)));
    const content = prefix + 'x'.repeat(Limits.InlineBytes - baseline + extra);
    const originalBytes = Buffer.byteLength(stableJson(blocks(content)));
    expect(originalBytes).toBe(Limits.InlineBytes + extra);
    expect(originalBytes).not.toBe(Buffer.byteLength(content));
    f.message({}, 'assistant', content);
    const result = projectLiveMessage(f.db, f.input)!;
    expect(result.representation).toBe(extra ? 'desktop_only' : 'complete');
    expect(result.payload.contentState).toBe(result.representation);
    expect(result.payload.originalContentBytes).toBe(String(originalBytes));
    expect(result.payload.blocks).toEqual(extra ? [] : blocks(content));
    if (extra) expect(result.payload.contentUnavailableReason).toBe('CONTENT_LIMIT_EXCEEDED');
    else expect(result.payload).not.toHaveProperty('contentUnavailableReason');
  });

  it('isolates oversized and malformed raw metadata instead of replacing it with empty metadata', () => {
    const f = fixture(); f.message({ privateData: 'x'.repeat(Limits.RawMetadataBytes) });
    expect(() => projectLiveMessage(f.db, f.input)).toThrow(ErrorCode.RawMetadataBudget);
    f.db.prepare('UPDATE cowork_messages SET metadata=?').run('{"private":');
    expect(() => projectLiveMessage(f.db, f.input)).toThrow(ErrorCode.MetadataInvalid);
  });

  it('preserves public filtering, unpublished-run filtering, and current-owner guards', () => {
    const f = fixture(); f.message({ kind: CoworkSystemMessageKind.ForkCompactionSummary, unused: 'x'.repeat(40000) }, 'system', 'internal');
    expect(projectLiveMessage(f.db, f.input)).toBeNull();
    f.db.prepare('UPDATE cowork_messages SET type=?,content=?,metadata=?').run('assistant', 'NO_REPLY', '{}');
    expect(projectLiveMessage(f.db, f.input)).toBeNull();
    f.db.prepare('UPDATE cowork_messages SET content=?,metadata=?').run('public', JSON.stringify({ remoteRunId: 'run' }));
    f.state('runPublished:run', false);
    expect(projectLiveMessage(f.db, f.input)).toBeNull();
    expect(() => projectLiveMessage(f.db, { ...f.input, owner: { userId: 'other', scopeKey: 'personal' } })).toThrow(ErrorCode.OwnerChanged);
    expect(() => projectLiveMessage(f.db, { ...f.input, deviceId: 'other' })).toThrow(ErrorCode.OwnerChanged);
  });

  it('retains frozen input and model-display selection without exposing raw model endpoints', () => {
    const f = fixture(); f.message({ remoteRunId: 'run', resolvedModelId: 'model-id' }, 'user', 'unfrozen text');
    f.state('inputRun:run', { input: { text: 'selected input', attachments: [] }, inputModel: { modelId: 'model-id', displayName: 'Before' } });
    const result = projectLiveMessage(f.db, f.input)!;
    expect(result.payload.blocks[0].text).toBe('selected input');
    expect(result.payload.inputModel.modelId).toBe('model-id');
    expect(result).not.toHaveProperty('toolSource');
  });

  it('reads final tool status from large metadata, preserving the tool schema and fallback name', () => {
    const f = fixture();
    f.message({ toolUseId: 'call', toolName: 'Edit' }, 'tool_use', '', 'use', 1); f.bindTool('use');
    f.message({ toolUseId: 'call', remoteRunId: 'run', isFinal: true, isError: false,
      toolResultDetails: { diff: 'x'.repeat(40000) } }); f.bindTool('message');
    const result = projectLiveMessage(f.db, { ...f.input, objectKind: 'tool', objectId: 'call' })!;
    expect(result.payload).toMatchObject({ toolCallId: 'call', runId: 'run', name: 'Edit', status: 'succeeded', summary: '', error: null });
    expect(Object.keys(result.payload).sort()).toEqual(['toolCallId', 'runId', 'name', 'status', 'summary', 'startedAt', 'finishedAt', 'error'].sort());
    expect(result).not.toHaveProperty('toolSource');
    expect(result.payload).not.toHaveProperty('encodingStats');
    expect(result.encodingStats?.rawMetadataBytes).toBe((f.db.prepare('SELECT SUM(octet_length(metadata)) AS bytes FROM cowork_messages').get() as { bytes: number }).bytes);
    expect(result.encodingStats?.normalizedMetadataBytes).toBeLessThan(Limits.MetadataBytes);
    expect(result.payloadHash).toBe(payloadHash(result.payload));
    f.state('syncTargetHistory:local', { runIds: ['run'] });
    expect(projectLiveMessage(f.db, { ...f.input, objectKind: 'tool', objectId: 'call' })).toBeNull();
  });

  it('caps aggregate tool-source reads and rejects mismatched tool membership', () => {
    const f = fixture();
    f.message({ toolUseId: 'call', toolName: 'Edit', unused: 'x'.repeat(140000) }, 'tool_use', '', 'use', 1); f.bindTool('use');
    f.message({ toolUseId: 'call', isFinal: true, unused: 'x'.repeat(140000) }); f.bindTool('message');
    const input = { ...f.input, objectKind: 'tool' as const, objectId: 'call' };
    expect(() => projectLiveMessage(f.db, input)).toThrow(ErrorCode.RawMetadataBudget);
    f.db.prepare('UPDATE cowork_messages SET metadata=? WHERE id=?').run(JSON.stringify({ toolUseId: 'other', toolName: 'Edit' }), 'message');
    expect(() => projectLiveMessage(f.db, input)).toThrow(ErrorCode.IdentityInvalid);
  });

  it('does not infer tool success from missing latest metadata or an invalid source type', () => {
    const f = fixture();
    f.message({ toolUseId: 'message', toolName: 'Edit' }, 'tool_use', '', 'use', 1); f.bindTool('use');
    f.message({ toolUseId: 'message', isFinal: true }); f.bindTool('message');
    f.db.exec("UPDATE remote_live_tools SET tool_id='message'; UPDATE remote_live_tool_sources SET tool_id='message';");
    const input = { ...f.input, objectKind: 'tool' as const };
    f.db.prepare('UPDATE cowork_messages SET metadata=NULL WHERE id=?').run('message');
    expect(() => projectLiveMessage(f.db, input)).toThrow(ErrorCode.MetadataInvalid);
    f.db.prepare('UPDATE cowork_messages SET type=?,metadata=? WHERE id=?').run('assistant', JSON.stringify({ toolUseId: 'message', toolName: 'Edit' }), 'message');
    expect(() => projectLiveMessage(f.db, input)).toThrow(ErrorCode.IdentityInvalid);
  });

  it('does not truncate malformed source identities or return stale source evidence', () => {
    const f = fixture(); f.message({ toolCallId: 'x'.repeat(65) });
    expect(() => projectLiveMessage(f.db, f.input)).toThrow(ErrorCode.IdentityInvalid);
    f.db.prepare('UPDATE remote_live_revisions SET revision=3').run();
    expect(projectLiveMessage(f.db, f.input)).toBeNull();
  });

  it('preserves the existing character-based tool name display policy for long Unicode names', () => {
    const f = fixture(), name = '工具'.repeat(90);
    f.message({ toolUseId: 'call', toolName: name, isFinal: true }); f.bindTool('message');
    const result = projectLiveMessage(f.db, { ...f.input, objectKind: 'tool', objectId: 'call' })!;
    expect(result.payload.name).toBe(name.slice(0, 128));
    expect(result.payload.status).toBe('succeeded');
  });

  it('encodes large metadata in the real isolated worker while the parent loop continues, and rejects the raw cap', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-live-metadata-worker-'));
    cleanup.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const worker = path.join(directory, 'worker.cjs');
    await build({ entryPoints: [path.join(__dirname, 'remoteLiveProjectionWorker.ts')], outfile: worker,
      bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'native-sqlite', setup(builder) {
        builder.onResolve({ filter: /^better-sqlite3$/u }, () => ({ path: require.resolve('better-sqlite3'), external: true }));
      } }] });
    const f = fixture(path.join(directory, 'core.sqlite'));
    f.message({ toolUseId: 'call', remoteRunId: 'run', isFinal: true, toolResultDetails: { diff: '中'.repeat(22000) } });
    const job = new RemoteLiveProjectionJob(worker);
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    try {
      const projected = await job.project(f.db, f.input);
      expect(ticks).toBeGreaterThan(0);
      expect(projected).toMatchObject({ representation: 'complete', toolSource: { messageId: 'message', toolId: 'call', sourceRevision: '2' },
        payload: { blocks: [{ text: 'Saved.' }] } });
      const raw = JSON.stringify({ toolUseId: 'call', toolResultDetails: { diff: 'x'.repeat(Limits.RawMetadataBytes) } });
      f.db.prepare('UPDATE cowork_messages SET metadata=?').run(raw);
      await expect(job.project(f.db, f.input)).rejects.toThrow(ErrorCode.RawMetadataBudget);
      expect(f.db.prepare('SELECT metadata FROM cowork_messages').get()).toEqual({ metadata: raw });
    } finally { clearInterval(heartbeat); job.cancel(); }
  });

});
