import type Database from 'better-sqlite3';

import type { AvailabilitySession, RemoteAvailabilityStore } from './remoteAvailabilityStore';
import type { RemoteStore } from './remoteStore';

const Phase = { Baseline: 'baseline', Run: 'run', Approval: 'approval', Question: 'question', PrivateQuestion: 'private_question', DeletedMessage: 'deleted_message', Complete: 'complete' } as const;
const phases = Object.values(Phase);
const PAGE = 4;
const boundedKey = (value: unknown): string => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) throw new Error('REMOTE_CONTROL_RECONCILIATION_INVALID');
  return value;
};
interface Cursor {
  pass: string; revision: string; phase: typeof Phase[keyof typeof Phase]; cursor: string;
}
export interface ControlReconciliationPage extends Cursor {
  nextPhase: Cursor['phase']; nextCursor: string;
}
export interface ControlReconciliationSelection {
  page: ControlReconciliationPage;
  runIds: string[]; approvalIds: string[]; questionIds: string[]; deletedMessageIds: string[];
}
interface SavedCursor { writer_generation: string; control_epoch: string; pass: string; revision: string; phase: Cursor['phase']; cursor: string }

/** A scoped scan cursor is derived state. Only original fact/checkpoint ACKs in the ledger establish publication. */
export class RemoteAvailabilityReconcile {
  private initialized: Database.Database | null = null;
  constructor(private readonly ledger: RemoteAvailabilityStore) {}
  private database(): Database.Database {
    const db = this.ledger.db;
    if (this.initialized !== db) {
      db.exec(`CREATE TABLE IF NOT EXISTS availability_control_reconcile(
        scope TEXT NOT NULL,local_id TEXT NOT NULL,writer_generation TEXT NOT NULL,control_epoch TEXT NOT NULL,
        pass TEXT NOT NULL,revision TEXT NOT NULL,phase TEXT NOT NULL,cursor TEXT NOT NULL,
        PRIMARY KEY(scope,local_id));`);
      this.initialized = db;
    }
    return db;
  }
  revision(store: RemoteStore, localId: string): string {
    return String((store.db.prepare('SELECT revision FROM remote_control_revisions WHERE session_id=?').get(localId) as { revision: number } | undefined)?.revision || 1);
  }
  /** Foreign entries are only shared scheduling hints; each target retains its own receipt/cursor. */
  pruneForeignPending(store: RemoteStore, localId: string, throughRevision: string): void {
    store.db.transaction(() => {
      const readState = (key: string): Record<string, unknown> | null => {
        const row = store.db.prepare('SELECT CASE WHEN octet_length(value)<=32768 THEN value END AS value FROM remote_state WHERE key=?')
          .get(key) as { value: string | null } | undefined;
        if (!row) return null;
        if (row.value === null) throw new Error('REMOTE_CONTROL_RECONCILIATION_INVALID');
        const value = JSON.parse(row.value) as unknown;
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      };
      const history = readState(`syncTargetHistory:${localId}`);
      if (!Array.isArray(history?.runIds) || !history.runIds.every(id => typeof id === 'string')) return;
      const foreign = new Set(history.runIds);
      if (!foreign.size) return;
      const pending = store.db.prepare(`SELECT CASE WHEN octet_length(object_key)<=1024 THEN object_key END AS object_key,revision
        FROM remote_control_pending WHERE session_id=? AND revision<=? ORDER BY revision,object_key LIMIT 16`)
        .all(localId, throughRevision) as Array<{ object_key: string | null; revision: number }>;
      for (const row of pending) {
        const key = boundedKey(row.object_key);
        let runId: unknown;
        if (key.startsWith('run.updated:')) runId = key.slice('run.updated:'.length);
        else if (key.startsWith('approval.updated:')) {
          const id = key.slice('approval.updated:'.length), decision = readState(`approval:${localId}:${id}`);
          if (decision?.approvalId === id) runId = decision.runId;
        } else if (key.startsWith('question.updated:')) {
          const id = key.slice('question.updated:'.length);
          runId = store.questionStates(localId, undefined, [id]).find(item => item.questionId === id)?.runId;
        }
        if (typeof runId !== 'string' || !foreign.has(runId)) continue;
        const run = readState(`runHistory:${localId}:${runId}`) || readState(`run:${localId}`);
        if (run?.runId !== runId) continue; // Missing original evidence remains pending and cannot grant authority.
        store.db.prepare('DELETE FROM remote_control_pending WHERE session_id=? AND object_key=? AND revision<=?')
          .run(localId, key, row.revision);
      }
    })();
  }
  private read(state: AvailabilitySession): SavedCursor | undefined {
    const row = this.database().prepare('SELECT * FROM availability_control_reconcile WHERE scope=? AND local_id=?')
      .get(state.scope, state.localId) as SavedCursor | undefined;
    if (row && (!phases.includes(row.phase) || !/^\d{1,19}$/u.test(row.revision) || typeof row.cursor !== 'string'
      || Buffer.byteLength(row.cursor) > 1024 || typeof row.pass !== 'string' || row.pass.length > 128))
      throw new Error('REMOTE_CONTROL_RECONCILIATION_INVALID');
    return row;
  }
  private save(state: AvailabilitySession, cursor: Cursor): void {
    this.database().prepare(`INSERT INTO availability_control_reconcile VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,local_id) DO UPDATE SET writer_generation=excluded.writer_generation,control_epoch=excluded.control_epoch,
        pass=excluded.pass,revision=excluded.revision,phase=excluded.phase,cursor=excluded.cursor`)
      .run(state.scope, state.localId, state.writerGeneration, state.controlEpoch, cursor.pass, cursor.revision, cursor.phase, cursor.cursor);
  }
  next(store: RemoteStore, state: AvailabilitySession, pass: string): ControlReconciliationSelection | null {
    const revision = this.revision(store, state.localId), saved = this.read(state);
    const cursor: Cursor = saved && saved.writer_generation === state.writerGeneration && saved.control_epoch === state.controlEpoch
      && saved.revision === revision && (saved.pass === pass || saved.phase !== Phase.Complete)
      ? { ...saved, pass } : { pass, revision, phase: Phase.Baseline, cursor: '' };
    if (cursor.phase === Phase.Complete) return null;
    this.save(state, cursor);
    const selection = { runIds: [] as string[], approvalIds: [] as string[], questionIds: [] as string[], deletedMessageIds: [] as string[] };
    let keys: string[] = [];
    if (cursor.phase === Phase.Baseline) {
      keys = Object.keys(state.records).filter(key => key > cursor.cursor).sort().slice(0, PAGE);
      for (const key of keys) {
        if (key.startsWith('run.updated:')) selection.runIds.push(key.slice('run.updated:'.length));
        if (key.startsWith('approval.updated:')) selection.approvalIds.push(key.slice('approval.updated:'.length));
        if (key.startsWith('question.updated:')) selection.questionIds.push(key.slice('question.updated:'.length));
        if (key.startsWith('message.deleted:')) selection.deletedMessageIds.push(key.slice('message.deleted:'.length));
      }
    } else if (cursor.phase === Phase.PrivateQuestion) {
      const rows = store.db.prepare(`SELECT CASE WHEN octet_length(key)<=1024 THEN key END AS key,
        CASE WHEN octet_length(question_id)<=1024 THEN question_id END AS question_id
        FROM remote_question_bindings WHERE session_id=? AND key>? ORDER BY key LIMIT ?`)
        .all(state.localId, cursor.cursor, PAGE) as Array<{ key: string | null; question_id: string | null }>;
      keys = rows.map(row => boundedKey(row.key)); selection.questionIds = rows.map(row => boundedKey(row.question_id));
    } else if (cursor.phase === Phase.DeletedMessage) {
      const rows = store.db.prepare('SELECT CASE WHEN octet_length(object_id)<=1024 THEN object_id END AS object_id FROM remote_live_revisions WHERE session_id=? AND object_id>? AND deleted=1 ORDER BY object_id LIMIT ?')
        .all(state.localId, cursor.cursor, PAGE) as Array<{ object_id: string | null }>;
      keys = rows.map(row => boundedKey(row.object_id)); selection.deletedMessageIds = keys;
    } else {
      const prefix = `${cursor.phase === Phase.Run ? 'runHistory' : cursor.phase}:${state.localId}:`;
      const rows = store.db.prepare('SELECT CASE WHEN octet_length(key)<=1024 THEN key END AS key FROM remote_state WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?')
        .all(prefix, `${prefix}\uffff`, cursor.cursor, PAGE) as Array<{ key: string | null }>;
      keys = rows.map(row => boundedKey(row.key));
      const ids = keys.map(key => key.slice(prefix.length));
      if (cursor.phase === Phase.Run) selection.runIds = ids;
      else if (cursor.phase === Phase.Approval) selection.approvalIds = ids;
      else selection.questionIds = ids;
    }
    return { ...selection, page: { pass, revision, phase: cursor.phase, cursor: cursor.cursor,
      nextPhase: keys.length === PAGE ? cursor.phase : phases[phases.indexOf(cursor.phase) + 1],
      nextCursor: keys.length === PAGE ? keys.at(-1)! : '' } };
  }
  /** Called after a verified ACK, or after every selected object matches an existing ACK hash. */
  advance(store: RemoteStore, state: AvailabilitySession, page: ControlReconciliationPage): boolean {
    if (!phases.includes(page.phase) || !phases.includes(page.nextPhase) || typeof page.nextCursor !== 'string'
      || Buffer.byteLength(page.nextCursor) > 1024 || ![page.phase, phases[phases.indexOf(page.phase) + 1]].includes(page.nextPhase))
      throw new Error('REMOTE_CONTROL_RECONCILIATION_INVALID');
    const saved = this.read(state);
    if (!saved || saved.writer_generation !== state.writerGeneration || saved.control_epoch !== state.controlEpoch
      || saved.pass !== page.pass || saved.revision !== page.revision || saved.phase !== page.phase || saved.cursor !== page.cursor
      || this.revision(store, state.localId) !== page.revision) return false;
    this.save(state, { ...page, phase: page.nextPhase, cursor: page.nextCursor });
    return page.nextPhase === Phase.Complete;
  }
}
