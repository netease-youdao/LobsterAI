import type Database from 'better-sqlite3';

import { CoworkTurnUsageStatus } from '../../shared/cowork/llmTurnUsage';
import { RemoteTaskCredits, type RemoteTaskUsage, type RemoteTurnUsage, RemoteUsageCoverage, RemoteUsageReason, RemoteUsageScope } from '../../shared/remote/taskCredits';
import { payloadHash } from './canonical';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
const tracePattern = /^[a-f0-9]{32}$/u;
const cents = (value: string): bigint => BigInt(value.replace('.', ''));
const maximumCents = cents(RemoteTaskCredits.MaximumAmount.toFixed(2));
const displayAmount = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amount = (value: bigint): string => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

/** Detect immutable usage requests so downgrade recovery can fence receipts before creating compatible operations. */
export function hasTaskCreditsSnapshot(value: unknown): boolean {
  if (typeof value === 'string') return /"(?:taskUsage|turnUsage)"\s*:/u.test(value);
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100000) return true;
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    if (Object.hasOwn(next, 'taskUsage') || Object.hasOwn(next, 'turnUsage')) return true;
    for (const child of Object.values(next)) {
      if (pending.length >= 100000) return true;
      pending.push(child);
    }
  }
  return false;
}

/** The public summary is rebuilt field by field; private trace, tokens and prompts never cross this boundary. */
export function remoteTurnUsage(metadata: unknown): RemoteTurnUsage | undefined {
  if (!record(metadata) || !record(metadata.turnUsage)) return undefined;
  const usage = metadata.turnUsage;
  if (!Object.values(CoworkTurnUsageStatus).includes(usage.status as CoworkTurnUsageStatus)
    || !count(usage.requestCount) || !count(usage.failedRequestCount) || usage.failedRequestCount > usage.requestCount
    || !timestamp(usage.updatedAt) || usage.mediaPending !== undefined && typeof usage.mediaPending !== 'boolean') return undefined;
  const billingScope = usage.billingScope === RemoteUsageScope.Personal || usage.billingScope === RemoteUsageScope.Enterprise
    ? usage.billingScope : RemoteUsageScope.Unknown;
  const hasAmount = usage.status === CoworkTurnUsageStatus.Settled || usage.status === CoworkTurnUsageStatus.Partial;
  const value = usage.displayCreditsUsed ?? usage.creditsUsed;
  if (hasAmount && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > RemoteTaskCredits.MaximumAmount)) return undefined;
  const status = usage.status === CoworkTurnUsageStatus.Settled && (billingScope === RemoteUsageScope.Unknown || usage.mediaPending === true)
    ? CoworkTurnUsageStatus.Partial : usage.status as CoworkTurnUsageStatus;
  return { schemaVersion: RemoteTaskCredits.SchemaVersion, source: RemoteTaskCredits.Source, status, billingScope,
    displayCreditsUsed: hasAmount ? displayAmount.format(value === 0 ? 0 : value as number) : null,
    requestCount: usage.requestCount, failedRequestCount: usage.failedRequestCount,
    mediaPending: usage.mediaPending === true, updatedAt: new Date(usage.updatedAt).toISOString() };
}

export function readTaskUsageState(db: Database.Database, key: string): unknown {
  const row = db.prepare('SELECT octet_length(value) AS bytes,CASE WHEN octet_length(value)<=? THEN value ELSE NULL END AS value FROM remote_state WHERE key=?')
    .get(RemoteTaskCredits.MetadataBytes, key) as { value: string | null; bytes: number } | undefined;
  if (row && (row.bytes > RemoteTaskCredits.MetadataBytes || row.value === null)) throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
  return row ? JSON.parse(row.value!) : null;
}
export function hasTaskUsageRunOrigin(db: Database.Database, sessionId: string, runId: string): boolean {
  const origin = db.prepare(`SELECT e.owner_hash,o.owner_user_id,o.owner_scope_key,o.ownership_status
    FROM local_execution_origin e JOIN cowork_session_ownership o ON o.session_id=e.session_id
    WHERE e.session_id=? AND e.run_id=?`).get(sessionId, runId) as { owner_hash: string; owner_user_id: string; owner_scope_key: string; ownership_status: string } | undefined;
  return origin?.ownership_status === 'confirmed'
    && origin.owner_hash === payloadHash({ userId: origin.owner_user_id, scopeKey: origin.owner_scope_key });
}

export const isInheritedTaskUsage = (createdAt: number, forkedAt: unknown): boolean =>
  typeof forkedAt === 'number' && forkedAt > 0 && createdAt <= forkedAt;
