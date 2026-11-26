import type Database from 'better-sqlite3';
import { createHash } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import { payloadHash, sameOwner, stableJson } from './canonical';

export interface QuestionEvidenceBinding {
  version: 1; key: string; sessionId: string; runId: string; questionId: string; ownerHash: string; bodyHash: string;
}
export interface QuestionEvidenceAuthenticator {
  sign(binding: QuestionEvidenceBinding): string;
  verify(binding: QuestionEvidenceBinding, signature: string): boolean;
}
interface BindingRow { fact: string | null; signature: string | null }
interface EvidenceStore { db: Database.Database; owner(sessionId: string): RemoteOwner | null }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
export const RemoteQuestionEvidenceBudget = { Rows: 4096, DamagedRows: 256, MetadataBytes: 512 * 1024, TimeMs: 25 } as const;
// Expressions are shared by the indexes and their readers so SQLite can seek rather
// than reparse every healthy historical decision on each control/heartbeat request.
const questionRange = "key>='questionDecision:' AND key<'questionDecision;'";
const questionFieldSql = (field: string): string => `CASE WHEN octet_length(value)<=32768 AND json_valid(value) THEN json_extract(value,'$.state.${field}') END`;
export const questionSessionSql = questionFieldSql('sessionId');
export const questionIdSql = questionFieldSql('questionId');
export const questionStatusSql = questionFieldSql('status');
const damagedSql = 'CASE WHEN octet_length(key)>1024 OR octet_length(value)>32768 THEN 1 ELSE NOT json_valid(value) END';
const damagedIndex = 'idx_remote_question_damaged';
function evidenceHeaders(db: Database.Database): string {
  const indexed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(damagedIndex);
  // Old/read-only sources without the optional index retain the bounded, fail-closed path.
  return `SELECT CASE WHEN octet_length(key)<=1024 THEN key END AS key,${damagedSql} AS damaged
    FROM remote_state WHERE ${questionRange}${indexed ? ` AND ${damagedSql}=1` : ''}
    ORDER BY key LIMIT ${indexed ? RemoteQuestionEvidenceBudget.DamagedRows + 1 : RemoteQuestionEvidenceBudget.Rows + 1}`;
}
class EvidenceScanBudget {
  private readonly started = performance.now();
  private rows = 0;
  private damaged = 0;
  private bytes = 0;
  inspect(key: string | null, damaged: number): boolean {
    if (!key || ++this.rows > RemoteQuestionEvidenceBudget.Rows || damaged && ++this.damaged > RemoteQuestionEvidenceBudget.DamagedRows) return false;
    return this.add(key);
  }
  add(value: string): boolean {
    this.bytes += Buffer.byteLength(value);
    return this.bytes <= RemoteQuestionEvidenceBudget.MetadataBytes && performance.now() - this.started <= RemoteQuestionEvidenceBudget.TimeMs;
  }
}


