import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { availabilityControlSnapshot } from './remoteAvailabilitySource';
import { RemoteQuestionEvidenceBudget, remoteQuestionEvidenceDigest } from './remoteQuestionEvidence';
import { RemoteSecurityJournal } from './remoteSecurityJournal';
import { RemoteStore } from './remoteStore';

const owner = { userId: 'owner', scopeKey: 'personal' };
const databases: Database.Database[] = [];
const identity = { installationId: 'installation', databaseId: 'database', deviceKey: Buffer.alloc(32, 5).toString('base64url') };
const journal = () => new RemoteSecurityJournal(identity, { read: async () => ({ current: null, previous: null }), replace: async () => {}, close: () => {} }, true);
function authenticate(store: RemoteStore): void {
  const value = journal();
  store.configureQuestionEvidence({ sign: fact => value.signQuestionBinding(fact), verify: (fact, signature) => value.verifyQuestionBinding(fact, signature) });
}
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,model_override TEXT DEFAULT '',thinking_level TEXT DEFAULT '');
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
  authenticate(store);
  for (const id of ['good', 'bad']) {
    store.transaction(() => { db.prepare("INSERT INTO cowork_sessions(id,title,created_at,updated_at,status) VALUES(?,?,1,1,'idle')").run(id, id); store.assignNew(id, owner, 'local_create'); });
    store.beginRun(id, `run-${id}`);
  }
  const value = (id: string) => ({ binding: { owner }, state: { sessionId: id, runId: `run-${id}`, questionId: `q-${id}`,
    questionVersion: '1', status: 'pending', resolution: { phase: 'idle' }, remoteAllowed: false } });
  return { store, db, value };
}
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

describe('authenticated private question fault scope', () => {
  it.each(['{', JSON.stringify({ oversized: 'x'.repeat(33000) })])('isolates a damaged attributed question across reopen', damaged => {
    const { store, db, value } = fixture();
    store.put('questionDecision:bad', value('bad'));
    db.prepare('UPDATE remote_state SET value=? WHERE key=?').run(damaged, 'questionDecision:bad');
    const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
    authenticate(reopened);
    expect(reopened.questionStates('good')).toEqual([]);
    expect(reopened.needsSecurityRecovery()).toBe(false);
    expect(() => availabilityControlSnapshot(reopened, 'good')).not.toThrow();
    expect(() => reopened.questionStates('bad')).toThrow('REMOTE_QUESTION_EVIDENCE_INVALID');
    expect(() => availabilityControlSnapshot(reopened, 'bad')).toThrow('REMOTE_QUESTION_EVIDENCE_INVALID');
    expect(db.prepare('SELECT value FROM remote_state WHERE key=?').get('questionDecision:bad')).toEqual({ value: damaged });
  });
  it('keeps unattributed and tampered binding evidence behind the shared remote fence', () => {
    const { store, db, value } = fixture(); store.put('questionDecision:bad', value('bad'));
    db.prepare("UPDATE remote_question_bindings SET signature='forged' WHERE key='questionDecision:bad'").run();
    db.prepare("UPDATE remote_state SET value='{' WHERE key='questionDecision:bad'").run();
    expect(store.questionStates('good')).toEqual([]);
    expect(store.needsSecurityRecovery()).toBe(true);
    expect(() => availabilityControlSnapshot(store, 'good')).toThrow('REMOTE_CONTROL_DECISION_EVIDENCE_MISSING');
  });
  it('does not trust a binding signed by another installation', () => {
    const { store, db, value } = fixture(); store.put('questionDecision:bad', value('bad'));
    db.prepare("UPDATE remote_state SET value='{' WHERE key='questionDecision:bad'").run();
    const foreign = new RemoteSecurityJournal({ ...identity, installationId: 'other' }, { read: async () => ({ current: null, previous: null }), replace: async () => {}, close: () => {} }, true);
    store.configureQuestionEvidence({ sign: fact => foreign.signQuestionBinding(fact), verify: (fact, proof) => foreign.verifyQuestionBinding(fact, proof) });
    expect(store.questionEvidenceHealthy()).toBe(false);
  });
  it('does not rebind one private question to a different task or run', () => {
    const { store, value } = fixture(); store.put('questionDecision:q', value('bad'));
    expect(() => store.put('questionDecision:q', value('good'))).toThrow('REMOTE_QUESTION_BINDING_CHANGED');
    expect(store.get('questionDecision:q')).toEqual(value('bad'));
  });
  it('backfills healthy legacy facts only with an authenticated owner and independent run identity', () => {
    const { store, db, value } = fixture();
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('questionDecision:good', JSON.stringify(value('good')));
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('questionDecision:bad', '{');
    store.questionEvidence.backfill(() => false);
    expect(store.questionEvidence.binding('questionDecision:good')).toBeNull();
    store.questionEvidence.backfill(() => true);
    expect(store.questionEvidence.binding('questionDecision:good')).toMatchObject({ sessionId: 'good', runId: 'run-good' });
    expect(store.questionEvidence.binding('questionDecision:bad')).toBeNull();
    expect(store.questionEvidenceHealthy()).toBe(false);
  });
  it('bounds authenticated damage inspection and preserves a shared unknown fence on exhaustion', () => {
    const { store, db, value } = fixture();
    db.transaction(() => {
      for (let i = 0; i <= RemoteQuestionEvidenceBudget.DamagedRows; i++) store.put(`questionDecision:${String(i).padStart(4, '0')}`, value('bad'));
      db.prepare("UPDATE remote_state SET value='{' WHERE key LIKE 'questionDecision:%'").run();
    })();
    const bindings = vi.spyOn(store.questionEvidence, 'binding');
    expect(store.questionEvidenceHealthy()).toBe(false);
    expect(bindings.mock.calls.length).toBeLessThanOrEqual(RemoteQuestionEvidenceBudget.DamagedRows);
    expect(store.needsSecurityRecovery()).toBe(true);
    expect(() => remoteQuestionEvidenceDigest(db)).toThrow('REMOTE_QUESTION_EVIDENCE_BUDGET');
    expect(db.prepare("SELECT COUNT(*) AS count FROM remote_state WHERE key LIKE 'questionDecision:%' AND value='{'").get())
      .toEqual({ count: RemoteQuestionEvidenceBudget.DamagedRows + 1 });
  });
  it('stops immediately on unknown evidence and treats a time budget as unknown', () => {
    const { store, db } = fixture();
    db.prepare('INSERT INTO remote_state VALUES (?,?)').run('questionDecision:unknown', '{');
    const bindings = vi.spyOn(store.questionEvidence, 'binding');
    expect(store.questionEvidenceHealthy()).toBe(false); expect(bindings).toHaveBeenCalledTimes(1);
    bindings.mockClear();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(RemoteQuestionEvidenceBudget.TimeMs + 1);
    expect(store.questionEvidenceHealthy()).toBe(false); expect(bindings).not.toHaveBeenCalled();
  });
  it('keeps local decisions usable when optional attribution schema cannot initialize', () => {
    const { db, value } = fixture();
    db.exec('DROP TABLE remote_question_bindings; CREATE VIEW remote_question_bindings AS SELECT 1 AS incompatible');
    const reopened = new RemoteStore(db, { deferredProjection: true, deferSynchronization: true, restoreRuns: false });
    expect(() => reopened.put('questionDecision:good', value('good'))).not.toThrow();
    expect(reopened.questionStates('good')).toMatchObject([{ questionId: 'q-good' }]);
  });
});

