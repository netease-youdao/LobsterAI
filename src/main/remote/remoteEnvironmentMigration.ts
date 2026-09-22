import { createHash } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { DeletionTarget } from '../../shared/remote/deletions';
import { RemoteEnvironment, sameRemoteEnvironment } from '../../shared/remote/environment';
import { RemoteRetention } from '../../shared/remote/retention';
import { parseRemoteSyncTarget } from '../../shared/remote/syncTarget';
import { payloadHash, stableJson } from './canonical';
import type { RemoteStore } from './remoteStore';

const StatePrefix = {
  Projection: 'projectionMode:',
  Questions: 'questionProjectionMode:projectionMode:',
  RetentionFence: 'retentionFence:',
  Connection: 'deviceConnection:',
  DeletionCapability: 'deletionCapability:',
  FileOutput: 'fileOutput:',
  DesktopAsset: 'desktopAsset:',
  FileBoundary: 'fileTerminalBoundary:',
  LocalDeletion: 'localGcDeleted:',
  Import: 'import:',
  SyncFailure: 'syncFailure:',
  EnvironmentAliases: 'remoteEnvironmentAliases:',
} as const;

interface MigrationContext {
  owner: RemoteOwner;
  deviceId: string;
  environment: RemoteEnvironment;
  /** Only historical API addresses already classified into this client's mode. */
  legacyEnvironments: readonly string[];
}

interface MigrationResult {
  sessions: number;
  stateRecords: number;
  admissions: number;
  collisions: number;
}

interface StateRow { key: string; value: string }
interface SessionRow { local_id: string; session_id: string; sync_environment: string | null }
interface VerifiedTargetContext { owner: RemoteOwner; deviceId: string; targetId: string; legacyEnvironments: readonly string[] }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = (value: string): unknown => { try { return JSON.parse(value); } catch { return undefined; } };
const matchesOwner = (value: unknown, owner: RemoteOwner): boolean => record(value)
  && value.userId === owner.userId && value.scopeKey === owner.scopeKey;
const aliasesKey = (environment: RemoteEnvironment, identity: { owner: RemoteOwner; deviceId: string }): string =>
  `${StatePrefix.EnvironmentAliases}${JSON.stringify([environment, identity.owner.userId, identity.owner.scopeKey, identity.deviceId])}`;
const readAliases = (store: Pick<RemoteStore, 'db'>, environment: RemoteEnvironment, identity: { owner: RemoteOwner; deviceId: string }): string[] => {
  const row = store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(aliasesKey(environment, identity)) as { value: string } | undefined;
  const value = row && parse(row.value);
  return Array.isArray(value) && value.every(alias => typeof alias === 'string') ? value : [];
};

