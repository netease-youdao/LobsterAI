import { createHash, randomUUID } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { RetentionState } from '../../shared/remote/retention';
import { parseRemoteSyncTarget, type RemoteSyncTargetIdentity } from '../../shared/remote/syncTarget';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { migrateVerifiedRemoteTargetCatalogRouting, migrateVerifiedRemoteTargetFileRouting } from './remoteEnvironmentMigration';
import { materializeRemotePreparedInputSources } from './remotePreparedInputSnapshots';
import { RemoteSyncStateError, retentionSequence } from './remoteRetention';
import type { RemoteStore, SyncRow } from './remoteStore';

type Store = Pick<RemoteStore, 'db'>;
type Row = Record<string, string | number | null>;
interface StateRow { key: string; value: string }
export const RemoteSyncTargetActivationKind = { Unchanged: 'unchanged', Claimed: 'claimed', Created: 'created', Restored: 'restored' } as const;
export interface StoredRemoteSyncTarget {
  targetId: string; owner: RemoteOwner; deviceId: string; syncTarget: RemoteSyncTargetIdentity | null; epoch: number;
}
export interface RemoteSyncTargetActivation {
  owner: RemoteOwner; deviceId: string; syncTarget: RemoteSyncTargetIdentity; targetId?: string;
  /** Only an authenticated, independently identified data space authorizes a fresh working set. */
  bootstrap?: boolean; legacyStates?: RetentionState[];
}
export interface RemoteSyncTargetActivationResult extends StoredRemoteSyncTarget {
  kind: typeof RemoteSyncTargetActivationKind[keyof typeof RemoteSyncTargetActivationKind];
}
const tables = {
  remote_sync: 'local_id', remote_outbox: 'session_id', remote_projection: 'session_id', remote_object_state: 'session_id',
  remote_reply_contents: 'session_id', remote_reply_chunks: 'session_id', remote_projection_publications: 'session_id',
  remote_projection_failures: 'session_id', remote_dirty: 'session_id', remote_content_dirty: 'session_id',
} as const;
const sessionKeys = ['import', 'syncFailure', 'snapshotEpoch', 'snapshotReason', 'workspace', 'inputModel', 'syncTargetHistory'];
const sessionPrefixes = ['replyContentVersion:', 'fileTerminalBoundary:'];
const accountKeys = ['settings', 'controlQueue', 'namePending', 'agentCatalogFailure', 'questionCapability', 'agentCapabilities', 'dualApprovalCapability'];
const ownSessions = "SELECT session_id FROM cowork_session_ownership WHERE owner_user_id=? AND owner_scope_key=? AND ownership_status='confirmed'";
const hasArchives = (store: Store): boolean => !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_sync_target_archives'").get();

export function remoteSyncTargetId(target: RemoteSyncTargetIdentity, owner: RemoteOwner): string {
  return payloadHash([target.dataSpaceId, target.dataGeneration, owner.userId, owner.scopeKey]);
}

export function activeRemoteSyncTargetContext(store: Store, owner: RemoteOwner): { targetId: string; epoch: number } | null {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_sync_target_active'").get()) return null;
  const row = store.db.prepare('SELECT target_id,epoch FROM remote_sync_target_active WHERE owner_user_id=? AND owner_scope_key=?')
    .get(owner.userId, owner.scopeKey) as { target_id: string; epoch: number } | undefined;
  return row ? { targetId: row.target_id, epoch: row.epoch } : null;
}

