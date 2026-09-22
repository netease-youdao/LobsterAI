import { promises as fs } from 'fs';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { payloadHash, sameOwner } from './canonical';
import type { DesktopInputRun, DesktopInputSource } from './desktopInputMetadata';
import type { LocalPreparedInput } from './inputPreparationService';
import type { InboxEntry } from './remoteBridge';
import { captureRemoteFileSnapshot, type RemoteFileSnapshot } from './remoteFileSnapshots';
import type { RemoteStore } from './remoteStore';

type Store = Pick<RemoteStore, 'db'>;
export interface RemotePreparedInputSource { preparationKey: string; attachmentIndex: number; runId: string }
type PreparedSource = DesktopInputSource & { preparedSource: RemotePreparedInputSource };
const read = <T>(store: Store, key: string): T | null => {
  const row = store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as T : null; } catch { return null; }
};

/** This proof is local execution history, never authorization to replay an old command on another service. */
function resolve(store: Store, owner: RemoteOwner, localSessionId: string, messageId: string, fallbackDeviceId: string,
  reference?: RemotePreparedInputSource): { prepared: LocalPreparedInput; key: string; runId: string } | null {
  const message = store.db.prepare(`SELECT m.metadata FROM cowork_messages m JOIN cowork_session_ownership o ON o.session_id=m.session_id
    WHERE m.id=? AND m.session_id=? AND m.type='user' AND o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=?`)
    .get(messageId, localSessionId, owner.userId, owner.scopeKey) as { metadata: string } | undefined;
  let metadata: { remoteRunId?: string; remoteCommandId?: string };
  try { metadata = JSON.parse(message?.metadata || '{}'); } catch { return null; }
  if (!metadata.remoteRunId || reference && metadata.remoteRunId !== reference.runId) return null;
  const run = read<{ runId: string }>(store, `runHistory:${localSessionId}:${metadata.remoteRunId}`);
  if (run?.runId !== metadata.remoteRunId) return null;
  const origin = read<string>(store, `syncRunTarget:${run.runId}`);
  let commandId = metadata.remoteCommandId;
  let entry = commandId ? (origin ? read<InboxEntry>(store, `inbox:${origin}:${commandId}`) : null) || read<InboxEntry>(store, `inbox:${commandId}`) : null;
  if (!entry) {
    const candidates = store.db.prepare(`SELECT value FROM remote_state WHERE key>='inbox:' AND key<'inbox:\uffff'
      AND json_extract(value,'$.localSessionId')=? AND json_extract(value,'$.runId')=?
      AND json_extract(value,'$.owner.userId')=? AND json_extract(value,'$.owner.scopeKey')=?
      AND (json_extract(value,'$.targetId') IS ? OR json_extract(value,'$.targetId')=?)
      AND (? IS NULL OR json_extract(value,'$.command.commandId')=?) LIMIT 2`)
      .all(localSessionId, run.runId, owner.userId, owner.scopeKey, origin, origin, commandId || null, commandId || null) as Array<{ value: string }>;
    if (candidates.length !== 1) return null;
    entry = JSON.parse(candidates[0].value) as InboxEntry;
    commandId ||= entry.command.commandId;
  }
  if (!entry || !sameOwner(entry.owner, owner) || entry.localSessionId !== localSessionId || entry.runId !== run.runId
    || entry.command.commandId !== commandId || origin && entry.targetId !== origin) return null;
  const input = entry.command.request?.payload;
  if (typeof input?.inputPreparationId !== 'string' || typeof input.inputDigest !== 'string' || !input.resolvedInput
    || payloadHash(input.resolvedInput) !== input.inputDigest) return null;
  const original = read<{ input: unknown }>(store, `inputRun:${run.runId}`);
  if (!original || payloadHash(original.input) !== input.inputDigest) return null;
  const keys = reference ? [reference.preparationKey] : [
    ...(entry.targetId ? [`inputPreparation:${JSON.stringify([entry.targetId, input.inputPreparationId])}`] : []),
    `inputPreparation:${input.inputPreparationId}`,
  ];
  let deviceId = fallbackDeviceId;
  if (entry.targetId && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_sync_targets'").get()) {
    const target = store.db.prepare('SELECT device_id FROM remote_sync_targets WHERE target_id=? AND owner_user_id=? AND owner_scope_key=?')
      .get(entry.targetId, owner.userId, owner.scopeKey) as { device_id: string } | undefined;
    if (!target?.device_id) return null;
    deviceId = target.device_id;
  }
  for (const key of keys) {
    if (!key.startsWith('inputPreparation:')) continue;
    const prepared = read<LocalPreparedInput>(store, key);
    if (prepared && sameOwner(prepared.owner, owner) && prepared.deviceId === deviceId && prepared.boundCommandId === commandId
      && prepared.preparationId === input.inputPreparationId && prepared.inputDigest === input.inputDigest
      && payloadHash(prepared.resolvedInput) === input.inputDigest && !prepared.cacheCleanup
      && Array.isArray(prepared.files) && Array.isArray(prepared.resolvedInput.attachments)) return { prepared, key, runId: run.runId };
  }
  return null;
}

