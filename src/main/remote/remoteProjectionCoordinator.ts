import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

import { remoteDiagnostics } from './remoteDiagnostics';
import type { ProjectionWork } from './remoteProjectionWorker';
import type { RemoteStore } from './remoteStore';
import { archivedRemoteSyncReferences } from './remoteSyncTargetStore';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

const yieldMain = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface Materialization { revision: number; sourceSeq: number; targetSourceSeq: number; digest: string }
const tables = ['remote_projection', 'remote_reply_contents', 'remote_reply_chunks', 'remote_outbox'] as const;

/** One immutable materialization at a time. Core writes continue between bounded publication batches. */
export class RemoteProjectionCoordinator {
  private running: Promise<void> | null = null;
  constructor(private store: RemoteStore, private workerPath = remoteWorkerPath(RemoteWorkerFile.Projection)) {}
  settled(): Promise<void> { return this.running || Promise.resolve(); }
  flush(): Promise<void> {
    if (this.running) return this.running;
    const operation = this.once().finally(() => { if (this.running === operation) this.running = null; });
    this.running = operation; return operation;
  }
  private work(input: ProjectionWork): Promise<Materialization> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: input, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
      });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('REMOTE_PROJECTION_BUDGET')); }, 125_000);
      worker.on('message', (message: { result?: Materialization; error?: string }) => {
        clearTimeout(timer); void worker.terminate();
        if (message.result) resolve(message.result); else reject(new Error(message.error || 'REMOTE_PROJECTION_FAILED'));
      });
      worker.on('error', error => {
        clearTimeout(timer);
        reject((error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new Error('REMOTE_PROJECTION_BUDGET') : error);
      });
      worker.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('REMOTE_PROJECTION_WORKER_EXIT')); });
    });
  }
  private async once(): Promise<void> {
    const work = this.store.nextProjectionWork();
    if (!work) return;
    const id = work.sessionId;
    const startedAt = Date.now();
    remoteDiagnostics.gauge('projection.queue', 1);
    if (this.store.db.name === ':memory:') { this.store.projectIsolatedForTest(id); return; }
    const directory = path.join(path.dirname(this.store.db.name), 'remote-projection-staging');
    let target: Database.Database | null = null;
    let filename: string | null = null;
    try {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      // A crashed worker may leave a disposable snapshot. Never accumulate another 256 MiB per retry.
      const publications = this.store.db.prepare('SELECT path FROM remote_projection_publications').all() as Array<{ path: unknown }>;
      const protectedPaths = new Set(publications.filter((row): row is { path: string } => typeof row.path === 'string' && path.isAbsolute(row.path)).map(row => path.resolve(row.path)));
      let referencesUnknown = publications.some(row => typeof row.path !== 'string' || !path.isAbsolute(row.path));
      try { for (const file of archivedRemoteSyncReferences(this.store, true).paths) protectedPaths.add(path.resolve(file)); }
      catch (error) {
        if (typeof (error as { code?: unknown })?.code === 'string' && /^SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR)/u.test(String((error as { code: string }).code))) throw error;
        referencesUnknown = true;
      }
      let stagingBytes = 0;
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9-]{36}\.sqlite(?:-wal|-shm)?$/u.test(entry.name)) continue;
        const file = path.join(directory, entry.name);
        const base = file.replace(/-(?:wal|shm)$/u, '');
        if (!referencesUnknown && !protectedPaths.has(base)) await fs.promises.rm(file, { force: true });
        else stagingBytes += (await fs.promises.stat(file)).size;
      }
      // Preserve isolated publications, but allow an independent 256 MiB materialization
      // while the shared spool remains within its 1 GiB budget.
      if (stagingBytes > 768 * 1024 * 1024) throw new Error('REMOTE_PROJECTION_BUDGET');
      filename = path.join(directory, `${randomUUID()}.sqlite`);
      const result = await this.work({ ...work, database: this.store.db.name, target: filename });
      // No projected object can cross an owner, environment, capability or source-sequence change.
      if (!this.store.projectionWorkCurrent(work) || this.store.sync(id)?.source_seq !== result.sourceSeq) { await fs.promises.rm(filename, { force: true }); return; }
      target = new Database(filename, { readonly: true, fileMustExist: true });
      this.store.db.transaction(() => {
        this.store.db.prepare('INSERT OR REPLACE INTO remote_projection_publications VALUES (?,?,?,?,?)')
          .run(id, filename, result.targetSourceSeq, result.revision, result.digest);
        // Reserve the high-water mark before exposing any new object; interrupted publication is recovered by full import, never sequence reuse.
        this.store.db.prepare('UPDATE remote_sync SET source_seq=? WHERE local_id=?').run(result.targetSourceSeq, id);
      })();
      for (const table of tables) {
        // Keep minimal monotonic object identities even if the disposable publication file disappears.
        if (table === 'remote_projection') {
          let cursor = '';
          while (true) {
            const rows = this.store.db.prepare('SELECT object_key,revision,record_json FROM remote_projection WHERE session_id=? AND object_key>? ORDER BY object_key LIMIT 16').all(id, cursor) as Array<{ object_key: string; revision: number; record_json: string }>;
            if (!rows.length) break;
            this.store.db.transaction(() => { for (const row of rows) this.store.retainObjectIdentity(id, row); })();
            cursor = rows.at(-1)!.object_key; await yieldMain();
          }
        }
        while (true) {
          const removed = this.store.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE session_id=? LIMIT 64)`).run(id).changes;
          if (!removed) break;
          await yieldMain();
        }
        let cursor = 0;
        while (true) {
          if (!this.store.projectionWorkCurrent(work)) throw new Error('REMOTE_PROJECTION_CONTEXT_CHANGED');
          const rows = target.prepare(`SELECT rowid AS _cursor,* FROM ${table} WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT 16`).all(id, cursor) as Array<Record<string, unknown> & { _cursor: number }>;
          if (!rows.length) break;
          this.store.db.transaction(() => {
            for (const { _cursor, ...row } of rows) {
              if (table === 'remote_outbox' && Number(row.source_seq) <= (this.store.sync(id)?.ack_seq || 0)) continue;
              if (table === 'remote_projection') this.store.retainObjectIdentity(id, row as unknown as { object_key: string; revision: number; record_json: string });
              this.store.db.prepare(`INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
            }
          })();
          cursor = rows.at(-1)!._cursor; await yieldMain();
        }
      }
      const keys = target.prepare("SELECT key,value FROM remote_state WHERE key LIKE 'replyContentVersion:%' OR key LIKE 'desktopAsset:%'")
        .iterate() as Iterable<{ key: string; value: string }>;
      for (const row of keys) {
        if (row.key.startsWith('replyContentVersion:')) {
          const current = this.store.get<number>(row.key) || 0;
          this.store.put(row.key, Math.max(current, Number(JSON.parse(row.value))));
        } else if (this.store.get(row.key) === null) this.store.put(row.key, JSON.parse(row.value));
        await yieldMain();
      }
      for (const row of target.prepare(`SELECT n.key,n.value,o.value AS previous FROM remote_state n LEFT JOIN projection_original_state o ON o.key=n.key
        WHERE (n.key LIKE 'inputVersion:%' OR n.key LIKE 'inputSignature:%' OR n.key LIKE 'inputModel:%') AND (o.value IS NULL OR o.value<>n.value)`).iterate() as Iterable<{ key: string; value: string; previous: string | null }>) {
        const current = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(row.key) as { value: string } | undefined;
        if ((current?.value ?? null) === row.previous) this.store.db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run(row.key, row.value);
      }
      this.store.db.transaction(() => {
        const stage = target!.prepare('SELECT needs_snapshot FROM remote_sync WHERE local_id=?').get(id) as { needs_snapshot: number };
        const epochKey = `snapshotEpoch:${id}`;
        const originalEpoch = Number(JSON.parse((target!.prepare('SELECT value FROM projection_original_state WHERE key=?').get(epochKey) as { value: string } | undefined)?.value || '0'));
        const nextEpoch = Number(JSON.parse((target!.prepare('SELECT value FROM remote_state WHERE key=?').get(epochKey) as { value: string } | undefined)?.value || '0'));
        if (nextEpoch > originalEpoch) this.store.put(epochKey, (this.store.get<number>(epochKey) || 0) + nextEpoch - originalEpoch);
        if (stage.needs_snapshot) this.store.db.prepare('UPDATE remote_sync SET needs_snapshot=1 WHERE local_id=?').run(id);
        const revision = this.store.projectionRevision(id);
        if (revision === result.revision) {
          this.store.db.prepare('DELETE FROM remote_dirty WHERE session_id=?').run(id);
          this.store.db.prepare('DELETE FROM remote_content_dirty WHERE session_id=?').run(id);
        }
        this.store.db.prepare('DELETE FROM remote_projection_publications WHERE session_id=?').run(id);
        this.store.db.prepare('DELETE FROM remote_projection_failures WHERE session_id=?').run(id);
      })();
      remoteDiagnostics.record('projection.completed');
      remoteDiagnostics.record('projection.bytes', (await fs.promises.stat(filename)).size);
      target.close(); target = null; await fs.promises.rm(filename, { force: true });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'REMOTE_PROJECTION_FAILED';
      this.store.recordProjectionFailure(id, reason); remoteDiagnostics.record('projection.failed');
      console.warn('[RemoteSync] Projection deferred without rolling back local state', { localSessionId: id, reason });
    } finally {
      remoteDiagnostics.gauge('projection.queue', 0); remoteDiagnostics.gauge('projection.durationMs', Date.now() - startedAt);
      if (target?.open) target.close();
      if (filename && !this.store.db.prepare('SELECT 1 FROM remote_projection_publications WHERE path=?').get(filename)) {
        for (const suffix of ['', '-wal', '-shm']) await fs.promises.rm(`${filename}${suffix}`, { force: true }).catch((): void => undefined);
      }
    }
  }
}
