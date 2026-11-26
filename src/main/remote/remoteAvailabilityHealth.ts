import type Database from 'better-sqlite3';

import type { RemoteStore } from './remoteStore';

function prepareWrites(db: Database.Database) {
  // Disposable display evidence only. Never consulted for ownership, permits or deletion GC.
  db.exec(`CREATE TABLE IF NOT EXISTS remote_availability_health_acks(
    scope TEXT NOT NULL,session_id TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,
    representation TEXT NOT NULL,PRIMARY KEY(scope,session_id,object_key))`);
  return {
    current: db.prepare('SELECT revision,representation FROM remote_availability_health_acks WHERE scope=? AND session_id=? AND object_key=?'),
    write: db.prepare(`INSERT INTO remote_availability_health_acks VALUES(?,?,?,?,?) ON CONFLICT(scope,session_id,object_key)
      DO UPDATE SET revision=excluded.revision,representation=excluded.representation
      WHERE revision<=excluded.revision AND (revision<>excluded.revision OR representation<>excluded.representation)`),
  };
}
function prepareReads(db: Database.Database) {
  return {
    messages: db.prepare(`SELECT COUNT(*) AS pending,MIN(m.created_at) AS oldest FROM cowork_messages m
      LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
      LEFT JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
      WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND COALESCE(r.revision,1)>COALESCE(a.revision,0)`),
    tools: db.prepare(`SELECT COUNT(*) AS pending FROM remote_live_tools r
      LEFT JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
      WHERE r.session_id=? AND r.revision>COALESCE(a.revision,0)`),
    unavailable: db.prepare("SELECT 1 FROM remote_availability_health_acks WHERE scope=? AND session_id=? AND representation NOT IN ('complete','desktop_only','local_only') LIMIT 1"),
    desktopOnly: db.prepare(`SELECT 1 FROM remote_availability_health_acks a
      LEFT JOIN cowork_messages m ON m.session_id=a.session_id AND a.object_key='message:'||m.id
      LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
      LEFT JOIN remote_live_tools t ON t.session_id=a.session_id AND a.object_key='tool:'||t.tool_id
      WHERE a.scope=? AND a.session_id=? AND a.representation='desktop_only'
        AND ((m.id IS NOT NULL AND COALESCE(r.deleted,0)=0 AND COALESCE(r.revision,1)=a.revision) OR t.revision=a.revision) LIMIT 1`),
  };
}
interface HealthStatements {
  schema: Database.Statement; exists: Database.Statement; version: number; writes: ReturnType<typeof prepareWrites>; reads?: ReturnType<typeof prepareReads>;
}
const statements = new WeakMap<Database.Database, HealthStatements>();
function queries(db: Database.Database): HealthStatements {
  let saved = statements.get(db);
  if (!saved) {
    const schema = db.prepare('PRAGMA schema_version'), writes = prepareWrites(db);
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_availability_health_acks'");
    saved = { schema, exists, writes, version: (schema.get() as { schema_version: number }).schema_version };
    statements.set(db, saved);
  } else if ((saved.schema.get() as { schema_version: number }).schema_version !== saved.version || !saved.exists.get()) {
    // External DDL can drop/recreate this optional cache. Never retain an empty/successful result in memory.
    const writes = prepareWrites(db);
    saved = { schema: saved.schema, exists: saved.exists, writes, version: (saved.schema.get() as { schema_version: number }).schema_version };
    statements.set(db, saved);
  }
  return saved;
}
export function recordAvailabilityObjectHealth(store: RemoteStore, scope: string, localId: string, key: string, revision: string, representation: string): void {
  if (!/^[0-9]{1,16}$/u.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('REMOTE_HEALTH_REVISION_INVALID');
  const { writes } = queries(store.db), next = Number(revision);
  const current = writes.current.get(scope, localId, key) as { revision: number; representation: string } | undefined;
  if (current && (current.revision > next || current.revision === next && current.representation === representation)) return;
  writes.write.run(scope, localId, key, next, representation);
}
export function availabilitySourceHealth(store: RemoteStore, scope: string, localId: string): { pending: number; oldest: number | null; unavailable: boolean; desktopOnly: boolean } {
  const saved = queries(store.db), reads = saved.reads ??= prepareReads(store.db);
  const messages = reads.messages.get(scope, localId) as { pending: number; oldest: number | null };
  const tools = reads.tools.get(scope, localId) as { pending: number };
  return { pending: messages.pending + tools.pending, oldest: messages.oldest, unavailable: !!reads.unavailable.get(scope, localId), desktopOnly: !!reads.desktopOnly.get(scope, localId) };
}