/** Supply worker projections with target-independent, proven local sources. No filesystem or network access occurs here. */
export function materializeRemotePreparedInputSources(store: Store, owner: RemoteOwner, fallbackDeviceId: string): number {
  let count = 0;
  let cursor = '';
  while (true) {
    const messages = store.db.prepare(`SELECT m.id,m.session_id FROM cowork_messages m JOIN cowork_session_ownership o ON o.session_id=m.session_id
      WHERE m.type='user' AND o.ownership_status='confirmed' AND o.owner_user_id=? AND o.owner_scope_key=? AND m.id>?
      ORDER BY m.id LIMIT 200`).all(owner.userId, owner.scopeKey, cursor) as Array<{ id: string; session_id: string }>;
    if (!messages.length) break;
    for (const message of messages) {
      const proof = resolve(store, owner, message.session_id, message.id, fallbackDeviceId);
      if (!proof) continue;
      const key = `desktopInputRun:${proof.runId}`, existing = read<DesktopInputRun & { localSessionId?: string }>(store, key);
      if (existing && (!sameOwner(existing.owner, owner) || existing.localSessionId && existing.localSessionId !== message.session_id || existing.attachments?.length)) continue;
      const attachments: PreparedSource[] = [];
      for (const [attachmentIndex, asset] of proof.prepared.resolvedInput.attachments.entries()) {
        const file = proof.prepared.files.find(item => item.assetId === asset.assetId && item.version === asset.version);
        if (!file?.identity || !/^[a-f0-9]{64}$/u.test(asset.sha256)) continue;
        attachments.push({ path: file.path, fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, intent: asset.intent,
          fileIdentity: { dev: file.identity.dev, ino: file.identity.ino, sizeBytes: String(file.identity.size), mtimeMs: file.identity.mtimeMs },
          preparedSource: { preparationKey: proof.key, attachmentIndex, runId: proof.runId } });
      }
      if (!attachments.length) continue;
      store.db.prepare('INSERT OR REPLACE INTO remote_state(key,value) VALUES (?,?)').run(key,
        JSON.stringify({ owner, localSessionId: message.session_id, text: proof.prepared.resolvedInput.text, attachments }));
      count++;
    }
    cursor = messages[messages.length - 1].id;
  }
  return count;
}

/** Each target uploads its own disposable copy; the sealed preparation remains usable when another target is activated. */
export async function capturePreparedInputSnapshot(store: Store, source: DesktopInputSource & {
  owner: RemoteOwner; localSessionId: string; messageId: string; preparedSource: RemotePreparedInputSource;
}, cacheRoot: string, deviceId: string, assertCurrent: () => void): Promise<RemoteFileSnapshot> {
  assertCurrent();
  const proof = resolve(store, source.owner, source.localSessionId, source.messageId, deviceId, source.preparedSource);
  const asset = proof?.prepared.resolvedInput.attachments[source.preparedSource.attachmentIndex];
  const file = asset && proof?.prepared.files.find(item => item.assetId === asset.assetId && item.version === asset.version);
  if (!proof || !asset || !file || file.path !== source.path || asset.fileName !== source.fileName || asset.mimeType !== source.mimeType
    || asset.intent !== source.intent || asset.sizeBytes !== source.sizeBytes) throw new Error(RemoteFileReason.Source);
  const check = async (): Promise<void> => {
    assertCurrent();
    const [stat, realPath] = await Promise.all([fs.lstat(file.path), fs.realpath(file.path)]);
    assertCurrent();
    const latest = resolve(store, source.owner, source.localSessionId, source.messageId, deviceId, source.preparedSource);
    if (!latest || payloadHash(latest.prepared) !== payloadHash(proof.prepared)) throw new Error(RemoteFileReason.Source);
    if (!stat.isFile() || stat.isSymbolicLink() || realPath !== file.identity.realPath || String(stat.dev) !== file.identity.dev
      || String(stat.ino) !== file.identity.ino || stat.size !== file.identity.size || stat.mtimeMs !== file.identity.mtimeMs) throw new Error(RemoteFileReason.Source);
  };
  await check();
  const snapshot = await captureRemoteFileSnapshot(file.path, cacheRoot, source.owner, Number(asset.sizeBytes), assertCurrent);
  try {
    await check();
    if (snapshot.sha256 !== asset.sha256 || snapshot.sizeBytes !== asset.sizeBytes) throw new Error(RemoteFileReason.Source);
    return snapshot;
  } catch (error) { await fs.rm(snapshot.path, { force: true }).catch((): void => undefined); throw error; }
}