/** Archive references remain live even while their service is disconnected. */
export function archivedRemoteSyncReferences(store: Store): { paths: Set<string>; importFileSets: Set<string> } {
  const paths = new Set<string>(), importFileSets = new Set<string>();
  if (!hasArchives(store)) return { paths, importFileSets };
  const visit = (value: unknown, name = ''): void => {
    if (typeof value === 'string') {
      if (name === 'fileSet') importFileSets.add(value);
      if (name === 'path' || name === 'filePath' || name === 'cacheDirectory') paths.add(value);
    } else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, key);
  };
  let bytes = 0;
  for (const row of store.db.prepare("SELECT table_name,row_json FROM remote_sync_target_archives WHERE table_name IN ('remote_state','remote_projection_publications')").iterate() as Iterable<{ table_name: string; row_json: string }>) {
    bytes += Buffer.byteLength(row.row_json);
    if (bytes > 32 * 1024 * 1024) throw new RemoteSyncStateError('Synchronization archive reference scan exceeds budget');
    const value = JSON.parse(row.row_json);
    visit(row.table_name === 'remote_state' ? JSON.parse(value.value) : value);
  }
  return { paths, importFileSets };
}

/** One active working set per account; archives never participate in normal delivery queries. */
export class RemoteSyncTargetStore {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS remote_sync_targets(
      target_id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,device_id TEXT NOT NULL,sync_target_json TEXT);
      CREATE TABLE IF NOT EXISTS remote_sync_target_active(
        owner_user_id TEXT NOT NULL,owner_scope_key TEXT NOT NULL,target_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        PRIMARY KEY(owner_user_id,owner_scope_key));
      CREATE TABLE IF NOT EXISTS remote_sync_target_archives(
        target_id TEXT NOT NULL,table_name TEXT NOT NULL,row_key INTEGER NOT NULL,row_json TEXT NOT NULL,
        PRIMARY KEY(target_id,table_name,row_key));
      CREATE TABLE IF NOT EXISTS remote_sync_target_archive_manifests(
        target_id TEXT PRIMARY KEY,row_count INTEGER NOT NULL,digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_sync_target_aliases(
        target_id TEXT NOT NULL,environment TEXT NOT NULL,PRIMARY KEY(target_id,environment));`);
  }
  active(owner: RemoteOwner): StoredRemoteSyncTarget | null {
    const row = this.store.db.prepare(`SELECT t.*,a.epoch FROM remote_sync_target_active a JOIN remote_sync_targets t ON t.target_id=a.target_id
      WHERE a.owner_user_id=? AND a.owner_scope_key=?`).get(owner.userId, owner.scopeKey) as Row | undefined;
    return row ? { targetId: String(row.target_id), owner: { ...owner }, deviceId: String(row.device_id),
      syncTarget: row.sync_target_json ? JSON.parse(String(row.sync_target_json)) : null, epoch: Number(row.epoch) } : null;
  }
  matchesEnvironment(targetId: string, environment: string | null | undefined): boolean {
    return environment === targetId || typeof environment === 'string'
      && !!this.store.db.prepare('SELECT 1 FROM remote_sync_target_aliases WHERE target_id=? AND environment=?').get(targetId, environment);
  }
  activateLegacy(input: { owner: RemoteOwner; deviceId: string; legacyStates?: RetentionState[] }): RemoteSyncTargetActivationResult {
    const active = this.active(input.owner);
    if (active?.syncTarget) throw new RemoteSyncStateError('An identified synchronization target cannot be downgraded');
    const targetId = `legacy:${payloadHash([input.owner.userId, input.owner.scopeKey, input.deviceId])}`;
    return this.activateInternal({ ...input, targetId, syncTarget: null });
  }
  activate(input: RemoteSyncTargetActivation): RemoteSyncTargetActivationResult {
    const target = parseRemoteSyncTarget(input.syncTarget);
    if (!target) throw new RemoteSyncStateError('Invalid synchronization target identity');
    const targetId = remoteSyncTargetId(target, input.owner);
    if (input.targetId && input.targetId !== targetId) throw new RemoteSyncStateError('Synchronization target identity mismatch');
    return this.activateInternal({ ...input, targetId, syncTarget: target });
  }
  private rows(owner: RemoteOwner): SyncRow[] {
    return this.store.db.prepare(`SELECT * FROM remote_sync WHERE local_id IN (${ownSessions})`).all(owner.userId, owner.scopeKey) as SyncRow[];
  }
  private state(): StateRow[] { return this.store.db.prepare('SELECT key,value FROM remote_state').all() as StateRow[]; }
  private canClaim(rows: SyncRow[], deviceId: string, states: RetentionState[]): boolean {
    const proof = new Map(states.map(value => [value.localSessionId, value]));
    return rows.every(row => {
      const pending = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`import:${row.local_id}`);
      // Assigned source positions alone are local work, but any registered stream requires evidence.
      if (!row.device_id && !row.ack_seq && row.server_seq === '0' && row.sync_protocol_version === 1 && !row.stream_epoch && !pending) return true;
      const state = proof.get(row.local_id);
      return !!state && row.device_id === deviceId && state.deviceId === deviceId && state.sessionId === row.session_id
        && state.syncProtocolVersion === row.sync_protocol_version && state.streamEpoch === row.stream_epoch
        && retentionSequence(state.lastSourceSeq) >= BigInt(row.ack_seq) && retentionSequence(state.lastSourceSeq) <= BigInt(row.source_seq)
        && retentionSequence(state.lastSeq) >= retentionSequence(row.server_seq);
    });
  }
  private register(target: Omit<StoredRemoteSyncTarget, 'epoch'>): void {
    const previous = this.store.db.prepare('SELECT * FROM remote_sync_targets WHERE target_id=?').get(target.targetId) as Row | undefined;
    if (previous && (previous.owner_user_id !== target.owner.userId || previous.owner_scope_key !== target.owner.scopeKey || previous.device_id !== target.deviceId)) {
      throw new RemoteSyncStateError('Synchronization target device or owner changed');
    }
    this.store.db.prepare('INSERT OR IGNORE INTO remote_sync_targets VALUES (?,?,?,?,?)').run(target.targetId, target.owner.userId,
      target.owner.scopeKey, target.deviceId, target.syncTarget ? stableJson(target.syncTarget) : null);
  }
  private tagExecution(owner: RemoteOwner, targetId: string, verifiedSessions = new Set<string>()): void {
    const sessions = new Map(this.rows(owner).map(row => [row.local_id, row]));
    const ids = new Set(sessions.keys());
    for (const row of this.state()) {
      if (row.key.startsWith('inbox:')) {
        const value = JSON.parse(row.value);
        const session = sessions.get(value.localSessionId);
        const remoteId = value.remoteSessionId || value.command?.sessionId;
        if (sameOwner(value.owner, owner) && !value.targetId && verifiedSessions.has(value.localSessionId)
          && session && remoteId === session.session_id) {
          value.targetId = targetId;
          this.store.db.prepare('UPDATE remote_state SET value=? WHERE key=?').run(stableJson(value), row.key);
        }
      } else if ([...ids].some(id => row.key === `run:${id}` || row.key.startsWith(`runHistory:${id}:`))) {
        const run = JSON.parse(row.value);
        if (typeof run.runId === 'string') this.store.db.prepare('INSERT OR IGNORE INTO remote_state VALUES (?,?)')
          .run(`syncRunTarget:${run.runId}`, JSON.stringify(targetId));
      }
    }
    for (const row of this.store.db.prepare(`SELECT DISTINCT json_extract(metadata,'$.remoteRunId') AS run_id FROM cowork_messages
      WHERE session_id IN (${ownSessions}) AND json_valid(metadata) AND json_type(metadata,'$.remoteRunId')='text'`).all(owner.userId, owner.scopeKey) as Array<{ run_id: string }>) {
      this.store.db.prepare('INSERT OR IGNORE INTO remote_state VALUES (?,?)').run(`syncRunTarget:${row.run_id}`, JSON.stringify(targetId));
    }
  }
  private transportState(row: StateRow, ids: Set<string>): boolean {
    if ([...ids].some(id => sessionKeys.some(prefix => row.key === `${prefix}:${id}`)
      || sessionPrefixes.some(prefix => row.key.startsWith(`${prefix}${id}:`)))) return true;
    if (row.key.startsWith('desktopAsset:') || row.key.startsWith('fileOutput:')) {
      const value = JSON.parse(row.value);
      return ids.has(value.localSessionId);
    }
    return false;
  }
  private archive(targetId: string, owner: RemoteOwner): void {
    const ids = new Set(this.rows(owner).map(row => row.local_id));
    this.store.db.prepare('DELETE FROM remote_sync_target_archives WHERE target_id=?').run(targetId);
    const insert = this.store.db.prepare('INSERT INTO remote_sync_target_archives VALUES (?,?,?,?)');
    for (const [table, column] of Object.entries(tables)) {
      let index = 0, cursor = 0;
      while (true) {
        const rows = this.store.db.prepare(`SELECT rowid AS archive_cursor,* FROM ${table} WHERE ${column} IN (${ownSessions}) AND rowid>? ORDER BY rowid LIMIT 64`)
          .all(owner.userId, owner.scopeKey, cursor) as Array<Row & { archive_cursor: number }>;
        if (!rows.length) break;
        for (const { archive_cursor, ...row } of rows) { insert.run(targetId, table, index++, stableJson(row)); cursor = archive_cursor; }
      }
    }
    let index = 0;
    for (const row of this.state()) if (this.transportState(row, ids)) insert.run(targetId, 'remote_state', index++, stableJson(row));
    const manifest = this.archiveManifest(targetId);
    this.store.db.prepare('INSERT OR REPLACE INTO remote_sync_target_archive_manifests VALUES (?,?,?)').run(targetId, manifest.row_count, manifest.digest);
  }
  private archiveManifest(targetId: string): { row_count: number; digest: string } {
    const hash = createHash('sha256'); let row_count = 0;
    for (const row of this.store.db.prepare('SELECT table_name,row_key,row_json FROM remote_sync_target_archives WHERE target_id=? ORDER BY table_name,row_key').iterate(targetId)) {
      hash.update(stableJson(row)); hash.update('\n'); row_count++;
    }
    return { row_count, digest: hash.digest('hex') };
  }
  private clear(owner: RemoteOwner): void {
    const ids = new Set(this.rows(owner).map(row => row.local_id));
    for (const row of this.state()) if (this.transportState(row, ids)) this.store.db.prepare('DELETE FROM remote_state WHERE key=?').run(row.key);
    for (const [table, column] of Object.entries(tables)) this.store.db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${ownSessions})`).run(owner.userId, owner.scopeKey);
    this.store.db.prepare(`UPDATE remote_session_revisions SET clean_revision=0 WHERE session_id IN (${ownSessions})`).run(owner.userId, owner.scopeKey);
  }
  private restore(targetId: string, owner: RemoteOwner): void {
    const expected = this.store.db.prepare('SELECT row_count,digest FROM remote_sync_target_archive_manifests WHERE target_id=?').get(targetId) as { row_count: number; digest: string } | undefined;
    const actual = this.archiveManifest(targetId);
    if (!expected || expected.row_count !== actual.row_count || expected.digest !== actual.digest) throw new RemoteSyncStateError('Synchronization recovery archive is missing or damaged');
    const owned = new Set((this.store.db.prepare(ownSessions).all(owner.userId, owner.scopeKey) as Array<{ session_id: string }>).map(row => row.session_id));
    for (const row of this.store.db.prepare("SELECT row_json FROM remote_sync_target_archives WHERE target_id=? AND table_name='remote_sync'").iterate(targetId) as Iterable<{ row_json: string }>) {
      if (!owned.has((JSON.parse(row.row_json) as SyncRow).local_id)) throw new RemoteSyncStateError('Archived synchronization ownership changed');
    }
    let cursor = 0;
    const tableColumns = new Map<string, Set<string>>();
    while (true) {
      const rows = this.store.db.prepare('SELECT rowid AS archive_cursor,table_name,row_json FROM remote_sync_target_archives WHERE target_id=? AND rowid>? ORDER BY rowid LIMIT 64')
        .all(targetId, cursor) as Array<{ archive_cursor: number; table_name: string; row_json: string }>;
      if (!rows.length) break;
      for (const saved of rows) {
        if (saved.table_name !== 'remote_state' && !Object.hasOwn(tables, saved.table_name)) throw new RemoteSyncStateError('Invalid synchronization archive table');
        const row = JSON.parse(saved.row_json) as Row;
        const columns = Object.keys(row);
        if (!tableColumns.has(saved.table_name)) tableColumns.set(saved.table_name,
          new Set((this.store.db.prepare(`PRAGMA table_info(${saved.table_name})`).all() as Array<{ name: string }>).map(column => column.name)));
        if (!columns.length || columns.some(column => !tableColumns.get(saved.table_name)!.has(column))) throw new RemoteSyncStateError('Invalid synchronization archive columns');
        const quotedColumns = columns.map(column => `"${column.replace(/"/gu, '""')}"`).join(',');
        this.store.db.prepare(`INSERT INTO ${saved.table_name} (${quotedColumns}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
        cursor = saved.archive_cursor;
      }
    }
    this.store.db.prepare('DELETE FROM remote_sync_target_archives WHERE target_id=?').run(targetId);
    this.store.db.prepare('DELETE FROM remote_sync_target_archive_manifests WHERE target_id=?').run(targetId);
  }
  private history(owner: RemoteOwner, targetId: string): void {
    for (const row of this.rows(owner)) {
      const runIds: string[] = [];
      for (const fact of this.store.db.prepare('SELECT value FROM remote_state WHERE key=? OR key LIKE ?').iterate(`run:${row.local_id}`, `runHistory:${row.local_id}:%`) as Iterable<{ value: string }>) {
        const run = JSON.parse(fact.value);
        const origin = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`syncRunTarget:${run.runId}`) as { value: string } | undefined;
        if (origin && JSON.parse(origin.value) !== targetId) runIds.push(run.runId);
      }
      for (const message of this.store.db.prepare('SELECT metadata FROM cowork_messages WHERE session_id=?').iterate(row.local_id) as Iterable<{ metadata: string | null }>) {
        let metadata: { remoteRunId?: string };
        try { metadata = JSON.parse(message.metadata || '{}'); } catch { continue; }
        if (!metadata.remoteRunId) continue;
        const origin = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`syncRunTarget:${metadata.remoteRunId}`) as { value: string } | undefined;
        if (origin && JSON.parse(origin.value) !== targetId) runIds.push(metadata.remoteRunId);
      }
      this.store.db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run(`syncTargetHistory:${row.local_id}`, stableJson({ targetId, runIds: [...new Set(runIds)] }));
    }
  }
  private claim(owner: RemoteOwner, targetId: string, verifiedStates: RetentionState[], previousId?: string): void {
    const environments = new Set(this.rows(owner).map(row => row.sync_environment).filter((value): value is string => value !== null));
    if (previousId) environments.add(previousId);
    const device = this.store.db.prepare('SELECT device_id FROM remote_sync_targets WHERE target_id=?').get(targetId) as { device_id: string };
    // Follow only a previously persisted account/device-specific acceptance chain, never a hostname list.
    for (const environment of [...environments]) {
      const accepted = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?')
        .get(`remoteEnvironmentAliases:${JSON.stringify([environment, owner.userId, owner.scopeKey, device.device_id])}`) as { value: string } | undefined;
      const aliases: unknown = accepted ? JSON.parse(accepted.value) : [];
      if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) throw new RemoteSyncStateError('Invalid persisted synchronization aliases');
      for (const alias of aliases as string[]) environments.add(alias);
    }
    if (previousId) for (const row of this.store.db.prepare('SELECT environment FROM remote_sync_target_aliases WHERE target_id=?').all(previousId) as Array<{ environment: string }>) environments.add(row.environment);
    for (const environment of environments) this.store.db.prepare('INSERT OR IGNORE INTO remote_sync_target_aliases VALUES (?,?)').run(targetId, environment);
    migrateVerifiedRemoteTargetFileRouting(this.store, { owner, deviceId: device.device_id, targetId, legacyEnvironments: [...environments] });
    this.store.db.prepare(`UPDATE remote_sync SET sync_environment=? WHERE local_id IN (${ownSessions})`).run(targetId, owner.userId, owner.scopeKey);
    for (const environment of environments) for (const prefix of ['projectionMode:', 'questionProjectionMode:projectionMode:', 'retentionFence:']) {
      const sourceKey = `${prefix}${JSON.stringify([environment, owner.userId, owner.scopeKey, device.device_id])}`;
      const targetKey = `${prefix}${JSON.stringify([targetId, owner.userId, owner.scopeKey, device.device_id])}`;
      const source = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(sourceKey) as { value: string } | undefined;
      if (!source) continue;
      const destination = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(targetKey) as { value: string } | undefined;
      if (destination && destination.value !== source.value) throw new RemoteSyncStateError('Conflicting synchronization protocol state');
      this.store.db.prepare('INSERT OR IGNORE INTO remote_state VALUES (?,?)').run(targetKey, source.value);
    }
    const suffix = `${owner.userId}:${owner.scopeKey}`;
    for (const prefix of accountKeys) for (const end of prefix === 'agentCatalogFailure' ? ['', `:${device.device_id}`] : ['']) {
      const keys = [...(previousId ? [`${prefix}:${previousId}:${suffix}${end}`] : []), `${prefix}:${suffix}${end}`];
      const source = keys.map(key => this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined).find(Boolean);
      if (source) this.store.db.prepare('INSERT OR IGNORE INTO remote_state VALUES (?,?)').run(`${prefix}:${targetId}:${suffix}${end}`, source.value);
    }
    for (const environment of environments) for (const prefix of ['deviceConnection', 'deletionCapability']) for (const end of ['', ':supported']) {
      this.store.db.prepare('INSERT OR IGNORE INTO remote_state SELECT ?,value FROM remote_state WHERE key=?')
        .run(`${prefix}:${targetId}:${suffix}${end}`, `${prefix}:${environment}:${suffix}${end}`);
    }
    if (previousId) {
      const move = (source: StateRow, key: string, value: string): void => {
        const existing = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined;
        if (key !== source.key && existing && existing.value !== value) throw new RemoteSyncStateError('Conflicting synchronization operation routing');
        this.store.db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run(key, value);
        if (key !== source.key) this.store.db.prepare('DELETE FROM remote_state WHERE key=?').run(source.key);
      };
      for (const row of this.state()) if (row.key.startsWith('inbox:') || row.key.startsWith('syncRunTarget:')) {
        const value = JSON.parse(row.value);
        if (row.key.startsWith('inbox:') ? value.targetId === previousId && sameOwner(value.owner, owner) : value === previousId) {
          if (typeof value === 'object') value.targetId = targetId;
          const key = row.key.startsWith(`inbox:${previousId}:`) ? `inbox:${targetId}:${row.key.slice(`inbox:${previousId}:`.length)}` : row.key;
          move(row, key, stableJson(typeof value === 'object' ? value : targetId));
        }
      }
      for (const row of this.state()) if (row.key.startsWith(`inputOperation:${previousId}:`)) {
        move(row, `inputOperation:${targetId}:${row.key.slice(`inputOperation:${previousId}:`.length)}`, row.value);
      } else if (row.key.startsWith('inputFence:') && this.rows(owner).some(session => row.key === `inputFence:${session.local_id}`)) {
        const value = JSON.parse(row.value);
        if (value.syncTargetId === previousId) move(row, row.key, stableJson({ ...value, syncTargetId: targetId }));
      }
    }
    this.tagExecution(owner, targetId, new Set(verifiedStates.map(state => state.localSessionId)));
    migrateVerifiedRemoteTargetCatalogRouting(this.store, { owner, deviceId: device.device_id, targetId, legacyEnvironments: [...environments] });
  }
  private activateInternal(input: { owner: RemoteOwner; deviceId: string; targetId: string; syncTarget: RemoteSyncTargetIdentity | null; bootstrap?: boolean; legacyStates?: RetentionState[] }): RemoteSyncTargetActivationResult {
    if (!input.deviceId || !input.owner.userId || !input.owner.scopeKey) throw new RemoteSyncStateError('Synchronization target requires an authenticated device and owner');
    return this.store.db.transaction(() => {
      const active = this.active(input.owner), rows = this.rows(input.owner);
      if (active?.targetId === input.targetId) {
        this.register(input);
        return { ...active, kind: RemoteSyncTargetActivationKind.Unchanged };
      }
      const known = this.store.db.prepare('SELECT * FROM remote_sync_targets WHERE target_id=?').get(input.targetId) as Row | undefined;
      const changedGeneration = input.syncTarget && this.store.db.prepare(`SELECT 1 FROM remote_sync_targets WHERE owner_user_id=? AND owner_scope_key=?
        AND json_extract(sync_target_json,'$.dataSpaceId')=? AND json_extract(sync_target_json,'$.dataGeneration')<>?`).get(
        input.owner.userId, input.owner.scopeKey, input.syncTarget.dataSpaceId, input.syncTarget.dataGeneration);
      if (changedGeneration) throw new RemoteSyncStateError('Synchronization data generation requires recovery');
      const claim = !known && !active?.syncTarget && this.canClaim(rows, input.deviceId, input.legacyStates || []);
      if (!claim && !known && (!input.bootstrap || !input.syncTarget || !active?.syncTarget)) throw new RemoteSyncStateError('Synchronization history requires verified state before binding');
      this.register(input);
      let kind: RemoteSyncTargetActivationResult['kind'];
      if (claim) {
        this.claim(input.owner, input.targetId, input.legacyStates || [], active?.targetId);
        kind = RemoteSyncTargetActivationKind.Claimed;
      } else {
        const priorId = active?.targetId || `legacy:${payloadHash([input.owner.userId, input.owner.scopeKey, 'unconfirmed'])}`;
        if (!active && rows.length) this.register({ owner: input.owner, targetId: priorId, deviceId: '', syncTarget: null });
        this.tagExecution(input.owner, priorId);
        if (active || rows.length) this.archive(priorId, input.owner);
        this.clear(input.owner);
        if (known) { this.restore(input.targetId, input.owner); kind = RemoteSyncTargetActivationKind.Restored; }
        else { kind = RemoteSyncTargetActivationKind.Created; }
        const available = this.store.db.prepare(`SELECT o.session_id FROM cowork_session_ownership o JOIN cowork_sessions s ON s.id=o.session_id
          WHERE o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'
          AND NOT EXISTS(SELECT 1 FROM remote_state WHERE key='localGcDeleted:'||o.session_id OR key='deletionClosed:'||o.session_id)`).all(input.owner.userId, input.owner.scopeKey) as Array<{ session_id: string }>;
        for (const row of available) this.store.db.prepare('INSERT OR IGNORE INTO remote_sync(local_id,session_id,device_id,sync_environment) VALUES (?,?,?,?)')
          .run(row.session_id, randomUUID(), input.deviceId, input.targetId);
        this.store.db.prepare(`UPDATE remote_sync SET needs_snapshot=1 WHERE local_id IN (${ownSessions})`).run(input.owner.userId, input.owner.scopeKey);
      }
      this.history(input.owner, input.targetId);
      materializeRemotePreparedInputSources(this.store, input.owner, input.deviceId);
      for (const row of this.rows(input.owner)) for (const table of ['remote_dirty', 'remote_content_dirty']) this.store.db.prepare(`INSERT OR IGNORE INTO ${table} VALUES (?)`).run(row.local_id);
      const epoch = (active?.epoch || 0) + 1;
      this.store.db.prepare('INSERT OR REPLACE INTO remote_sync_target_active VALUES (?,?,?,?)').run(input.owner.userId, input.owner.scopeKey, input.targetId, epoch);
      return { owner: { ...input.owner }, deviceId: input.deviceId, targetId: input.targetId, syncTarget: input.syncTarget, epoch, kind };
    })();
  }
}
