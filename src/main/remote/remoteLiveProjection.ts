import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import { payloadHash, sameOwner, stableJson } from './canonical';
import { type ArtifactProjectionJob, projectRemoteArtifacts } from './remoteArtifactProjection';
import { isPublicReplyMessage, redactReplyText, replyBlocks, replyToolState } from './remoteReplyProjection';

export interface LiveProjectionInput { database: string; localId: string; sessionId: string; deviceId: string; owner: RemoteOwner; objectId: string; revision: string; objectKind?: 'message' | 'tool'; environment?: string }
export interface LiveProjection { objectKind: 'message' | 'tool'; objectId: string; sourceObjectRevision: string; representation: 'complete' | 'desktop_only'; payloadHash: string; payload: Record<string, any> }
/** Read one bounded source object. No historic projection, outbox or NOS is consulted. */
export function projectLiveMessage(db: Database.Database, input: LiveProjectionInput): LiveProjection | null {
  return db.transaction((): LiveProjection | null => {
    const owner = db.prepare('SELECT owner_user_id,owner_scope_key,ownership_status FROM cowork_session_ownership WHERE session_id=?').get(input.localId) as any;
    const binding = db.prepare('SELECT session_id,device_id,migration_frozen FROM remote_sync WHERE local_id=?').get(input.localId) as any;
    if (!owner || owner.ownership_status !== 'confirmed' || !sameOwner({ userId: owner.owner_user_id, scopeKey: owner.owner_scope_key }, input.owner)
      || !binding || binding.session_id !== input.sessionId || binding.device_id !== input.deviceId || binding.migration_frozen) throw new Error('REMOTE_LIVE_OWNER_CHANGED');
    if (input.objectKind === 'tool') return projectLiveTool(db, input);
    const revision = db.prepare('SELECT revision,deleted FROM remote_live_revisions WHERE session_id=? AND object_id=?').get(input.localId, input.objectId) as { revision: number; deleted: number } | undefined;
    if (!revision || revision.deleted || String(revision.revision) !== input.revision) return null;
    const row = db.prepare(`SELECT id,session_id,type,created_at,sequence,
      length(CAST(content AS BLOB)) AS content_bytes,length(CAST(metadata AS BLOB)) AS metadata_bytes,
      CASE WHEN length(CAST(content AS BLOB))<=131072 THEN content ELSE '' END AS content,
      CASE WHEN length(CAST(metadata AS BLOB))<=32768 THEN metadata ELSE NULL END AS metadata
      FROM cowork_messages WHERE session_id=? AND id=?`).get(input.localId, input.objectId) as any;
    if (!row || !['user', 'assistant', 'system', 'tool_use', 'tool_result'].includes(row.type)) return null;
    if (row.metadata_bytes > 32768) throw new Error('REMOTE_LIVE_METADATA_BUDGET');
    const metadata = JSON.parse(row.metadata || '{}');
    if (!isPublicReplyMessage(row)) return null;
    const readState = (key: string): any => {
      const value = db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined;
      return value ? JSON.parse(value.value) : null;
    };
    const foreign = new Set(readState(`syncTargetHistory:${input.localId}`)?.runIds || []);
    const runId = metadata.remoteRunId && !foreign.has(metadata.remoteRunId) ? metadata.remoteRunId : null;
    if (runId && readState(`runPublished:${runId}`) === false) return null;
    let content = redactReplyText(row.content || '');
    let prepared: any = null, desktop: any = null;
    if (row.type === 'user' && runId) {
      prepared = readState(`inputRun:${runId}`);
      desktop = readState(`desktopInputRun:${runId}`);
      if (prepared) content = redactReplyText(prepared.input.text);
      else if (desktop && sameOwner(desktop.owner, input.owner)) content = redactReplyText(desktop.text);
    }
    const blocks: Record<string, any>[] = replyBlocks({ ...row, content }, metadata);
    if (row.type === 'user' && prepared) for (const asset of prepared.input.attachments || []) blocks.push({ type: 'attachment',
      assetId: asset.assetId, version: asset.version, name: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, availability: 'ready', intent: asset.intent });
    if (row.type === 'user' && desktop && sameOwner(desktop.owner, input.owner)) for (const [index, source] of (desktop.attachments || []).entries()) {
      const job = readState(`desktopAsset:${row.id}:${index}`);
      if (job?.availability === 'ready' && job.uploadedAsset && job.environment === input.environment) {
        const asset = job.uploadedAsset; blocks.push({ type: 'attachment', assetId: asset.assetId, version: asset.version, name: asset.fileName,
          mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, availability: 'ready', intent: asset.intent });
      } else blocks.push({ type: 'artifact', artifactId: job?.uploadRequestId || payloadHash([row.id,index]), name: source.fileName,
        mimeType: source.mimeType, sizeBytes: source.sizeBytes, availability: 'desktop_only' });
    }
    blocks.push(...liveArtifactBlocks(db, input, row.id));
    const originalBytes = Buffer.byteLength(stableJson(blocks));
    const omitted = row.content_bytes > 131072 || originalBytes > 48 * 1024;
    const payload: Record<string, any> = {
      messageId: row.id, ordinal: String(Math.max(1, row.sequence || 1)), runId,
      commandId: runId ? metadata.remoteCommandId || null : null,
      role: row.type.startsWith('tool_') ? 'tool' : row.type === 'system' ? 'notice' : row.type, status: metadata.isStreaming ? 'streaming' : 'complete',
      createdAt: new Date(row.created_at).toISOString(), projectionVersion: 4,
      displayOrdinal: String(Math.max(1, row.sequence || 1)), contentState: omitted ? 'desktop_only' : 'complete',
      preview: Buffer.from(content).subarray(0, 1000).toString('utf8').replace(/\uFFFD$/u, ''),
      originalContentBytes: String(omitted && row.content_bytes > 131072 ? row.content_bytes : originalBytes),
      blocks: omitted ? [] : blocks,
      ...(omitted ? { contentUnavailableReason: 'CONTENT_LIMIT_EXCEEDED' } : {}),
    };
    return { objectKind: 'message', objectId: row.id, sourceObjectRevision: input.revision,
      representation: omitted ? 'desktop_only' : 'complete', payloadHash: payloadHash(payload), payload };
  })();
}

