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
  constructor(private readonly deps: Dependencies) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep().catch(() => console.warn('[RemoteGc] Cache cleanup deferred')); }, 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private entries<T>(prefix: string, after = '', limit = PAGE): Array<{ key: string; value: T }> {
    return (this.deps.store.db.prepare('SELECT key,value FROM remote_state WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?')
      .all(prefix, `${prefix}\uffff`, after, limit) as Array<{ key: string; value: string }>).map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  private valid(tombstone: Tombstone): boolean {
    const store = this.deps.store, sync = store.sync(tombstone.localSessionId);
    const closed = store.get<{ operationId: string; deletionVersion: string; receiptId: string; receiptDigest: string }>(`${RemoteDeletion.Closed}${tombstone.localSessionId}`);
    return sameOwner(tombstone.owner, this.deps.owner()) && sameOwner(tombstone.owner, store.owner(tombstone.localSessionId))
      && !store.needsSecurityRecovery() && this.deps.enabled?.() !== false && !!sync && !sync.migration_frozen
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
  private blocked(sessionId: string): boolean {
    const store = this.deps.store, run = store.run(sessionId);
    if (run && !terminalRuns.has(run.status)) return true;
    if (store.get(`inputFence:${sessionId}`) || store.get(`${RemoteDeletion.Fence}${sessionId}`)) return true;
    const imported = store.get<JsonRecord>(`import:${sessionId}`);
    if (imported && !terminalImports.has(imported.state)) return true;
    const approvals = this.entries<JsonRecord>(`approval:${sessionId}:`, '', 101);
    if (approvals.length > 100 || approvals.some(row => row.value.status === 'pending' || row.value.resolution?.phase === 'unknown')) return true;
    if (store.db.prepare(`SELECT 1 FROM remote_state WHERE
      (key LIKE ? AND (json_extract(value,'$.status')='pending' OR json_extract(value,'$.resolution.phase')='unknown'))
      OR (key LIKE 'questionDecision:%' AND json_extract(value,'$.state.sessionId')=?
        AND (json_extract(value,'$.state.status')='pending' OR json_extract(value,'$.state.resolution.phase')='unknown')) LIMIT 1`)
      .get(`question:${sessionId}:%`, sessionId)) return true;
    // A bounded admission check deliberately retains data when old command history is huge.
    // It does not parse an unlimited inbox on the main thread to gain disk space.
    const inbox = this.entries<JsonRecord>('inbox:', '', 501);
    if (inbox.length > 500) return true;
    return inbox.some(({ value }) => value.localSessionId === sessionId
      && (!terminalCommands.has(value.state) || !terminalCommands.has(value.command?.status)));
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
    }
    if (rows.length < PAGE) tombstone.jobCursor = prefixes[index + 1] || 'done';
    if (tombstone.jobCursor !== 'done') return false;
    if (tombstone.jobsBlocked) { tombstone.jobCursor = prefixes[0]; tombstone.jobsBlocked = false; return false; }
    return true;
  }
  async sweep(now = Date.now()): Promise<number> {
    if (this.running || this.deps.enabled?.() === false || this.deps.store.needsSecurityRecovery() || !this.deps.owner()) return 0;
    this.running = true;
    let removed = 0;
    try {
      const rows = this.entries<Tombstone>(Prefix.Deleted, this.cursor, 5);
      for (const { key, value } of rows) {
        this.cursor = key;
        if (value.phase === Phase.Deleted || value.ackAt === null || !Number.isFinite(value.ackAt)
          || Math.max(value.deletedAt, value.ackAt) + GRACE_MS > now || !this.valid(value) || this.blocked(value.localSessionId)) continue;
        value.phase = Phase.Deleting; this.deps.store.put(key, value);
        let page = this.deleteBodyPage('remote_projection', value.localSessionId, "AND object_key<>'deleted'"); removed += page;
        if (!page) { page = this.deleteBodyPage('remote_reply_contents', value.localSessionId); removed += page; }
        if (!page) { page = this.deleteBodyPage('remote_reply_chunks', value.localSessionId); removed += page; }
        if (!page) { page = this.deleteBodyPage('remote_outbox', value.localSessionId, `AND source_seq<=${value.completionReceipt ? value.sourceHighWatermark : value.ackSourceSeq}`); removed += page; }
        if (!page && this.trimJobs(value)) value.phase = Phase.Deleted;
        this.deps.store.put(key, value);
      }
      if (rows.length < 5) this.cursor = '';
      await this.files();
      remoteDiagnostics.record('gc.rows', removed);
      return removed;
    } finally { this.running = false; }
  }
  private referenced(filePath: string): boolean {
    if (archivedRemoteSyncReferences(this.deps.store).paths.has(filePath)) return true;
    for (const prefix of ['desktopAsset:', DESKTOP_INPUT_RUN_PREFIX, 'fileOutput:', 'inputPreparation:']) {
      const rows = this.entries<JsonRecord>(prefix, '', 501);
      if (rows.length > 500 || rows.some(row => stableJson(row.value).includes(filePath))) return true;
    }
    return false;
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
    const rows = this.entries<CacheFile>(Prefix.File, this.fileCursor, 5);
    for (const { key, value } of rows) {
      this.fileCursor = key;
      if (value.phase === Phase.Deleted || !sameOwner(value.owner, this.deps.owner()) || this.deps.enabled?.() === false
        || this.deps.store.needsSecurityRecovery() || this.referenced(value.filePath)) continue;
      const tombstone = this.deps.store.get<Tombstone>(`${Prefix.Deleted}${value.localSessionId}`);
      if (!tombstone || !this.valid(tombstone) || this.blocked(value.localSessionId)) continue;
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
        if (!sameOwner(value.owner, this.deps.owner()) || !this.valid(tombstone) || this.referenced(value.filePath)) continue;
        await fs.unlink(value.filePath);
        remoteDiagnostics.record('gc.bytes', stat.size);
        this.deps.store.put(key, { ...value, phase: Phase.Deleted });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.deps.store.put(key, { ...value, phase: Phase.Deleted });
        // Retry a bounded page later; failure does not escape into local task operations.
      }
    }
    if (rows.length < 5) this.fileCursor = '';
  }
}