/** Identity is authenticated separately from the mutable private decision body. It never grants execution. */
export class RemoteQuestionEvidence {
  private ready = false;
  private authenticator: QuestionEvidenceAuthenticator | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCursor = '';
  constructor(private readonly store: EvidenceStore) {
    try { this.initializeBindings(); }
    catch (error) { console.warn('[RemoteSecurity] Question attribution unavailable', error); }
    try {
      store.db.transaction(() => store.db.exec(`CREATE INDEX IF NOT EXISTS ${damagedIndex} ON remote_state(key)
        WHERE ${questionRange} AND ${damagedSql}=1;
        CREATE INDEX IF NOT EXISTS idx_remote_question_session ON remote_state(${questionSessionSql},${questionIdSql},key) WHERE ${questionRange};
        CREATE INDEX IF NOT EXISTS idx_remote_question_pending ON remote_state(${questionSessionSql},key)
        WHERE ${questionRange} AND ${questionStatusSql}='pending';`))();
    } catch (error) { console.warn('[RemoteSecurity] Question evidence indexing deferred', error); }
  }
  private initializeBindings(): void {
    this.store.db.transaction(() => this.store.db.exec(`CREATE TABLE IF NOT EXISTS remote_question_bindings(
      key TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT NOT NULL,question_id TEXT NOT NULL,fact TEXT NOT NULL,signature TEXT);
      CREATE INDEX IF NOT EXISTS idx_remote_question_binding_session ON remote_question_bindings(session_id,key);`))();
    this.ready = true;
  }
  configure(authenticator: QuestionEvidenceAuthenticator): void {
    this.authenticator = authenticator;
    if (this.hasPendingAttribution()) this.scheduleRetry();
  }
  private hasPendingAttribution(): boolean {
    return !!this.store.db.prepare("SELECT 1 FROM remote_state WHERE key>='questionEvidencePending:' AND key<'questionEvidencePending;' LIMIT 1").get();
  }
  private scheduleRetry(): void {
    if (this.retryTimer || !this.authenticator || !this.store.db.open) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.store.db.open) return;
      try {
        this.retryCursor = this.repairPending(this.retryCursor) || '';
        if (!this.hasPendingAttribution()) return;
      } catch { /* Retain signed intent and retry without involving desktop writes. */ }
      this.scheduleRetry();
    }, 30_000);
    this.retryTimer.unref();
  }
  /** One bounded retry page, authorized by the signed intent committed with the original decision. */
  repairPending(after = ''): string | null {
    if (!this.authenticator) return null;
    if (!this.ready) this.initializeBindings();
    const rows = this.store.db.prepare(`SELECT key FROM remote_state WHERE key>='questionEvidencePending:'
      AND key<'questionEvidencePending;' AND key>? ORDER BY key LIMIT 32`).all(after) as Array<{ key: string }>;
    for (const row of rows) {
      const key = row.key.slice('questionEvidencePending:'.length);
      const original = this.store.db.prepare(`SELECT CASE WHEN octet_length(value)<=32768 THEN value END AS value
        FROM remote_state WHERE key=?`).get(key) as { value: string | null } | undefined;
      if (!original?.value) continue;
      let value: unknown;
      try { value = JSON.parse(original.value); } catch { continue; }
      const fact = this.fact(key, value);
      if (!fact || !this.pendingAttribution(key, fact)) continue;
      try { this.store.db.transaction(() => this.persist(key, value))(); }
      catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'SQLITE_ERROR' || code === 'SQLITE_SCHEMA') this.ready = false;
        if (!this.ready || /^SQLITE_(?:CORRUPT|NOTADB|FULL|IOERR|BUSY|LOCKED)/u.test(code || '')) throw error;
        // A conflicting attribution or per-row constraint does not starve the
        // next task; retain its signed intent and revisit on the next sweep.
      }
    }
    return rows.length === 32 ? rows.at(-1)!.key : null;
  }
  private fact(key: string, value: unknown): QuestionEvidenceBinding | null {
    if (!record(value) || !record(value.state) || !record(value.binding)) return null;
    const { sessionId, runId, questionId } = value.state;
    if (![sessionId, runId, questionId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)) return null;
    const owner = this.store.owner(sessionId);
    if ((value.binding.owner !== null || owner !== null) && !sameOwner(value.binding.owner, owner)) return null;
    return { version: 1, key, sessionId, runId, questionId, ownerHash: payloadHash(owner), bodyHash: payloadHash(value) };
  }
  /** Immutable identity is checked before the core decision changes. Attribution
   * persistence itself is optional and happens only after the core commit. */
  assertIdentity(key: string, value: unknown): void {
    const fact = this.fact(key, value);
    const matches = (previous: { session_id: string; run_id: string; question_id: string }): boolean => !!fact
      && previous.session_id === fact.sessionId && previous.run_id === fact.runId && previous.question_id === fact.questionId;
    if (this.ready) {
      try {
        const bound = this.store.db.prepare('SELECT session_id,run_id,question_id FROM remote_question_bindings WHERE key=?').get(key) as
          { session_id: string; run_id: string; question_id: string } | undefined;
        if (bound && !matches(bound)) throw new Error('REMOTE_QUESTION_BINDING_CHANGED');
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_ERROR' && code !== 'SQLITE_SCHEMA') throw error;
        this.ready = false;
      }
    }
    const row = this.store.db.prepare(`SELECT CASE WHEN octet_length(value)<=32768 THEN value END AS value FROM remote_state WHERE key=?`)
      .get(key) as { value: string | null } | undefined;
    if (!row) return;
    let previous: QuestionEvidenceBinding | null = null;
    try { previous = row.value === null ? null : this.fact(key, JSON.parse(row.value)); } catch { /* Unknown original identity cannot be rebound. */ }
    if (!previous || !matches({ session_id: previous.sessionId, run_id: previous.runId, question_id: previous.questionId }))
      throw new Error('REMOTE_QUESTION_BINDING_CHANGED');
  }
  stageAttribution(key: string, value: unknown): void {
    const fact = this.fact(key, value);
    if (!fact || !this.authenticator) return;
    let signature: string;
    try { signature = this.authenticator.sign(fact); } catch { return; }
    // The signed intent commits with the private decision. It lets recovery
    // distinguish a failed cache update from later tampering with a signed body.
    this.store.db.prepare('INSERT INTO remote_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`questionEvidencePending:${key}`, stableJson({ fact, signature }));
  }
  private pendingAttribution(key: string, fact: QuestionEvidenceBinding): boolean {
    const row = this.store.db.prepare(`SELECT CASE WHEN octet_length(value)<=8192 THEN value END AS value
      FROM remote_state WHERE key=?`).get(`questionEvidencePending:${key}`) as { value: string | null } | undefined;
    try {
      const pending = JSON.parse(row?.value || 'null');
      return !!pending && stableJson(pending.fact) === stableJson(fact) && !!this.authenticator?.verify(fact, pending.signature);
    } catch { return false; }
  }
  record(key: string, value: unknown): void {
    if (!this.ready) { this.scheduleRetry(); return; }
    try { this.store.db.transaction(() => this.persist(key, value))(); }
    catch (error) {
      this.scheduleRetry();
      const code = (error as { code?: string }).code;
      if (code !== 'SQLITE_ERROR' && code !== 'SQLITE_SCHEMA') throw error;
      this.ready = false;
      console.warn('[RemoteSecurity] Question attribution deferred', error);
    }
  }
  private persist(key: string, value: unknown): void {
    const fact = this.fact(key, value);
    const previous = this.store.db.prepare('SELECT session_id,run_id,question_id FROM remote_question_bindings WHERE key=?').get(key) as
      { session_id: string; run_id: string; question_id: string } | undefined;
    if (previous && (!fact || previous.session_id !== fact.sessionId || previous.run_id !== fact.runId || previous.question_id !== fact.questionId))
      throw new Error('REMOTE_QUESTION_BINDING_CHANGED');
    if (!fact) return;
    let signature: string | null = null;
    try { signature = this.authenticator?.sign(fact) || null; } catch { /* Signing is optional; unsigned facts cannot narrow a security fence. */ }
    this.store.db.prepare(`INSERT INTO remote_question_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(key)
      DO UPDATE SET fact=excluded.fact,signature=excluded.signature`).run(key, fact.sessionId, fact.runId, fact.questionId, stableJson(fact), signature);
    if (signature && this.pendingAttribution(key, fact)) this.store.db.prepare('DELETE FROM remote_state WHERE key=?').run(`questionEvidencePending:${key}`);
  }
  binding(key: string): QuestionEvidenceBinding | null {
    if (!this.ready) return null;
    try {
      const row = this.store.db.prepare(`SELECT CASE WHEN octet_length(fact)<=4096 THEN fact END AS fact,
        CASE WHEN octet_length(signature)<=128 THEN signature END AS signature FROM remote_question_bindings WHERE key=?`).get(key) as BindingRow | undefined;
      if (!row?.signature || !this.authenticator || !row.fact) return null;
      const fact = JSON.parse(row.fact) as QuestionEvidenceBinding;
      return fact.version === 1 && fact.key === key && this.authenticator.verify(fact, row.signature) ? fact : null;
    } catch { return null; }
  }
  private revoked(fact: QuestionEvidenceBinding, currentRunId?: string): boolean {
    if (!currentRunId || currentRunId === fact.runId) return false;
    const row = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`runHistory:${fact.sessionId}:${fact.runId}`) as { value: string } | undefined;
    try { const run = JSON.parse(row?.value || 'null'); return run?.runId === fact.runId && terminal.has(run.status); } catch { return false; }
  }
  sessionKeys(sessionId: string): string[] {
    if (!this.ready) return [];
    try {
      const rows = this.store.db.prepare(`SELECT b.key FROM remote_question_bindings b JOIN remote_state s ON s.key=b.key
        WHERE b.session_id=? AND ${damagedSql.replaceAll('key', 's.key').replaceAll('value', 's.value')}=1
        ORDER BY b.key LIMIT ${RemoteQuestionEvidenceBudget.DamagedRows + 1}`).all(sessionId) as Array<{ key: string }>;
      if (rows.length > RemoteQuestionEvidenceBudget.DamagedRows) throw new Error('REMOTE_CONTROL_DECISION_BUDGET');
      return rows.map(row => row.key).filter(key => this.binding(key)?.sessionId === sessionId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'SQLITE_ERROR' && code !== 'SQLITE_SCHEMA') throw error;
      this.ready = false;
      return [];
    }
  }

  /** Unknown old records retain the shared fence; proven damaged records affect only their own task. */
  healthy(sessionId?: string, currentRunId?: string): boolean {
    const budget = new EvidenceScanBudget();
    const rows = this.store.db.prepare(evidenceHeaders(this.store.db)).iterate() as Iterable<{ key: string | null; damaged: number }>;
    for (const row of rows) {
      if (!budget.inspect(row.key, row.damaged)) return false;
      if (!row.damaged) continue;
      const fact = this.binding(row.key!);
      if (!fact || !budget.add(stableJson(fact))) return false;
      if (fact.sessionId === sessionId && fact.ownerHash === payloadHash(this.store.owner(fact.sessionId)) && !this.revoked(fact, currentRunId))
        throw new Error('REMOTE_QUESTION_EVIDENCE_INVALID');
    }
    return true;
  }
  skip(key: string, sessionId: string, currentRunId?: string): boolean {
    const fact = this.binding(key);
    return !!fact && (fact.sessionId !== sessionId || fact.ownerHash !== payloadHash(this.store.owner(sessionId)) || this.revoked(fact, currentRunId));
  }
  verifyValue(key: string, value: unknown): void {
    const fact = this.binding(key);
    if (fact && payloadHash(value) !== fact.bodyHash) throw new Error('REMOTE_QUESTION_EVIDENCE_INVALID');
  }
  /** Backfill only bounded healthy bytes corroborated by a signed owner and an independent run/decision identity. */
  backfill(verifyOwner: (sessionId: string, owner: RemoteOwner) => boolean, after = ''): string | null {
    if (!this.ready || !this.authenticator) return null;
    const rows = this.store.db.prepare(`SELECT s.key,CASE WHEN octet_length(s.value)<=32768 THEN s.value END AS value
      FROM remote_state s
      WHERE s.key>='questionDecision:' AND s.key<'questionDecision;' AND s.key>? ORDER BY s.key LIMIT 32`)
      .all(after) as Array<{ key: string; value: string | null }>;
    for (const row of rows) {
      try {
        if (row.value === null) continue;
        const value = JSON.parse(row.value), fact = this.fact(row.key, value);
        if (!fact) continue;
        const bound = this.store.db.prepare('SELECT signature FROM remote_question_bindings WHERE key=?').get(row.key) as { signature: string | null } | undefined;
        // Never re-sign a modified signed body just because it still names an
        // existing owner/run. Only authenticated, committed intent can repair it.
        if (bound?.signature && !this.pendingAttribution(row.key, fact)) continue;
        const owner = this.store.owner(fact.sessionId);
        if (!owner || !verifyOwner(fact.sessionId, owner)) continue;
        const run = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(`runHistory:${fact.sessionId}:${fact.runId}`) as { value: string } | undefined;
        const history = JSON.parse(run?.value || 'null');
        if (history?.runId !== fact.runId || !/^[1-9][0-9]*$/u.test(history.statusVersion || '')) continue;
        const question = this.store.db.prepare('SELECT run_id,owner_hash FROM remote_decision_bindings WHERE key=? AND session_id=?')
          .get(`question:${fact.sessionId}:${fact.questionId}`, fact.sessionId) as { run_id: string; owner_hash: string } | undefined;
        const dispatch = this.store.db.prepare('SELECT run_id,owner_hash FROM local_execution_dispatch WHERE session_id=?')
          .get(fact.sessionId) as { run_id: string; owner_hash: string } | undefined;
        if (![question, dispatch].some(source => source?.run_id === fact.runId && source.owner_hash === fact.ownerHash)) continue;
        this.store.db.transaction(() => {
          const current = this.store.db.prepare('SELECT value FROM remote_state WHERE key=?').get(row.key) as { value: string } | undefined;
          if (current?.value === row.value) this.record(row.key, value);
        })();
      } catch { /* Unverifiable legacy evidence remains unchanged and cannot acquire authority. */ }
    }
    return rows.length === 32 ? rows.at(-1)!.key : null;
  }
}

/** Bounded metadata only; the worker compares a scope decision already verified by its parent. */
export function remoteQuestionEvidenceDigest(db: Database.Database): string {
  const digest = createHash('sha256'), budget = new EvidenceScanBudget();
  const rows = db.prepare(evidenceHeaders(db)).iterate() as Iterable<{ key: string | null; damaged: number }>;
  const binding = db.prepare(`SELECT CASE WHEN octet_length(fact)<=4096 THEN fact END AS fact,
    CASE WHEN octet_length(signature)<=128 THEN signature END AS signature FROM remote_question_bindings WHERE key=?`);
  for (const row of rows) {
    if (!budget.inspect(row.key, row.damaged)) throw new Error('REMOTE_QUESTION_EVIDENCE_BUDGET');
    if (!row.damaged) continue;
    const fact = binding.get(row.key) as BindingRow | undefined;
    const encoded = stableJson({ key: row.key, fact: fact?.fact ?? null, signature: fact?.signature ?? null });
    if (!budget.add(encoded)) throw new Error('REMOTE_QUESTION_EVIDENCE_BUDGET');
    digest.update(encoded).update('\n');
  }
  return digest.digest('hex');
}