/** New deletion operations carry a data identity; their signed serviceScope remains unchanged. */
export function matchesRemoteDeletionTargetScope(store: Pick<RemoteStore, 'db'>, target: DeletionTarget, environment: string): boolean {
  if (target.syncTarget === undefined) return samePersistedRemoteEnvironment(store, { owner: target, deviceId: target.deviceId }, environment, target.serviceScope);
  const identity = parseRemoteSyncTarget(target.syncTarget);
  if (!identity || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_sync_targets'").get()) return false;
  const registered = store.db.prepare(`SELECT sync_target_json FROM remote_sync_targets
    WHERE target_id=? AND owner_user_id=? AND owner_scope_key=? AND device_id=?`)
    .get(environment, target.userId, target.scopeKey, target.deviceId) as { sync_target_json: string | null } | undefined;
  return !!registered?.sync_target_json && stableJson(identity) === stableJson(parse(registered.sync_target_json));
}

/** Compare immutable legacy proof scopes using only aliases accepted for this account/device. */
export function samePersistedRemoteEnvironment(store: Pick<RemoteStore, 'db'>, identity: { owner: RemoteOwner; deviceId: string }, left: string, right: string): boolean {
  const hasTargets = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_sync_targets'").get();
  const isTarget = (value: string): boolean => /^(?:[a-f0-9]{64}|legacy:[a-f0-9]{64})$/u.test(value)
    || hasTargets && !!store.db.prepare('SELECT 1 FROM remote_sync_targets WHERE target_id=?').get(value);
  if (isTarget(left) || isTarget(right)) {
    if (!hasTargets) return false;
    const targetId = isTarget(left) ? left : right, environment = targetId === left ? right : left;
    const target = store.db.prepare(`SELECT 1 FROM remote_sync_targets
      WHERE target_id=? AND owner_user_id=? AND owner_scope_key=? AND device_id=?`)
      .get(targetId, identity.owner.userId, identity.owner.scopeKey, identity.deviceId);
    if (!target) return false;
    return environment === targetId || !!store.db.prepare('SELECT 1 FROM remote_sync_target_aliases WHERE target_id=? AND environment=?')
      .get(targetId, environment);
  }
  if (sameRemoteEnvironment(left, right)) return true;
  const modes = Object.values(RemoteEnvironment);
  const aliases = new Map(modes.map(mode => [mode, readAliases(store, mode, identity)]));
  const resolve = (value: string): RemoteEnvironment | undefined => {
    const known = modes.find(mode => sameRemoteEnvironment(value, mode));
    if (known) return known;
    const accepted = modes.filter(mode => aliases.get(mode)!.includes(value));
    // A custom address used in both modes does not establish which immutable proof it names.
    return accepted.length === 1 ? accepted[0] : undefined;
  };
  const a = resolve(left), b = resolve(right);
  return a !== undefined && a === b;
}

/** Called only after a server state proof has claimed these legacy streams for the target. */
export function migrateVerifiedRemoteTargetFileRouting(store: Pick<RemoteStore, 'db'>, context: VerifiedTargetContext): void {
  const aliases = new Set(context.legacyEnvironments.filter(value => value && value !== context.targetId));
  if (!aliases.size) return;
  store.db.transaction(() => {
    const sessions = (store.db.prepare(`SELECT s.local_id,s.session_id,s.sync_environment FROM remote_sync s
      JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=? AND s.device_id=?`)
      .all(context.owner.userId, context.owner.scopeKey, context.deviceId) as SessionRow[])
      .filter(row => row.sync_environment === context.targetId || row.sync_environment !== null && aliases.has(row.sync_environment));
    const byId = new Map(sessions.map(row => [row.local_id, row]));
    const filePrefix = `${StatePrefix.FileOutput}${createHash('sha256')
      .update(JSON.stringify([context.targetId, context.owner, context.deviceId])).digest('hex')}:`;
    for (const prefix of [StatePrefix.FileOutput, StatePrefix.DesktopAsset, StatePrefix.FileBoundary]) {
      const rows = store.db.prepare('SELECT key,value FROM remote_state WHERE key>=? AND key<?').all(prefix, `${prefix}\uffff`) as StateRow[];
      for (const row of rows) {
        const value = parse(row.value);
        if (!record(value) || typeof value.environment !== 'string' || !aliases.has(value.environment)
          || !matchesOwner(value.owner, context.owner) || value.deviceId !== context.deviceId) continue;
        const localId = prefix === StatePrefix.FileBoundary ? row.key.slice(prefix.length).split(':')[0] : value.localSessionId;
        const session = typeof localId === 'string' ? byId.get(localId) : undefined;
        if (!session || value.sessionId !== undefined && value.sessionId !== session.session_id) continue;
        let destination = row.key;
        if (prefix === StatePrefix.FileOutput) {
          if (typeof value.localArtifactId !== 'string' || !/^fileOutput:[a-f0-9]{64}:/u.test(row.key)
            || row.key.slice(row.key.indexOf(':', prefix.length) + 1) !== `${localId}:${value.localArtifactId}`) continue;
          destination = `${filePrefix}${localId}:${value.localArtifactId}`;
        }
        const serialized = stableJson({ ...value, environment: context.targetId });
        const existing = store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(destination) as { value: string } | undefined;
        if (destination !== row.key && existing && stableJson(parse(existing.value)) !== serialized) {
          throw new Error('Remote target file routing conflict');
        }
        store.db.prepare('INSERT INTO remote_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run(destination, serialized);
        if (destination !== row.key) store.db.prepare('DELETE FROM remote_state WHERE key=?').run(row.key);
      }
    }
  })();
}

/** Preserve immutable catalog publications and already consumed inputs after a verified legacy claim. */
export function migrateVerifiedRemoteTargetCatalogRouting(store: Pick<RemoteStore, 'db'>, context: VerifiedTargetContext): void {
  const aliases = new Set(context.legacyEnvironments.filter(value => value && value !== context.targetId));
  const identity = [context.owner.userId, context.owner.scopeKey, context.deviceId];
  store.db.transaction(() => {
    const read = store.db.prepare('SELECT value FROM remote_state WHERE key=?');
    const write = store.db.prepare('INSERT OR IGNORE INTO remote_state(key,value) VALUES (?,?)');
    const copy = (destination: string, value: string): void => {
      const existing = read.get(destination) as { value: string } | undefined;
      if (existing && stableJson(parse(existing.value)) !== stableJson(parse(value))) throw new Error('Remote target catalog routing conflict');
      write.run(destination, value);
    };
    for (const prefix of ['inputModels:', 'agentCatalog:', 'agentWorkspaces:']) {
      const rows = store.db.prepare('SELECT key,value FROM remote_state WHERE key>=? AND key<?').all(prefix, `${prefix}\uffff`) as StateRow[];
      const candidates = new Map<string, { explicit: StateRow[]; unscoped: StateRow[] }>();
      for (const row of rows) {
        const key = parse(row.key.slice(prefix.length));
        if (!Array.isArray(key) || !key.every(value => typeof value === 'string')) continue;
        const length = prefix === 'agentWorkspaces:' ? 4 : 3;
        const scoped = key.length === length + 1 && aliases.has(key[0]);
        const parts = scoped ? key.slice(1) : key;
        if ((!scoped && key.length !== length) || !identity.every((part, index) => parts[index] === part)) continue;
        const destination = `${prefix}${JSON.stringify([context.targetId, ...parts])}`;
        const group = candidates.get(destination) || { explicit: [], unscoped: [] };
        group[scoped ? 'explicit' : 'unscoped'].push(row); candidates.set(destination, group);
      }
      for (const [destination, group] of candidates) {
        // A precise scoped cache wins over an older unscoped cache. Neither original is removed.
        for (const row of group.explicit.length ? group.explicit : group.unscoped) copy(destination, row.value);
      }
    }
    const inputs = store.db.prepare('SELECT key,value FROM remote_state WHERE key>=? AND key<?')
      .all('inputPreparation:', 'inputPreparation:\uffff') as StateRow[];
    for (const row of inputs) {
      const prepared = parse(row.value);
      if (!record(prepared) || !matchesOwner(prepared.owner, context.owner) || prepared.deviceId !== context.deviceId
        || typeof prepared.preparationId !== 'string' || typeof prepared.boundCommandId !== 'string'
        || typeof prepared.inputDigest !== 'string' || prepared.cacheCleanup) continue;
      const sourceTarget = prepared.targetId ?? prepared.environment;
      if (sourceTarget !== undefined && sourceTarget !== context.targetId && (typeof sourceTarget !== 'string' || !aliases.has(sourceTarget))) continue;
      const commandRows = [read.get(`inbox:${context.targetId}:${prepared.boundCommandId}`), read.get(`inbox:${prepared.boundCommandId}`)] as Array<{ value: string } | undefined>;
      const consumed = commandRows.some(saved => {
        const entry = saved && parse(saved.value);
        if (!record(entry) || entry.targetId !== context.targetId || !matchesOwner(entry.owner, context.owner) || !record(entry.command)) return false;
        const request = entry.command.request;
        if (!record(request) || !record(request.payload) || request.payload.resolvedInput === undefined) return false;
        return entry.command.commandId === prepared.boundCommandId && request.payload.inputPreparationId === prepared.preparationId
          && request.payload.inputDigest === prepared.inputDigest && payloadHash(request.payload.resolvedInput) === prepared.inputDigest;
      });
      if (consumed) copy(`inputPreparation:${JSON.stringify([context.targetId, prepared.preparationId])}`,
        stableJson({ ...prepared, targetId: context.targetId }));
    }
  })();
}

/**
 * Rename mutable local routing metadata after the account/device have been verified.
 * Source events, ACKs, import bodies/hashes and deletion/journal evidence are untouched.
 */
export function migrateRemoteEnvironment(store: Pick<RemoteStore, 'db'>, context: MigrationContext): MigrationResult {
  const { db } = store;
  const aliases = new Set(context.legacyEnvironments.filter(value => value && value !== context.environment));
  const result: MigrationResult = { sessions: 0, stateRecords: 0, admissions: 0, collisions: 0 };
  if (!aliases.size || !context.deviceId) return result;
  return db.transaction(() => {
    const read = db.prepare('SELECT key,value FROM remote_state WHERE key=?');
    const write = db.prepare('INSERT INTO remote_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const remove = db.prepare('DELETE FROM remote_state WHERE key=?');
    const previousAliases = readAliases(store, context.environment, context);
    const acceptedAliases = [...new Set([...previousAliases, ...aliases])].sort();
    if (stableJson(previousAliases) !== stableJson(acceptedAliases)) {
      write.run(aliasesKey(context.environment, context), stableJson(acceptedAliases));
      result.stateRecords++;
    }
    const relocate = (row: StateRow, destination: string, value = row.value): void => {
      const existing = read.get(destination) as StateRow | undefined;
      if (destination !== row.key && existing) {
        const previous = parse(existing.value), next = parse(value);
        if (previous === undefined || next === undefined || stableJson(previous) !== stableJson(next)) {
          // Never replace a different pending request or file publication with an older alias.
          result.collisions++;
          return;
        }
      }
      write.run(destination, value);
      if (destination !== row.key) remove.run(row.key);
      result.stateRecords++;
    };

    const sessions = (db.prepare(`SELECT s.local_id,s.session_id,s.sync_environment FROM remote_sync s
      JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?
        AND (s.device_id=? OR s.device_id='')`).all(context.owner.userId, context.owner.scopeKey, context.deviceId) as SessionRow[])
      .filter(row => row.sync_environment === null || row.sync_environment === context.environment || aliases.has(row.sync_environment));
    const byId = new Map(sessions.map(row => [row.local_id, row]));
    for (const session of sessions) {
      if (!session.sync_environment || !aliases.has(session.sync_environment)) continue;
      db.prepare('UPDATE remote_sync SET sync_environment=? WHERE local_id=?').run(context.environment, session.local_id);
      result.sessions++;
      const key = `${StatePrefix.SyncFailure}${session.local_id}`;
      const failure = read.get(key) as StateRow | undefined;
      const value = failure && parse(failure.value);
      if (record(value) && value.blocked === true && value.reason === RemoteRetention.StateConflict) {
        // Re-run the ordinary protocol checks; this is not an acknowledgement or a repair receipt.
        remove.run(key);
        result.stateRecords++;
      }
    }

    for (const alias of aliases) {
      for (const prefix of [StatePrefix.Projection, StatePrefix.Questions, StatePrefix.RetentionFence]) {
        const key = `${prefix}${JSON.stringify([alias, context.owner.userId, context.owner.scopeKey, context.deviceId])}`;
        const row = read.get(key) as StateRow | undefined;
        if (row) relocate(row, `${prefix}${JSON.stringify([context.environment, context.owner.userId, context.owner.scopeKey, context.deviceId])}`);
      }
      for (const [prefix, suffix] of [[StatePrefix.Connection, ''], [StatePrefix.Connection, ':supported'], [StatePrefix.DeletionCapability, '']]) {
        const ownerKey = `${context.owner.userId}:${context.owner.scopeKey}${suffix}`;
        const row = read.get(`${prefix}${alias}:${ownerKey}`) as StateRow | undefined;
        if (row) relocate(row, `${prefix}${context.environment}:${ownerKey}`);
      }
    }

    const filePrefix = `${StatePrefix.FileOutput}${createHash('sha256')
      .update(JSON.stringify([context.environment, context.owner, context.deviceId])).digest('hex')}:`;
    for (const prefix of [StatePrefix.FileOutput, StatePrefix.DesktopAsset, StatePrefix.FileBoundary, StatePrefix.LocalDeletion, StatePrefix.Import]) {
      const rows = db.prepare('SELECT key,value FROM remote_state WHERE key>=? AND key<?').all(prefix, `${prefix}\uffff`) as StateRow[];
      for (const row of rows) {
        const value = parse(row.value);
        if (!record(value) || typeof value.environment !== 'string' || !aliases.has(value.environment)) continue;
        const localId = prefix === StatePrefix.Import || prefix === StatePrefix.LocalDeletion ? row.key.slice(prefix.length)
          : prefix === StatePrefix.FileBoundary ? row.key.slice(prefix.length).split(':')[0] : value.localSessionId;
        const session = typeof localId === 'string' ? byId.get(localId) : undefined;
        if (!session || (value.owner !== undefined ? !matchesOwner(value.owner, context.owner) : prefix !== StatePrefix.Import)
          || value.deviceId !== undefined && value.deviceId !== context.deviceId
          || value.sessionId !== undefined && value.sessionId !== session.session_id) continue;
        let destination = row.key;
        if (prefix === StatePrefix.FileOutput) {
          if (typeof value.localArtifactId !== 'string' || !/^fileOutput:[a-f0-9]{64}:/u.test(row.key)
            || row.key.slice(row.key.indexOf(':', prefix.length) + 1) !== `${localId}:${value.localArtifactId}`) continue;
          destination = `${filePrefix}${localId}:${value.localArtifactId}`;
        }
        // An import's environment is not part of its manifest or upload body. A GC tombstone's
        // completion receipt is immutable: change only the outer local routing field.
        relocate(row, destination, stableJson({ ...value, environment: context.environment }));
      }
    }

    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ownership_association_operations'").get()) {
      const receipts = db.prepare(`SELECT operation_id,remote_admissions_json FROM ownership_association_operations
        WHERE owner_user_id=? AND owner_scope_key=?`).all(context.owner.userId, context.owner.scopeKey) as Array<{ operation_id: string; remote_admissions_json: string }>;
      const canonicalKey = payloadHash({ owner: context.owner, environment: context.environment, deviceId: context.deviceId });
      for (const receipt of receipts) {
        const admissions = parse(receipt.remote_admissions_json);
        if (!record(admissions) || Object.hasOwn(admissions, canonicalKey)) continue;
        const admitted = [...aliases].map(environment => admissions[payloadHash({ owner: context.owner, environment, deviceId: context.deviceId })])
          .find(value => record(value) && typeof value.admittedAt === 'number' && typeof value.capability === 'string');
        if (!admitted) continue;
        db.prepare('UPDATE ownership_association_operations SET remote_admissions_json=? WHERE operation_id=?')
          .run(stableJson({ ...admissions, [canonicalKey]: admitted }), receipt.operation_id);
        result.admissions++;
      }
    }
    return result;
  })();
}
