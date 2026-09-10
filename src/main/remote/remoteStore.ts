import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { REMOTE_MESSAGE_BYTES, type RemoteAgentSummary, type RemoteOwner, type RemoteRunStatusValue } from '../../shared/remote/constants';
import { payloadHash, remoteError, sameOwner, stableJson } from './canonical';

export interface ProjectionRecord { eventType: string; payload: Record<string, any> }
export interface RemoteEvent extends ProjectionRecord { eventId: string; sourceSeq: string; occurredAt: string }
export interface SyncRow {
  local_id: string; session_id: string; device_id: string; source_seq: number; ack_seq: number;
  server_seq: string; needs_snapshot: number;
}
export interface RemoteRun {
  runId: string; status: RemoteRunStatusValue; statusVersion: string;
  startedAt: string | null; finishedAt: string | null; error: ReturnType<typeof remoteError> | null;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const preview = (text: string): string => Buffer.from(text).subarray(0, 3000).toString('utf8').replace(/\uFFFD$/u, '');
const iso = (value: number): string => new Date(value).toISOString();
const publicMessage = (row: any): boolean => {
  if (!['user', 'assistant', 'tool_use', 'tool_result'].includes(row.type)) return false;
  try { return JSON.parse(row.metadata || '{}').isThinking !== true; } catch { return row.type === 'user'; }
};
const shortName = (value: unknown): string => String(value || '').slice(0, 128).replace(/[\uD800-\uDBFF]$/u, '');
const publicText = (value: unknown): string => String(value || '').replace(/<think(?:ing)?>[\s\S]*?(<\/think(?:ing)?>|$)/gi, '').replace(/(?:file|lobster-artifact):\/\/[^\s)]+/gi, '[desktop file]');

/** Native SQLite transactions commit synchronously; no deferred persistence is allowed here. */
export class RemoteStore {
  private depth = 0;
  private changeVersion = 0;
  private publishing = false;
  private artifactTracking = false;
  private advanceCheckpoint: (() => number) | null = null;
  private enabledOwner: RemoteOwner | null = null;
  private wake: () => void = () => undefined;
  private agentSummary: ((sessionId: string, owner: RemoteOwner) => RemoteAgentSummary | null) | null = null;