function projectLiveTool(db: Database.Database, input: LiveProjectionInput): LiveProjection | null {
  const revision = db.prepare('SELECT revision FROM remote_live_tools WHERE session_id=? AND tool_id=?').get(input.localId, input.objectId) as { revision: number } | undefined;
  if (!revision || String(revision.revision) !== input.revision) return null;
  const rows = db.prepare(`SELECT m.id,m.type,m.created_at,m.sequence,
    CASE WHEN length(CAST(m.metadata AS BLOB))<=32768 THEN m.metadata ELSE NULL END AS metadata
    FROM remote_live_tool_sources t JOIN cowork_messages m ON m.id=t.message_id AND m.session_id=t.session_id
    WHERE t.session_id=? AND t.tool_id=? ORDER BY m.sequence DESC LIMIT 16`).all(input.localId, input.objectId) as any[];
  if (!rows.length) return null;
  const latest = rows[0];
  if (!latest.metadata) throw new Error('REMOTE_LIVE_METADATA_BUDGET');
  const metadata = JSON.parse(latest.metadata);
  let name = metadata.toolName;
  if (!name) for (const row of rows.slice(1)) { name = JSON.parse(row.metadata || '{}').toolName; if (name) break; }
  if (typeof name !== 'string' || !name) throw new Error('REMOTE_LIVE_TOOL_IDENTITY_MISSING');
  const read = (key: string): any => { const row = db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : null; };
  const runId = metadata.remoteRunId || null;
  if (runId && (read(`runPublished:${runId}`) === false || (read(`syncTargetHistory:${input.localId}`)?.runIds || []).includes(runId))) return null;
  const status = replyToolState(latest.type, metadata);
  const payload: Record<string, any> = { toolCallId: input.objectId, runId, name: redactReplyText(name).slice(0, 128).replace(/[\uD800-\uDBFF]$/u, ''),
    status, summary: '', startedAt: new Date(rows.at(-1).created_at).toISOString(),
    finishedAt: ['succeeded','failed','cancelled'].includes(status) ? new Date(latest.created_at).toISOString() : null, error: null };
  return { objectKind: 'tool', objectId: input.objectId, sourceObjectRevision: input.revision, representation: 'complete', payloadHash: payloadHash(payload), payload };
}

function liveArtifactBlocks(db: Database.Database, input: LiveProjectionInput, messageId: string): Record<string, unknown>[] {
  if (!input.environment) return [];
  const prefix = `fileOutput:${createHash('sha256').update(JSON.stringify([input.environment,input.owner,input.deviceId])).digest('hex')}:${input.localId}:`;
  const jobs = db.prepare('SELECT value FROM remote_state WHERE key>=? AND key<? AND length(CAST(value AS BLOB))<=131072 LIMIT 64')
    .all(prefix,`${prefix}\uffff`) as Array<{ value: string }>;
  const projected: Array<{ localArtifactId: string; block: Record<string, unknown> }> = [];
  for (const row of jobs) {
    try {
      const job = JSON.parse(row.value) as ArtifactProjectionJob & { owner: RemoteOwner; environment: string; deviceId: string; localSessionId: string };
      if (sameOwner(job.owner,input.owner) && job.environment === input.environment && job.deviceId === input.deviceId && job.localSessionId === input.localId)
        projected.push(...projectRemoteArtifacts([job],messageId));
    } catch { /* One damaged file display never removes the message text. */ }
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_local_artifacts'").get()) {
    const local = db.prepare(`SELECT a.id,a.file_name,a.extension,a.size_bytes,a.availability FROM library_local_artifacts a
      JOIN library_artifact_sessions r ON r.artifact_id=a.id WHERE r.session_id=? AND r.last_message_id=? ORDER BY a.id LIMIT 64`)
      .all(input.localId,messageId) as any[];
    for (const item of local) if (!projected.some(value => value.localArtifactId === item.id)) projected.push({ localArtifactId: item.id, block: {
      type: 'artifact', artifactId: item.id, name: String(item.file_name).split(/[\\/]/u).at(-1)!.slice(0,128),
      mimeType: 'application/octet-stream', sizeBytes: Number.isSafeInteger(item.size_bytes) && item.size_bytes >= 0 ? String(item.size_bytes) : null,
      availability: item.availability === 'missing' ? 'missing' : 'desktop_only',
    } });
  }
  return projected.map(item => item.block);
}
