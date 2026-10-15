import { randomUUID } from 'crypto';

import { sameOwner } from './canonical';
import type { DesktopInputRun } from './desktopInputMetadata';
import { touchAvailabilityMessage } from './remoteAvailabilitySource';
import type { RemoteStore } from './remoteStore';

/** Optional, bounded preparation. Original message/run ownership remains authoritative. */
export function ensureDesktopInputJobs(store: RemoteStore, localId: string, messageId: string): number | null {
  return store.transaction(() => {
    const owner = store.owner(localId), binding = store.controlBinding(localId);
    if (!owner || !binding || binding.migration_frozen || store.isSyncClosed(localId) || !store.isTaskAdmitted(localId)) return null;
    store.assertActor(localId, owner); store.assertNoDeletionEffect(localId);
    const message = store.db.prepare(`SELECT metadata FROM cowork_messages WHERE id=? AND session_id=? AND type='user'
      AND octet_length(metadata)<=32768`).get(messageId, localId) as { metadata: string } | undefined;
    if (!message) return null;
    const metadata = JSON.parse(message.metadata);
    const runId = metadata?.remoteRunId;
    if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) return null;
    const run = store.get<{ runId: string }>(`runHistory:${localId}:${runId}`);
    if (run?.runId !== runId || store.get(`runPublished:${runId}`) === false) return null;
    const history = store.get<{ runIds?: string[] }>(`syncTargetHistory:${localId}`);
    if (history?.runIds?.includes(runId)) return null;
    const input = store.get<DesktopInputRun & { localSessionId?: string }>(`desktopInputRun:${runId}`);
    if (!input || !sameOwner(input.owner, owner) || input.localSessionId && input.localSessionId !== localId
      || !Array.isArray(input.attachments) || input.attachments.length > 20 || input.attachments.some(source =>
        !source || typeof source.path !== 'string' || typeof source.fileName !== 'string' || typeof source.mimeType !== 'string'
        || !['file', 'image'].includes(source.intent) || !/^\d{1,19}$/u.test(source.sizeBytes) || source.preparedSource)) return null;
    let changed = false;
    for (const [index, source] of input.attachments.entries()) {
      const key = `desktopAsset:${messageId}:${index}`;
      // An existing or corrupt receipt is never replaced with a new upload identity.
      if (store.get(key) !== null) continue;
      store.put(key, { ...source, owner, localSessionId: localId, sessionId: binding.session_id,
        messageId, uploadRequestId: randomUUID(), availability: 'desktop_only' });
      changed = true;
    }
    if (!changed) return null;
    touchAvailabilityMessage(store.db, localId, messageId);
    return (store.db.prepare('SELECT revision FROM remote_live_revisions WHERE session_id=? AND object_id=?')
      .get(localId, messageId) as { revision: number }).revision;
  });
}

/** Covers capture that completes after the user message; other records remain independent. */
export function ensureRecentDesktopInputJobs(store: RemoteStore, localId: string): void {
  const messages = store.db.prepare("SELECT id FROM cowork_messages WHERE session_id=? AND type='user' ORDER BY sequence DESC LIMIT 16")
    .all(localId) as Array<{ id: string }>;
  for (const message of messages) {
    try { ensureDesktopInputJobs(store, localId, message.id); }
    catch { /* Live publication revisits this object; never fail the local task. */ }
  }
}
