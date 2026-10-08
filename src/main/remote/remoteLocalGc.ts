import { promises as fs } from 'fs';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import { type DeletionClaim, type DeletionCompletion, type DeletionReceipt, RemoteDeletion } from '../../shared/remote/deletions';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { remoteDiagnostics } from './remoteDiagnostics';
import { matchesRemoteDeletionTargetScope, samePersistedRemoteEnvironment } from './remoteEnvironmentMigration';
import { remoteFileCacheDirectory } from './remoteFileSnapshots';
import type { RemoteStore } from './remoteStore';
import { archivedRemoteSyncReferences } from './remoteSyncTargetStore';
import { SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry } from './remoteTelemetry';

const Scan = { Deleted: 'localGcScan:deleted', File: 'localGcScan:file' } as const;
const Prefix = { Deleted: 'localGcDeleted:', File: 'localGcFile:', Receipt: 'localGcReceipt:' } as const;
const Phase = { Eligible: 'eligible', Deleting: 'deleting', Deleted: 'deleted' } as const;
const GRACE_MS = 24 * 60 * 60_000;
const PAGE = 20;
const DESKTOP_INPUT_RUN_PREFIX = 'desktopInputRun:';
const terminalRuns = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const terminalCommands = new Set(['applied', 'rejected', 'expired']);
const terminalImports = new Set(['committed', 'aborted', 'expired']);
interface Tombstone {
  owner: RemoteOwner; localSessionId: string; sessionId: string; deviceId: string; environment: string | null;
  streamEpoch: string | null; deletedAt: number; deleteRevision: number; sourceHighWatermark: number;
  completionReceipt?: DeletionCompletion; ackAt: number | null; ackSourceSeq: number | null; phase: typeof Phase[keyof typeof Phase]; jobCursor?: string; jobsBlocked?: boolean;
}
interface CacheFile { owner: RemoteOwner; localSessionId: string; filePath: string; inputDeviceId?: string; phase: typeof Phase[keyof typeof Phase] }
type JsonRecord = Record<string, any>;
const record = (value: unknown): value is JsonRecord => !!value && typeof value === 'object' && !Array.isArray(value);
class GcRecordError extends Error {}


/** Called inside the existing core deletion transaction, before removing the session. */
export function recordRemoteSessionDeletion(store: RemoteStore, sessionId: string, now = Date.now()): void {
  if (!store.db.inTransaction) throw new Error('Deletion evidence requires a core transaction');
  const owner = store.owner(sessionId), sync = store.sync(sessionId);
  if (!owner || !sync || store.get(`${Prefix.Deleted}${sessionId}`)) return;
  const value: Tombstone = { owner, localSessionId: sessionId, sessionId: sync.session_id, deviceId: sync.device_id,
    environment: sync.sync_environment, streamEpoch: sync.stream_epoch, deletedAt: now,
    deleteRevision: store.projectionRevision(sessionId) + 1, sourceHighWatermark: sync.source_seq,
    ackAt: null, ackSourceSeq: null, phase: Phase.Eligible };
  store.put(`${Prefix.Deleted}${sessionId}`, value);
}

/** Call only after RemoteStore.acknowledge has validated and committed the server ACK. */
export function acknowledgeRemoteSessionDeletion(store: RemoteStore, sessionId: string, now = Date.now()): void {
  const key = `${Prefix.Deleted}${sessionId}`, saved = store.get<Tombstone>(key), sync = store.sync(sessionId);
  if (!saved || !sync || saved.phase === Phase.Deleted || store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(sessionId)
    || sync.session_id !== saved.sessionId || (saved.deviceId && sync.device_id !== saved.deviceId)
    || (saved.environment && (sync.sync_environment === null
      || !samePersistedRemoteEnvironment(store, { owner: saved.owner, deviceId: sync.device_id }, sync.sync_environment, saved.environment)))
    || (saved.streamEpoch && sync.stream_epoch !== saved.streamEpoch)
    || sync.needs_snapshot || sync.source_seq !== sync.ack_seq || sync.ack_seq <= saved.sourceHighWatermark) return;
  const deletion = store.db.prepare("SELECT record_json FROM remote_projection WHERE session_id=? AND object_key='deleted'").get(sessionId) as { record_json: string } | undefined;
  if (!deletion || JSON.parse(deletion.record_json).eventType !== 'session.deleted') return;
  store.put(key, { ...saved, deviceId: sync.device_id, environment: sync.sync_environment, streamEpoch: sync.stream_epoch,
    ackAt: saved.ackAt ?? now, ackSourceSeq: sync.ack_seq });
}

