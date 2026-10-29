import type Database from 'better-sqlite3';

import { RemoteInputIntent } from '../../shared/remote/input';
import type { SyncRow } from './remoteStore';

const sourceKeys = new Set(['path', 'fileName', 'mimeType', 'intent', 'sizeBytes', 'fileIdentity', 'snapshot', 'captureReason']);
const localAvailability = 'desktop_only';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const parse = (raw?: string): unknown => { try { return raw === undefined ? undefined : JSON.parse(raw); } catch { return undefined; } };

// Statements are connection-scoped; data is always reread so account/receipt changes
// take effect immediately. Weak keys do not retain closed fixture/worker databases.
function prepare(db: Database.Database) {
  return {
    owner: db.prepare(`SELECT owner_user_id AS userId,owner_scope_key AS scopeKey FROM cowork_session_ownership
      WHERE session_id=? AND ownership_status='confirmed'`),
    message: db.prepare(`SELECT metadata FROM cowork_messages WHERE id=? AND session_id=? AND type='user'
      AND octet_length(metadata)<=32768`),
    state: db.prepare('SELECT value FROM remote_state WHERE key=? AND octet_length(value)<=1048576'),
  };
}
const statements = new WeakMap<Database.Database, ReturnType<typeof prepare>>();
function queries(db: Database.Database): ReturnType<typeof prepare> {
  let saved = statements.get(db);
  if (!saved) { saved = prepare(db); statements.set(db, saved); }
  return saved;
}

/** Input source metadata contains records/scalars only. Reject unknown arrays and
 * bound comparison work without recursion or materializing canonical copies. */
function equalJSON(left: unknown, right: unknown): boolean {
  const pending: Array<{ left: unknown; right: unknown; depth: number }> = [{ left, right, depth: 0 }];
  let remaining = 4096;
  while (pending.length) {
    if (--remaining < 0) return false;
    const pair = pending.pop()!;
    if (pair.left === pair.right) continue;
    if (pair.depth >= 8 || !record(pair.left) || !record(pair.right)) return false;
    const keys = Object.keys(pair.left);
    if (keys.length !== Object.keys(pair.right).length || keys.length + pending.length > remaining) return false;
    for (const key of keys) {
      if (!Object.hasOwn(pair.right, key)) return false;
      pending.push({ left: pair.left[key], right: pair.right[key], depth: pair.depth + 1 });
    }
  }
  return true;
}

/** A local upload identity is not a remote receipt. Admit only the exact, untouched
 * job derived from an owned user message; any transport fields retain the barrier. */
export function isUnpublishedDesktopInputJob(db: Database.Database, key: string, value: unknown, row: SyncRow): boolean {
  const match = /^desktopAsset:([^:]+):(0|[1-9]\d?)$/u.exec(key);
  if (!match || Number(match[2]) >= 20 || !record(value) || value.localSessionId !== row.local_id
    || value.sessionId !== row.session_id || value.messageId !== match[1] || value.availability !== localAvailability
    || typeof value.uploadRequestId !== 'string' || !value.uploadRequestId || value.uploadRequestId.length > 64) return false;
  const sql = queries(db);
  const owner = sql.owner.get(row.local_id);
  if (!owner) return false;
  const message = sql.message.get(match[1], row.local_id) as { metadata: string } | undefined;
  const metadata = parse(message?.metadata);
  if (!record(metadata) || typeof metadata.remoteRunId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(metadata.remoteRunId)) return false;
  const read = (stateKey: string): unknown => parse((sql.state.get(stateKey) as { value: string } | undefined)?.value);
  const run = read(`runHistory:${row.local_id}:${metadata.remoteRunId}`);
  const input = read(`desktopInputRun:${metadata.remoteRunId}`);
  if (!record(run) || run.runId !== metadata.remoteRunId || !record(input) || !record(input.owner)
    || !equalJSON(input.owner, owner) || input.localSessionId !== undefined && input.localSessionId !== row.local_id
    || !Array.isArray(input.attachments) || input.attachments.length > 20) return false;
  const source: unknown = input.attachments[Number(match[2])];
  if (!record(source) || Object.keys(source).some(field => !sourceKeys.has(field))
    || typeof source.path !== 'string' || typeof source.fileName !== 'string' || typeof source.mimeType !== 'string'
    || typeof source.sizeBytes !== 'string' || !/^\d{1,19}$/u.test(source.sizeBytes)
    || source.intent !== RemoteInputIntent.File && source.intent !== RemoteInputIntent.Image) return false;
  // Exact equality rejects asset IDs, device/environment bindings, receipts, retry
  // state and unknown future fields even if availability still says desktop_only.
  return equalJSON(value, { ...source, owner: input.owner, localSessionId: row.local_id,
    sessionId: row.session_id, messageId: match[1], uploadRequestId: value.uploadRequestId, availability: localAvailability });
}
