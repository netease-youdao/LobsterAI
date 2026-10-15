import type { RemoteStore } from './remoteStore';

/** Disposable display evidence only. Never consulted for ownership, permits or deletion GC. */
function ensure(store: RemoteStore): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS remote_availability_health_acks(
    scope TEXT NOT NULL,session_id TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,
    representation TEXT NOT NULL,PRIMARY KEY(scope,session_id,object_key))`);
}
export function recordAvailabilityObjectHealth(store: RemoteStore, scope: string, localId: string, key: string, revision: string, representation: string): void {
  if (!/^[0-9]{1,16}$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('REMOTE_HEALTH_REVISION_INVALID');
  ensure(store);
  store.db.prepare(`INSERT INTO remote_availability_health_acks VALUES(?,?,?,?,?) ON CONFLICT(scope,session_id,object_key)
    DO UPDATE SET revision=excluded.revision,representation=excluded.representation WHERE revision<=excluded.revision`)
    .run(scope, localId, key, Number(revision), representation);
}
export function availabilitySourceHealth(store: RemoteStore, scope: string, localId: string): { pending: number; oldest: number | null; unavailable: boolean } {
  ensure(store);
  const messages = store.db.prepare(`SELECT COUNT(*) AS pending,MIN(m.created_at) AS oldest FROM cowork_messages m
    LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
    LEFT JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
    WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND COALESCE(r.revision,1)>COALESCE(a.revision,0)`)
    .get(scope, localId) as { pending: number; oldest: number | null };
  const tools = store.db.prepare(`SELECT COUNT(*) AS pending FROM remote_live_tools r
    LEFT JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
    WHERE r.session_id=? AND r.revision>COALESCE(a.revision,0)`).get(scope, localId) as { pending: number };
  const unavailable = !!store.db.prepare("SELECT 1 FROM remote_availability_health_acks WHERE scope=? AND session_id=? AND representation<>'complete' LIMIT 1").get(scope, localId);
  return { pending: messages.pending + tools.pending, oldest: messages.oldest, unavailable };
}
