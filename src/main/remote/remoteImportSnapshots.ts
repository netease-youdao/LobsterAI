import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

import { sameOwner, stableJson } from './canonical';
import type { ImportPartIndex, ImportSnapshotIdentity, ImportSnapshotPackage, ImportSnapshotWork } from './remoteImportSnapshotWorker';
import type { RemoteStore } from './remoteStore';
import { archivedRemoteSyncReferences } from './remoteSyncTargetStore';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

const fileSetPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
export class RemoteImportSnapshotError extends Error {}
/** Private immutable snapshot bodies. Only the manifest/index is persisted in the core database. */
export class RemoteImportSnapshots {
  private readonly root: string;
  private cancelWorker: (() => void) | null = null;
  private active: string | null = null;
  constructor(private readonly store: RemoteStore, private readonly workerPath = remoteWorkerPath(RemoteWorkerFile.ImportSnapshot)) {
    this.root = path.join(path.dirname(store.db.name), 'remote-import-snapshots');
  }
  private directory(fileSet: string): string {
    if (!fileSetPattern.test(fileSet)) throw new RemoteImportSnapshotError('REMOTE_IMPORT_PART_UNAVAILABLE');
    return path.join(this.root, fileSet);
  }
  cancel(): void { this.cancelWorker?.(); }
  private async work<T>(input: ImportSnapshotWork, current: () => boolean): Promise<T> {
    if (this.cancelWorker || !current()) throw new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED');
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } });
      let finished = false;
      const finish = (error?: Error, value?: T): void => {
        if (finished) return; finished = true;
        clearTimeout(timer); clearInterval(guard);
        void worker.terminate().then(() => {
          this.cancelWorker = null;
          if (error) reject(error); else if (!current()) reject(new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED')); else resolve(value!);
        });
      };
      const timer = setTimeout(() => finish(new RemoteImportSnapshotError('REMOTE_IMPORT_BUDGET')), input.operation === 'build' ? 125_000 : 10_000);
      const guard = setInterval(() => { if (!current()) finish(new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED')); }, 100);
      this.cancelWorker = () => finish(new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED'));
      worker.on('message', message => finish(message.error ? new RemoteImportSnapshotError(message.error) : undefined, message.result));
      worker.on('error', error => finish(new RemoteImportSnapshotError((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'REMOTE_IMPORT_BUDGET' : 'REMOTE_IMPORT_PART_UNAVAILABLE')));
      worker.on('exit', () => finish(new RemoteImportSnapshotError('REMOTE_IMPORT_PART_UNAVAILABLE')));
    });
  }
  identity(localSessionId: string, owner: ImportSnapshotIdentity['owner'], deviceId: string, environment: string): ImportSnapshotIdentity {
    const row = this.store.sync(localSessionId);
    if (!row || !sameOwner(owner, this.store.owner(localSessionId)) || this.store.projectionPublishing(localSessionId)
      || row.device_id !== deviceId || row.sync_environment && row.sync_environment !== environment) throw new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED');
    return { localSessionId, sessionId: row.session_id, owner: { ...owner }, deviceId, environment, sourceSeq: String(row.source_seq),
      snapshotEpoch: this.store.get<number>(`snapshotEpoch:${localSessionId}`) || 0,
      revision: (this.store.db.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(localSessionId) as { revision: number } | undefined)?.revision || 0 };
  }
  matches(identity: ImportSnapshotIdentity): boolean {
    try { return stableJson(identity) === stableJson(this.identity(identity.localSessionId, identity.owner, identity.deviceId, identity.environment)); }
    catch { return false; }
  }
  async create(fileSet: string, identity: ImportSnapshotIdentity, current: () => boolean): Promise<ImportSnapshotPackage> {
    this.active = fileSet;
    try {
      await this.collect();
      if (!current()) throw new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED');
      const result = await this.work<ImportSnapshotPackage>({ operation: 'build', database: this.store.db.name, directory: this.directory(fileSet), fileSet, identity }, current);
      if (!this.matches(identity)) throw new RemoteImportSnapshotError('REMOTE_IMPORT_CONTEXT_CHANGED');
      return result;
    } catch (error) { await fs.promises.rm(this.directory(fileSet), { recursive: true, force: true }); throw error; }
    finally { this.active = null; }
  }
  async read(fileSet: string, part: ImportPartIndex, current: () => boolean): Promise<string> {
    return this.work<string>({ operation: 'read', directory: this.directory(fileSet), part }, current);
  }
  async exists(fileSet: string, parts: ImportPartIndex[]): Promise<boolean> {
    try {
      const directory = this.directory(fileSet), parent = await fs.promises.lstat(directory);
      if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
      for (const part of parts) {
        if (!Number.isSafeInteger(part.partNo) || part.partNo < 0) return false;
        const stat = await fs.promises.lstat(path.join(directory, `${part.partNo}.json`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== part.byteSize) return false;
      }
      return true;
    } catch { return false; }
  }
  async release(fileSet: string): Promise<void> {
    const references = this.referenced();
    if (references === null || references.has(fileSet)) return;
    await fs.promises.rm(this.directory(fileSet), { recursive: true, force: true });
  }
  private referenced(): Set<string> | null {
    // Unknown receipts can still own files. Corrupt bookkeeping must never authorize cache deletion.
    if (this.store.db.prepare("SELECT 1 FROM remote_state WHERE key LIKE 'import:%' AND NOT json_valid(value) LIMIT 1").get()) return null;
    let archived: ReturnType<typeof archivedRemoteSyncReferences>;
    try { archived = archivedRemoteSyncReferences(this.store); }
    catch (error) {
      // Preserve all spool files on uncertain evidence. Shared storage errors still propagate.
      if (typeof (error as { code?: unknown })?.code === 'string' && String((error as { code: string }).code).startsWith('SQLITE_')) throw error;
      return null;
    }
    return new Set([...archived.importFileSets,
      ...(this.store.db.prepare("SELECT json_extract(value,'$.fileSet') AS file_set FROM remote_state WHERE key LIKE 'import:%' AND json_valid(value)").all() as Array<{ file_set: string | null }>).map(row => row.file_set).filter((value): value is string => typeof value === 'string')]);
  }
  async collect(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.promises.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new RemoteImportSnapshotError('REMOTE_IMPORT_PART_UNAVAILABLE');
    const protectedSets = this.referenced(); if (this.active) protectedSets?.add(this.active);
    let total = 0;
    for (const entry of await fs.promises.readdir(this.root, { withFileTypes: true })) {
      if (!fileSetPattern.test(entry.name)) continue;
      const directory = this.directory(entry.name);
      if (protectedSets !== null && !protectedSets.has(entry.name)) { await fs.promises.rm(directory, { recursive: true, force: true }); continue; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const file of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!file.isFile()) continue;
        total += (await fs.promises.lstat(path.join(directory, file.name))).size;
      }
    }
    // Leave space for the next 256 MiB materialization under the shared 1 GiB spool budget.
    if (total > 768 * 1024 * 1024) throw new RemoteImportSnapshotError('REMOTE_IMPORT_BUDGET');
  }
}
