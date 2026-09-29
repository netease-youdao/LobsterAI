import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';

import type { RemoteAgentSummary, RemoteOwner } from '../../shared/remote/constants';
import { sameOwner } from './canonical';
import { type ArtifactProjectionJob,projectRemoteArtifacts } from './remoteArtifactProjection';
import { RemoteStore } from './remoteStore';

export interface ProjectionWork {
  database: string; target: string; sessionId: string; owner: RemoteOwner; deviceId: string; environment: string | null;
  deletions?: boolean; agent: RemoteAgentSummary | null; approval: boolean; questions: boolean; input: boolean; files: boolean; reply: boolean;
}
/** Runs only in a worker: consistent source read, bounded disk materialization, then projection. */
function materialize(work: ProjectionWork): { revision: number; sourceSeq: number; targetSourceSeq: number; digest: string } {
  const available = (): number => { const disk = fs.statfsSync(path.dirname(work.target)); return disk.bavail * disk.bsize; };
  if (available() < 768 * 1024 * 1024) throw new Error('REMOTE_PROJECTION_BUDGET');
  let lastDiskCheck = Date.now();
  const source = new Database(work.database, { readonly: true, fileMustExist: true, timeout: 100 });
  const target = new Database(work.target);
  target.pragma('journal_mode = DELETE'); target.pragma('synchronous = FULL');
  const began = Date.now(); let bytes = 0;
  const initialWal = fs.existsSync(`${work.database}-wal`) ? fs.statSync(`${work.database}-wal`).size : 0;
  const budget = (): void => {
    if (Date.now() - lastDiskCheck > 1000) { lastDiskCheck = Date.now(); if (available() < 512 * 1024 * 1024) throw new Error('REMOTE_PROJECTION_BUDGET'); }
    const wal = fs.existsSync(`${work.database}-wal`) ? fs.statSync(`${work.database}-wal`).size : 0;
    if (Date.now() - began > 120_000 || bytes > 256 * 1024 * 1024 || wal - initialWal > 128 * 1024 * 1024) throw new Error('REMOTE_PROJECTION_BUDGET');
  };
  const copy = (table: string, query: string, args: unknown[] = []): void => {
    const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
    if (!schema) return;
    if (!target.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) target.exec(schema.sql);
    const statement = source.prepare(query);
    const rowBytes = statement.columns().map(column => `COALESCE(length(CAST("${column.name.replace(/"/gu, '""')}" AS BLOB)),0)`).join('+');
    // Native SQLite must reject an oversized row before Node materializes its text/metadata.
    if (source.prepare(`SELECT 1 FROM (${query}) WHERE (${rowBytes})>? LIMIT 1`).get(...args, 256 * 1024 * 1024)) throw new Error('REMOTE_PROJECTION_BUDGET');
    const rows = statement.iterate(...args);
    let insert: Database.Statement | null = null;
    for (const row of rows as Iterable<Record<string, unknown>>) {
      budget(); bytes += Buffer.byteLength(JSON.stringify(row));
      insert ??= target.prepare(`INSERT OR IGNORE INTO ${table} (${Object.keys(row).map(key => `"${key}"`).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`);
      insert.run(...Object.values(row));
    }
  };
  try {
    let revision = 0, sourceSeq = 0;
    source.transaction(() => {
      const ownership = source.prepare("SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status='confirmed'").get(work.sessionId) as { owner_user_id: string; owner_scope_key: string } | undefined;
      if (!ownership || !sameOwner(work.owner, { userId: ownership.owner_user_id, scopeKey: ownership.owner_scope_key })) throw new Error('REMOTE_PROJECTION_OWNER_CHANGED');
      revision = (source.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(work.sessionId) as { revision: number } | undefined)?.revision || 0;
      sourceSeq = (source.prepare('SELECT source_seq FROM remote_sync WHERE local_id=?').get(work.sessionId) as { source_seq: number }).source_seq;
      target.transaction(() => {
        copy('cowork_sessions', 'SELECT * FROM cowork_sessions WHERE id=?', [work.sessionId]);
        copy('cowork_messages', 'SELECT * FROM cowork_messages WHERE session_id=? ORDER BY sequence,created_at,id', [work.sessionId]);
        copy('cowork_session_ownership', 'SELECT * FROM cowork_session_ownership WHERE session_id=?', [work.sessionId]);
        copy('remote_sync', 'SELECT * FROM remote_sync WHERE local_id=?', [work.sessionId]);
        copy('remote_object_state', 'SELECT * FROM remote_object_state WHERE session_id=?', [work.sessionId]);
        for (const table of ['remote_projection', 'remote_outbox', 'remote_reply_contents', 'remote_reply_chunks']) copy(table, `SELECT * FROM ${table} WHERE session_id=?`, [work.sessionId]);
        copy('remote_state', 'SELECT * FROM remote_state WHERE key LIKE ? OR key LIKE ?', [`%:${work.sessionId}`, `%:${work.sessionId}:%`]);
        if (source.prepare("SELECT 1 FROM remote_state WHERE key LIKE 'questionDecision:%' AND NOT json_valid(value) LIMIT 1").get()) throw new Error('REMOTE_QUESTION_EVIDENCE_UNAVAILABLE');
        copy('remote_state', "SELECT * FROM remote_state WHERE key LIKE 'questionDecision:%' AND CASE WHEN json_valid(value) THEN json_extract(value,'$.state.sessionId') END=?", [work.sessionId]);
        const runIds = new Set<string>();
        const messageIds: string[] = [];
        for (const row of target.prepare("SELECT value FROM remote_state WHERE key LIKE 'run:%' OR key LIKE 'runHistory:%' OR key LIKE 'questionDecision:%'").iterate() as Iterable<{ value: string }>) {
          const fact = JSON.parse(row.value), runId = fact.state?.runId || fact.runId;
          if (typeof runId === 'string') runIds.add(runId);
        }
        for (const message of target.prepare('SELECT id,metadata FROM cowork_messages').iterate() as Iterable<{ id: string; metadata: string }>) {
          messageIds.push(message.id);
          try { const metadata = JSON.parse(message.metadata || '{}'); if (typeof metadata.remoteRunId === 'string') runIds.add(metadata.remoteRunId); } catch { /* Same legacy metadata policy as the projector. */ }
        }
        for (const id of runIds) copy('remote_state', 'SELECT * FROM remote_state WHERE key IN (?,?,?)', [`inputRun:${id}`, `desktopInputRun:${id}`, `runPublished:${id}`]);
        for (const id of messageIds) copy('remote_state', 'SELECT * FROM remote_state WHERE key LIKE ?', [`desktopAsset:${id}:%`]);
        copy('remote_state', "SELECT * FROM remote_state WHERE key LIKE 'fileOutput:%' AND json_valid(value) AND json_extract(value,'$.localSessionId')=?", [work.sessionId]);
        const artifacts = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_local_artifacts'").get();
        if (artifacts) {
          // Preserve foreign-key checks: materialize artifact parents before their session relations.
          copy('library_local_artifacts', 'SELECT a.* FROM library_local_artifacts a WHERE EXISTS(SELECT 1 FROM library_artifact_sessions r WHERE r.artifact_id=a.id AND r.session_id=?)', [work.sessionId]);
          copy('library_artifact_sessions', 'SELECT * FROM library_artifact_sessions WHERE session_id=?', [work.sessionId]);
        }
      })();
    })();
    source.close(); budget();
    target.exec('CREATE TABLE projection_original_state AS SELECT * FROM remote_state');
    const store = new RemoteStore(target, { deferredProjection: true, restoreRuns: false });
    store.configureDetachedProjection(work);
    for (const row of target.prepare("SELECT object_key,revision,record_json FROM remote_object_state WHERE session_id=? AND object_key NOT LIKE 'question:%'").all(work.sessionId) as Iterable<{ object_key: string; revision: number; record_json: string }>) {
      target.prepare('INSERT OR IGNORE INTO remote_projection VALUES (?,?,?,?,?)').run(work.sessionId, row.object_key, 'rebuild', row.revision, row.record_json);
    }
    store.setAgentSummaryResolver(() => work.agent);
    const jobs = store.entries<ArtifactProjectionJob & { owner: RemoteOwner; environment: string; deviceId: string }>('fileOutput:')
      .map(row => row.value).filter(job => sameOwner(job.owner, work.owner) && job.deviceId === work.deviceId && job.environment === work.environment);
    store.setArtifactProjectionResolver((_id, messageId) => projectRemoteArtifacts(jobs, messageId));
    store.transaction(() => { store.project(work.sessionId); store.pruneReplyContents(work.sessionId); });
    const targetSourceSeq = store.sync(work.sessionId)!.source_seq;
    budget();
    target.pragma('wal_checkpoint(TRUNCATE)'); target.pragma('journal_mode = DELETE'); target.close();
    if (fs.statSync(work.target).size > 256 * 1024 * 1024) throw new Error('REMOTE_PROJECTION_BUDGET');
    const hash = createHash('sha256'), descriptor = fs.openSync(work.target, 'r'), buffer = Buffer.alloc(256 * 1024);
    try { let length: number; while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length)); }
    finally { fs.closeSync(descriptor); }
    return { revision, sourceSeq, targetSourceSeq, digest: hash.digest('hex') };
  } finally { if (source.open) source.close(); if (target.open) target.close(); }
}
if (parentPort) {
  try { parentPort.postMessage({ result: materialize(workerData as ProjectionWork) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : 'REMOTE_PROJECTION_FAILED' }); }
}

// Retain worker-thread entry compatibility for existing packaged-worker diagnostics.
// Production uses one bounded IPC job in an independently terminable child process.
if (!parentPort && process.send) {
  process.once('message', (request: { type?: string; jobId?: string; input?: unknown }) => {
    if (request.type !== 'remote.history.job' || typeof request.jobId !== 'string' || !/^[a-f0-9-]{36}$/u.test(request.jobId)) {
      process.disconnect(); return;
    }
    const work = request.input as ProjectionWork;
    try { process.send!({ jobId: request.jobId, result: materialize(work) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      process.send!({ jobId: request.jobId, error: /^REMOTE_[A-Z_]+$/u.test(message) ? message : 'REMOTE_PROJECTION_FAILED' });
    }
  });
}