/** Dedicated deletion proof closes unsent source data without inventing a source ACK. */
export function acknowledgeRemoteDeletionCompletion(store: RemoteStore, entry: DeletionClaim & { receipt?: DeletionReceipt }, completion: DeletionCompletion, now = Date.now()): boolean {
  const receipt = entry.receipt, target = entry.target, sync = store.sync(target.localSessionId);
  const closed = store.get<{ receiptId: string; receiptDigest: string }>(`${RemoteDeletion.Closed}${target.localSessionId}`);
  const key = `${Prefix.Deleted}${target.localSessionId}`, saved = store.get<Tombstone>(key);
  if (!receipt || !saved || !sync || !closed || completion.proofKind !== 'remote_execution'
    || completion.operationId !== entry.operation.operationId || completion.deletionVersion !== entry.operation.deletionVersion
    || !sameOwner(completion.owner, target) || !sameOwner(saved.owner, target)
    || completion.serviceScope !== target.serviceScope || completion.deviceId !== target.deviceId
    || completion.sessionId !== target.sessionId || completion.localSessionId !== target.localSessionId || completion.streamEpoch !== target.streamEpoch
    || completion.receiptDigest !== receipt.receiptDigest || completion.localReceiptId !== receipt.localReceiptId
    || completion.localDeletionRevision !== receipt.localDeletionRevision || payloadHash(completion.guard || null) !== payloadHash(receipt.guard)
    || completion.closedSourceHighWatermark !== receipt.closedSourceHighWatermark || closed.receiptId !== receipt.localReceiptId || closed.receiptDigest !== receipt.receiptDigest
    || sync.session_id !== target.sessionId || sync.device_id !== target.deviceId || sync.stream_epoch !== target.streamEpoch
    || sync.sync_environment === null || !matchesRemoteDeletionTargetScope(store, target, sync.sync_environment)
    || String(sync.source_seq) !== receipt.closedSourceHighWatermark || sync.ack_seq < Number(receipt.lastAcknowledgedSourceSeq)
    || store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(target.localSessionId)) return false;
  store.put(key, { ...saved, deviceId: sync.device_id, environment: sync.sync_environment, streamEpoch: sync.stream_epoch,
    completionReceipt: completion, ackAt: saved.ackAt ?? now, ackSourceSeq: sync.ack_seq });
  return true;
}

interface Dependencies {
  store: RemoteStore; cacheRoot: string; inputCacheRoot?: string; owner(): RemoteOwner | null;
  /** Disable GC while ownership or execution evidence requires recovery. */
  enabled?(): boolean;
}

