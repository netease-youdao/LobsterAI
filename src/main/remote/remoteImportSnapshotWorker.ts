import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';

import type { RemoteOwner } from '../../shared/remote/constants';
import { payloadHash, sameOwner, stableJson } from './canonical';

export const IMPORT_PART_BYTES = 600 * 1024;
const SNAPSHOT_BYTES = 256 * 1024 * 1024;
export interface ImportPartIndex { partNo: number; payloadHash: string; byteSize: number }
export interface ImportSnapshotIdentity {
  localSessionId: string; sessionId: string; deviceId: string; environment: string; owner: RemoteOwner;
  sourceSeq: string; snapshotEpoch: number; revision: number;
}
export interface ImportSnapshotPackage {
  fileSet: string; identity: ImportSnapshotIdentity; parts: ImportPartIndex[];
  manifest: { partCount: number; recordCounts: Record<string, number>; manifestHash: string };
}
export type ImportSnapshotWork = { operation: 'build'; database: string; directory: string; fileSet: string; identity: ImportSnapshotIdentity }
  | { operation: 'read'; directory: string; part: ImportPartIndex };
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
function available(directory: string): number { const disk = fs.statfsSync(directory); return disk.bavail * disk.bsize; }
function build(work: Extract<ImportSnapshotWork, { operation: 'build' }>): ImportSnapshotPackage {
  if (available(path.dirname(work.directory)) < SNAPSHOT_BYTES + 512 * 1024 * 1024) throw new Error('REMOTE_IMPORT_BUDGET');
  fs.mkdirSync(work.directory, { mode: 0o700 });
  const source = new Database(work.database, { readonly: true, fileMustExist: true, timeout: 100 });
  const started = Date.now(); let total = 0, lastSpaceCheck = started;
  const initialWal = fs.existsSync(`${work.database}-wal`) ? fs.statSync(`${work.database}-wal`).size : 0;
  const checkBudget = (): void => {
    if (Date.now() - started > 120_000 || total > SNAPSHOT_BYTES) throw new Error('REMOTE_IMPORT_BUDGET');
    if (Date.now() - lastSpaceCheck < 1000) return;
    lastSpaceCheck = Date.now();
    const wal = fs.existsSync(`${work.database}-wal`) ? fs.statSync(`${work.database}-wal`).size : 0;
    if (available(work.directory) < 512 * 1024 * 1024 || wal - initialWal > 128 * 1024 * 1024) throw new Error('REMOTE_IMPORT_BUDGET');
  };
  try {
    return source.transaction(() => {
      const expected = work.identity;
      const owner = source.prepare("SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status='confirmed'").get(expected.localSessionId) as { owner_user_id: string; owner_scope_key: string } | undefined;
      const row = source.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(expected.localSessionId) as { session_id: string; device_id: string; source_seq: number; sync_environment: string | null } | undefined;
      const revision = (source.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(expected.localSessionId) as { revision: number } | undefined)?.revision || 0;
      const epoch = source.prepare('SELECT value FROM remote_state WHERE key=?').get(`snapshotEpoch:${expected.localSessionId}`) as { value: string } | undefined;
      if (!owner || !sameOwner(expected.owner, { userId: owner.owner_user_id, scopeKey: owner.owner_scope_key }) || !row
        || row.session_id !== expected.sessionId || row.device_id !== expected.deviceId || row.sync_environment && row.sync_environment !== expected.environment
        || String(row.source_seq) !== expected.sourceSeq || revision !== expected.revision || (epoch ? JSON.parse(epoch.value) : 0) !== expected.snapshotEpoch
        || source.prepare('SELECT 1 FROM remote_projection_publications WHERE session_id=?').get(expected.localSessionId)) throw new Error('REMOTE_IMPORT_CONTEXT_CHANGED');
      if (source.prepare('SELECT 1 FROM remote_projection WHERE session_id=? AND length(CAST(record_json AS BLOB))>? LIMIT 1').get(expected.localSessionId, IMPORT_PART_BYTES - 14)) throw new Error('REMOTE_IMPORT_RECORD_LIMIT');
      const parts: ImportPartIndex[] = [], recordCounts: Record<string, number> = {};
      let records: string[] = [], bytes = 14; // {"records":[]} including no commas.
      const flush = (): void => {
        const payload = `{"records":[${records.join(',')}]}`;
        const byteSize = Buffer.byteLength(payload), partNo = parts.length;
        if (byteSize > IMPORT_PART_BYTES) throw new Error('REMOTE_IMPORT_RECORD_LIMIT');
        const descriptor = fs.openSync(path.join(work.directory, `${partNo}.json`), 'wx', 0o600);
        try { fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        parts.push({ partNo, payloadHash: hash(payload), byteSize }); total += byteSize;
        records = []; bytes = 14; checkBudget();
      };
      const deletion = source.prepare("SELECT record_json FROM remote_projection WHERE session_id=? AND json_valid(record_json) AND json_extract(record_json,'$.eventType')='session.deleted' LIMIT 1").get(expected.localSessionId) as { record_json: string } | undefined;
      const rows = deletion ? [deletion] : source.prepare('SELECT record_json FROM remote_projection WHERE session_id=? ORDER BY object_key').iterate(expected.localSessionId) as Iterable<{ record_json: string }>;
      for (const { record_json: json } of rows) {
        checkBudget();
        const record = JSON.parse(json) as { eventType: string };
        const encoded = stableJson(record), size = Buffer.byteLength(encoded);
        if (size + 14 > IMPORT_PART_BYTES) throw new Error('REMOTE_IMPORT_RECORD_LIMIT');
        if (records.length && (records.length >= 1000 || bytes + 1 + size > IMPORT_PART_BYTES)) flush();
        bytes += (records.length ? 1 : 0) + size; records.push(encoded);
        recordCounts[record.eventType] = (recordCounts[record.eventType] || 0) + 1;
      }
      if (records.length || !parts.length) flush();
      const result = { fileSet: work.fileSet, identity: expected, parts,
        manifest: { partCount: parts.length, recordCounts, manifestHash: payloadHash(parts) } };
      for (const directory of process.platform === 'win32' ? [] : [work.directory, path.dirname(work.directory)]) {
        const descriptor = fs.openSync(directory, 'r');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      }
      return result;
    })();
  } finally { source.close(); }
}
function read(work: Extract<ImportSnapshotWork, { operation: 'read' }>): string {
  if (!Number.isSafeInteger(work.part.partNo) || work.part.partNo < 0 || work.part.byteSize > IMPORT_PART_BYTES) throw new Error('REMOTE_IMPORT_PART_UNAVAILABLE');
  const directory = fs.lstatSync(work.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('REMOTE_IMPORT_PART_UNAVAILABLE');
  const file = path.join(work.directory, `${work.part.partNo}.json`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== work.part.byteSize || stat.size > IMPORT_PART_BYTES) throw new Error('REMOTE_IMPORT_PART_UNAVAILABLE');
    const data = fs.readFileSync(fd, 'utf8');
    if (hash(data) !== work.part.payloadHash) throw new Error('REMOTE_IMPORT_PART_UNAVAILABLE');
    return data;
  } finally { fs.closeSync(fd); }
}
if (parentPort) {
  try { const work = workerData as ImportSnapshotWork; parentPort.postMessage({ result: work.operation === 'build' ? build(work) : read(work) }); }
  catch (error) { const message = error instanceof Error ? error.message : ''; parentPort.postMessage({ error: /^REMOTE_IMPORT_[A-Z_]+$/u.test(message) ? message : 'REMOTE_IMPORT_PART_UNAVAILABLE' }); }
}

// Retain worker-thread entry compatibility for existing packaged-worker diagnostics.
// Production uses one bounded IPC job in an independently terminable child process.
if (!parentPort && process.send) {
  process.once('message', (request: { type?: string; jobId?: string; input?: unknown }) => {
    if (request.type !== 'remote.history.job' || typeof request.jobId !== 'string' || !/^[a-f0-9-]{36}$/u.test(request.jobId)) {
      process.disconnect(); return;
    }
    const work = request.input as ImportSnapshotWork;
    try { process.send!({ jobId: request.jobId, result: work.operation === 'build' ? build(work) : read(work) }); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      process.send!({ jobId: request.jobId, error: /^REMOTE_[A-Z_]+$/u.test(message) ? message : 'REMOTE_IMPORT_PART_UNAVAILABLE' });
    }
  });
}