it('does not roll back a local private decision after the optional attribution table becomes unavailable', () => {
  const { store, db, value } = fixture();
  db.exec('DROP TABLE remote_question_bindings');
  expect(() => store.put('questionDecision:good', value('good'))).not.toThrow();
  expect(store.get('questionDecision:good')).toEqual(value('good'));
  expect(store.questionStates('good')).toMatchObject([{ questionId: 'q-good' }]);
});


it('does not fence a device with more than 4096 healthy historical question decisions', () => {
  const { store, db, value } = fixture();
  db.transaction(() => {
    for (let i = 0; i < RemoteQuestionEvidenceBudget.Rows + 100; i++) {
      const state = { ...value('bad'), state: { ...value('bad').state, questionId: `historical-${i}`, status: 'resolved' } };
      db.prepare('INSERT INTO remote_state VALUES (?,?)').run(`questionDecision:history-${i}`, JSON.stringify(state));
    }
  })();
  store.put('questionDecision:good', value('good'));
  expect(store.questionEvidenceHealthy()).toBe(true);
  expect(store.needsSecurityRecovery()).toBe(false);
  expect(() => remoteQuestionEvidenceDigest(db)).not.toThrow();
  expect(store.questionStates('good', undefined, ['q-good'])).toMatchObject([{ questionId: 'q-good' }]);
  expect(() => availabilityControlSnapshot(store, 'good')).not.toThrow();
  store.put('questionDecision:zz-damaged', value('bad'));
  db.prepare("UPDATE remote_state SET value='{' WHERE key='questionDecision:zz-damaged'").run();
  expect(store.questionEvidenceHealthy('good')).toBe(true);
  expect(() => store.questionEvidenceHealthy('bad')).toThrow('REMOTE_QUESTION_EVIDENCE_INVALID');
});

