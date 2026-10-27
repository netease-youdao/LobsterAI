import Database from 'better-sqlite3';
import path from 'path';

import { type RemoteOwner, type RemoteSyncLanes, RemoteSyncLaneStatus as Lane, type RemoteSyncTaskIssue, RemoteSyncTaskIssueSource, RemoteSyncTaskIssueStatus, type RemoteWorkspace } from '../../shared/remote/constants';
import { payloadHash } from './canonical';
import { readRemoteDisplayDeletionHealth, type RemoteDisplayDeletionHealth } from './remoteDisplayDeletionHealth';
import { readRemoteDisplayAdmission, RemoteSyncAdmissionBudgetError } from './remoteDisplayHealthAdmission';
import { readRemoteDisplayTaskHealth, type TaskSyncHealth } from './remoteDisplayHealthTask';

export const RemoteDisplayHealthStatus = { Known: 'known', Unknown: 'unknown' } as const;
export const RemoteDisplayHealthFailure = {
  Unavailable: 'REMOTE_DISPLAY_HEALTH_UNAVAILABLE', Budget: 'REMOTE_DISPLAY_HEALTH_BUDGET', Inconsistent: 'REMOTE_DISPLAY_HEALTH_INCONSISTENT',
} as const;
export interface RemoteDisplayHealthInput {
  database: string;
  owner: RemoteOwner;
  /** The bridge's remoteEnvironment, not the network URL. */
  target: string;
  targetId: string | null;
  deviceId: string | null;
  /** Null preserves the bridge's absence of an active availability context. */
  availabilityScope: string | null;
  historySupported: boolean;
  settingsKey: string; controlsKey: string; nameKey: string; catalogFailureKey: string;
}
export interface RemoteDisplayAvailabilityHealth {
  sessions: number; pendingSessions: number; degraded: boolean; oldest: number | null; lastSuccess: number | null;
  lanes: RemoteSyncLanes; countsTruncated: boolean; desktopOnlySessions?: number;
}
export interface RemoteDisplaySettings { enabled?: boolean; name?: string; workspaces?: Array<RemoteWorkspace & { path: string }>; settingsVersion?: string }
export type RemoteDisplayHealthResult = {
  status: typeof RemoteDisplayHealthStatus.Known; observedAt: number;
  settings: RemoteDisplaySettings | null; pendingSettings: boolean; pendingName: boolean; catalogFailed: boolean;
  legacy: { pendingSessions: number; oldest: number | null; lastSuccess: string | null };
  availability: RemoteDisplayAvailabilityHealth | null;
  /** Snapshot only; configure/command handlers continue to use live authoritative checks. */
  taskHealth?: TaskSyncHealth;
  pendingDeletions?: number;
} | { status: typeof RemoteDisplayHealthStatus.Unknown; observedAt: number; reason: typeof RemoteDisplayHealthFailure[keyof typeof RemoteDisplayHealthFailure] };
const Limit = { Sessions: 128, LegacyRows: 10000, JsonBytes: 1024 * 1024, DurationMs: 4500 } as const;
class DisplayHealthError extends Error {
  constructor(readonly reason: typeof RemoteDisplayHealthFailure[keyof typeof RemoteDisplayHealthFailure]) { super(reason); }
}
const unknown = (reason: typeof RemoteDisplayHealthFailure[keyof typeof RemoteDisplayHealthFailure]): never => { throw new DisplayHealthError(reason); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sequence = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value);
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : unknown(RemoteDisplayHealthFailure.Inconsistent);
const timestamp = (value: unknown): number | null => value === null || value === undefined ? null : count(value);
const minTime = (values: Array<number | null>): number | null => values.reduce<number | null>((result, value) => value !== null && (result === null || value < result) ? value : result, null);
const scalar = <T>(db: Database.Database, sql: string, ...args: unknown[]): T | undefined => db.prepare(sql).get(...args) as T | undefined;
function state(db: Database.Database, key: string): unknown {
  const row = scalar<{ value: string | null }>(db, 'SELECT CASE WHEN octet_length(value)<=65536 THEN value END AS value FROM remote_state WHERE key=?', key);
  if (!row) return null;
  if (row.value === null) return unknown(RemoteDisplayHealthFailure.Budget);
  try { return JSON.parse(row.value); } catch { return unknown(RemoteDisplayHealthFailure.Inconsistent); }
}
function jsonRecord(value: string | null): Record<string, unknown> {
  if (value === null) return unknown(RemoteDisplayHealthFailure.Budget);
  try { const parsed: unknown = JSON.parse(value); if (object(parsed)) return parsed; } catch { /* Fixed failure only. */ }
  return unknown(RemoteDisplayHealthFailure.Inconsistent);
}
/** Display-only collector. No Store constructors, migrations, repair, signing or admission mutation. */
export function collectRemoteDisplayHealth(input: RemoteDisplayHealthInput): RemoteDisplayHealthResult {
  const observedAt = Date.now(), deadline = observedAt + Limit.DurationMs;
  const handles: Array<{ db: Database.Database; version: number }> = [];
  const guard = (): void => { if (Date.now() > deadline) unknown(RemoteDisplayHealthFailure.Budget); };
  const open = (filename: string): Database.Database => {
    const db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 50 });
    try {
      db.pragma('query_only=ON');
      const version = Number(db.pragma('data_version', { simple: true }));
      db.exec('BEGIN');
      // Acquire a read snapshot before another database is opened.
      db.prepare('SELECT name FROM sqlite_master LIMIT 1').get();
      handles.push({ db, version }); return db;
    } catch (error) { db.close(); throw error; }
  };
  try {
    if (!input || typeof input.database !== 'string' || input.database === ':memory:' || !path.isAbsolute(input.database)
      || !input.owner || typeof input.owner.userId !== 'string' || typeof input.owner.scopeKey !== 'string'
      || typeof input.target !== 'string' || typeof input.historySupported !== 'boolean'
      || input.targetId !== null && typeof input.targetId !== 'string' || input.deviceId !== null && typeof input.deviceId !== 'string'
      || input.availabilityScope !== null && typeof input.availabilityScope !== 'string'
      || [input.settingsKey, input.controlsKey, input.nameKey, input.catalogFailureKey].some(key => typeof key !== 'string' || key.length > 4096)) unknown(RemoteDisplayHealthFailure.Inconsistent);
    const core = open(input.database);
    const storedSettings = state(core, input.settingsKey);
    if (storedSettings !== null && !object(storedSettings)) unknown(RemoteDisplayHealthFailure.Inconsistent);
    let settings: RemoteDisplaySettings | null = null;
    if (object(storedSettings)) {
      if (storedSettings.enabled !== undefined && typeof storedSettings.enabled !== 'boolean'
        || storedSettings.name !== undefined && (typeof storedSettings.name !== 'string' || storedSettings.name.length > 256)
        || storedSettings.settingsVersion !== undefined && !sequence(storedSettings.settingsVersion)
        || storedSettings.workspaces !== undefined && (!Array.isArray(storedSettings.workspaces) || storedSettings.workspaces.length > 50
          || storedSettings.workspaces.some(value => !object(value) || typeof value.workspaceId !== 'string' || typeof value.name !== 'string'
            || typeof value.path !== 'string' || value.path.length > 4096 || value.name.length > 256 || typeof value.available !== 'boolean')))
        unknown(RemoteDisplayHealthFailure.Inconsistent);
      settings = {
        ...(storedSettings.enabled !== undefined ? { enabled: storedSettings.enabled as boolean } : {}),
        ...(storedSettings.name !== undefined ? { name: storedSettings.name as string } : {}),
        ...(storedSettings.settingsVersion !== undefined ? { settingsVersion: storedSettings.settingsVersion as string } : {}),
        ...(storedSettings.workspaces !== undefined ? { workspaces: (storedSettings.workspaces as Array<RemoteWorkspace & { path: string }>).map(value => ({ workspaceId: value.workspaceId, name: value.name, path: value.path, available: value.available })) } : {}),
      };
    }
    const controls = state(core, input.controlsKey);
    if (controls !== null && !Array.isArray(controls)) unknown(RemoteDisplayHealthFailure.Inconsistent);
    const pendingSettings = Array.isArray(controls) && controls.length > 0, pendingName = Boolean(state(core, input.nameKey));
    const catalogFailed = Boolean(state(core, input.catalogFailureKey));
    if (input.targetId !== null) {
      const active = scalar<{ target_id: string; device_id: string }>(core, `SELECT t.target_id,t.device_id FROM remote_sync_target_active a
        JOIN remote_sync_targets t ON t.target_id=a.target_id AND t.owner_user_id=a.owner_user_id AND t.owner_scope_key=a.owner_scope_key
        WHERE a.owner_user_id=? AND a.owner_scope_key=?`, input.owner.userId, input.owner.scopeKey);
      if (active?.target_id !== input.targetId || active.device_id !== input.deviceId) unknown(RemoteDisplayHealthFailure.Inconsistent);
    }
    let control: Database.Database | null = null, history: Database.Database | null = null;
    const scope = input.availabilityScope;
    if (scope !== null) {
      if (!input.targetId || !input.deviceId || scope !== `${input.targetId}:${input.owner.userId}:${input.owner.scopeKey}:${input.deviceId}`)
        unknown(RemoteDisplayHealthFailure.Inconsistent);
      control = open(path.join(path.dirname(input.database), 'remote-control.sqlite'));
      const locator = scalar<{ ledger_id: string; phase: string }>(core, 'SELECT ledger_id,phase FROM remote_control_ledger_locator WHERE id=1');
      const identity = scalar<{ ledger_id: string }>(control, 'SELECT ledger_id FROM availability_identity WHERE id=1');
      const migration = scalar<{ phase: string }>(control, 'SELECT phase FROM availability_migration WHERE id=1');
      if (!locator || locator.phase !== 'ready' || !identity || locator.ledger_id !== identity.ledger_id || migration?.phase !== 'ready')
        unknown(RemoteDisplayHealthFailure.Inconsistent);
    }
    const hasAvailability = (id: string): boolean => !!control && !!scalar(control, 'SELECT 1 FROM availability_sessions WHERE scope=? AND local_id=?', scope, id);
    const currentBinding = (id: string): boolean => {
      const row = scalar<{ sync_environment: string | null; device_id: string | null }>(core, 'SELECT sync_environment,device_id FROM remote_sync WHERE local_id=?', id);
      return !!row && (!row.device_id || row.device_id === input.deviceId) && (!row.sync_environment || row.sync_environment === input.target
        || !!scalar(core, 'SELECT 1 FROM remote_sync_target_aliases WHERE target_id=? AND environment=?', input.target, row.sync_environment));
    };
    const visible = (id: string): boolean => !!control && currentBinding(id) && !hasAvailability(id);
    const legacyRows = core.prepare(`SELECT s.local_id,r.dirty_at AS oldest FROM remote_sync s
      LEFT JOIN remote_session_revisions r ON r.session_id=s.local_id JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?
        AND NOT EXISTS(SELECT 1 FROM remote_state closed WHERE closed.key='deletionClosed:'||s.local_id)
        AND (s.needs_snapshot=1 OR s.source_seq>s.ack_seq OR EXISTS(SELECT 1 FROM remote_dirty d WHERE d.session_id=s.local_id))
      LIMIT ?`).all(input.owner.userId, input.owner.scopeKey, Limit.LegacyRows + 1) as Array<{ local_id: string; oldest: number | null }>;
    if (legacyRows.length > Limit.LegacyRows) unknown(RemoteDisplayHealthFailure.Budget);
    guard();
    const legacyPending = legacyRows.filter(row => { guard(); return visible(row.local_id); });
    const last = state(core, `lastSuccessfulSync:${input.owner.userId}:${input.owner.scopeKey}`);
    if (last !== null && (typeof last !== 'string' || !Number.isFinite(Date.parse(last)))) unknown(RemoteDisplayHealthFailure.Inconsistent);
    const legacy = { pendingSessions: legacyPending.length, oldest: minTime(legacyPending.map(row => timestamp(row.oldest))), lastSuccess: last as string | null };
    let availability: RemoteDisplayAvailabilityHealth | null = null;
    let availabilityFailedSessions = 0, admissionFailure: unknown = null;
    const availabilityTaskIssues: RemoteSyncTaskIssue[] = [];
    const admitted = (id: string): boolean => {
      try { return readRemoteDisplayAdmission(core, input.owner, input.deviceId!, input.targetId, id); }
      catch (error) { admissionFailure = error; return false; }
    };
    let pendingDeletions = 0;
    // Registration has not established a deletion target while these identities are absent.
    const deletedRows = input.targetId && input.deviceId ? core.prepare(`SELECT s.local_id,s.session_id,s.device_id,s.stream_epoch,s.source_seq,s.ack_seq FROM remote_sync s
      JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?
        AND EXISTS(SELECT 1 FROM remote_state WHERE key='localGcDeleted:'||s.local_id)
        AND NOT EXISTS(SELECT 1 FROM cowork_sessions WHERE id=s.local_id) LIMIT ?`)
      .all(input.owner.userId, input.owner.scopeKey, Limit.Sessions + 1) as Array<{ local_id: string; session_id: string; device_id: string; stream_epoch: string | null; source_seq: number; ack_seq: number }> : [];
    if (deletedRows.length > Limit.Sessions) unknown(RemoteDisplayHealthFailure.Budget);
    const deletions = new Map<string, RemoteDisplayDeletionHealth>();
    for (const row of deletedRows) {
      guard();
      if (!currentBinding(row.local_id)) continue;
      const deletion = readRemoteDisplayDeletionHealth(core, control, { owner: input.owner, targetId: input.targetId, deviceId: input.deviceId, scope }, row.local_id);
      deletions.set(row.local_id, deletion);
      if (deletion.pending) pendingDeletions++;
    }
    if (control && scope) {
      // This disposable ACK cache was formerly created lazily by the display read.
      // Absence means no known ACKs; deriving pending must not create a table.
      const hasHealthAcks = !!scalar(core, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_availability_health_acks'");
      const healthAcks = hasHealthAcks ? 'remote_availability_health_acks'
        : '(SELECT NULL AS scope,NULL AS session_id,NULL AS object_key,0 AS revision,NULL AS representation WHERE 0)';
      const total = count(scalar<{ total: number }>(control, 'SELECT COUNT(*) AS total FROM availability_sessions WHERE scope=?', scope)?.total);
      const persistedPending = count(scalar<{ total: number }>(control, `SELECT COUNT(*) AS total FROM (
        SELECT local_id FROM availability_sessions WHERE scope=? AND CASE WHEN json_valid(body) THEN json_extract(body,'$.phase')<>'active' ELSE 1 END
        UNION SELECT local_id FROM availability_requests WHERE scope=? AND resolution_receipt IS NULL)`, scope, scope)?.total);
      let degraded = !!scalar(control, 'SELECT 1 FROM availability_faults WHERE scope=? LIMIT 1', scope);
      if (scalar(control, 'SELECT 1 FROM availability_sessions WHERE scope=? AND (octet_length(body)>? OR NOT json_valid(body)) LIMIT 1', scope, Limit.JsonBytes))
        unknown(RemoteDisplayHealthFailure.Inconsistent);
      const rows = control.prepare(`SELECT local_id,CASE WHEN octet_length(body)<=? THEN body END AS body
        FROM availability_sessions WHERE scope=? ORDER BY local_id LIMIT ?`).all(Limit.JsonBytes, scope, Limit.Sessions + 1) as Array<{ local_id: string; body: string | null }>;
      let pending = 0, desktopOnlySessions = 0, oldest: number | null = null;
      const lanes: RemoteSyncLanes = {}, rank = [Lane.Idle, Lane.Pending, Lane.InFlight, Lane.Backoff, Lane.Degraded, Lane.Unknown];
      for (const row of rows.slice(0, Limit.Sessions)) {
        guard();
        const saved = jsonRecord(row.body);
        const binding = scalar<{ session_id: string; device_id: string | null; migration_frozen: number; owner_user_id: string; owner_scope_key: string; ownership_status: string; title: string; local_exists: number }>(core, `SELECT s.session_id,s.device_id,s.migration_frozen,o.owner_user_id,o.owner_scope_key,o.ownership_status,substr(c.title,1,256) AS title,c.id IS NOT NULL AS local_exists
          FROM remote_sync s JOIN cowork_session_ownership o ON o.session_id=s.local_id LEFT JOIN cowork_sessions c ON c.id=s.local_id WHERE s.local_id=?`, row.local_id);
        if (!binding || binding.owner_user_id !== input.owner.userId || binding.owner_scope_key !== input.owner.scopeKey || binding.ownership_status !== 'confirmed'
          || !currentBinding(row.local_id) || binding.session_id !== saved.sessionId || binding.device_id !== input.deviceId || saved.scope !== scope || saved.localId !== row.local_id
          || typeof saved.writerGeneration !== 'string' || !['activating','bootstrap','active'].includes(String(saved.phase)) || !sequence(saved.controlRevision))
          unknown(RemoteDisplayHealthFailure.Inconsistent);
        const revision = scalar<{ revision: number }>(core, 'SELECT revision FROM remote_control_revisions WHERE session_id=?', row.local_id)?.revision || 1;
        const deletionValue = state(core, `localGcDeleted:${row.local_id}`);
        const deletion = deletionValue === null ? null : object(deletionValue) ? deletionValue : unknown(RemoteDisplayHealthFailure.Inconsistent);
        if (!binding.local_exists && !deletion) unknown(RemoteDisplayHealthFailure.Inconsistent);
        const deletionPending = !!deletion && (deletions.get(row.local_id)?.pending ?? true);
        const requests = control.prepare(`SELECT lane,MIN(CASE WHEN octet_length(body)<=? AND json_valid(body) THEN json_extract(body,'$.createdAt') END) AS oldest,
          SUM(CASE WHEN octet_length(body)>? OR NOT json_valid(body) THEN 1 ELSE 0 END) AS invalid FROM availability_requests
          WHERE scope=? AND local_id=? AND resolution_receipt IS NULL GROUP BY lane`).all(Limit.JsonBytes, Limit.JsonBytes, scope, row.local_id) as Array<{ lane: string; oldest: number | null; invalid: number }>;
        if (requests.some(request => request.invalid || !['live','control'].includes(request.lane))) unknown(RemoteDisplayHealthFailure.Inconsistent);
        const messages = deletion ? { pending: 0, oldest: null } : scalar<{ pending: number; oldest: number | null }>(core, `SELECT COUNT(*) AS pending,MIN(m.created_at) AS oldest FROM cowork_messages m
          LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
          LEFT JOIN ${healthAcks} a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
          WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND COALESCE(r.revision,1)>COALESCE(a.revision,0)`, scope, row.local_id)!;
        const tools = deletion ? 0 : count(scalar<{ pending: number }>(core, `SELECT COUNT(*) AS pending FROM remote_live_tools r
          LEFT JOIN ${healthAcks} a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
          WHERE r.session_id=? AND r.revision>COALESCE(a.revision,0)`, scope, row.local_id)?.pending);
        // Only ACKs for the current source revision describe current content. Older ACKs are backlog,
        // while unsupported/unknown representations cannot claim complete synchronization.
        const representations = deletion || !hasHealthAcks ? undefined : scalar<{ desktopOnly: number; unavailable: number }>(core, `SELECT
          COALESCE(SUM(CASE WHEN representation='desktop_only' AND ack_revision=source_revision THEN 1 ELSE 0 END),0) AS desktopOnly,
          COALESCE(SUM(CASE WHEN representation IS NULL OR representation NOT IN ('complete','desktop_only','local_only') OR ack_revision>source_revision THEN 1 ELSE 0 END),0) AS unavailable
          FROM (SELECT a.representation,a.revision AS ack_revision,COALESCE(r.revision,1) AS source_revision FROM cowork_messages m
            LEFT JOIN remote_live_revisions r ON r.session_id=m.session_id AND r.object_id=m.id
            JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=m.session_id AND a.object_key='message:'||m.id
            WHERE m.session_id=? AND m.type IN ('user','assistant','system','tool_use','tool_result') AND a.revision>=COALESCE(r.revision,1) AND COALESCE(r.deleted,0)=0
            UNION ALL SELECT a.representation,a.revision,r.revision FROM remote_live_tools r
            JOIN remote_availability_health_acks a ON a.scope=? AND a.session_id=r.session_id AND a.object_key='tool:'||r.tool_id
            WHERE r.session_id=? AND a.revision>=r.revision)`, scope, row.local_id, scope, row.local_id);
        if (representations && count(representations.desktopOnly) > 0) desktopOnlySessions++;
        const unavailable = !!representations && count(representations.unavailable) > 0;
        const faultRow = scalar<{ total: number; nextRetryAt: number | null; liveObjects: number }>(control,
          `SELECT COUNT(*) AS total,MIN(next_retry) AS nextRetryAt,
            COALESCE(SUM(CASE WHEN substr(object_key,1,8)='message:' OR substr(object_key,1,5)='tool:' THEN 1 ELSE 0 END),0) AS liveObjects
          FROM availability_faults WHERE scope=? AND local_id=?`, scope, row.local_id)!;
        const fault = count(faultRow.total) > 0;
        if (fault) {
          availabilityFailedSessions++;
          const nextRetryAt = count(faultRow.nextRetryAt), hasLiveFault = count(faultRow.liveObjects) > 0;
          if (availabilityTaskIssues.length < 20) availabilityTaskIssues.push({ localSessionId: row.local_id,
            title: typeof binding.title === 'string' ? binding.title : '', ...(hasLiveFault ? { source: RemoteSyncTaskIssueSource.Live } : {}),
            status: RemoteSyncTaskIssueStatus.Isolated, nextRetryAt, retryable: hasLiveFault && admitted(row.local_id) });
        }
        const taskLanes: RemoteSyncLanes = {
          control: !deletion && (saved.phase !== 'active' || saved.controlRevision !== String(revision)) || requests.some(request => request.lane === 'control') ? Lane.Pending : Lane.Idle,
          live: unavailable ? Lane.Unknown : fault ? Lane.Degraded : count(messages.pending) + tools || requests.some(request => request.lane === 'live') ? Lane.Pending : Lane.Idle,
          deletion: deletionPending ? Lane.Pending : Lane.Idle, recovery: Lane.Idle,
        };
        if (input.historySupported && !deletion && saved.phase === 'active') {
          if (!history) {
            history = open(path.join(path.dirname(input.database), 'remote-sync.sqlite'));
            const profile = scalar<{ sidecar_id: string }>(core, 'SELECT sidecar_id FROM remote_history_profile WHERE id=1');
            const identity = scalar<{ sidecar_id: string }>(history, 'SELECT sidecar_id FROM history_identity WHERE id=1');
            if (!profile || !identity || profile.sidecar_id !== identity.sidecar_id) unknown(RemoteDisplayHealthFailure.Inconsistent);
          }
          const migration = scalar<{ phase: string; migration_id: string; manifest_hash: string; manifest: string | null }>(core,
            `SELECT phase,migration_id,manifest_hash,CASE WHEN octet_length(manifest_json)<=16384 THEN manifest_json END AS manifest
            FROM remote_history_migrations WHERE scope=? AND local_id=? AND writer_generation=?`, scope, row.local_id, saved.writerGeneration);
          const historyRow = scalar<{ body: string | null }>(history, 'SELECT CASE WHEN octet_length(body)<=65536 THEN body END AS body FROM history_sessions WHERE scope=? AND local_id=? AND writer_generation=?', scope, row.local_id, saved.writerGeneration);
          if (!migration || migration.phase !== 'ready' || !historyRow) unknown(RemoteDisplayHealthFailure.Inconsistent);
          const manifest = jsonRecord(migration.manifest), context = manifest.context;
          if (payloadHash(manifest) !== migration.manifest_hash || !object(context) || context.scope !== scope || context.localId !== row.local_id
            || context.sessionId !== saved.sessionId || context.writerGeneration !== saved.writerGeneration || context.deviceId !== input.deviceId
            || !object(context.owner) || context.owner.userId !== input.owner.userId || context.owner.scopeKey !== input.owner.scopeKey
            || !object(manifest.legacy) || !scalar(history, 'SELECT 1 FROM history_migration_copies WHERE migration_id=? AND manifest_hash=? AND manifest_json=?',
              migration.migration_id, migration.manifest_hash, migration.manifest)) unknown(RemoteDisplayHealthFailure.Inconsistent);
          const legacySource = count((manifest.legacy as Record<string, unknown>).source_seq), legacyAck = count((manifest.legacy as Record<string, unknown>).ack_seq);
          if (legacyAck > legacySource) unknown(RemoteDisplayHealthFailure.Inconsistent);
          const historySession = jsonRecord(historyRow.body);
          if (historySession.scope !== scope || historySession.localId !== row.local_id || historySession.sessionId !== saved.sessionId
            || historySession.writerGeneration !== saved.writerGeneration || historySession.deviceId !== input.deviceId
            || historySession.migrationId !== migration.migration_id || historySession.legacyMetadataHash !== migration.manifest_hash
            || !object(historySession.owner) || historySession.owner.userId !== input.owner.userId || historySession.owner.scopeKey !== input.owner.scopeKey
            || !sequence(historySession.resolvedSourceSeq)) unknown(RemoteDisplayHealthFailure.Inconsistent);
          // Unknown request bodies remain untouched: display counts depend only on existing scalar state.
          if (scalar(history, "SELECT 1 FROM history_operations WHERE scope=? AND local_id=? AND writer_generation=? AND state NOT IN ('pending','complete') LIMIT 1", scope, row.local_id, saved.writerGeneration))
            unknown(RemoteDisplayHealthFailure.Inconsistent);
          const operation = scalar(history, "SELECT 1 FROM history_operations WHERE scope=? AND local_id=? AND writer_generation=? AND state='pending' LIMIT 1", scope, row.local_id, saved.writerGeneration);
          taskLanes.history = operation || BigInt(String(historySession.resolvedSourceSeq)) < BigInt(legacySource) ? Lane.Pending : Lane.Idle;
        }
        if (Object.values(taskLanes).some(lane => lane !== Lane.Idle)) pending++;
        degraded ||= unavailable || fault || Object.values(taskLanes).includes(Lane.Unknown);
        oldest = minTime([oldest, timestamp(messages.oldest), ...requests.map(request => timestamp(request.oldest)), deletionPending ? timestamp(deletion!.deletedAt) : null]);
        for (const [name, status] of Object.entries(taskLanes)) {
          const lane = name as keyof RemoteSyncLanes;
          if (!lanes[lane] || rank.indexOf(status!) > rank.indexOf(lanes[lane]!)) lanes[lane] = status;
        }
      }
      const countsTruncated = rows.length > Limit.Sessions;
      if (countsTruncated) { degraded = true; lanes.recovery = Lane.Unknown; }
      const lastSuccess = timestamp(scalar<{ at: number | null }>(control, 'SELECT MAX(ack_at) AS at FROM availability_progress WHERE scope=?', scope)?.at);
      availability = { sessions: total, pendingSessions: Math.max(pending, persistedPending), degraded, oldest, lastSuccess, lanes, countsTruncated, desktopOnlySessions };
    }
    guard();
    const taskHealth = input.deviceId ? readRemoteDisplayTaskHealth(core, { owner: input.owner, target: input.target, deviceId: input.deviceId }, admitted, visible, observedAt) : undefined;
    if (taskHealth) {
      // visible() excludes availability sessions, so these two task sets cannot double-count a session.
      taskHealth.failedSessions += availabilityFailedSessions;
      taskHealth.isolatedSessions += availabilityFailedSessions;
      const issues = [...availabilityTaskIssues, ...taskHealth.taskIssues].filter(issue =>
        !!scalar(core, 'SELECT 1 FROM cowork_sessions WHERE id=?', issue.localSessionId));
      taskHealth.taskIssuesTruncated ||= availabilityFailedSessions > availabilityTaskIssues.length || issues.length > 20;
      taskHealth.taskIssues = issues.slice(0, 20);
      taskHealth.countsTruncated ||= availability?.countsTruncated;
    }
    if (admissionFailure) unknown(admissionFailure instanceof RemoteSyncAdmissionBudgetError ? RemoteDisplayHealthFailure.Budget : RemoteDisplayHealthFailure.Inconsistent);
    guard();
    for (const { db, version } of handles) {
      db.exec('ROLLBACK');
      if (Number(db.pragma('data_version', { simple: true })) !== version) unknown(RemoteDisplayHealthFailure.Inconsistent);
    }
    const result: RemoteDisplayHealthResult = { status: RemoteDisplayHealthStatus.Known, observedAt: Date.now(), settings, pendingSettings, pendingName, catalogFailed, legacy, availability,
      ...(pendingDeletions ? { pendingDeletions } : {}), ...(taskHealth ? { taskHealth } : {}) };
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) unknown(RemoteDisplayHealthFailure.Budget);
    return result;
  } catch (error) {
    return { status: RemoteDisplayHealthStatus.Unknown, observedAt: Date.now(),
      reason: error instanceof DisplayHealthError ? error.reason : RemoteDisplayHealthFailure.Unavailable };
  } finally {
    for (const { db } of handles.reverse()) if (db.open) db.close();
  }
}
