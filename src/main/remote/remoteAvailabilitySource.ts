import type Database from 'better-sqlite3';

import { stableJson } from './canonical';
import { questionSessionSql, questionStatusSql } from './remoteQuestionEvidence';
import { redactReplyText } from './remoteReplyProjection';
import type { ProjectionRecord, RemoteRun, RemoteStore } from './remoteStore';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** Durable source versions and deletion identities belong to the core commit; cloud projection revisions are separate. */
export function initializeAvailabilitySource(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_live_revisions(
    session_id TEXT NOT NULL, object_id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session_id,object_id));
    CREATE TABLE IF NOT EXISTS remote_live_tools(session_id TEXT NOT NULL,tool_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_id,tool_id));
    CREATE TABLE IF NOT EXISTS remote_control_revisions(session_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_control_pending(session_id TEXT NOT NULL,object_key TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(session_id,object_key));
    CREATE INDEX IF NOT EXISTS idx_remote_live_revision_session ON remote_live_revisions(session_id,revision,object_id);`);
  // Refresh this new feature's trigger when upgrading a pre-release database.
  db.exec('DROP TRIGGER IF EXISTS remote_live_message_delete');
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const ref = operation === 'DELETE' ? 'OLD' : 'NEW';
    const toolId = `COALESCE(CASE WHEN json_valid(${ref}.metadata) THEN COALESCE(json_extract(${ref}.metadata,'$.toolUseId'),json_extract(${ref}.metadata,'$.toolCallId')) END,${ref}.id)`;
    // Replace pre-upgrade triggers before any desktop write; they wrote an optional join cache.
    db.exec(`DROP TRIGGER IF EXISTS remote_live_tool_${operation.toLowerCase()};
      CREATE TRIGGER remote_live_tool_${operation.toLowerCase()} AFTER ${operation} ON cowork_messages WHEN ${ref}.type IN ('tool_use','tool_result') BEGIN
      INSERT INTO remote_live_tools VALUES(${ref}.session_id,${toolId},1) ON CONFLICT(session_id,tool_id) DO UPDATE SET revision=revision+1; END;
      DROP TRIGGER IF EXISTS remote_live_message_${operation.toLowerCase()};
      CREATE TRIGGER remote_live_message_${operation.toLowerCase()} AFTER ${operation} ON cowork_messages BEGIN
      INSERT INTO remote_live_revisions VALUES(${ref}.session_id,${ref}.id,1,${operation === 'DELETE' ? 1 : 0})
      ON CONFLICT(session_id,object_id) DO UPDATE SET revision=revision+1,deleted=excluded.deleted;
      ${operation === 'DELETE' ? `INSERT INTO remote_control_revisions VALUES(OLD.session_id,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
        INSERT INTO remote_control_pending SELECT OLD.session_id,'message.deleted:'||OLD.id,revision FROM remote_control_revisions WHERE session_id=OLD.session_id
        ON CONFLICT(session_id,object_key) DO UPDATE SET revision=excluded.revision;` : ''} END;
      DROP TRIGGER IF EXISTS remote_control_session_${operation.toLowerCase()};
      CREATE TRIGGER remote_control_session_${operation.toLowerCase()} AFTER ${operation} ON cowork_sessions BEGIN
      INSERT INTO remote_control_revisions VALUES(${ref}.id,1)
      ON CONFLICT(session_id) DO UPDATE SET revision=revision+1; END;`);
  }
}
/** Derived membership only: original messages plus durable object/tool revisions remain in core. */
export function initializeAvailabilityProjectionSources(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_live_tool_sources(session_id TEXT NOT NULL,message_id TEXT NOT NULL,tool_id TEXT NOT NULL,PRIMARY KEY(session_id,message_id));
    CREATE INDEX IF NOT EXISTS idx_remote_live_tool_sources ON remote_live_tool_sources(session_id,tool_id,message_id);`);
  if ((db.prepare("SELECT type FROM sqlite_master WHERE name='remote_live_tool_sources'").get() as { type: string } | undefined)?.type !== 'table')
    throw new Error('REMOTE_AVAILABILITY_DERIVED_SCHEMA_INVALID');
}
export function touchAvailabilityControl(db: Database.Database, sessionId: string): void {
  db.prepare('INSERT INTO remote_control_revisions VALUES(?,1) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1').run(sessionId);
}
export function touchAvailabilityMessage(db: Database.Database, sessionId: string, messageId: string): void {
  db.prepare(`INSERT INTO remote_live_revisions(session_id,object_id,revision,deleted)
    SELECT session_id,id,1,0 FROM cowork_messages WHERE session_id=? AND id=?
    ON CONFLICT(session_id,object_id) DO UPDATE SET revision=revision+1`).run(sessionId,messageId);
}
export function markAvailabilityControl(db: Database.Database, sessionId: string, objectKey: string): void {
  db.prepare(`INSERT INTO remote_control_pending SELECT ?,?,revision FROM remote_control_revisions WHERE session_id=?
    ON CONFLICT(session_id,object_key) DO UPDATE SET revision=excluded.revision`).run(sessionId, objectKey, sessionId);
}
export interface ControlSnapshot { revision: string; records: ProjectionRecord[]; hash: string }
/** Only private control facts are read here. A poisoned projection/outbox cannot poison this checkpoint. */
export function availabilityControlSnapshot(store: RemoteStore, localId: string, pendingRunIds: string[] = [], includeDirtyRuns = true, required: { approvalIds?: string[]; questionIds?: string[]; deletedMessageIds?: string[] } = {}, options: { incremental?: boolean; paged?: boolean } = {}): ControlSnapshot {
  return store.db.transaction(() => {
    let capturedBytes = 0;
    const boundedState = (key: string): void => {
      const header = store.db.prepare('SELECT octet_length(value) AS bytes FROM remote_state WHERE key=?').get(key) as { bytes: number } | undefined;
      const bytes = header?.bytes || 0; capturedBytes += bytes;
      if (bytes > 32 * 1024 || capturedBytes > 1024 * 1024) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
    };
    const session = store.db.prepare('SELECT substr(title,1,128) AS title,created_at,updated_at,status FROM cowork_sessions WHERE id=?').get(localId) as Record<string, any> | undefined;
    if (!session) throw new Error('REMOTE_CONTROL_CORE_SESSION_MISSING');
    const binding = store.controlBinding(localId);
    if (!binding || store.isSyncClosed(localId)) throw new Error('REMOTE_CONTROL_CORE_SESSION_CLOSED');
    for (const key of ['syncTargetHistory','run','origin','workspace','inputModel','inputFence','deletionGuard']) boundedState(`${key}:${localId}`);
    const targetHistory = store.get<{ runIds: string[] }>(`syncTargetHistory:${localId}`);
    const foreignRuns = new Set(targetHistory?.runIds || []);
    const visible = (runId: string): boolean => !foreignRuns.has(runId) && store.get<boolean>(`runPublished:${runId}`) !== false;
    const current = store.run(localId);
    const run = current && visible(current.runId) ? current : null;
    const controlVersion = store.controlVersion(localId);
    const pending = store.db.prepare(`SELECT object_key FROM remote_control_pending WHERE session_id=? ORDER BY revision,object_key LIMIT ${options.incremental ? 16 : 65}`).all(localId) as Array<{ object_key: string }>;
    const pendingRuns = pending.filter(item => item.object_key.startsWith('run.updated:')).map(item => item.object_key.slice('run.updated:'.length));
    pendingRunIds = [...new Set([...pendingRunIds, ...(includeDirtyRuns ? pendingRuns.slice(0,8) : [])])];
    const decisionChanges = includeDirtyRuns ? pending : [];
    const requiredApprovals = [...new Set([...(required.approvalIds || []), ...decisionChanges.filter(item => item.object_key.startsWith('approval.updated:')).map(item => item.object_key.slice('approval.updated:'.length))])];
    const requiredQuestions = [...new Set([...(required.questionIds || []), ...decisionChanges.filter(item => item.object_key.startsWith('question.updated:')).map(item => item.object_key.slice('question.updated:'.length))])];
    const limit = 65;
    const decisionRows = (kind: string, ids: string[]): Array<Record<string, any>> => {
      if (ids.length > 64) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
      const prefix = `${kind}:${localId}:`;
      const rows = store.db.prepare(`SELECT key,octet_length(value) AS bytes FROM remote_state WHERE key>=? AND key<?
        AND (key IN (SELECT ?||value FROM json_each(?)) ${options.incremental ? '' : "OR CASE WHEN octet_length(value)>32768 THEN 1 WHEN json_valid(value) THEN json_extract(value,'$.status')='pending' ELSE 1 END"})
        ORDER BY key LIMIT ?`).all(prefix, `${prefix}\uffff`, prefix, JSON.stringify(ids), limit) as Array<{ key: string; bytes: number }>;
      capturedBytes += rows.reduce((sum, row) => sum + row.bytes, 0);
      if (rows.length > 64 || rows.some(row => row.bytes > 32768) || capturedBytes > 1024 * 1024) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
      return rows.map(row => JSON.parse((store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(row.key) as { value: string }).value) as Record<string, any>);
    };
    const approvals = decisionRows('approval', requiredApprovals).filter(item => visible(item.runId));
    const publicQuestions = decisionRows('question', requiredQuestions);
    const questionIds = [...new Set([...requiredQuestions, ...publicQuestions.map(item => String(item.questionId))])];
    if (!store.questionEvidenceHealthy(localId)) throw new Error('REMOTE_CONTROL_DECISION_EVIDENCE_MISSING');
    if (!options.incremental) {
      const privateRows = store.db.prepare(`SELECT json_extract(value,'$.state.questionId') AS id FROM remote_state
        WHERE key>='questionDecision:' AND key<'questionDecision;'
          AND ${questionSessionSql}=? AND ${questionStatusSql}='pending' LIMIT ?`)
        .all(localId, limit) as Array<{ id: string }>;
      questionIds.push(...privateRows.map(item => item.id).filter(id => !questionIds.includes(id)));
    }
    if (questionIds.length > 64 || pendingRunIds.length > 64) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
    const questions: ReturnType<RemoteStore['questionStates']> = [];
    for (let offset = 0; offset < questionIds.length; offset += 64)
      questions.push(...store.questionStates(localId, undefined, questionIds.slice(offset, offset + 64)).filter(item => visible(item.runId)));
    if ((required.approvalIds || []).some(id => !approvals.some(item => item.approvalId === id))
      || (required.questionIds || []).some(id => !questions.some(item => item.questionId === id))) throw new Error('REMOTE_CONTROL_DECISION_EVIDENCE_MISSING');
    const neededRuns = new Set([...pendingRunIds, ...approvals.map(item => item.runId), ...questions.map(item => item.runId)]);
    if (run) neededRuns.add(run.runId);
    const runs = new Map<string, RemoteRun>();
    if (run) runs.set(run.runId, run);
    for (const runId of neededRuns) {
      if (!runs.has(runId)) {
        boundedState(`runHistory:${localId}:${runId}`);
        const historical = store.get<RemoteRun>(`runHistory:${localId}:${runId}`);
        if (!historical || !visible(runId)) throw new Error('REMOTE_CONTROL_CORE_RUN_MISSING');
        runs.set(runId, historical);
      }
    }
    // Refresh the independently persisted input version before sealing the core revision.
    const inputVersion = store.inputVersion(localId);
    const recent = store.db.prepare("SELECT substr(content,1,512) AS content FROM cowork_messages WHERE session_id=? AND type IN ('user','assistant') ORDER BY sequence DESC LIMIT 1").get(localId) as { content: string } | undefined;
    const summary: Record<string, unknown> = {
      sessionId: binding.session_id, title: String(session.title || '').slice(0, 128).replace(/[\uD800-\uDBFF]$/u, ''), origin: store.get(`origin:${localId}`) || 'desktop',
      workspaceId: store.get(`workspace:${localId}`), preview: redactReplyText(recent?.content || '').slice(0, 512), createdAt: new Date(session.created_at).toISOString(),
      updatedAt: new Date(session.updated_at).toISOString(), localStatus: session.status, controlVersion, run,
      agent: store.currentAgentSummary(localId), deletionGuard: store.deletionGuard(localId), inputVersion, inputModel: store.get(`inputModel:${localId}`),
    };
    const records: ProjectionRecord[] = [{ eventType: 'session.upsert', payload: { session: summary } }];
    // Closed decisions precede terminal runs. Pending decisions follow introduction of their run.
    const decisions: ProjectionRecord[] = approvals.map(item => {
      const { pendingDecision: _pending, ...approval } = item;
      return { eventType: 'approval.updated', payload: { approval, controlVersion } };
    });
    decisions.push(...questions.map(question => ({ eventType: 'question.updated', payload: { question, controlVersion } })));
    for (const item of runs.values()) if (!terminal.has(item.status)) records.push({ eventType: 'run.updated', payload: { run: item, controlVersion } });
    records.push(...decisions);
    for (const item of runs.values()) if (terminal.has(item.status)) records.push({ eventType: 'run.updated', payload: { run: item, controlVersion } });
    const deletedIds = options.incremental ? pending.filter(item => item.object_key.startsWith('message.deleted:')).map(item => item.object_key.slice('message.deleted:'.length)) : required.deletedMessageIds || [];
    const deleted = store.db.prepare(`SELECT object_id,revision FROM remote_live_revisions r WHERE session_id=? AND deleted=1
      ${options.incremental ? 'AND object_id IN (SELECT value FROM json_each(?))' : includeDirtyRuns ? `AND (EXISTS(SELECT 1 FROM remote_control_pending p WHERE p.session_id=r.session_id AND p.object_key='message.deleted:'||r.object_id)
        OR object_id IN (SELECT value FROM json_each(?)))` : ''} ORDER BY object_id LIMIT ${options.incremental ? 16 : options.paged ? 4097 : includeDirtyRuns ? 24 : 65}`)
      .all(localId,...(includeDirtyRuns || options.incremental ? [JSON.stringify(deletedIds)] : [])) as Array<{ object_id: string; revision: number }>;
    records.push(...deleted.map(item => ({ eventType: 'message.deleted', payload: { messageId: item.object_id, sourceObjectRevision: String(item.revision) } })));
    if (records.length > (options.paged ? 4096 : 64) || Buffer.byteLength(stableJson(records)) > (options.paged ? 16 * 1024 * 1024 : 240 * 1024)) throw new Error('REMOTE_CONTROL_CHECKPOINT_BUDGET');
    const revision = (store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(localId) as { revision: number } | undefined)?.revision || 1;
    // hash is calculated by the caller after this small core transaction.
    return { revision: String(revision), records, hash: '' };
  })();
}