/** Bounded best-effort maintenance. No safety ledger or user workspace file is a GC target. */
export class RemoteLocalGc {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cursor = '';
  private fileCursor = '';
  private readonly invalidRecords = new Map<string, number>();
  constructor(private readonly deps: Dependencies) {
    const cursor = (key: string): string => {
      try { const value = deps.store.get<unknown>(key); return typeof value === 'string' ? value : ''; }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; return ''; }
    };
    this.cursor = cursor(Scan.Deleted); this.fileCursor = cursor(Scan.File);
  }
  private damaged(key: string): void {
    const fingerprint = payloadHash(key), now = Date.now();
    if (now - (this.invalidRecords.get(fingerprint) || 0) < 60_000) return;
    if (this.invalidRecords.size >= 64) this.invalidRecords.delete(this.invalidRecords.keys().next().value!);
    this.invalidRecords.set(fingerprint, now);
    console.warn('[RemoteGc] Invalid record retained', { fingerprint });
  }
  private localError(error: unknown, key: string): boolean {
    if (!(error instanceof SyntaxError) && !(error instanceof GcRecordError) && !(error instanceof TypeError)
      && !(error instanceof Error && ['REMOTE_RUN_EVIDENCE_INVALID', 'REMOTE_QUESTION_EVIDENCE_INVALID'].includes(error.message))) return false;
    this.damaged(key); return true;
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => console.warn('[RemoteGc] Cache cleanup deferred')); }, 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private entries<T>(prefix: string, after = '', limit = PAGE): Array<{ key: string; value: T | null }> {
    return (this.deps.store.db.prepare('SELECT key,CASE WHEN length(CAST(value AS BLOB))<=1048576 THEN value END AS value FROM remote_state WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?')
      .all(prefix, `${prefix}\uffff`, after, limit) as Array<{ key: string; value: string | null }>).map(row => {
        try {
          if (row.value === null || Buffer.byteLength(row.value) > 1024 * 1024) throw new GcRecordError();
          const value: unknown = JSON.parse(row.value);
          if (!record(value)) throw new GcRecordError();
          return { key: row.key, value: value as T };
        } catch (error) { if (!this.localError(error, row.key)) throw error; return { key: row.key, value: null }; }
      });
  }
  private valid(tombstone: Tombstone): boolean {
    if (!record(tombstone) || !record(tombstone.owner) || typeof tombstone.localSessionId !== 'string'
      || typeof tombstone.sessionId !== 'string' || typeof tombstone.deviceId !== 'string'
      || !Number.isSafeInteger(tombstone.sourceHighWatermark) || !Number.isFinite(tombstone.deletedAt)) throw new GcRecordError();
    const store = this.deps.store, sync = store.sync(tombstone.localSessionId);
    const closed = store.get<{ operationId: string; deletionVersion: string; receiptId: string; receiptDigest: string }>(`${RemoteDeletion.Closed}${tombstone.localSessionId}`);
    return sameOwner(tombstone.owner, this.deps.owner()) && sameOwner(tombstone.owner, store.owner(tombstone.localSessionId))
      && !store.needsSecurityRecovery() && store.areControlsAdmitted() && store.isTaskAdmitted(tombstone.localSessionId)
      && this.deps.enabled?.() !== false && !!sync && !sync.migration_frozen
      && sync.session_id === tombstone.sessionId && sync.device_id === tombstone.deviceId
      && (sync.sync_environment === tombstone.environment || sync.sync_environment !== null && tombstone.environment !== null
        && samePersistedRemoteEnvironment(store, { owner: tombstone.owner, deviceId: tombstone.deviceId }, sync.sync_environment, tombstone.environment))
      && sync.stream_epoch === tombstone.streamEpoch
      && (tombstone.completionReceipt
        ? closed?.receiptId === tombstone.completionReceipt.localReceiptId && closed?.receiptDigest === tombstone.completionReceipt.receiptDigest
          && closed?.operationId === tombstone.completionReceipt.operationId && closed?.deletionVersion === tombstone.completionReceipt.deletionVersion
          && payloadHash(store.deletionGuard(tombstone.localSessionId)) === payloadHash(tombstone.completionReceipt.guard || null)
          && String(sync.source_seq) === tombstone.completionReceipt.closedSourceHighWatermark
        : !sync.needs_snapshot && sync.ack_seq === sync.source_seq && sync.ack_seq === tombstone.ackSourceSeq)
      && !store.db.prepare('SELECT 1 FROM cowork_sessions WHERE id=?').get(tombstone.localSessionId)
      && !store.projectionPublishing(tombstone.localSessionId);
  }
  private async blocked(sessionId: string): Promise<boolean> {
    const store = this.deps.store, run = store.run(sessionId);
    if (run && !terminalRuns.has(run.status)) return true;
    if (store.get(`inputFence:${sessionId}`) || store.get(`${RemoteDeletion.Fence}${sessionId}`)) return true;
    const imported = store.get<JsonRecord>(`import:${sessionId}`);
    if (imported && !terminalImports.has(imported.state)) return true;
    const approvals = this.entries<JsonRecord>(`approval:${sessionId}:`, '', 101);
    if (approvals.length > 100 || approvals.some(row => !row.value || row.value.status === 'pending' || row.value.resolution?.phase === 'unknown')) return true;
    if (!store.questionEvidenceHealthy(sessionId)) return true;
    if (store.db.prepare(`SELECT 1 FROM remote_state WHERE
      (key LIKE ? AND CASE WHEN json_valid(value) THEN
        json_extract(value,'$.status')='pending' OR json_extract(value,'$.resolution.phase')='unknown' ELSE 1 END)
      OR (key LIKE 'questionDecision:%' AND CASE WHEN json_valid(value) THEN
        json_extract(value,'$.state.sessionId')=? AND
          (json_extract(value,'$.state.status')='pending' OR json_extract(value,'$.state.resolution.phase')='unknown') ELSE 0 END) LIMIT 1`)
      .get(`question:${sessionId}:%`, sessionId)) return true;
    return this.scanReferences('inbox:', value => value.localSessionId === sessionId
      && (!terminalCommands.has(value.state) || !terminalCommands.has(value.command?.status)));
  }
  /** A complete scan is valid only if no DB write occurred across any yielded page.
   * High water bounds the work even if another task keeps appending commands. */
  private databaseVersion(): string {
    return JSON.stringify([this.deps.store.db.prepare('SELECT total_changes() AS n').get(), this.deps.store.db.pragma('data_version', { simple: true })]);
  }
  private async scanReferences(prefix: string, referenced: (value: JsonRecord) => boolean): Promise<boolean> {
    const db = this.deps.store.db;
    const started = this.databaseVersion();
    const last = db.prepare('SELECT key FROM remote_state WHERE key>=? AND key<? ORDER BY key DESC LIMIT 1')
      .get(prefix, `${prefix}\uffff`) as { key: string } | undefined;
    if (!last) return false;
    let after = '';
    while (true) {
      const rows = this.entries<JsonRecord>(prefix, after, 50);
      for (const row of rows) {
        if (row.key > last.key) break;
        if (!row.value || referenced(row.value)) return true;
        after = row.key;
      }
      if (rows.length < 50 || after >= last.key) return this.databaseVersion() !== started;
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.databaseVersion() !== started || this.deps.enabled?.() === false || this.deps.store.needsSecurityRecovery()) return true;
    }
  }

  private deleteBodyPage(table: string, sessionId: string, extra = ''): number {
    // Table names are a closed internal list; each statement commits at most PAGE rows.
    return this.deps.store.db.prepare(`DELETE FROM ${table} WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE session_id=? ${extra} LIMIT ${PAGE})`).run(sessionId).changes;
  }
  private stageFiles(tombstone: Tombstone, files: string[], inputDeviceId?: string): void {
    for (const filePath of new Set(files)) {
      if (!path.isAbsolute(filePath) || !this.fileDirectories({ owner: tombstone.owner, localSessionId: tombstone.localSessionId, filePath, inputDeviceId, phase: Phase.Eligible })) continue;
      const key = `${Prefix.File}${payloadHash([tombstone.owner, filePath])}`;
      if (!this.deps.store.get(key)) this.deps.store.put(key, { owner: tombstone.owner, localSessionId: tombstone.localSessionId,
        filePath, ...(inputDeviceId ? { inputDeviceId } : {}), phase: Phase.Eligible } satisfies CacheFile);
    }
  }
  private inputRunBelongsToSession(key: string, job: JsonRecord, sessionId: string): boolean {
    if (!key.startsWith(DESKTOP_INPUT_RUN_PREFIX)) return false;
    // Explicit identity wins over legacy key conventions, including conflicting or malformed values.
    if (job.localSessionId !== undefined) return job.localSessionId === sessionId;
    if (key.startsWith(`${DESKTOP_INPUT_RUN_PREFIX}${sessionId}:`)) return true;
    const runId = key.slice(DESKTOP_INPUT_RUN_PREFIX.length);
    if (!runId || runId.includes(':')) return false;
    // Old writers used a random run ID without a session field. Exact durable history is sufficient;
    // unknown or unsettled history remains retained without scanning unrelated sessions.
    const run = this.deps.store.get<{ runId: string; status: string }>(`runHistory:${sessionId}:${runId}`);
    return run?.runId === runId && terminalRuns.has(run.status);
  }
  private preparationCommand(job: JsonRecord): JsonRecord | null {
    if (typeof job.boundCommandId !== 'string') return null;
    const keys = typeof job.targetId === 'string' ? [`inbox:${job.targetId}:${job.boundCommandId}`, `inbox:${job.boundCommandId}`]
      : [`inbox:${job.boundCommandId}`];
    for (const key of keys) {
      const command = this.deps.store.get<JsonRecord>(key);
      if (command && (job.targetId === undefined || command.targetId === job.targetId)) return command;
    }
    return null;
  }
  private trimJobs(tombstone: Tombstone): boolean {
    const store = this.deps.store;
    const prefixes = ['desktopAsset:', DESKTOP_INPUT_RUN_PREFIX, 'fileOutput:', 'inputPreparation:'];
    const cursor = tombstone.jobCursor || prefixes[0];
    const index = prefixes.findIndex(prefix => cursor.startsWith(prefix));
    if (index < 0) return true;
    const rows = this.entries<JsonRecord>(prefixes[index], cursor === prefixes[index] ? '' : cursor);
    for (const row of rows) {
      tombstone.jobCursor = row.key;
      const job = row.value;
      if (!job) { tombstone.jobsBlocked = true; continue; }
      try {
        const inputRun = this.inputRunBelongsToSession(row.key, job, tombstone.localSessionId);
        const preparation = row.key.startsWith('inputPreparation:');
        const command = preparation ? this.preparationCommand(job) : null;
        const preparationTarget = job.targetId ?? command?.targetId;
        if (preparation && typeof preparationTarget === 'string' && preparationTarget !== tombstone.environment
          && (tombstone.environment === null || !samePersistedRemoteEnvironment(store,
            { owner: tombstone.owner, deviceId: tombstone.deviceId }, preparationTarget, tombstone.environment))) continue;
        if ((!inputRun && job.localSessionId !== tombstone.localSessionId && !(preparation && command?.localSessionId === tombstone.localSessionId)) || !sameOwner(job.owner, tombstone.owner)) continue;
        if (inputRun && !Array.isArray(job.attachments)) { tombstone.jobsBlocked = true; continue; }
        if (preparation && (!this.deps.inputCacheRoot || !command || !terminalCommands.has(command.state) || !terminalCommands.has(command.command?.status)
          || job.deviceId !== tombstone.deviceId || !Array.isArray(job.files))) { tombstone.jobsBlocked = true; continue; }
        if (row.key.startsWith('fileOutput:') && (!Array.isArray(job.queue) || !tombstone.completionReceipt && (job.queue.length || job.rename))) { tombstone.jobsBlocked = true; continue; }
        if (row.key.startsWith('desktopAsset:') && job.availability !== 'ready' && !tombstone.completionReceipt) { tombstone.jobsBlocked = true; continue; }
        const files: string[] = [];
        if (typeof job.snapshot?.path === 'string') files.push(job.snapshot.path);
        if (preparation) for (const file of job.files) { if (typeof file.path === 'string') files.push(file.path); if (typeof file.imagePath === 'string') files.push(file.imagePath); }
        if (inputRun) for (const item of job.attachments || []) if (typeof item.snapshot?.path === 'string') files.push(item.snapshot.path);
        if (tombstone.completionReceipt && row.key.startsWith('fileOutput:')) for (const publication of job.queue || []) if (typeof publication.snapshot?.path === 'string') files.push(publication.snapshot.path);
        const receipt = { keyHash: payloadHash(row.key), payloadHash: payloadHash(job), owner: job.owner,
          localSessionId: tombstone.localSessionId, assetId: job.assetId || job.uploadedAsset?.assetId || null,
          artifactId: job.artifactId || null, uploadRequestId: job.uploadRequestId || null,
          completedPublications: job.completedPublications || [], preparationId: job.preparationId || null,
          boundCommandId: job.boundCommandId || null, requestHash: job.requestHash || null, inputDigest: job.inputDigest || null, cleanedAt: Date.now() };
        store.db.transaction(() => { store.put(`${Prefix.Receipt}${payloadHash(row.key)}`, receipt);
          this.stageFiles(tombstone, files, preparation ? job.deviceId : undefined); store.remove(row.key); })();
      } catch (error) { if (!this.localError(error, row.key)) throw error; tombstone.jobsBlocked = true; }
    }
    if (rows.length < PAGE) tombstone.jobCursor = prefixes[index + 1] || 'done';
    if (tombstone.jobCursor !== 'done') return false;
    if (tombstone.jobsBlocked) { tombstone.jobCursor = prefixes[0]; tombstone.jobsBlocked = false; return false; }
    return true;
  }
  async sweep(now = Date.now()): Promise<number> {
    if (this.running || this.deps.enabled?.() === false || this.deps.store.needsSecurityRecovery()
      || !this.deps.store.areControlsAdmitted() || !this.deps.owner()) return 0;
    this.running = true;
    const telemetry = captureRemoteTelemetry({ operationKind: SyncTelemetry.Kind.Cleanup, lane: 'background' });
    let removed = 0, skipped = 0, completed = false;
    try {
      const rows = this.entries<Tombstone>(Prefix.Deleted, this.cursor, 5);
      for (const { key, value } of rows) {
        this.cursor = key; this.deps.store.put(Scan.Deleted, key);
        if (!value) { skipped++; continue; }
        try {
          const version = this.databaseVersion();
          if (value.phase === Phase.Deleted || value.ackAt === null || !Number.isFinite(value.ackAt)
            || Math.max(value.deletedAt, value.ackAt) + GRACE_MS > now || !this.valid(value) || await this.blocked(value.localSessionId)) {
            skipped++; continue;
          }
          this.deps.store.db.transaction(() => {
            if (version !== this.databaseVersion() || !this.valid(value)) { skipped++; return; }
            value.phase = Phase.Deleting; this.deps.store.put(key, value);
            let page = this.deleteBodyPage('remote_projection', value.localSessionId, "AND object_key<>'deleted'"); removed += page;
            if (!page) { page = this.deleteBodyPage('remote_reply_contents', value.localSessionId); removed += page; }
            if (!page) { page = this.deleteBodyPage('remote_reply_chunks', value.localSessionId); removed += page; }
            if (!page) { page = this.deleteBodyPage('remote_outbox', value.localSessionId, `AND source_seq<=${value.completionReceipt ? value.sourceHighWatermark : value.ackSourceSeq}`); removed += page; }
            if (!page && this.trimJobs(value)) value.phase = Phase.Deleted;
            this.deps.store.put(key, value);
          })();
        } catch (error) { if (!this.localError(error, key)) throw error; skipped++; }
      }
      if (rows.length < 5) { this.cursor = ''; this.deps.store.put(Scan.Deleted, ''); }
      await this.files();
      remoteDiagnostics.record('gc.rows', removed);
      completed = true;
      return removed;
    } finally {
      telemetry.emit(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.Cleanup,
        outcome: completed ? SyncTelemetry.Outcome.Completed : SyncTelemetry.Outcome.Failed,
        count: removed, skippedCount: skipped, reason: completed ? SyncTelemetry.Reason.None : SyncTelemetry.Reason.StorageUnavailable });
      this.running = false;
    }
  }
  private async referenced(filePath: string): Promise<boolean> {
    const version = this.databaseVersion();
    if (archivedRemoteSyncReferences(this.deps.store).paths.has(filePath)) return true;
    for (const prefix of ['desktopAsset:', DESKTOP_INPUT_RUN_PREFIX, 'fileOutput:', 'inputPreparation:'])
      if (await this.scanReferences(prefix, value => stableJson(value).includes(filePath))) return true;
    return version !== this.databaseVersion();
  }
  private fileDirectories(value: CacheFile): string[] | null {
    const root = path.resolve(value.inputDeviceId ? this.deps.inputCacheRoot || '' : this.deps.cacheRoot);
    if (value.inputDeviceId) {
      if (!this.deps.inputCacheRoot) return null;
      const ownerFolder = path.join(root, payloadHash([value.owner.userId, value.owner.scopeKey, value.inputDeviceId]));
      const folder = path.dirname(value.filePath);
      if (path.dirname(folder) !== ownerFolder || !/^[0-9a-f-]{36}$/iu.test(path.basename(folder))) return null;
      return [root, ownerFolder, folder];
    }
    const folder = remoteFileCacheDirectory(root, value.owner);
    return path.dirname(value.filePath) === folder ? [root, path.dirname(folder), folder] : null;
  }
  private async files(): Promise<void> {
    const telemetry = captureRemoteTelemetry({ operationKind: SyncTelemetry.Kind.Cleanup, lane: 'files' });
    const rows = this.entries<CacheFile>(Prefix.File, this.fileCursor, 5);
    for (const { key, value } of rows) {
      this.fileCursor = key; this.deps.store.put(Scan.File, key);
      if (!value) continue;
      try {
        if (!record(value.owner) || typeof value.filePath !== 'string' || !path.isAbsolute(value.filePath)
          || typeof value.localSessionId !== 'string') throw new GcRecordError();
        if (value.phase === Phase.Deleted || !sameOwner(value.owner, this.deps.owner()) || this.deps.enabled?.() === false
          || this.deps.store.needsSecurityRecovery() || await this.referenced(value.filePath)) continue;
        const tombstone = this.deps.store.get<Tombstone>(`${Prefix.Deleted}${value.localSessionId}`);
        if (!tombstone || !this.valid(tombstone) || await this.blocked(value.localSessionId)) continue;
        value.phase = Phase.Deleting; this.deps.store.put(key, value);
        try {
          const directories = this.fileDirectories(value);
          if (!directories) continue;
          // Never follow symlinks at any owned path component or remove a directory.
          for (const directory of directories) {
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('Unsafe cache directory');
          }
          const stat = await fs.lstat(value.filePath);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe cache file');
          const version = this.databaseVersion();
          if (await this.referenced(value.filePath) || await this.blocked(value.localSessionId)
            || version !== this.databaseVersion() || !sameOwner(value.owner, this.deps.owner()) || !this.valid(tombstone)) continue;
          await fs.unlink(value.filePath);
          remoteDiagnostics.record('gc.bytes', stat.size);
          this.deps.store.put(key, { ...value, phase: Phase.Deleted });
          telemetry.emit(SyncTelemetry.Event.Stage, { stage: SyncTelemetry.Stage.Cleanup, outcome: SyncTelemetry.Outcome.Completed,
            localSessionId: value.localSessionId, remoteOwnerId: value.owner.userId, ownerScopeId: value.owner.scopeKey, count: 1 });
        } catch (error) {
          if (String((error as NodeJS.ErrnoException).code || '').startsWith('SQLITE_')) throw error;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.deps.store.put(key, { ...value, phase: Phase.Deleted });
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') telemetry.emit(SyncTelemetry.Event.Stage,
            { stage: SyncTelemetry.Stage.Cleanup, outcome: SyncTelemetry.Outcome.Deferred, localSessionId: value.localSessionId,
              remoteOwnerId: value.owner.userId, ownerScopeId: value.owner.scopeKey, reason: SyncTelemetry.Reason.StorageUnavailable });
          // Retry a bounded page later; failure does not escape into local task operations.
        }
      } catch (error) { if (!this.localError(error, key)) throw error; }
    }
    if (rows.length < 5) { this.fileCursor = ''; this.deps.store.put(Scan.File, ''); }
  }
}
