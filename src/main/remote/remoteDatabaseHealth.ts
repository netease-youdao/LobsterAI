import { Worker } from 'worker_threads';

import { SyncTelemetry } from './remoteSyncTelemetry';
import { captureRemoteTelemetry } from './remoteTelemetry';

/** A short-lived read-only worker retains the real SQLite corruption check off the UI thread. */
export class RemoteDatabaseHealth {
  private verifiedAt = 0;
  private healthy = false;
  private pending: Promise<boolean> | null = null;
  constructor(private database: string) {}
  current(): boolean { return this.healthy && Date.now() - this.verifiedAt < 30_000; }
  invalidate(): void { this.healthy = false; this.verifiedAt = 0; }
  verify(): Promise<boolean> {
    if (this.current()) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const telemetry = captureRemoteTelemetry({ domain: 'database_health' });
    const previous = this.verifiedAt ? (this.healthy ? 'ready' : 'blocked') : 'unknown';
    const work = new Promise<boolean>(resolve => {
      const worker = new Worker(`
        const { parentPort, workerData } = require('worker_threads');
        const Database = require(workerData.sqlite);
        let db;
        try { db = new Database(workerData.database, { readonly: true, fileMustExist: true, timeout: 100 });
          parentPort.postMessage(db.pragma('quick_check', { simple: true }) === 'ok');
        } catch { parentPort.postMessage(false); }
        finally { if (db && db.open) db.close(); }
      `, { eval: true, workerData: { database: this.database, sqlite: require.resolve('better-sqlite3') } });
      let finished = false;
      const finish = (healthy: boolean): void => {
        if (finished) return; finished = true;
        clearTimeout(timer); this.healthy = healthy; this.verifiedAt = Date.now();
        const state = healthy ? 'ready' : 'blocked';
        if (state !== previous) telemetry.emit(SyncTelemetry.Event.Admission,
          { fromState: previous, toState: state, reason: healthy ? SyncTelemetry.Reason.None : SyncTelemetry.Reason.DatabaseUnknown });
        void worker.terminate(); resolve(healthy);
      };
      const timer = setTimeout(() => finish(false), 5000);
      worker.once('message', result => finish(result === true));
      worker.once('error', () => finish(false));
      worker.once('exit', code => { if (code !== 0) finish(false); });
    }).catch(error => {
      telemetry.emit(SyncTelemetry.Event.Admission,
        { fromState: previous, toState: 'blocked', reason: SyncTelemetry.Reason.WorkerFailed });
      throw error;
    }).finally(() => { if (this.pending === work) this.pending = null; });
    this.pending = work; return work;
  }
}
