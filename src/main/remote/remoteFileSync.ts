import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteDeletion } from '../../shared/remote/deletions';
import { type RemoteArtifactManifest, type RemoteFilePolicy, RemoteFileReason, remoteFileRule } from '../../shared/remote/files';
import type { RemoteInputAsset } from '../../shared/remote/input';
import { sameOwner, stableJson } from './canonical';
import type { DesktopInputSource } from './desktopInputMetadata';
import { projectRemoteArtifacts, remoteArtifactReasons } from './remoteArtifactProjection';
import { type DeliveredFileDependencies,RemoteDeliveredFileSync } from './remoteDeliveredFileSync';
import { type DesktopMessageAssetJob, uploadDesktopMessageAsset } from './remoteDesktopAssetUpload';
import { fileRetryAllowed, nextFileRetry, RemoteFileRequestError, RemoteFileRetryPhase, type RemoteFileRetryState } from './remoteFileRetry';
import { captureRemoteFileSnapshot, remoteFileCacheDirectory, type RemoteFileSnapshot, verifyRemoteFileSnapshot } from './remoteFileSnapshots';
import { requestRemoteFilePart } from './remoteFileTransferLog';
import { capturePreparedInputSnapshot, type RemotePreparedInputSource } from './remotePreparedInputSnapshots';
import type { RemoteStore } from './remoteStore';
import { archivedRemoteSyncReferences } from './remoteSyncTargetStore';

