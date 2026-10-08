import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { stableJson } from './canonical';
import { activeRemoteSyncTargetContext } from './remoteSyncTargetStore';

interface Fault { epoch: string; reason: string; revision: number; context: string; probe_epoch: string | null; published_revision: number | null }
/** Scheduling evidence only. This never grants task admission, execution or cloud acknowledgement. */
export function initializeProjectionFaults(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_projection_faults(session_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,
    reason TEXT NOT NULL,revision INTEGER NOT NULL,context TEXT NOT NULL,probe_epoch TEXT,published_revision INTEGER);`);
  if ((db.prepare("SELECT type FROM sqlite_master WHERE name='remote_projection_faults'").get() as { type: string } | undefined)?.type !== 'table') throw new Error('REMOTE_PROJECTION_SCHEMA_INVALID');
}
function context(db: Database.Database, id: string): string {
  const row = db.prepare(`SELECT o.owner_user_id,o.owner_scope_key,s.device_id,s.sync_environment
    FROM cowork_session_ownership o JOIN remote_sync s ON s.local_id=o.session_id
    WHERE o.session_id=? AND o.ownership_status='confirmed'`).get(id) as
    { owner_user_id: string; owner_scope_key: string; device_id: string; sync_environment: string | null } | undefined;
  if (!row) return stableJson(null);
  return stableJson([row, activeRemoteSyncTargetContext({ db }, { userId: row.owner_user_id, scopeKey: row.owner_scope_key })]);
}
export function projectionFault(db: Database.Database, id: string): Fault | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_projection_faults'").get()) return null;
  const row = db.prepare(`SELECT CASE WHEN octet_length(epoch)<=128 THEN epoch END AS epoch,
    CASE WHEN octet_length(reason)<=256 THEN reason END AS reason,revision,
    CASE WHEN octet_length(context)<=8192 THEN context END AS context,
    CASE WHEN octet_length(probe_epoch)<=128 THEN probe_epoch END AS probe_epoch,published_revision
    FROM remote_projection_faults WHERE session_id=?`).get(id) as Fault | undefined;
  return row?.epoch && row.reason && row.context === context(db, id) ? row : null;
}
export function recordProjectionFault(db: Database.Database, id: string, reason: string, revision: number, retryAt: number): void {
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO remote_projection_failures VALUES (?,?,?,?)').run(id, reason, retryAt, revision);
    db.prepare('INSERT OR REPLACE INTO remote_projection_faults VALUES (?,?,?,?,?,NULL,NULL)').run(id, randomUUID(), reason, revision, context(db, id));
  })();
}
export function grantProjectionProbe(db: Database.Database, id: string): void {
  const failure = db.prepare('SELECT reason,revision FROM remote_projection_failures WHERE session_id=?').get(id) as { reason: string; revision: number } | undefined;
  if (!failure) return;
  const fault = projectionFault(db, id);
  // Legacy failures receive fresh scheduling evidence only after the caller's existing safety checks.
  if (!fault || fault.reason !== failure.reason || fault.revision !== failure.revision) {
    db.prepare('INSERT OR REPLACE INTO remote_projection_faults VALUES (?,?,?,?,?,NULL,NULL)').run(id, randomUUID(), failure.reason, failure.revision, context(db, id));
  }
  db.prepare('UPDATE remote_projection_faults SET probe_epoch=epoch,published_revision=NULL WHERE session_id=?').run(id);
}
export function projectionProbeEligible(db: Database.Database, id: string, reason: string): boolean {
  const fault = projectionFault(db, id);
  if (!fault || fault.reason !== reason || fault.probe_epoch !== fault.epoch) return false;
  const failure = db.prepare('SELECT reason,revision FROM remote_projection_failures WHERE session_id=?').get(id) as { reason: string; revision: number } | undefined;
  return !!failure && failure.reason === fault.reason && failure.revision === fault.revision;
}
export function finishProjectionFault(db: Database.Database, id: string, revision: number, expectedEpoch: string | null): void {
  const current = db.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(id) as { revision: number } | undefined;
  const fault = projectionFault(db, id);
  if (current?.revision !== revision || (fault?.epoch ?? null) !== expectedEpoch) return;
  db.prepare('DELETE FROM remote_projection_failures WHERE session_id=?').run(id);
  if (fault) db.prepare('UPDATE remote_projection_faults SET published_revision=? WHERE session_id=? AND epoch=?').run(revision, id, fault.epoch);
}