const forkColumns = new WeakMap<Database.Database, boolean>();
export function taskUsageForkAt(db: Database.Database, sessionId: string): number | undefined {
  let hasColumn = forkColumns.get(db);
  if (hasColumn === undefined) {
    hasColumn = (db.prepare('PRAGMA table_info(cowork_sessions)').all() as Array<{ name: string }>).some(column => column.name === 'forked_at');
    forkColumns.set(db, hasColumn);
  }
  return hasColumn ? (db.prepare('SELECT forked_at FROM cowork_sessions WHERE id=?').get(sessionId) as { forked_at?: number } | undefined)?.forked_at : undefined;
}

/** Match the existing history projection's target ownership rule, including legacy commands without a run. */
export function taskUsageVisible(metadata: Record<string, unknown>, history: unknown, read: (key: string) => unknown, hasRunOrigin: (runId: string) => boolean): boolean {
  if (history != null && !record(history)) throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
  const target = record(history) ? history : {};
  const runIds = target.runIds ?? [];
  if (!Array.isArray(runIds) || runIds.some(value => typeof value !== 'string')) throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
  if (runIds.includes(metadata.remoteRunId)) return false;
  if (metadata.remoteRunId) {
    if (typeof metadata.remoteRunId !== 'string') throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
    if (!hasRunOrigin(metadata.remoteRunId)) throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
    const published = read(`runPublished:${metadata.remoteRunId}`);
    if (published != null && typeof published !== 'boolean') throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
    return published !== false;
  }
  if (target.targetId && metadata.remoteCommandId) {
    if (typeof target.targetId !== 'string' || typeof metadata.remoteCommandId !== 'string') throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
    const command = read(`inbox:${target.targetId}:${metadata.remoteCommandId}`) || read(`inbox:${metadata.remoteCommandId}`);
    return record(command) && command.targetId === target.targetId;
  }
  return true;
}

interface UsageRow { id: string; created_at: number; metadata: string | null; metadata_bytes: number }
interface Candidate { usage: RemoteTurnUsage; keys: string[]; duplicate?: boolean }
const cache = new WeakMap<Database.Database, Map<string, { version: string; value: RemoteTaskUsage }>>();

