import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { sameOwner } from './canonical';
import type { DesktopInputRun } from './desktopInputMetadata';
import { touchAvailabilityMessage } from './remoteAvailabilitySource';
import type { RemoteStore } from './remoteStore';

function prepare(db: Database.Database) {
  return {
    message: db.prepare(`SELECT metadata FROM cowork_messages WHERE id=? AND session_id=? AND type='user'
      AND octet_length(metadata)<=32768`),
    state: db.prepare('SELECT value FROM remote_state WHERE key=?'),
    revision: db.prepare('SELECT revision FROM remote_live_revisions WHERE session_id=? AND object_id=?'),
    recent: db.prepare("SELECT id FROM cowork_messages WHERE session_id=? AND type='user' ORDER BY sequence DESC LIMIT 16"),
  };
}
const statements = new WeakMap<Database.Database, ReturnType<typeof prepare>>();
function queries(db: Database.Database): ReturnType<typeof prepare> {
  let saved = statements.get(db);
  if (!saved) { saved = prepare(db); statements.set(db, saved); }
  return saved;
}
function read<T>(sql: ReturnType<typeof prepare>, key: string): T | null {
  const row = sql.state.get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as T : null;
}
function candidate(sql: ReturnType<typeof prepare>, localId: string, messageId: string) {
  const message = sql.message.get(messageId, localId) as { metadata: string } | undefined;
  if (!message) return null;
  const metadata = JSON.parse(message.metadata), runId = metadata?.remoteRunId;
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) return null;
  const input = read<DesktopInputRun & { localSessionId?: string }>(sql, `desktopInputRun:${runId}`);
  if (!input || !Array.isArray(input.attachments) || !input.attachments.length || input.attachments.length > 20 || input.attachments.some(source =>
    !source || typeof source.path !== 'string' || typeof source.fileName !== 'string' || typeof source.mimeType !== 'string'
    || !['file', 'image'].includes(source.intent) || !/^\d{1,19}$/u.test(source.sizeBytes) || source.preparedSource)) return null;
  return { runId, input };
}
function preparation(store: RemoteStore, sql: ReturnType<typeof prepare>, localId: string, messageId: string,
  value: NonNullable<ReturnType<typeof candidate>>) {
  const owner = store.owner(localId), binding = store.controlBinding(localId);
  if (!owner || !binding || binding.migration_frozen || store.isSyncClosed(localId) || !store.isTaskAdmitted(localId)) return null;
  store.assertActor(localId, owner); store.assertNoDeletionEffect(localId);
  const { runId, input } = value;
  const run = read<{ runId: string }>(sql, `runHistory:${localId}:${runId}`);
  if (run?.runId !== runId || read(sql, `runPublished:${runId}`) === false) return null;
  const history = read<{ runIds?: string[] }>(sql, `syncTargetHistory:${localId}`);
  if (history?.runIds?.includes(runId) || !sameOwner(input.owner, owner) || input.localSessionId && input.localSessionId !== localId) return null;
  const missing: number[] = [];
  for (const index of input.attachments.keys()) {
    const existing = sql.state.get(`desktopAsset:${messageId}:${index}`) as { value: string } | undefined;
    // Physical receipt presence, including null/unknown data, must not allocate another upload identity.
    if (existing) { JSON.parse(existing.value); continue; }
    missing.push(index);
  }
  return missing.length ? { owner, binding, input, missing } : null;
}

/** Optional, bounded preparation. Original message/run ownership remains authoritative. */
export function ensureDesktopInputJobs(store: RemoteStore, localId: string, messageId: string): number | null {
  const sql = queries(store.db), preliminary = candidate(sql, localId, messageId);
  // Read-only hints may avoid work, but never authorize a write or enter the trusted transaction.
  if (!preliminary || !preparation(store, sql, localId, messageId, preliminary)) return null;
  return store.transaction(() => {
    const current = candidate(sql, localId, messageId);
    const ready = current && preparation(store, sql, localId, messageId, current);
    if (!ready) return null;
    const { owner, binding, input, missing } = ready;
    for (const index of missing) store.put(`desktopAsset:${messageId}:${index}`, { ...input.attachments[index], owner,
      localSessionId: localId, sessionId: binding.session_id, messageId, uploadRequestId: randomUUID(), availability: 'desktop_only' });
    touchAvailabilityMessage(store.db, localId, messageId);
    return (sql.revision.get(localId, messageId) as { revision: number }).revision;
  });
}

/** Covers capture that completes after the user message; other records remain independent. */
export function ensureRecentDesktopInputJobs(store: RemoteStore, localId: string): void {
  const messages = queries(store.db).recent.all(localId) as Array<{ id: string }>;
  for (const message of messages) {
    try { ensureDesktopInputJobs(store, localId, message.id); }
    catch { /* Live publication revisits this object; never fail the local task. */ }
  }
}