it('uses indexes for healthy task lookup and the sparse damaged set', () => {
  const { db } = fixture();
  const plans = db.prepare(`EXPLAIN QUERY PLAN SELECT key FROM remote_state
    WHERE key>='questionDecision:' AND key<'questionDecision;'
    AND CASE WHEN octet_length(key)>1024 OR octet_length(value)>32768 THEN 1 ELSE NOT json_valid(value) END=1 ORDER BY key LIMIT 257`).all();
  expect(JSON.stringify(plans)).toContain('idx_remote_question_damaged');
});


it('commits a local answer when optional attribution writes fail and backfills its changed hash', () => {
  const { store, db, value } = fixture();
  store.put('questionDecision:good', value('good'));
  const old = store.questionEvidence.binding('questionDecision:good');
  db.exec(`CREATE TRIGGER fail_attribution BEFORE UPDATE ON remote_question_bindings BEGIN SELECT RAISE(ABORT,'attribution unavailable'); END;`);
  const answered = { ...value('good'), state: { ...value('good').state, status: 'answered', questionVersion: '2' } };
  expect(() => store.put('questionDecision:good', answered)).not.toThrow();
  expect(store.get('questionDecision:good')).toEqual(answered);
  expect(store.questionEvidence.binding('questionDecision:good')).toEqual(old);
  expect(() => store.questionStates('good')).toThrow('REMOTE_QUESTION_EVIDENCE_INVALID');
  db.exec('DROP TRIGGER fail_attribution');
  store.questionEvidence.backfill(() => true);
  expect(store.questionStates('good')).toMatchObject([{ status: 'answered', questionVersion: '2' }]);
});

it('keeps private question identity immutable even while optional attribution is unavailable', () => {
  const { store, db, value } = fixture(); store.put('questionDecision:good', value('good'));
  db.exec('DROP TABLE remote_question_bindings');
  expect(() => store.put('questionDecision:good', value('bad'))).toThrow('REMOTE_QUESTION_BINDING_CHANGED');
  expect(store.get('questionDecision:good')).toEqual(value('good'));
});


it('does not backfill a tampered signed body without matching authenticated pending intent', () => {
  const { store, db, value } = fixture(); store.put('questionDecision:good', value('good'));
  const changed = { ...value('good'), state: { ...value('good').state, status: 'answered' } };
  db.prepare('UPDATE remote_state SET value=? WHERE key=?').run(JSON.stringify(changed), 'questionDecision:good');
  store.questionEvidence.backfill(() => true);
  expect(() => store.questionStates('good')).toThrow('REMOTE_QUESTION_EVIDENCE_INVALID');
});


it('retries a failed attribution write in the background without restarting the desktop', () => {
  vi.useFakeTimers();
  try {
    const { store, db, value } = fixture(); store.put('questionDecision:good', value('good'));
    db.exec(`CREATE TRIGGER fail_attribution BEFORE UPDATE ON remote_question_bindings BEGIN SELECT RAISE(ABORT,'attribution unavailable'); END;`);
    const answered = { ...value('good'), state: { ...value('good').state, status: 'answered', questionVersion: '2' } };
    store.put('questionDecision:good', answered);
    expect(store.get('questionDecision:good')).toEqual(answered);
    db.exec('DROP TRIGGER fail_attribution');
    vi.advanceTimersByTime(30_000);
    expect(store.questionStates('good')).toMatchObject([{ status: 'answered', questionVersion: '2' }]);
    expect(store.get('questionEvidencePending:questionDecision:good')).toBeNull();
  } finally { vi.useRealTimers(); }
});


it('a failed attribution row does not starve another pending local answer', () => {
  const { store, db, value } = fixture();
  for (const id of ['bad', 'good']) store.put(`questionDecision:${id}`, value(id));
  db.exec(`CREATE TRIGGER fail_attribution BEFORE UPDATE ON remote_question_bindings BEGIN SELECT RAISE(ABORT,'attribution unavailable'); END;`);
  for (const id of ['bad', 'good']) store.put(`questionDecision:${id}`, { ...value(id), state: { ...value(id).state, status: 'answered', questionVersion: '2' } });
  db.exec(`DROP TRIGGER fail_attribution; CREATE TRIGGER fail_attribution BEFORE UPDATE ON remote_question_bindings
    WHEN NEW.key='questionDecision:bad' BEGIN SELECT RAISE(ABORT,'bad attribution'); END;`);
  expect(() => store.questionEvidence.repairPending()).not.toThrow();
  expect(store.questionStates('good')).toMatchObject([{ status: 'answered' }]);
  expect(store.get('questionEvidencePending:questionDecision:bad')).not.toBeNull();
  expect(store.get('questionEvidencePending:questionDecision:good')).toBeNull();
});