/** Full local user-turn coverage, independent of cloud retention and message pagination. Bounded in rows and bytes. */
export function remoteTaskUsage(db: Database.Database, sessionId: string, capturedSourceVersion?: string): RemoteTaskUsage {
  const source = db.prepare('SELECT revision FROM remote_session_revisions WHERE session_id=?').get(sessionId) as { revision: number } | undefined;
  const sourceVersion = capturedSourceVersion ?? String(Math.max(1, source?.revision ?? 0));
  const cached = cache.get(db)?.get(sessionId);
  if (cached?.version === sourceVersion) return cached.value;
  const total = db.prepare("SELECT count(*) AS count FROM cowork_messages WHERE session_id=? AND type='user'").get(sessionId) as { count: number };
  const columns = db.prepare('PRAGMA table_info(cowork_sessions)').all() as Array<{ name: string }>;
  const hasFork = columns.some(column => column.name === 'forked_at');
  const session = db.prepare(`SELECT updated_at${hasFork ? ',forked_at' : ''} FROM cowork_sessions WHERE id=?`).get(sessionId) as { updated_at: number; forked_at?: number };
  const read = (key: string): unknown => readTaskUsageState(db, key);
  let history: unknown;
  let invalidHistory = false;
  try { history = read(`syncTargetHistory:${sessionId}`); } catch { invalidHistory = true; }
  const reasons = new Set<RemoteUsageReason>();
  const candidates: Candidate[] = [], attribution = new Map<string, Candidate>();
  let pendingTurnCount = 0, unavailableTurnCount = 0, scanned = 0, bytes = 0;
  let updatedAt = timestamp(session?.updated_at) ? session.updated_at : 0;
  const rows = db.prepare(`SELECT id,created_at,octet_length(metadata) AS metadata_bytes,
    CASE WHEN octet_length(metadata)<=? THEN metadata ELSE NULL END AS metadata
    FROM cowork_messages WHERE session_id=? AND type='user' ORDER BY sequence,created_at,id LIMIT ?`)
    .iterate(RemoteTaskCredits.MetadataBytes, sessionId, RemoteTaskCredits.MaximumTurns) as Iterable<UsageRow>;
  for (const row of rows) {
    if (bytes + (row.metadata_bytes ?? 0) > RemoteTaskCredits.ScanBytes) { reasons.add(RemoteUsageReason.ScanLimit); break; }
    scanned++; bytes += row.metadata_bytes ?? 0;
    if (timestamp(row.created_at)) updatedAt = Math.max(updatedAt, row.created_at);
    let metadata: unknown;
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { metadata = null; }
    if (!record(metadata) || row.metadata_bytes > RemoteTaskCredits.MetadataBytes) {
      unavailableTurnCount++; reasons.add(RemoteUsageReason.Invalid); continue;
    }
    const usage = remoteTurnUsage(metadata);
    if (!usage) {
      unavailableTurnCount++; reasons.add(metadata.turnUsage == null ? RemoteUsageReason.Missing : RemoteUsageReason.Invalid); continue;
    }
    try {
      if (invalidHistory) throw new Error('REMOTE_USAGE_ATTRIBUTION_INVALID');
      if (!taskUsageVisible(metadata, history, read, runId => hasTaskUsageRunOrigin(db, sessionId, runId))) {
        unavailableTurnCount++; reasons.add(RemoteUsageReason.UnknownScope); continue;
      }
    } catch { unavailableTurnCount++; reasons.add(RemoteUsageReason.Invalid); continue; }
    if (isInheritedTaskUsage(row.created_at, session?.forked_at)) {
      unavailableTurnCount++; reasons.add(RemoteUsageReason.Duplicate); continue;
    }
    updatedAt = Math.max(updatedAt, Date.parse(usage.updatedAt));
    if (usage.status === CoworkTurnUsageStatus.Pending || usage.status === CoworkTurnUsageStatus.Partial) {
      pendingTurnCount++; reasons.add(RemoteUsageReason.Pending);
    }
    if (usage.billingScope === RemoteUsageScope.Unknown) {
      unavailableTurnCount++; reasons.add(RemoteUsageReason.UnknownScope); continue;
    }
    if (usage.displayCreditsUsed === null) {
      unavailableTurnCount++;
      if (usage.status !== CoworkTurnUsageStatus.Pending) reasons.add(RemoteUsageReason.Missing);
      continue;
    }
    const trace = record(metadata.llmTrace) ? metadata.llmTrace : null;
    const primary = record(metadata.turnUsage) ? metadata.turnUsage.traceId : null;
    const related = trace?.relatedTraceIds ?? [];
    const media = metadata.turnMediaTaskIds ?? [];
    if (typeof primary !== 'string' || !tracePattern.test(primary) || !Array.isArray(related) || related.length > 64
      || related.some(value => typeof value !== 'string' || !tracePattern.test(value)) || !Array.isArray(media) || media.length > 100
      || media.some(value => typeof value !== 'string' || !/^[1-9]\d{0,19}$/u.test(value))
      || trace?.traceId !== undefined && trace.traceId !== primary) {
      unavailableTurnCount++; reasons.add(RemoteUsageReason.Invalid); continue;
    }
    const candidate: Candidate = { usage, keys: [...new Set([primary, ...related].map(value => `trace:${value}`).concat(media.map(value => `media:${value}`)))] };
    for (const key of candidate.keys) {
      const previous = attribution.get(key);
      if (previous) { previous.duplicate = true; candidate.duplicate = true; }
      else attribution.set(key, candidate);
    }
    candidates.push(candidate);
  }
  if (scanned < total.count) reasons.add(RemoteUsageReason.ScanLimit);
  const totals = new Map<typeof RemoteUsageScope.Personal | typeof RemoteUsageScope.Enterprise, bigint>();
  let knownTurnCount = 0;
  for (const candidate of candidates) {
    if (candidate.duplicate) { unavailableTurnCount++; reasons.add(RemoteUsageReason.Duplicate); continue; }
    const scope = candidate.usage.billingScope as typeof RemoteUsageScope.Personal | typeof RemoteUsageScope.Enterprise;
    const next = (totals.get(scope) ?? 0n) + cents(candidate.usage.displayCreditsUsed!);
    if (next > maximumCents) { unavailableTurnCount++; reasons.add(RemoteUsageReason.Invalid); continue; }
    totals.set(scope, next); knownTurnCount++;
  }
  const value: RemoteTaskUsage = { schemaVersion: RemoteTaskCredits.SchemaVersion, source: RemoteTaskCredits.Source,
    scope: RemoteTaskCredits.Scope, sourceVersion,
    coverage: reasons.size === 0 ? RemoteUsageCoverage.Complete : knownTurnCount ? RemoteUsageCoverage.Partial : RemoteUsageCoverage.Unavailable,
    totals: [RemoteUsageScope.Personal, RemoteUsageScope.Enterprise].flatMap(scope => totals.has(scope) ? [{ billingScope: scope, displayCreditsUsed: amount(totals.get(scope)!) }] : []),
    totalTurnCount: total.count, knownTurnCount, pendingTurnCount, unavailableTurnCount,
    updatedAt: new Date(updatedAt).toISOString(), reasons: [...reasons].sort() };
  let entries = cache.get(db);
  if (!entries) { entries = new Map(); cache.set(db, entries); }
  if (entries.size >= 128) entries.delete(entries.keys().next().value!);
  entries.set(sessionId, { version: sourceVersion, value });
  return value;
}
