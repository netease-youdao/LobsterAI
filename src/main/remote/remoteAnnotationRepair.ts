import type Database from 'better-sqlite3';

import type { RemoteAvailabilityStore } from './remoteAvailabilityStore';
import type { RecoveryCandidate } from './remoteLiveRecovery';
import { assertRemoteSidecarHeadroom } from './remoteSidecarHeadroom';

const ScanLimit = 32;
const CandidateLimit = 4;
/** Inspect acknowledged identities only. Raw metadata is read later by the isolated encoder. */
export function annotationRepairCandidates(core: Database.Database, ledger: RemoteAvailabilityStore,
  scope: string, localId: string, writerGeneration: string): RecoveryCandidate[] {
  const previous = ledger.db.prepare('SELECT writer_generation,object_cursor FROM availability_annotation_scan WHERE scope=? AND local_id=?')
    .get(scope, localId) as { writer_generation: string; object_cursor: string } | undefined;
  const cursor = previous?.writer_generation === writerGeneration && /^message:[A-Za-z0-9_-]{1,64}$/u.test(previous.object_cursor)
    ? previous.object_cursor : 'message:';
  const page = ledger.db.prepare(`SELECT object_id FROM availability_objects
    WHERE scope=? AND local_id=? AND object_id>? AND object_id<'message;' ORDER BY object_id LIMIT ?`)
    .all(scope, localId, cursor, ScanLimit) as Array<{ object_id: string }>;
  const result: RecoveryCandidate[] = [];
  let next = '';
  const source = core.prepare(`SELECT r.revision,r.deleted,m.type,m.sequence FROM remote_live_revisions r
    JOIN cowork_messages m ON m.id=r.object_id AND m.session_id=r.session_id WHERE r.session_id=? AND r.object_id=?`);
  for (const item of page) {
    next = item.object_id;
    const objectId = item.object_id.slice('message:'.length);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(objectId)) continue;
    const row = source.get(localId, objectId) as { revision: number; deleted: number; type: string; sequence: number } | undefined;
    if (!row || row.deleted || row.type !== 'user') continue;
    result.push({ object_id: objectId, revision: row.revision, kind: 'message', position: row.sequence, annotationCheck: true });
    if (result.length === CandidateLimit) break;
  }
  assertRemoteSidecarHeadroom(ledger.db.name, 256, 0);
  ledger.db.prepare(`INSERT INTO availability_annotation_scan VALUES(?,?,?,?) ON CONFLICT(scope,local_id)
    DO UPDATE SET writer_generation=excluded.writer_generation,object_cursor=excluded.object_cursor`)
    .run(scope, localId, writerGeneration, next);
  return result;
}
