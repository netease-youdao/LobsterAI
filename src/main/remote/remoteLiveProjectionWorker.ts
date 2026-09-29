import Database from 'better-sqlite3';

import { type LiveProjectionInput, projectLiveMessage } from './remoteLiveProjection';

// This child never writes the core DB and is killed by the supervisor after two seconds.
process.once('message', (request: { type?: string; jobId?: string; input?: LiveProjectionInput }) => {
  const input = request.input, jobId = request.jobId;
  let db: Database.Database | null = null;
  try {
    if (request.type !== 'remote.history.job' || typeof jobId !== 'string' || !/^[a-f0-9-]{36}$/u.test(jobId) || !input || typeof input.database !== 'string' || typeof input.localId !== 'string' || typeof input.objectId !== 'string'
      || !/^[1-9]\d*$/u.test(input.revision)) throw new Error('REMOTE_LIVE_INVALID_JOB');
    db = new Database(input.database, { readonly: true, fileMustExist: true, timeout: 100 });
    const result = projectLiveMessage(db, input);
    process.send?.({ jobId, result }, () => { db?.close(); process.exit(0); });
  } catch (error) {
    process.send?.({ jobId, error: error instanceof Error ? error.message : 'REMOTE_LIVE_PROJECTION_FAILED' }, () => { db?.close(); process.exit(1); });
  }
});