interface Source { id: string; file_path: string; file_name: string; file_identity: string; updated_at: number; message_id: string; run_id: string; session_id: string }
interface Publication {
  publicationId: string; captureSequence: string; messageId: string; runId: string; fileName: string; mimeType: string;
  snapshot: RemoteFileSnapshot; terminal: boolean; expectedLatestVersion?: string; assetId?: string; artifactVersion?: string;
  generation?: string;
}
interface ArtifactJob {
  owner: RemoteOwner; environment: string; deviceId: string; localSessionId: string; sessionId: string; localArtifactId: string;
  artifactId?: string; name: string; revision: string; latest: RemoteArtifactManifest['latest'];
  captureSequence: string; queue: Publication[]; signature?: string; dirtyAt?: number; changedAt?: number; lastCaptureAt?: number;
  terminalRuns: string[]; references: Record<string, { runId: string; latest: NonNullable<RemoteArtifactManifest['latest']>; pinned: boolean }>;
  completedPublications?: string[];
  messageId?: string; sizeBytes?: string;
  rename?: { operationId: string; name: string; expectedRevision?: string };
  reason?: string; retryAt?: number; retry?: RemoteFileRetryState;
}
interface InputJob extends DesktopMessageAssetJob {
  localSessionId: string; snapshot?: RemoteFileSnapshot; availability: string; uploadedAsset?: RemoteInputAsset; reason?: string; retryAt?: number; captureReason?: string; retry?: RemoteFileRetryState;
  environment?: string;
  preparedSource?: RemotePreparedInputSource;
}
interface Connection { owner: RemoteOwner; environment: string; deviceId: string; generation: string }
interface TerminalBoundary { owner: RemoteOwner; environment: string; deviceId: string; ordinal: string; finishedAt: string }
export interface RemoteFileSyncDependencies {
  store: RemoteStore; cacheRoot: string; owner(): RemoteOwner | null; environment(): string; enabled(): boolean;
  access(filePath: string): { assertAllowed(): void };
  recordArtifact?: DeliveredFileDependencies['recordArtifact'];
  /** Only an already sealed producer version may be pinned to a completed run. Must not perform file I/O here. */
  terminalSnapshot?(source: Source): { snapshot: RemoteFileSnapshot; runId: string; artifactId: string; producerRevision: string } | null;
  request(connection: Connection, pathname: string, init: RequestInit): Promise<Response>;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const expiredUploadStates = new Set(['deleted', 'expired']);
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const mimeTypes: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const mime = (name: string): string => mimeTypes[path.extname(name).slice(1).toLowerCase()] || 'text/plain';
const escapeId = (value: string): string => encodeURIComponent(value);
const durableJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;


/** One account-bound scheduler; persisted snapshots survive HTTP/WS and process restarts. */
export class RemoteFileSync {
  private connection: Connection | null = null;
  private policy: RemoteFilePolicy | null = null;
  private policyAt = 0;
  private policyRetryAt = 0;
  private cleanupAt = 0;
  private work: Promise<void> | null = null;
  private enabled = false;
  private fileHealth: { degraded: boolean; pending: number | null } = { degraded: false, pending: null };
  health(): { degraded: boolean; pending: number | null } { return { ...this.fileHealth }; }
  /** A task retry changes only retry timing; immutable jobs and unsafe isolation remain intact. */
  retrySession(sessionId: string): boolean {
    const connection = this.connection;
    if (!connection || !this.current(connection, sessionId)) return false;
    const now = Date.now(), key = `fileManualRetry:${this.prefix(connection)}${sessionId}`;
    const lastRetryAt = this.deps.store.get<number>(key);
    if (lastRetryAt !== null && now - lastRetryAt < 60_000) return false;
    let accepted = false;
    this.deps.store.transaction(() => {
      const entries = [...this.fileEntries<InputJob>('desktopAsset:'), ...this.fileEntries<ArtifactJob>(`${this.prefix(connection)}${sessionId}:`)];
      for (const entry of entries) {
        const job = entry.value;
        if (job.localSessionId !== sessionId || !sameOwner(job.owner, connection.owner)
          || job.environment && job.environment !== connection.environment || !job.retry
          || job.retry.phase !== RemoteFileRetryPhase.Backoff && job.retry.phase !== RemoteFileRetryPhase.Cooldown
          || (job.retry.serverRetryAt || 0) > now) continue;
        job.retry = { ...job.retry, nextRetryAt: now }; job.retryAt = now;
        this.deps.store.put(entry.key, durableJson(job)); accepted = true;
      }
      if (accepted) this.deps.store.put(key, now);
    });
    return accepted;
  }
  private observationCursor = 0;
  private coldObservationAt = new Map<string, number>();
  private readonly delivered: RemoteDeliveredFileSync;
  constructor(private readonly deps: RemoteFileSyncDependencies) {
    this.delivered = new RemoteDeliveredFileSync(deps);
    deps.store.setArtifactProjectionResolver((sessionId, messageId) => this.projection(sessionId, messageId));
    deps.store.setFileTerminalBoundary((sessionId, runId) => this.captureTerminal(sessionId, runId));
  }
  configure(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.pause(); }
  // Capture sealed send-time bytes before the asynchronous file policy arrives. Upload still waits for policy admission.
  canCaptureInput(): boolean { return this.enabled && this.deps.enabled() && this.deps.owner() !== null; }
  private canUploadInput(): boolean { return this.canCaptureInput() && this.policy?.features.desktopInputSync === true; }
  async prepareRun(sessionId: string, roots: string[], validEpoch: () => boolean): Promise<void> {
    const connection = this.connection;
    if (!connection || !this.current(connection, sessionId)) return;
    await this.delivered.prepare(sessionId, roots, connection.owner, () => validEpoch() && this.current(connection, sessionId));
  }
  pause(): void { this.delivered.clear(); this.fileHealth = { degraded: false, pending: null }; this.connection = null; this.policy = null; this.policyAt = 0; this.policyRetryAt = 0; }
  private prefix(connection: Connection): string {
    return `fileOutput:${createHash('sha256').update(JSON.stringify([connection.environment, connection.owner, connection.deviceId])).digest('hex')}:`;
  }
  private current(connection: Connection, sessionId?: string): boolean {
    return this.enabled && this.deps.enabled() && sameOwner(connection.owner, this.deps.owner())
      && connection.environment === this.deps.environment() && this.connection?.generation === connection.generation
      && this.connection.deviceId === connection.deviceId && (!sessionId || this.deps.store.isTaskAdmitted(sessionId) && !this.deps.store.get(`${RemoteDeletion.Closed}${sessionId}`) && sameOwner(this.deps.store.owner(sessionId), connection.owner));
  }
  private assert(connection: Connection, sessionId?: string): void { if (!this.current(connection, sessionId)) throw new Error(RemoteFileReason.Access); }
  tick(connection: Connection): void {
    if (!this.enabled) return;
    if (!this.connection || !sameOwner(this.connection.owner, connection.owner) || this.connection.environment !== connection.environment
      || this.connection.deviceId !== connection.deviceId || this.connection.generation !== connection.generation) {
      this.policy = null; this.policyAt = 0; this.policyRetryAt = 0; this.fileHealth = { degraded: false, pending: null };
    }
    this.connection = connection;
    this.deps.store.setFileEnvironment(connection.environment);
    if (this.work) return;
    const work = this.cycle(connection).catch(() => {
      if (this.current(connection)) this.fileHealth = { degraded: true, pending: this.fileHealth.pending };
    }).finally(() => { if (this.work === work) this.work = null; });
    this.work = work;
  }
  async settled(): Promise<void> { await this.work; }
  private async request(connection: Connection, pathname: string, init: RequestInit): Promise<Record<string, any>> {
    this.assert(connection);
    const response = await requestRemoteFilePart(pathname, init, () => this.deps.request(connection, pathname, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { ...init.headers, ...(this.policy ? { 'X-Remote-File-Policy-Version': this.policy.policyVersion } : {}) },
    })).catch((error: unknown) => { throw new RemoteFileRequestError(error instanceof Error ? error.message : RemoteFileReason.Transfer); });
    this.assert(connection);
    const envelope = await response.json().catch((error: unknown) => {
      if (!response.ok) throw new RemoteFileRequestError(RemoteFileReason.Transfer, response.status, response.headers.get('Retry-After'));
      throw error;
    }) as { code: number; data: Record<string, any> };
    this.assert(connection);
    if (!response.ok || envelope.code !== 0) {
      const reason = envelope.data?.reason || RemoteFileReason.Transfer;
      if (reason === RemoteFileReason.Policy) { this.policy = null; this.policyAt = 0; this.policyRetryAt = 0; }
      throw new RemoteFileRequestError(String(reason), response.status, response.headers.get('Retry-After'), String(reason));
    }
    return envelope.data;
  }
  private json(connection: Connection, pathname: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Record<string, any>> {
    return this.request(connection, pathname, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  private async cycle(connection: Connection): Promise<void> {
    if (!this.policy || Date.now() - this.policyAt > 300_000) {
      if (Date.now() < this.policyRetryAt) return;
      this.policyRetryAt = Date.now() + 60_000;
      const policy = await this.json(connection, `/file-policy?deviceId=${escapeId(connection.deviceId)}`) as RemoteFilePolicy;
      if (!Array.isArray(policy.types) || !policy.features || !policy.limits || !/^\d+$/u.test(policy.policyVersion)) return;
      this.policy = policy; this.policyAt = Date.now(); this.policyRetryAt = 0;
    }
    this.fileHealth = { degraded: false, pending: 0 };
    if (Date.now() - this.cleanupAt > 3_600_000) {
      // Unknown references prohibit garbage collection, not independent publication of verified resources.
      await this.cleanupSnapshots(connection).catch(() => { this.fileHealth.degraded = true; }); this.cleanupAt = Date.now();
    }
    if (this.canUploadInput()) await this.inputs(connection);
    if (!this.policy?.features.artifactPublish || !this.current(connection)) return;
    await this.delivered.collect(connection.owner, this.policy, sessionId => this.current(connection, sessionId),
      (sessionId, messageId, runId, filePath, snapshot) => {
        const sync = this.deps.store.sync(sessionId);
        if (!sync || sync.device_id !== connection.deviceId) return false;
        const source = this.sources(sessionId, runId).find(item => item.message_id === messageId && item.file_path === filePath);
        if (!source) return false;
        const { key, job } = this.getJob(connection, source);
        // The immutable bytes were sealed after completion: publish current/latest, never fabricate a terminal version.
        this.enqueueSnapshot(source, job, snapshot, false);
        job.reason = undefined; job.terminalRuns.push(runId);
        this.save(key, job);
        return true;
      }).catch(() => { this.fileHealth.degraded = true; });
    await this.observe(connection).catch(() => { this.fileHealth.degraded = true; });
    for (const { key, value: job } of this.fileEntries<ArtifactJob>(this.prefix(connection), true)) {
      try {
        if (this.deps.store.get(`${RemoteDeletion.Closed}${job.localSessionId}`)) continue;
        if (!this.current(connection)) return;
        if (!this.current(connection, job.localSessionId)) continue;
        this.fileHealth.pending = (this.fileHealth.pending || 0) + job.queue.length + (job.rename ? 1 : 0);
        if (job.reason) this.fileHealth.degraded = true;
        if ((!job.queue.length && !job.rename) || !this.retryAllowed(job)) continue;
        try {
          if (job.rename && job.artifactId) {
            const rename = job.rename;
            if (!rename.expectedRevision) {
              const value = await this.json(connection, `/sessions/${escapeId(job.sessionId)}/artifacts/${escapeId(job.artifactId)}`);
              rename.expectedRevision = value.revision; this.save(key, job);
            }
            const renamed = await this.json(connection, `/artifacts/${escapeId(job.artifactId)}`, rename, 'PATCH');
            job.name = renamed.name; job.revision = renamed.revision; job.rename = undefined; this.save(key, job);
          }
          await this.publish(connection, key, job);
        }
        catch (error) {
          if (this.deps.store.get(`${RemoteDeletion.Closed}${job.localSessionId}`)) continue;
          if (!this.current(connection)) return;
          if (!this.current(connection, job.localSessionId)) continue;
          this.fileHealth.degraded = true;
          job.reason = error instanceof Error ? error.message : RemoteFileReason.Transfer;
          job.retry = nextFileRetry(job.retry, error, Date.now(), this.policy?.policyVersion || ''); job.retryAt = job.retry.nextRetryAt;
          this.save(key, job);
          if (job.artifactId) await this.json(connection, `/artifacts/${escapeId(job.artifactId)}/sync-state`, {
            operationId: randomUUID(), expectedRevision: job.revision, syncState: 'blocked',
            reason: remoteArtifactReasons.has(job.reason) ? job.reason : RemoteFileReason.Transfer,
          }, 'PUT').catch((): void => undefined);
        }
      } catch { this.fileHealth.degraded = true; /* Preserve the resource and continue even if its failure record is malformed. */ }
    }
  }
  private retryAllowed(job: { retry?: RemoteFileRetryState; retryAt?: number }): boolean {
    return job.retry ? fileRetryAllowed(job.retry, Date.now(), this.policy?.policyVersion || '') : (job.retryAt || 0) <= Date.now();
  }
  private fileEntries<T>(prefix: string, page = false, strict = false): Array<{ key: string; value: T }> {
    const cursorKey = `fileScheduleCursor:${prefix}`;
    let cursor = '';
    if (page) {
      try {
        const value = this.deps.store.get<string>(cursorKey);
        if (typeof value === 'string' && value.startsWith(prefix)) cursor = value;
      } catch { this.fileHealth.degraded = true; /* The cursor is a reconstructible scheduling hint, never an upload receipt. */ }
    }
    const read = (after: string): Array<{ key: string; value: string }> => this.deps.store.db.prepare(
      `SELECT key,value FROM remote_state WHERE key>=? AND key<? AND key>? ORDER BY key${page ? ' LIMIT 50' : ''}`,
    ).all(prefix, `${prefix}\uffff`, after) as Array<{ key: string; value: string }>;
    let rows = read(cursor);
    if (page && !rows.length && cursor) rows = read('');
    if (page && rows.length) this.deps.store.put(cursorKey, rows[rows.length - 1].key);
    const parsed: Array<{ key: string; value: T }> = [];
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value) as T;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file job');
        const job = value as unknown as InputJob | ArtifactJob;
        if (!safeId(job.localSessionId) || !job.owner || typeof job.owner.userId !== 'string' || typeof job.owner.scopeKey !== 'string'
          || typeof job.sessionId !== 'string') throw new Error('Invalid file job identity');
        if (prefix.startsWith('fileOutput:')) {
          const output = job as ArtifactJob;
          if (!Array.isArray(output.queue) || !Array.isArray(output.terminalRuns) || !output.references || Array.isArray(output.references)
            || typeof output.references !== 'object' || !/^\d+$/u.test(output.captureSequence)) throw new Error('Invalid artifact job');
        } else if (!safeId((job as InputJob).messageId) || typeof (job as InputJob).fileName !== 'string') throw new Error('Invalid input job');
        parsed.push({ key: row.key, value });
      } catch {
        // This is operation evidence: retain both the live row and its original bytes, never reconstruct a new upload ID.
        this.deps.store.db.prepare('INSERT OR IGNORE INTO remote_corrupt_state VALUES (?,?,?)').run(row.key, row.value, Date.now());
        this.fileHealth.degraded = true;
        if (strict) throw new Error(RemoteFileReason.Source);
      }
    }
    return parsed;
  }
  private async cleanupSnapshots(connection: Connection): Promise<void> {
    this.assert(connection);
    const references = archivedRemoteSyncReferences(this.deps.store).paths;
    for (const { value } of this.deps.store.entries<{ owner: RemoteOwner; attachments: Array<{ snapshot?: RemoteFileSnapshot }> }>('desktopInputRun:'))
      if (value.owner.userId === connection.owner.userId) for (const item of value.attachments) if (item.snapshot) references.add(item.snapshot.path);
    for (const { value } of this.deps.store.entries<InputJob>('desktopAsset:')) if (value.owner.userId === connection.owner.userId && value.snapshot) references.add(value.snapshot.path);
    for (const { value } of this.deps.store.entries<ArtifactJob>('fileOutput:')) if (value.owner.userId === connection.owner.userId)
      for (const pending of value.queue) references.add(pending.snapshot.path);
    const accountRoot = path.dirname(remoteFileCacheDirectory(this.deps.cacheRoot, connection.owner));
    const scopes = await fs.promises.readdir(accountRoot, { withFileTypes: true }).catch((): fs.Dirent[] => []);
    let scanned = 0;
    for (const scope of scopes) {
      if (!scope.isDirectory() || !/^[a-f0-9]{64}$/u.test(scope.name)) continue;
      for (const file of await fs.promises.readdir(path.join(accountRoot, scope.name), { withFileTypes: true })) {
        if (++scanned > 4096) return;
        if (!file.isFile() || !/^[a-f0-9-]{36}$/u.test(file.name)) continue;
        const target = path.join(accountRoot, scope.name, file.name);
        if (!references.has(target) && (await fs.promises.stat(target)).mtimeMs < Date.now() - 86_400_000) { this.assert(connection); await fs.promises.rm(target, { force: true }); }
      }
    }
  }
  private save(key: string, job: ArtifactJob): void {
    this.deps.store.transaction(() => {
      // A terminal boundary can enqueue while an HTTP await is outstanding. Merge durable additions before saving the receipt.
      const persisted = this.deps.store.get<ArtifactJob>(key);
      if (persisted) {
        if (persisted.rename && !job.rename && persisted.rename.name !== job.name) job.rename = persisted.rename;
        if (BigInt(persisted.captureSequence) > BigInt(job.captureSequence)) {
          job.messageId = persisted.messageId; job.sizeBytes = persisted.sizeBytes; job.signature = persisted.signature;
          job.dirtyAt = persisted.dirtyAt; job.changedAt = persisted.changedAt;
        }
        if (persisted.reason === RemoteFileReason.Final && persisted.terminalRuns.some(runId => !job.terminalRuns.includes(runId))) job.reason = persisted.reason;
        job.completedPublications = [...new Set([...(persisted.completedPublications || []), ...(job.completedPublications || [])])].slice(-128);
        const finished = new Set(job.completedPublications);
        const queued = new Map([...persisted.queue, ...job.queue].filter(item => !finished.has(item.publicationId)).map(item => [item.publicationId, item]));
        job.queue = [...queued.values()].sort((left, right) => BigInt(left.captureSequence) < BigInt(right.captureSequence) ? -1 : 1);
        job.terminalRuns = [...new Set([...persisted.terminalRuns, ...job.terminalRuns])];
        if (BigInt(persisted.captureSequence) > BigInt(job.captureSequence)) job.captureSequence = persisted.captureSequence;
        job.references = { ...persisted.references, ...job.references };
      }
      const durable = durableJson(job);
      // Observation of an unchanged file is not a new publication or a conversation change.
      if (persisted && stableJson(persisted) === stableJson(durable)) return;
      this.deps.store.put(key, durable); this.deps.store.markFilesDirty(job.localSessionId);
    });
  }
  private sources(sessionId: string, runId?: string): Source[] {
    if (!this.deps.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_local_artifacts'").get()) return [];
    const rows = this.deps.store.db.prepare(`SELECT a.id,a.file_path,a.file_name,a.file_identity,a.updated_at,
      m.id AS message_id,m.metadata,r.session_id FROM library_local_artifacts a
      JOIN library_artifact_sessions r ON r.artifact_id=a.id JOIN cowork_messages m ON m.id=r.last_message_id AND m.session_id=r.session_id
      WHERE r.session_id=? AND r.relation_kind IN ('created','modified') AND a.availability='available'
      AND m.type IN ('assistant','tool_result') ORDER BY a.id`).all(sessionId) as Array<Source & { metadata: string }>;
    return rows.flatMap(row => {
      try { const run = JSON.parse(row.metadata).remoteRunId;
        return safeId(run) && (!runId || run === runId) && safeId(row.id) && safeId(row.message_id) ? [{ ...row, run_id: run }] : [];
      } catch { return []; }
    });
  }
  private getJob(connection: Connection, source: Source): { key: string; job: ArtifactJob } {
    const key = `${this.prefix(connection)}${source.session_id}:${source.id}`;
    const job = this.deps.store.get<ArtifactJob>(key) || {
      owner: connection.owner, environment: connection.environment, deviceId: connection.deviceId, localSessionId: source.session_id,
      sessionId: this.deps.store.sync(source.session_id)!.session_id, localArtifactId: source.id, name: source.file_name,
      revision: '0', latest: null, captureSequence: '0', queue: [], terminalRuns: [], references: {},
    };
    job.messageId = source.message_id;
    if (job.name !== source.file_name) {
      if (!job.artifactId) job.name = source.file_name;
      else if (job.rename?.name !== source.file_name) job.rename = { operationId: randomUUID(), name: source.file_name };
    }
    return { key, job };
  }
  private enqueueSnapshot(source: Source, job: ArtifactJob, snapshot: RemoteFileSnapshot, final: boolean): void {
    job.captureSequence = String(BigInt(job.captureSequence) + 1n);
    job.queue.push({ publicationId: randomUUID(), captureSequence: job.captureSequence, messageId: source.message_id, runId: source.run_id,
      fileName: path.basename(source.file_name), mimeType: mime(source.file_name), snapshot, terminal: final });
    job.lastCaptureAt = Date.now(); job.dirtyAt = undefined;
    if (job.reason !== RemoteFileReason.Final) job.reason = undefined;
  }
  private captureProducerVersion(connection: Connection, source: Source, job: ArtifactJob): boolean {
    this.assert(connection, source.session_id);
    const sealed = this.deps.terminalSnapshot?.(source);
    if (!sealed) return false;
    if (!this.policy || sealed.runId !== source.run_id || sealed.artifactId !== source.id || !sealed.producerRevision
      || sealed.producerRevision.length > 128 || !sealed.snapshot.sha256 || job.queue.filter(item => item.terminal).length >= 3) throw new Error(RemoteFileReason.Final);
    const reason = remoteFileRule(this.policy, source.file_name, sealed.snapshot.sizeBytes, true);
    if (reason) throw new Error(reason);
    this.enqueueSnapshot(source, job, sealed.snapshot, true);
    return true;
  }
  private async capture(connection: Connection, source: Source, job: ArtifactJob): Promise<void> {
    if (!this.policy) throw new Error(RemoteFileReason.Final);
    if (job.queue.length) return;
    const lease = this.deps.access(source.file_path);
    const ordinal = this.deps.store.get<string>(`fileRunOrdinal:${source.session_id}`);
    const assert = (): void => {
      this.assert(connection, source.session_id); lease.assertAllowed();
      const relation = this.deps.store.db.prepare('SELECT last_message_id FROM library_artifact_sessions WHERE artifact_id=? AND session_id=?').get(source.id, source.session_id) as { last_message_id: string } | undefined;
      if (relation?.last_message_id !== source.message_id || this.deps.store.run(source.session_id)?.runId !== source.run_id
        || this.deps.store.get<string>(`fileRunOrdinal:${source.session_id}`) !== ordinal) throw new Error(RemoteFileReason.Source);
    };
    assert();
    const before = await fs.promises.stat(source.file_path);
    if (!source.file_identity || `${before.dev}:${before.ino}:${Math.trunc(before.birthtimeMs)}` !== source.file_identity) throw new Error(RemoteFileReason.Source);
    const reason = remoteFileRule(this.policy, source.file_name, String(before.size), true);
    if (reason) throw new Error(reason);
    const snapshot = await captureRemoteFileSnapshot(source.file_path, this.deps.cacheRoot, connection.owner, 30 * 1024 * 1024, assert);
    try {
      assert();
      if (snapshot.identity !== `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`) throw new Error(RemoteFileReason.Source);
      this.enqueueSnapshot(source, job, snapshot, false);
    } catch (error) { await fs.promises.rm(snapshot.path, { force: true }); throw error; }
  }
  private async observe(connection: Connection): Promise<void> {
    const rows = this.deps.store.sessions(connection.owner);
    const offset = rows.length ? this.observationCursor % rows.length : 0;
    const selected = [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 20);
    this.observationCursor = rows.length ? (offset + selected.length) % rows.length : 0;
    for (const row of selected) {
      try {
        const activeRun = this.deps.store.run(row.local_id);
        if (!activeRun || terminal.has(activeRun.status)) {
          if ((this.coldObservationAt.get(row.local_id) ?? 0) > Date.now()) continue;
          this.coldObservationAt.set(row.local_id, Date.now() + 60000);
          if (this.coldObservationAt.size > 2000) this.coldObservationAt.delete(this.coldObservationAt.keys().next().value!);
        }
        if (!this.current(connection)) return;
        if (!this.current(connection, row.local_id)) continue;
        let count = 0;
        for (const source of this.sources(row.local_id)) {
          if (++count > (this.policy?.limits.maxTaskArtifactCount || 20)) break;
          try {
            const { key, job } = this.getJob(connection, source);
            try {
              const stat = await fs.promises.stat(source.file_path);
              job.sizeBytes = String(stat.size);
              const signature = `${source.updated_at}:${source.message_id}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
              if (signature !== job.signature) { job.signature = signature; job.changedAt = Date.now(); job.dirtyAt ||= Date.now(); }
              const run = this.deps.store.run(row.local_id);
              if (run?.runId === source.run_id && terminal.has(run.status) && !job.terminalRuns.includes(run.runId)) {
                const boundary = this.deps.store.get<TerminalBoundary>(`fileTerminalBoundary:${row.local_id}:${run.runId}`);
                const ordinal = this.deps.store.get<string>(`fileRunOrdinal:${row.local_id}`);
                // Renderer indexing can follow complete. Admission must have been durably recorded at the real live boundary.
                const admitted = boundary && sameOwner(boundary.owner, connection.owner) && boundary.environment === connection.environment
                  && boundary.deviceId === connection.deviceId && boundary.finishedAt === run.finishedAt && boundary.ordinal === ordinal
                  && ordinal === this.deps.store.get<string>(`fileRunOrdinal:${row.local_id}:${run.runId}`)
                  && stat.mtimeMs <= Date.parse(boundary.finishedAt) + 1 && stat.birthtimeMs <= Date.parse(boundary.finishedAt) + 1;
                if (admitted) {
                  try {
                    if (!this.captureProducerVersion(connection, source, job)) { job.reason = RemoteFileReason.Final; await this.capture(connection, source, job); }
                  } catch { job.reason = RemoteFileReason.Final; }
                }
                else job.reason = RemoteFileReason.Final;
                job.terminalRuns.push(run.runId);
              } else if (run?.runId !== source.run_id && !job.terminalRuns.includes(source.run_id)) {
                job.reason = RemoteFileReason.Final; job.terminalRuns.push(source.run_id);
              } else if (job.dirtyAt && !job.queue.length && run?.runId === source.run_id && !terminal.has(run.status)
                && (Date.now() - (job.changedAt || 0) >= 2_000 || Date.now() - job.dirtyAt >= 10_000)) await this.capture(connection, source, job);
            } catch (error) { job.reason = error instanceof Error ? error.message : RemoteFileReason.Source; }
            this.save(key, job);
          } catch { this.fileHealth.degraded = true; }
        }
      } catch { this.fileHealth.degraded = true; }
    }
  }
  private captureTerminal(sessionId: string, runId: string): void {
    const connection = this.connection;
    this.coldObservationAt.delete(sessionId);
    if (!connection || !this.current(connection, sessionId) || !this.policy?.features.artifactPublish) return;
    const run = this.deps.store.run(sessionId), ordinal = this.deps.store.get<string>(`fileRunOrdinal:${sessionId}:${runId}`);
    if (!ordinal || run?.runId !== runId || !run.finishedAt || !terminal.has(run.status)) return;
    this.deps.store.put(`fileTerminalBoundary:${sessionId}:${runId}`, { owner: connection.owner, environment: connection.environment,
      deviceId: connection.deviceId, ordinal, finishedAt: run.finishedAt } satisfies TerminalBoundary);
    for (const source of this.sources(sessionId, runId).slice(0, this.policy.limits.maxTaskArtifactCount)) {
      const { key, job } = this.getJob(connection, source);
      if (job.terminalRuns.includes(runId)) continue;
      try {
        if (this.captureProducerVersion(connection, source, job)) job.terminalRuns.push(runId);
        else job.reason = RemoteFileReason.Final; // Mutable sources are captured later as current versions, never as pinned terminal bytes.
      } catch { job.reason = RemoteFileReason.Final; job.terminalRuns.push(runId); }
      this.save(key, job);
    }
  }
  private async inputs(connection: Connection): Promise<void> {
    if (!this.policy || !this.canUploadInput()) return;
    const jobs = this.fileEntries<InputJob>('desktopAsset:', true);
    for (const { key, value: job } of jobs) {
      try {
        if (!sameOwner(job.owner, connection.owner) || !this.current(connection, job.localSessionId)) continue;
        if (job.environment && job.environment !== connection.environment) continue;
        if (job.availability === 'ready') continue;
        this.fileHealth.pending = (this.fileHealth.pending || 0) + 1;
        if (job.reason) this.fileHealth.degraded = true;
        if (!this.retryAllowed(job)) continue;
        const session = this.deps.store.sync(job.localSessionId);
        if (!session || session.device_id !== connection.deviceId || session.needs_snapshot || session.source_seq !== session.ack_seq) continue;
        try {
          const reason = remoteFileRule(this.policy, job.fileName, job.sizeBytes || '0', false);
          if (reason) throw new Error(reason);
          // The quota boundary must include every sibling, even outside this scheduler page. Corrupt siblings block only this message.
          const siblings = this.deps.store.entries<InputJob>(`desktopAsset:${job.messageId}:`).map(row => row.value);
          if (siblings.some(item => item.messageId !== job.messageId || !sameOwner(item.owner, job.owner))) throw new Error(RemoteFileReason.Access);
          if (siblings.length > this.policy.limits.maxInputCount || siblings.reduce((sum, item) => sum + BigInt(item.sizeBytes || '0'), 0n) > BigInt(this.policy.limits.maxInputBytes)
            || siblings.filter(item => item.intent === 'image').reduce((sum, item) => sum + BigInt(item.sizeBytes || '0'), 0n) > BigInt(this.policy.limits.maxImageBytes)) throw new Error('INPUT_TOTAL_TOO_LARGE');
          // An executed phone input retains a sealed preparation; each target gets an independent upload copy.
          if (!job.snapshot && job.preparedSource) {
            job.snapshot = await capturePreparedInputSnapshot(this.deps.store, job as InputJob & DesktopInputSource & { preparedSource: RemotePreparedInputSource },
              this.deps.cacheRoot, connection.deviceId, () => this.assert(connection, job.localSessionId));
            this.assert(connection, job.localSessionId);
            this.deps.store.put(key, durableJson(job));
          }
          // Mutable historical file paths never become retrospective snapshots.
          if (!job.snapshot) throw new Error(typeof job.captureReason === 'string' && remoteArtifactReasons.has(job.captureReason)
            ? job.captureReason : RemoteFileReason.Source);
          job.deviceId = connection.deviceId; job.sessionId = session.session_id; job.environment = connection.environment;
          const uploadedAsset = await uploadDesktopMessageAsset({ ...job, path: job.snapshot.path, sha256: job.snapshot.sha256, fileIdentity: undefined }, {
            current: () => this.current(connection, job.localSessionId) && !!this.deps.store.db.prepare("SELECT id FROM cowork_messages WHERE id=? AND session_id=? AND type='user'").get(job.messageId, job.localSessionId),
            request: (pathname, init) => this.deps.request(connection, pathname.replace(/^\/api\/remote\/v1/u, ''), { ...init,
              headers: { ...init.headers, 'X-Remote-File-Policy-Version': this.policy!.policyVersion } }),
            persist: patch => {
              this.assert(connection, job.localSessionId);
              const changed = patch.availability !== undefined && (job.availability !== patch.availability || job.reason !== undefined);
              Object.assign(job, patch);
              if (patch.availability !== undefined) job.reason = undefined;
              this.deps.store.transaction(() => {
                this.deps.store.put(key, durableJson(job));
                if (changed) this.deps.store.markFilesDirty(job.localSessionId);
              });
            },
            progress: () => {
              this.assert(connection, job.localSessionId); job.retry = undefined; job.retryAt = undefined;
              this.deps.store.put(key, durableJson(job));
            },
          }, { partBudget: 1 });
          this.assert(connection, job.localSessionId);
          if (!uploadedAsset) { job.retry = undefined; job.retryAt = undefined; this.deps.store.put(key, durableJson(job)); continue; }
          this.deps.store.transaction(() => { this.deps.store.put(key, durableJson({ ...job, retry: undefined, retryAt: undefined, availability: 'ready', uploadedAsset, reason: undefined })); this.deps.store.markFilesDirty(job.localSessionId); });
          // Remote publication is already committed. A private-cache cleanup failure must not erase its ready receipt.
          await fs.promises.rm(job.snapshot.path, { force: true }).catch((): void => undefined);
        } catch (error) {
          if (!this.current(connection)) return;
          if (!this.current(connection, job.localSessionId)) continue;
          this.fileHealth.degraded = true;
          const reason = error instanceof Error ? error.message : RemoteFileReason.Transfer;
          const changed = job.reason !== reason;
          job.reason = reason; job.retry = nextFileRetry(job.retry, error, Date.now(), this.policy?.policyVersion || ''); job.retryAt = job.retry.nextRetryAt;
          this.deps.store.transaction(() => {
            this.deps.store.put(key, durableJson(job));
            if (changed) this.deps.store.markFilesDirty(job.localSessionId);
          });
        }
      } catch { this.fileHealth.degraded = true; /* A resource read/recovery failure cannot starve the next job. */ }
    }
  }
  private async publish(connection: Connection, key: string, job: ArtifactJob): Promise<void> {
    const pending = job.queue[0]; if (!pending) return;
    const sync = this.deps.store.sync(job.localSessionId);
    if (!sync || sync.needs_snapshot || sync.source_seq !== sync.ack_seq) return;
    const current = (): boolean => {
      const session = this.deps.store.sync(job.localSessionId);
      const message = this.deps.store.db.prepare('SELECT metadata FROM cowork_messages WHERE id=? AND session_id=?').get(pending.messageId, job.localSessionId) as { metadata: string } | undefined;
      const run = this.deps.store.get<{ runId: string; status: string }>(`runHistory:${job.localSessionId}:${pending.runId}`);
      let messageRun: unknown; try { messageRun = JSON.parse(message?.metadata || '{}').remoteRunId; } catch { return false; }
      return this.current(connection, job.localSessionId) && sameOwner(job.owner, connection.owner) && job.environment === connection.environment
        && job.deviceId === connection.deviceId && session?.device_id === connection.deviceId && session.session_id === job.sessionId
        && messageRun === pending.runId && run?.runId === pending.runId && (!pending.terminal || terminal.has(run.status));
    };
    if (!current()) throw new Error(RemoteFileReason.Access);
    const sha256 = await verifyRemoteFileSnapshot(pending.snapshot, current);
    if (!job.artifactId) {
      const registered = await this.json(connection, `/devices/${escapeId(connection.deviceId)}/artifacts`, {
        localArtifactId: job.localArtifactId, sessionId: job.sessionId, messageId: pending.messageId, runId: pending.runId, name: job.name,
      });
      if (!safeId(registered.artifactId)) throw new Error(RemoteFileReason.Transfer);
      job.artifactId = registered.artifactId; job.revision = registered.revision; this.save(key, job);
    }
    const artifactPath = `/artifacts/${escapeId(job.artifactId)}`;
    // Query authoritative state before retrying an unknown publish result or advancing the queue.
    const manifest = await this.json(connection, `/sessions/${escapeId(job.sessionId)}/artifacts/${escapeId(job.artifactId)}`) as RemoteArtifactManifest;
    job.latest = manifest.latest; job.revision = manifest.revision;
    if (pending.artifactVersion && manifest.latest?.artifactVersion === pending.artifactVersion && manifest.latest.sha256 === sha256) {
      await this.finish(connection, key, job, pending); return;
    }
    if (!pending.assetId && manifest.latest?.sha256 === sha256) {
      // Reuse verified bytes while still giving the new message a current/latest reference.
      pending.artifactVersion = manifest.latest.artifactVersion;
      await this.finish(connection, key, job, pending); return;
    }
    // A newer message must not leave an older message pointing at a stale "latest" version.
    for (const [messageId, reference] of Object.entries(job.references)) {
      if (messageId === pending.messageId || reference.pinned) continue;
      await this.json(connection, `${artifactPath}/references`, { requestId: `history-${createHash('sha256').update(`${job.artifactId}:${messageId}:${reference.latest.artifactVersion}`).digest('hex').slice(0, 32)}`,
        artifactVersion: reference.latest.artifactVersion, messageId, runId: reference.runId, sha256: reference.latest.sha256, kind: 'history' });
      reference.pinned = true; this.save(key, job); return;
    }
    let upload: Record<string, any>;
    for (let attempt = 0; ; attempt++) {
      if (!current()) throw new Error(RemoteFileReason.Access);
      if (pending.assetId) {
        upload = await this.json(connection, `/artifact-uploads/${escapeId(pending.assetId)}`);
      } else {
        pending.expectedLatestVersion ??= manifest.latest?.artifactVersion || '0'; this.save(key, job);
        upload = await this.json(connection, `${artifactPath}/versions`, {
          publicationId: pending.publicationId, expectedLatestVersion: pending.expectedLatestVersion, captureSequence: pending.captureSequence,
          messageId: pending.messageId, runId: pending.runId, fileName: pending.fileName, mimeType: pending.mimeType, sizeBytes: pending.snapshot.sizeBytes, sha256,
        });
        if (!safeId(upload.assetId) || !/^[1-9]\d*$/u.test(upload.artifactVersion)) throw new Error(RemoteFileReason.Transfer);
        pending.assetId = upload.assetId; pending.artifactVersion = upload.artifactVersion;
      }
      if (!expiredUploadStates.has(upload.status) && !expiredUploadStates.has(upload.publicationStatus)) break;
      if (attempt !== 0) throw new Error(RemoteFileReason.Transfer);
      await this.replaceExpiredPublication(connection, key, job, pending, upload, current, sha256);
    }
    // An idempotent CREATE can return an old-generation upload after its first receipt was lost.
    if (upload.writerGeneration !== connection.generation) upload = await this.json(connection, `/artifact-uploads/${escapeId(pending.assetId!)}/resume`, { publicationId: pending.publicationId, sha256 });
    pending.generation = connection.generation; this.save(key, job);
    const uploadPath = `/artifact-uploads/${escapeId(pending.assetId!)}`;
    if (upload.status !== 'ready' && upload.status !== 'published') {
      const partBytes = Number(upload.partBytes), partCount = Number(upload.partCount), size = Number(pending.snapshot.sizeBytes);
      if (!Number.isInteger(partBytes) || partBytes < 1 || partBytes > 4 * 1024 * 1024 || partCount !== Math.ceil(size / partBytes) || !Array.isArray(upload.completedParts)
        || upload.completedParts.some((value: unknown) => !Number.isInteger(value) || Number(value) < 1 || Number(value) > partCount)) throw new Error(RemoteFileReason.Transfer);
      const handle = await fs.promises.open(pending.snapshot.path, 'r');
      let sent = false;
      try {
        for (let partNo = 1; partNo <= partCount; partNo++) {
          if (!current()) throw new Error(RemoteFileReason.Access);
          if (upload.completedParts.includes(partNo)) continue;
          if (sent) return;
          const offset = (partNo - 1) * partBytes, length = Math.min(partBytes, size - offset), buffer = new Uint8Array(length);
          let read = 0;
          while (read < length) { const chunk = await handle.read(buffer, read, length - read, offset + read); if (!chunk.bytesRead) throw new Error(RemoteFileReason.Source); read += chunk.bytesRead; }
          const digest = createHash('sha256').update(buffer).digest('hex');
          // Electron computes Content-Length from these fixed bytes; setting it manually rejects net.fetch.
          await this.request(connection, `${uploadPath}/parts/${partNo}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': digest }, body: buffer.buffer });
          sent = true; job.retry = undefined; job.retryAt = undefined; this.save(key, job);
        }
      } finally { await handle.close(); }
      await this.json(connection, `${uploadPath}/complete`, { sha256 });
    }
    if (!current()) throw new Error(RemoteFileReason.Access);
    const published = await this.json(connection, `${artifactPath}/versions/${escapeId(pending.artifactVersion!)}/publish`, { publicationId: pending.publicationId }) as RemoteArtifactManifest;
    if (!published.latest || published.latest.sha256 !== sha256 || published.latest.artifactVersion !== pending.artifactVersion) throw new Error(RemoteFileReason.Source);
    job.latest = published.latest; job.revision = published.revision;
    await this.finish(connection, key, job, pending);
  }
  private async replaceExpiredPublication(connection: Connection, key: string, job: ArtifactJob, pending: Publication,
    upload: Record<string, any>, current: () => boolean, sha256: string): Promise<void> {
    // Only an explicit, matching unpublished tombstone permits a new operation ID. Timeouts/404s are not proof of expiry.
    if (upload.published !== false || !expiredUploadStates.has(upload.publicationStatus)
      || upload.artifactId !== job.artifactId || upload.assetId !== pending.assetId || upload.artifactVersion !== pending.artifactVersion
      || upload.publicationId !== pending.publicationId || upload.captureSequence !== pending.captureSequence
      || upload.expectedLatestVersion !== pending.expectedLatestVersion || upload.sha256 !== sha256 || upload.sizeBytes !== pending.snapshot.sizeBytes) throw new Error(RemoteFileReason.Transfer);
    const latest = await this.json(connection, `/sessions/${escapeId(job.sessionId)}/artifacts/${escapeId(job.artifactId!)}`) as RemoteArtifactManifest;
    if (latest.artifactId !== job.artifactId || latest.sessionId !== job.sessionId || latest.pendingArtifactVersion !== null
      || latest.latestVersion !== pending.expectedLatestVersion || (latest.latest?.artifactVersion || '0') !== pending.expectedLatestVersion
      || !/^\d+$/u.test(latest.lastCaptureSequence) || BigInt(latest.lastCaptureSequence) >= BigInt(pending.captureSequence)) throw new Error(RemoteFileReason.Transfer);
    if (!pending.snapshot.cacheIdentity || !pending.snapshot.sha256
      || path.dirname(pending.snapshot.path) !== remoteFileCacheDirectory(this.deps.cacheRoot, connection.owner)
      || await verifyRemoteFileSnapshot(pending.snapshot, current) !== sha256) throw new Error(RemoteFileReason.Source);
    if (!current()) throw new Error(RemoteFileReason.Access);
    // Retire the old ID atomically so the durable queue merge cannot resurrect it. Preserve bytes, order and the original CAS.
    job.completedPublications = [...(job.completedPublications || []), pending.publicationId];
    pending.publicationId = randomUUID(); pending.assetId = undefined; pending.artifactVersion = undefined; pending.generation = undefined;
    job.latest = latest.latest; job.revision = latest.revision; this.save(key, job);
  }
  private async finish(connection: Connection, key: string, job: ArtifactJob, pending: Publication): Promise<void> {
    if (!job.latest) throw new Error(RemoteFileReason.Transfer);
    if (pending.terminal) await this.json(connection, `/artifacts/${escapeId(job.artifactId!)}/references`, {
      requestId: pending.publicationId, artifactVersion: job.latest.artifactVersion, messageId: pending.messageId,
      runId: pending.runId, sha256: pending.snapshot.sha256, kind: 'terminal',
    });
    this.assert(connection, job.localSessionId);
    const previous = job.references[pending.messageId];
    // Reusing bytes for a new running message cannot pin it early: that message may still publish a later final version.
    if (!previous?.pinned && (pending.terminal || pending.artifactVersion || previous)) job.references[pending.messageId] = { runId: pending.runId, latest: job.latest, pinned: pending.terminal };
    job.queue = job.queue.filter(item => item.publicationId !== pending.publicationId);
    job.completedPublications = [...(job.completedPublications || []), pending.publicationId];
    if (job.reason !== RemoteFileReason.Final) job.reason = undefined;
    job.retry = undefined; job.retryAt = undefined; this.save(key, job);
    await fs.promises.rm(pending.snapshot.path, { force: true }).catch((): void => undefined);
  }
  private projection(sessionId: string, messageId: string): Array<{ localArtifactId: string; block: Record<string, unknown> }> {
    const connection = this.connection;
    if (!connection || !this.current(connection, sessionId)) return [];
    return projectRemoteArtifacts(this.fileEntries<ArtifactJob>(`${this.prefix(connection)}${sessionId}:`, false, true)
      .map(row => row.value).filter(job => job.localSessionId === sessionId), messageId);
  }
}
