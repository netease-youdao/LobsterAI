import type Database from 'better-sqlite3';

import { RemoteHistoryJob } from './remoteHistoryJob';
import { type LiveProjection, type LiveProjectionInput, projectLiveMessage } from './remoteLiveProjection';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

export class RemoteLiveProjectionJob {
  private readonly encoder = new RemoteHistoryJob();
  private running = false;
  constructor(private readonly workerPath = remoteWorkerPath(RemoteWorkerFile.LiveProjection), private readonly timeoutMs = 2000) {}
  cancel(): void { this.encoder.cancel(); }
  async project(db: Database.Database, input: LiveProjectionInput): Promise<LiveProjection | null> {
    if (this.running) throw new Error('REMOTE_LIVE_ENCODER_BUSY');
    if (db.name === ':memory:') return projectLiveMessage(db, input);
    this.running = true;
    try {
      return await this.encoder.run<LiveProjection | null>(this.workerPath,input, {
        timeoutMs: this.timeoutMs,memoryMb: 96,current: () => db.open,prefix: 'REMOTE_LIVE_ENCODER',resultLimitBytes: 128 * 1024,
      });
    } finally { this.running = false; }
  }
}