  constructor(readonly db: Database.Database) {
    // Set outside transactions. FULL makes inbox receipts/outbox ACK cleanup durable at COMMIT.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_write_context (id INTEGER PRIMARY KEY CHECK(id=1), trusted INTEGER NOT NULL);
      INSERT OR IGNORE INTO remote_write_context VALUES (1,0);
      CREATE TABLE IF NOT EXISTS cowork_session_ownership (
        session_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, owner_scope_key TEXT NOT NULL,
        ownership_status TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS remote_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_content_dirty (session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS remote_sync (
        local_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id TEXT NOT NULL DEFAULT '',
        source_seq INTEGER NOT NULL DEFAULT 0, ack_seq INTEGER NOT NULL DEFAULT 0,
        server_seq TEXT NOT NULL DEFAULT '0', needs_snapshot INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS remote_outbox (
        session_id TEXT NOT NULL, source_seq INTEGER NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(session_id,source_seq));
      CREATE TABLE IF NOT EXISTS remote_projection (
        session_id TEXT NOT NULL, object_key TEXT NOT NULL, hash TEXT NOT NULL,
        revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(session_id,object_key));
      CREATE TABLE IF NOT EXISTS remote_source_owner (source_id TEXT PRIMARY KEY, owner_json TEXT NOT NULL);
    `);
    for (const table of ['cowork_sessions', 'cowork_messages']) {
      const sid = table === 'cowork_sessions' ? 'id' : 'session_id';
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS remote_content_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN INSERT OR IGNORE INTO remote_content_dirty VALUES (${ref}.${sid}); END;
          CREATE TRIGGER IF NOT EXISTS remote_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
          INSERT OR IGNORE INTO remote_dirty VALUES (${ref}.${sid});
          UPDATE cowork_session_ownership SET ownership_status='quarantined'
          WHERE session_id=${ref}.${sid} AND (SELECT trusted FROM remote_write_context WHERE id=1)=0;
          END;`);
      }
    }
    this.artifactTracking = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='library_local_artifacts'").get();
    if (this.artifactTracking) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS remote_content_library_relation_${operation.toLowerCase()}
          AFTER ${operation} ON library_artifact_sessions BEGIN INSERT OR IGNORE INTO remote_content_dirty VALUES (${ref}.session_id); END;
          CREATE TRIGGER IF NOT EXISTS remote_content_library_artifact_${operation.toLowerCase()}
          AFTER ${operation} ON library_local_artifacts BEGIN
          INSERT OR IGNORE INTO remote_content_dirty SELECT session_id FROM library_artifact_sessions WHERE artifact_id=${ref}.id; END;
          CREATE TRIGGER IF NOT EXISTS remote_library_relation_${operation.toLowerCase()}
          AFTER ${operation} ON library_artifact_sessions BEGIN
          INSERT OR IGNORE INTO remote_dirty SELECT ${ref}.session_id WHERE EXISTS
            (SELECT 1 FROM cowork_session_ownership WHERE session_id=${ref}.session_id AND ownership_status='confirmed'); END;
          CREATE TRIGGER IF NOT EXISTS remote_library_artifact_${operation.toLowerCase()}
          AFTER ${operation} ON library_local_artifacts BEGIN
          INSERT OR IGNORE INTO remote_dirty SELECT r.session_id FROM library_artifact_sessions r
            JOIN cowork_session_ownership o ON o.session_id=r.session_id
            WHERE r.artifact_id=${ref}.id AND o.ownership_status='confirmed'; END;`);
      }
    }
    db.prepare('UPDATE remote_write_context SET trusted=0 WHERE id=1').run();
    // Process exits are not completion evidence. Preserve run identity for reconciliation.
    for (const row of this.db.prepare("SELECT key,value FROM remote_state WHERE key LIKE 'run:%'").all() as any[]) {
      const run = JSON.parse(row.value) as RemoteRun;
      if (!terminal.has(run.status)) this.put(row.key, { ...run, status: 'reconciling', statusVersion: String(BigInt(run.statusVersion) + 1n) });
    }
  }

  setWake(listener: () => void): void { this.wake = listener; }
  setEnabledOwner(owner: RemoteOwner | null): void { this.enabledOwner = owner; }
  setAgentSummaryResolver(resolver: ((sessionId: string, owner: RemoteOwner) => RemoteAgentSummary | null) | null): void {
    if (Boolean(this.agentSummary) === Boolean(resolver)) { this.agentSummary = resolver; return; }
    this.agentSummary = resolver;
    if (resolver) this.db.prepare(`INSERT OR IGNORE INTO remote_dirty SELECT session_id FROM cowork_session_ownership WHERE ownership_status='confirmed'`).run();
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM remote_state WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  put(key: string, value: unknown): void {
    if (this.depth === 0 && this.advanceCheckpoint) { this.transaction(() => this.put(key, value)); return; }
    this.db.prepare('INSERT INTO remote_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, stableJson(value));
  }
  remove(key: string): void { this.db.prepare('DELETE FROM remote_state WHERE key=?').run(key); }
  entries<T>(prefix: string): Array<{ key: string; value: T }> {
    return (this.db.prepare('SELECT key,value FROM remote_state WHERE key LIKE ?').all(`${prefix}%`) as any[])
      .map(row => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  transaction<T>(operation: () => T): T {
    if (this.depth > 0) return operation();
    const beforeChange = this.changeVersion;
    const result = this.db.transaction(() => {
      this.depth++;
      this.db.prepare('UPDATE remote_write_context SET trusted=1 WHERE id=1').run();
      try {
        const value = operation();
        if (!this.publishing) this.captureDirty();
        if (this.advanceCheckpoint) this.put('databaseCheckpoint', this.advanceCheckpoint());
        return value;
      } finally {
        this.db.prepare('UPDATE remote_write_context SET trusted=0 WHERE id=1').run();
        this.depth--;
      }
    })();
    if (this.changeVersion !== beforeChange) this.wake();
    return result;
  }
  owner(sessionId: string): RemoteOwner | null {
    const row = this.db.prepare("SELECT owner_user_id,owner_scope_key FROM cowork_session_ownership WHERE session_id=? AND ownership_status='confirmed'").get(sessionId) as any;
    return row ? { userId: row.owner_user_id, scopeKey: row.owner_scope_key } : null;
  }
  assertActor(sessionId: string, actor: RemoteOwner | null): void {
    const row = this.db.prepare('SELECT ownership_status FROM cowork_session_ownership WHERE session_id=?').get(sessionId) as any;
    if (row && (row.ownership_status !== 'confirmed' || !sameOwner(this.owner(sessionId), actor))) throw new Error('Session belongs to another account or requires local recovery');
  }
  assignNew(sessionId: string, owner: RemoteOwner | null, source: string): void {
    if (!owner) return;
    if (!this.db.inTransaction || this.depth === 0) throw new Error('Ownership must be recorded in the creation transaction');
    this.db.prepare('INSERT INTO cowork_session_ownership VALUES (?,?,?,?,?,?)').run(sessionId, owner.userId, owner.scopeKey, 'confirmed', source, Date.now());
    this.db.prepare('INSERT INTO remote_sync(local_id,session_id) VALUES (?,?)').run(sessionId, randomUUID());
  }
  inheritNew(sessionId: string, parentId: string): void { this.assignNew(sessionId, this.owner(parentId), 'inherited_parent'); }
  bindSource(sourceId: string, owner: RemoteOwner | null): void {
    if (!owner) return;
    this.db.prepare('INSERT OR IGNORE INTO remote_source_owner VALUES (?,?)').run(sourceId, stableJson(owner));
  }
  sourceOwner(sourceId: string): RemoteOwner | null {
    const row = this.db.prepare('SELECT owner_json FROM remote_source_owner WHERE source_id=?').get(sourceId) as any;
    return row ? JSON.parse(row.owner_json) : null;
  }
  validateDatabaseInstance(instanceId: string, checkpoint = 0, advance?: () => number): void {
    const stored = this.get<string>('databaseInstance');
    if ((stored && stored !== instanceId) || (this.get<number>('databaseCheckpoint') || 0) !== checkpoint) {
      this.db.transaction(() => {
        this.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined'").run();
        this.db.prepare('DELETE FROM remote_outbox').run();
        this.db.prepare('DELETE FROM remote_source_owner').run();
        this.put('executionHistoryComplete', false);
        this.db.prepare("DELETE FROM remote_state WHERE key LIKE 'inbox:%' OR key LIKE 'import:%' OR key LIKE 'registration:%'").run();
      })();
    }
    this.put('databaseInstance', instanceId);
    this.put('databaseCheckpoint', checkpoint);
    this.advanceCheckpoint = advance || null;
  }
  hasCompleteExecutionHistory(): boolean {
    return this.get<boolean>('executionHistoryComplete') !== false && this.db.pragma('quick_check', { simple: true }) === 'ok';
  }
  markRunDispatched(sessionId: string): void {
    const run = this.run(sessionId);
    if (!run) return;
    this.transaction(() => {
      this.put(`runPublished:${run.runId}`, true);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
  }
  quarantineAll(): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE cowork_session_ownership SET ownership_status='quarantined'").run();
      this.db.prepare('DELETE FROM remote_outbox').run();
    })();
  }
  sync(sessionId: string): SyncRow | null { return this.db.prepare('SELECT * FROM remote_sync WHERE local_id=?').get(sessionId) as SyncRow || null; }
  sessions(owner: RemoteOwner): SyncRow[] {
    return this.db.prepare(`SELECT s.* FROM remote_sync s JOIN cowork_session_ownership o ON o.session_id=s.local_id
      WHERE o.owner_user_id=? AND o.owner_scope_key=? AND o.ownership_status='confirmed'`).all(owner.userId, owner.scopeKey) as SyncRow[];
  }
  localSessionId(remoteSessionId: string): string | null {
    return (this.db.prepare('SELECT local_id FROM remote_sync WHERE session_id=?').get(remoteSessionId) as any)?.local_id || null;
  }
  bindRemote(sessionId: string, remoteId: string, deviceId: string): void {
    this.db.prepare('UPDATE remote_sync SET session_id=?,device_id=? WHERE local_id=?').run(remoteId, deviceId, sessionId);
  }
  run(sessionId: string): RemoteRun | null { return this.get<RemoteRun>(`run:${sessionId}`); }
  controlVersion(sessionId: string): string { return this.get<string>(`control:${sessionId}`) || '0'; }
  beginRun(sessionId: string, runId: string = randomUUID(), commandId: string | null = null): RemoteRun {
    const previous = this.run(sessionId);
    if (previous && !terminal.has(previous.status)) throw new Error('REMOTE_SESSION_BUSY');
    const run: RemoteRun = { runId, status: 'starting', statusVersion: '1', startedAt: iso(Date.now()), finishedAt: null, error: null };
    this.transaction(() => {
      this.remove(`gatewayRun:${sessionId}`);
      this.put(`run:${sessionId}`, run);
      this.put(`runHistory:${sessionId}:${runId}`, run);
      this.put(`runCommand:${sessionId}`, commandId);
      this.put(`runPublished:${runId}`, commandId === null);
      this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
    return run;
  }
  updateRun(sessionId: string, status: RemoteRunStatusValue, error?: string): void {
    const previous = this.run(sessionId);
    if (!previous || terminal.has(previous.status) || previous.status === status) return;
    this.transaction(() => {
      this.put(`run:${sessionId}`, { ...previous, status, statusVersion: String(BigInt(previous.statusVersion) + 1n),
        finishedAt: terminal.has(status) ? iso(Date.now()) : null,
        error: error ? remoteError(47019, 'EXECUTION_FAILED', error) : null });
      if (terminal.has(status)) for (const { key, value: approval } of this.entries<any>(`approval:${sessionId}:`)) {
        if (approval.status === 'pending') this.put(key, { ...approval, status: 'cancelled', approvalVersion: String(BigInt(approval.approvalVersion) + 1n), resolvedAt: iso(Date.now()) });
      }
      this.put(`runHistory:${sessionId}:${previous.runId}`, this.run(sessionId));
      this.bumpControl(sessionId);
      this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
    });
  }
  expireApprovals(now = Date.now()): void {
    const expired = this.entries<any>('approval:').filter(row => row.value.status === 'pending' && Date.parse(row.value.expiresAt) <= now);
    if (!expired.length) return;
    this.transaction(() => {
      for (const { key, value: approval } of expired) {
        const sessionId = key.slice('approval:'.length, key.indexOf(':', 'approval:'.length));
        this.put(key, { ...approval, status: 'expired', resolvedAt: iso(now), approvalVersion: String(BigInt(approval.approvalVersion) + 1n) });
        this.bumpControl(sessionId);
        if (this.run(sessionId)?.status === 'waiting_approval') this.updateRun(sessionId, 'waiting_local');
        this.db.prepare('INSERT OR IGNORE INTO remote_dirty VALUES (?)').run(sessionId);
      }
    });
  }
  private bumpControl(sessionId: string): void { this.put(`control:${sessionId}`, String(BigInt(this.controlVersion(sessionId)) + 1n)); }

  requireSnapshot(sessionId: string): void {
    this.db.prepare('UPDATE remote_sync SET needs_snapshot=1 WHERE local_id=?').run(sessionId);
    this.put(`snapshotEpoch:${sessionId}`, (this.get<number>(`snapshotEpoch:${sessionId}`) || 0) + 1);
  }
  private captureDirty(): void {
    this.publishing = true;
    try {
      const dirty = this.db.prepare('SELECT session_id FROM remote_dirty').all() as Array<{ session_id: string }>;
      if (dirty.length) this.changeVersion++;
      for (const { session_id: id } of dirty) {
        const owner = this.owner(id);
        if (!owner) continue;
        if (!sameOwner(owner, this.enabledOwner)) {
          this.requireSnapshot(id);
          continue;
        }
        const hasAgentChanges = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_ownership_dirty'").get();
        const summaryOnly = Boolean(hasAgentChanges && this.db.prepare(`SELECT 1 FROM cowork_sessions s JOIN agent_ownership_dirty a ON a.agent_id=s.agent_id
          WHERE s.id=? AND NOT EXISTS (SELECT 1 FROM remote_content_dirty c WHERE c.session_id=s.id)`).get(id));
        this.project(id, summaryOnly);
      }
      this.db.prepare('DELETE FROM remote_dirty').run();
      this.db.prepare('DELETE FROM remote_content_dirty').run();
    } finally { this.publishing = false; }
  }
  private record(sessionId: string, key: string, record: ProjectionRecord): void {
    const old = this.db.prepare('SELECT hash,revision,record_json FROM remote_projection WHERE session_id=? AND object_key=?').get(sessionId, key) as any;
    if (old && record.payload.message) {
      const previous = JSON.parse(old.record_json).payload.message;
      if (previous) {
        record.payload.message.ordinal = previous.ordinal;
        record.payload.message.runId = previous.runId;
        record.payload.message.commandId = previous.commandId;
      }
    }
    if (old && record.payload.tool) {
      const previous = JSON.parse(old.record_json).payload.tool;
      if (previous) { record.payload.tool.runId = previous.runId; record.payload.tool.startedAt = previous.startedAt; }
    }
    const hash = payloadHash(record);
    if (old?.hash === hash) return;
    const revision = (old?.revision || 0) + 1;
    const projected = JSON.parse(stableJson(record)) as ProjectionRecord;
    if (projected.payload.message) projected.payload.message.revision = String(revision);
    if (projected.payload.tool) projected.payload.tool.revision = String(revision);
    this.db.prepare(`INSERT INTO remote_projection VALUES (?,?,?,?,?) ON CONFLICT(session_id,object_key)
      DO UPDATE SET hash=excluded.hash,revision=excluded.revision,record_json=excluded.record_json`)
      .run(sessionId, key, hash, revision, stableJson(projected));
    this.enqueue(sessionId, projected);
  }
  private enqueue(sessionId: string, record: ProjectionRecord): void {
    const row = this.sync(sessionId);
    if (!row) return;
    const sourceSeq = row.source_seq + 1;
    const event: RemoteEvent = { ...record, eventId: randomUUID(), sourceSeq: String(sourceSeq), occurredAt: iso(Date.now()) };
    this.db.prepare('UPDATE remote_sync SET source_seq=? WHERE local_id=?').run(sourceSeq, sessionId);
    // A full snapshot supersedes unsent events only after its durable server commit.
    this.db.prepare('INSERT INTO remote_outbox VALUES (?,?,?)').run(sessionId, sourceSeq, stableJson(event));
    const size = this.db.prepare('SELECT count(*) AS n,sum(length(event_json)) AS bytes FROM remote_outbox WHERE session_id=?').get(sessionId) as any;
    if (size.n > 2000 || size.bytes > 16 * 1024 * 1024) {
      this.requireSnapshot(sessionId);
      // Snapshot projection is durable; no assigned payload is rewritten or reused.
      this.db.prepare('DELETE FROM remote_outbox WHERE session_id=?').run(sessionId);
    }
  }
  project(sessionId: string, summaryOnly = false): void {
    const s = this.db.prepare('SELECT * FROM cowork_sessions WHERE id=?').get(sessionId) as any;
    if (!s) { if (!this.get<string>(`deletedAt:${sessionId}`)) this.requireSnapshot(sessionId); const deletedAt = this.get<string>(`deletedAt:${sessionId}`) || iso(Date.now()); this.put(`deletedAt:${sessionId}`, deletedAt); this.record(sessionId, 'deleted', { eventType: 'session.deleted', payload: { deletedAt } }); return; }
    const storedRun = this.run(sessionId);
    const run = storedRun && this.get<boolean>(`runPublished:${storedRun.runId}`) !== false ? storedRun : null;
    const previous = summaryOnly ? this.db.prepare("SELECT record_json FROM remote_projection WHERE session_id=? AND object_key='session'").get(sessionId) as { record_json: string } | undefined : undefined;
    summaryOnly = summaryOnly && Boolean(previous);
    const messages = summaryOnly ? [] : this.db.prepare('SELECT * FROM cowork_messages WHERE session_id=? ORDER BY sequence,created_at,id').all(sessionId) as any[];
    const visible = messages.filter(publicMessage);
    const latestText = visible.filter(m => ['user', 'assistant'].includes(m.type)).at(-1)?.content || '';
    this.record(sessionId, 'session', { eventType: 'session.upsert', payload: { session: {
      sessionId: this.sync(sessionId)?.session_id, title: shortName(publicText(s.title)), origin: this.get(`origin:${sessionId}`) || 'desktop',
      workspaceId: this.get(`workspace:${sessionId}`), preview: summaryOnly ? JSON.parse(previous!.record_json).payload.session.preview : preview(publicText(latestText)), createdAt: iso(s.created_at), updatedAt: iso(s.updated_at),
      localStatus: s.status, controlVersion: this.controlVersion(sessionId), run,
      ...(this.agentSummary && this.owner(sessionId) ? { agent: this.agentSummary(sessionId, this.owner(sessionId)!) } : {}),
    } } });
    for (const { value: historicalRun } of this.entries<RemoteRun>(`runHistory:${sessionId}:`)) {
      const projectedRun = historicalRun.runId === run?.runId ? run : historicalRun;
      if (this.get<boolean>(`runPublished:${historicalRun.runId}`) !== false) this.record(sessionId, `run:${historicalRun.runId}`, { eventType: 'run.updated', payload: { run: projectedRun, controlVersion: this.controlVersion(sessionId) } });
    }
    for (const { value: approval } of this.entries<any>(`approval:${sessionId}:`)) {
      const { pendingDecision: _pending, ...safe } = approval;
      this.record(sessionId, `approval:${safe.approvalId}`, { eventType: 'approval.updated', payload: { approval: safe, controlVersion: this.controlVersion(sessionId) } });
    }
    // Agent metadata changes reuse the committed preview and never scan/re-upload conversation messages.
    if (summaryOnly) return;
    const liveKeys = new Set<string>();
    const tools = new Map<string, ProjectionRecord>();
    // Read catalog metadata only; never enumerate files or select file_path/path_key.
    const artifacts = this.artifactTracking ? this.db.prepare(`SELECT a.id,a.file_name,a.extension,a.size_bytes,a.availability,r.last_message_id
      FROM library_local_artifacts a JOIN library_artifact_sessions r ON r.artifact_id=a.id
      WHERE r.session_id=? AND r.last_message_id IS NOT NULL ORDER BY a.id`).all(sessionId) as any[] : [];
    for (const m of visible) {
      let metadata: any = {};
      try { metadata = JSON.parse(m.metadata || '{}'); } catch { /* Legacy malformed metadata is not transmitted. */ }
      if (metadata.remoteRunId && this.get<boolean>(`runPublished:${metadata.remoteRunId}`) === false) continue;
      const isTool = m.type.startsWith('tool_');
      const toolId = String(metadata.toolUseId || metadata.toolCallId || m.id);
      const content = publicText(m.content);
      const blocks: any[] = isTool ? [{ type: 'tool', toolCallId: toolId }] : [{ type: m.type === 'user' ? 'text' : 'markdown', text: content }];
      for (const artifact of artifacts.filter(a => a.last_message_id === m.id)) blocks.push({ type: 'artifact', artifactId: artifact.id,
        name: String(artifact.file_name).split(/[\\/]/).pop()!.slice(0, 128),
        mimeType: ({ pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', html: 'text/html' } as Record<string, string>)[String(artifact.extension).replace(/^\./, '').toLowerCase()] || 'application/octet-stream',
        sizeBytes: Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes >= 0 ? String(artifact.size_bytes) : null,
        availability: artifact.availability === 'missing' ? 'missing' : 'desktop_only',
      });
      const message: any = { messageId: m.id, ordinal: String(Math.max(1, m.sequence || 1)), revision: '0',
        runId: metadata.remoteRunId || null, commandId: metadata.remoteCommandId || null,
        role: isTool ? 'tool' : m.type, status: metadata.isStreaming ? 'streaming' : 'complete', createdAt: iso(m.created_at),
        contentState: 'complete', preview: isTool ? '' : preview(content), originalContentBytes: String(Buffer.byteLength(stableJson(blocks))), blocks };
      if (Buffer.byteLength(stableJson(message)) > REMOTE_MESSAGE_BYTES - 128) { message.blocks = []; message.contentState = 'desktop_only'; }
      this.record(sessionId, `message:${m.id}`, { eventType: 'message.upsert', payload: { message } });
      liveKeys.add(`message:${m.id}`);
      if (isTool) tools.set(toolId, { eventType: 'tool.upsert', payload: { tool: {
        toolCallId: toolId, runId: metadata.remoteRunId || run?.runId || null, revision: '0', name: shortName(metadata.toolName || 'tool'),
        status: m.type === 'tool_result' ? (metadata.isError ? 'failed' : 'succeeded') : 'running',
        summary: '', startedAt: iso(m.created_at), finishedAt: m.type === 'tool_result' ? iso(m.created_at) : null, error: null,
      } } });
    }
    for (const [toolId, record] of tools) this.record(sessionId, `tool:${toolId}`, record);
    const existing = this.db.prepare("SELECT object_key,revision,record_json FROM remote_projection WHERE session_id=? AND object_key LIKE 'message:%'").all(sessionId) as any[];
    for (const p of existing) if (!liveKeys.has(p.object_key) && JSON.parse(p.record_json).eventType !== 'message.deleted') {
      const deleted = { eventType: 'message.deleted', payload: { messageId: p.object_key.slice(8), revision: String(p.revision + 1) } };
      this.enqueue(sessionId, deleted);
      this.db.prepare('UPDATE remote_projection SET hash=?,revision=?,record_json=? WHERE session_id=? AND object_key=?')
        .run(payloadHash(deleted), p.revision + 1, stableJson(deleted), sessionId, p.object_key);
    }
  }
  snapshot(sessionId: string): { baseSourceSeq: string; snapshotEpoch: number; records: ProjectionRecord[] } {
    return this.transaction(() => {
      this.project(sessionId);
      let records = (this.db.prepare('SELECT record_json FROM remote_projection WHERE session_id=? ORDER BY object_key').all(sessionId) as any[]).map(row => JSON.parse(row.record_json));
      const deletion = records.find(record => record.eventType === 'session.deleted');
      if (deletion) records = [deletion];
      return { baseSourceSeq: String(this.sync(sessionId)!.source_seq), snapshotEpoch: this.get<number>(`snapshotEpoch:${sessionId}`) || 0, records };
    });
  }
  pending(sessionId: string): RemoteEvent[] {
    const rows = this.db.prepare('SELECT event_json FROM remote_outbox WHERE session_id=? ORDER BY source_seq LIMIT 100').all(sessionId) as any[];
    const result: RemoteEvent[] = [];
    let bytes = 0;
    for (const row of rows) { const length = Buffer.byteLength(row.event_json); if (result.length && bytes + length > 240 * 1024) break; result.push(JSON.parse(row.event_json)); bytes += length; }
    return result;
  }
  acknowledge(sessionId: string, deviceId: string, remoteId: string, committedSourceSeq: string, committedSeq: string, snapshot = false, snapshotEpoch?: number): void {
    this.transaction(() => {
      const row = this.sync(sessionId);
      const ack = BigInt(committedSourceSeq);
      if (!row || row.session_id !== remoteId || row.device_id !== deviceId || ack < BigInt(row.ack_seq) || ack > BigInt(row.source_seq)) throw new Error('Remote ACK outside durable local bounds');
      this.db.prepare('UPDATE remote_sync SET ack_seq=?,server_seq=?,needs_snapshot=? WHERE local_id=?')
        .run(Number(ack), committedSeq, snapshot && (snapshotEpoch === undefined || snapshotEpoch === (this.get<number>(`snapshotEpoch:${sessionId}`) || 0)) ? 0 : row.needs_snapshot, sessionId);
      this.db.prepare('DELETE FROM remote_outbox WHERE session_id=? AND source_seq<=?').run(sessionId, Number(ack));
    });
  }
}
