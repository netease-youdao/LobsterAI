import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CoworkTurnUsageStatus } from '../../shared/cowork/llmTurnUsage';
import { RemoteTaskCredits, RemoteUsageCoverage, RemoteUsageReason, RemoteUsageScope } from '../../shared/remote/taskCredits';
import { payloadHash } from './canonical';
import { availabilityControlSnapshot } from './remoteAvailabilitySource';
import { projectLiveMessage } from './remoteLiveProjection';
import { RemoteStore } from './remoteStore';
import { hasTaskCreditsSnapshot, remoteTaskUsage, remoteTurnUsage } from './remoteTaskCredits';

const owner = { userId: 'owner', scopeKey: 'personal' };
const trace = 'a'.repeat(32), secondTrace = 'b'.repeat(32);
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function usage(overrides: Record<string, unknown> = {}) {
  return { traceId: trace, status: CoworkTurnUsageStatus.Settled, billingScope: RemoteUsageScope.Personal,
    creditsUsed: 4.835, displayCreditsUsed: 4.84, requestCount: 2, failedRequestCount: 0,
    updatedAt: 1793854800000, ...overrides };
}
function fixture(enabled = true) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE cowork_sessions(id TEXT PRIMARY KEY,title TEXT,created_at INTEGER,updated_at INTEGER,status TEXT,
    model_override TEXT,thinking_level TEXT,forked_at INTEGER);
    CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,content TEXT,metadata TEXT,created_at INTEGER,sequence INTEGER);`);
  const store = new RemoteStore(db); store.setEnabledOwner(owner); store.setReplyProjectionSupported(true);
  store.transaction(() => {
    db.exec("INSERT INTO cowork_sessions VALUES('s','Task',1,1,'idle',NULL,NULL,NULL)");
    store.assignNew('s', owner, 'local_create');
  });
  db.prepare("UPDATE remote_sync SET device_id='pc' WHERE local_id='s'").run();
  store.setProjectionIdentity('test', owner, 'pc');
  store.setTaskCreditsProjectionSupported(enabled);
  const add = (id: string, metadata: unknown, createdAt = 2, role = 'user') => store.transaction(() => {
    db.prepare("INSERT INTO cowork_messages VALUES(?,'s',?,'hello',?,?,?)").run(id, role, JSON.stringify(metadata), createdAt, createdAt);
  });
  const live = (id = 'u') => {
    const revision = db.prepare("SELECT revision FROM remote_live_revisions WHERE session_id='s' AND object_id=?").get(id) as { revision: number };
    return projectLiveMessage(db, { database: '', localId: 's', sessionId: store.sync('s')!.session_id, owner,
      deviceId: 'pc', objectId: id, revision: String(revision.revision), taskCreditsSupported: enabled })!.payload;
  };
  return { db, store, add, live };
}
describe('task credits public projection', () => {
  it('uses server display rounding and strips private or unexpected metadata', () => {
    const result = remoteTurnUsage({ turnUsage: usage({ tokenCreditEstimate: { secret: 'sk-private' }, prompt: 'private' }) })!;
    expect(result.displayCreditsUsed).toBe('4.84');
    expect(result).toEqual({ schemaVersion: 1, source: RemoteTaskCredits.Source, status: CoworkTurnUsageStatus.Settled,
      billingScope: RemoteUsageScope.Personal, displayCreditsUsed: '4.84', requestCount: 2, failedRequestCount: 0,
      mediaPending: false, updatedAt: new Date(1793854800000).toISOString() });
    expect(JSON.stringify(result)).not.toMatch(/traceId|private|token/);
  });
  it.each([-1, Infinity, NaN, '4.84', 1000000000000])('omits invalid monetary metadata %s without breaking the message', value => {
    expect(remoteTurnUsage({ turnUsage: usage({ displayCreditsUsed: value }) })).toBeUndefined();
  });
  it('rejects counts outside the server range and uses desktop half-expand rounding for legacy amounts', () => {
    expect(remoteTurnUsage({ turnUsage: usage({ requestCount: 2147483648 }) })).toBeUndefined();
    expect(remoteTurnUsage({ turnUsage: usage({ displayCreditsUsed: -0 }) })?.displayCreditsUsed).toBe('0.00');
    expect(remoteTurnUsage({ turnUsage: usage({ displayCreditsUsed: undefined, creditsUsed: 1.005 }) })?.displayCreditsUsed).toBe('1.01');
  });
  it('keeps a detached historical snapshot on the captured source version even when projection setup touches local hints', () => {
    const f = fixture(); f.add('u', { turnUsage: usage() });
    const original = remoteTaskUsage(f.db, 's');
    f.store.configureDetachedProjection({ database: '', target: '', sessionId: 's', owner, deviceId: 'pc', environment: 'test',
      agent: null, approval: false, questions: false, input: false, files: false, reply: true, taskCredits: true,
      taskCreditsSourceVersion: original.sourceVersion });
    f.store.setAgentSummaryResolver(() => null);
    expect(f.store.currentTaskUsage('s')).toEqual(original);
  });
  it('preserves unknown scope and never treats it as personal', () => {
    expect(remoteTurnUsage({ turnUsage: usage({ billingScope: undefined }) })).toMatchObject({
      status: CoworkTurnUsageStatus.Partial, billingScope: RemoteUsageScope.Unknown });
    const f = fixture(); f.add('u', { turnUsage: usage({ billingScope: undefined }) });
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ coverage: RemoteUsageCoverage.Unavailable, totals: [], knownTurnCount: 0,
      reasons: expect.arrayContaining([RemoteUsageReason.UnknownScope]) });
  });
  it('gates live and history, attaches only to user messages, and backfills revisions on enable', () => {
    const f = fixture(false); expect(f.store.taskCreditsBackfillEnabled('s')).toBe(false); f.add('u', { turnUsage: usage() }); f.add('a', { turnUsage: usage() }, 3, 'assistant');
    expect(f.live()).not.toHaveProperty('turnUsage');
    expect(f.store.snapshot('s').records.find(row => row.eventType === 'session.upsert')!.payload.session).not.toHaveProperty('taskUsage');
    const before = f.db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='u'").get() as { revision: number };
    f.store.setTaskCreditsProjectionSupported(true);
    const after = f.db.prepare("SELECT revision FROM remote_live_revisions WHERE object_id='u'").get() as { revision: number };
    expect(after.revision).toBeGreaterThan(before.revision);
    const records = f.store.snapshot('s').records;
    expect(records.find(row => row.payload.message?.messageId === 'u')!.payload.message.turnUsage.displayCreditsUsed).toBe('4.84');
    expect(records.find(row => row.payload.message?.messageId === 'a')!.payload.message).not.toHaveProperty('turnUsage');
    f.store.setTaskCreditsProjectionSupported(false);
    expect(f.store.taskCreditsBackfillEnabled('s')).toBe(true);
    expect(f.store.currentTaskUsage('s')).toBeUndefined();
  });
  it('uses the same safe usage in live and history and recalculates control totals after delayed metadata', () => {
    const f = fixture(); f.add('u', {});
    const initial = availabilityControlSnapshot(f.store, 's');
    expect(initial.records[0].payload.session.taskUsage.coverage).toBe(RemoteUsageCoverage.Unavailable);
    f.store.transaction(() => f.db.prepare("UPDATE cowork_messages SET metadata=? WHERE id='u'").run(JSON.stringify({ turnUsage: usage() })));
    const next = availabilityControlSnapshot(f.store, 's');
    expect(BigInt(next.revision)).toBeGreaterThan(BigInt(initial.revision));
    expect(BigInt(next.records[0].payload.session.taskUsage.sourceVersion)).toBeGreaterThan(BigInt(initial.records[0].payload.session.taskUsage.sourceVersion));
    const historical = f.store.snapshot('s').records.find(row => row.payload.message?.messageId === 'u')!.payload.message;
    expect(f.live().turnUsage).toEqual(historical.turnUsage);
    expect(next.records[0].payload.session.taskUsage).toEqual(remoteTaskUsage(f.db, 's'));
  });
  it('separates billing scopes and uses all local turns without a history page', () => {
    const f = fixture(); f.add('u', { turnUsage: usage() });
    f.add('u2', { turnUsage: usage({ traceId: secondTrace, billingScope: RemoteUsageScope.Enterprise, displayCreditsUsed: 1.02 }) }, 3);
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ coverage: RemoteUsageCoverage.Complete, totalTurnCount: 2, knownTurnCount: 2,
      totals: [{ billingScope: RemoteUsageScope.Personal, displayCreditsUsed: '4.84' }, { billingScope: RemoteUsageScope.Enterprise, displayCreditsUsed: '1.02' }] });
    expect(remoteTaskUsage(f.db, 's')).toEqual(remoteTaskUsage(f.db, 's'));
  });
  it.each(['trace', 'related', 'media'])('excludes every conflicting %s attribution instead of double counting', kind => {
    const f = fixture();
    f.add('u', { turnUsage: usage(), ...(kind === 'media' ? { turnMediaTaskIds: ['12'] } : {}) });
    f.add('u2', { turnUsage: usage({ traceId: kind === 'trace' ? trace : secondTrace }),
      ...(kind === 'related' ? { llmTrace: { traceId: secondTrace, relatedTraceIds: [trace] } } : {}),
      ...(kind === 'media' ? { turnMediaTaskIds: ['12'] } : {}) }, 3);
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ knownTurnCount: 0, unavailableTurnCount: 2, totals: [], reasons: [RemoteUsageReason.Duplicate] });
  });
  it('excludes inherited fork costs and hidden foreign account runs', () => {
    const f = fixture();
    f.store.transaction(() => f.db.prepare("UPDATE cowork_sessions SET forked_at=10 WHERE id='s'").run());
    f.add('inherited', { turnUsage: usage() });
    f.store.put('syncTargetHistory:s', { runIds: ['foreign'] });
    f.add('foreign', { remoteRunId: 'foreign', turnUsage: usage({ traceId: secondTrace }) }, 11);
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ knownTurnCount: 0, unavailableTurnCount: 2,
      reasons: expect.arrayContaining([RemoteUsageReason.Duplicate, RemoteUsageReason.UnknownScope]) });
    expect(f.live('foreign')).not.toHaveProperty('turnUsage');
    expect(f.live('inherited')).not.toHaveProperty('turnUsage');
    expect(f.store.snapshot('s').records.find(row => row.payload.message?.messageId === 'inherited')!.payload.message).not.toHaveProperty('turnUsage');
  });
  it('keeps partial amounts and pending separate from coverage completeness', () => {
    const f = fixture(); f.add('u', { turnUsage: usage({ status: CoworkTurnUsageStatus.Partial, mediaPending: true }) });
    f.add('u2', { turnUsage: usage({ traceId: secondTrace, status: CoworkTurnUsageStatus.Pending }) }, 3);
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ coverage: RemoteUsageCoverage.Partial, knownTurnCount: 1,
      pendingTurnCount: 2, unavailableTurnCount: 1, totalTurnCount: 2 });
  });
  it('bounds both row count and raw metadata bytes and never marks a truncated scan complete', () => {
    const f = fixture();
    f.store.transaction(() => { const insert = f.db.prepare("INSERT INTO cowork_messages VALUES(?,'s','user','hello','{}',2,?)");
      for (let index = 0; index <= RemoteTaskCredits.MaximumTurns; index++) insert.run(String(index), index); });
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ totalTurnCount: 10001, unavailableTurnCount: 10000,
      reasons: expect.arrayContaining([RemoteUsageReason.ScanLimit]) });
    const g = fixture(); g.add('huge', { turnUsage: usage(), private: 'x'.repeat(RemoteTaskCredits.ScanBytes + 1) });
    expect(remoteTaskUsage(g.db, 's')).toMatchObject({ totalTurnCount: 1, knownTurnCount: 0, unavailableTurnCount: 0,
      reasons: [RemoteUsageReason.ScanLimit] });
  });
  it('advances persisted source versions when a cached snapshot changes target history or legacy command attribution', () => {
    const f = fixture(); f.add('u', { remoteCommandId: 'command', turnUsage: usage() });
    const original = remoteTaskUsage(f.db, 's');
    f.db.prepare('INSERT OR REPLACE INTO remote_state VALUES (?,?)').run('syncTargetHistory:s', JSON.stringify({ targetId: 'current', runIds: [] }));
    f.store.put('inbox:command', { targetId: 'old', localSessionId: 's' });
    const excluded = remoteTaskUsage(f.db, 's');
    expect(BigInt(excluded.sourceVersion)).toBeGreaterThan(BigInt(original.sourceVersion));
    expect(excluded).toMatchObject({ knownTurnCount: 0, reasons: [RemoteUsageReason.UnknownScope] });
    expect(excluded.updatedAt).toBe(new Date(2).toISOString());
    expect(f.live()).not.toHaveProperty('turnUsage');
    f.store.put('inbox:current:command', { targetId: 'current', localSessionId: 's' });
    const restored = remoteTaskUsage(f.db, 's');
    expect(BigInt(restored.sourceVersion)).toBeGreaterThan(BigInt(excluded.sourceVersion));
    expect(restored.knownTurnCount).toBe(1);
    expect(f.live().turnUsage.displayCreditsUsed).toBe('4.84');
  });
  it('invalidates cached run visibility and fails closed for malformed attribution state', () => {
    const f = fixture();
    f.db.prepare("INSERT INTO local_execution_origin VALUES('s','run','desktop',?,'{}')").run(payloadHash(owner));
    f.add('u', { remoteRunId: 'run', turnUsage: usage() });
    const original = remoteTaskUsage(f.db, 's');
    f.store.put('runPublished:run', false);
    const excluded = remoteTaskUsage(f.db, 's');
    expect(BigInt(excluded.sourceVersion)).toBeGreaterThan(BigInt(original.sourceVersion));
    expect(excluded.knownTurnCount).toBe(0);
    f.store.put('runPublished:run', false);
    expect(remoteTaskUsage(f.db, 's').sourceVersion).toBe(excluded.sourceVersion);
    f.db.prepare("UPDATE remote_state SET value='{' WHERE key='runPublished:run'").run();
    const invalid = remoteTaskUsage(f.db, 's');
    expect(BigInt(invalid.sourceVersion)).toBeGreaterThan(BigInt(excluded.sourceVersion));
    expect(invalid).toMatchObject({ knownTurnCount: 0, reasons: [RemoteUsageReason.Invalid] });
    f.db.prepare("INSERT INTO remote_state VALUES('syncTargetHistory:s','{')").run();
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ knownTurnCount: 0, reasons: [RemoteUsageReason.Invalid] });
  });
  it('requires a current-owner run origin and drops malformed published state from both projections', () => {
    const f = fixture(); f.add('u', { remoteRunId: 'run', turnUsage: usage() });
    expect(remoteTaskUsage(f.db, 's').knownTurnCount).toBe(0);
    expect(f.live()).not.toHaveProperty('turnUsage');
    f.db.prepare("INSERT INTO local_execution_origin VALUES('s','run','desktop','old-owner','{}')").run();
    expect(remoteTaskUsage(f.db, 's').knownTurnCount).toBe(0);
    f.db.prepare("UPDATE local_execution_origin SET owner_hash=? WHERE session_id='s' AND run_id='run'").run(payloadHash(owner));
    expect(remoteTaskUsage(f.db, 's').knownTurnCount).toBe(1);
    f.store.put('runPublished:run', 'invalid');
    expect(remoteTaskUsage(f.db, 's')).toMatchObject({ knownTurnCount: 0, reasons: [RemoteUsageReason.Invalid] });
    expect(f.live()).not.toHaveProperty('turnUsage');
    expect(f.store.snapshot('s').records.find(row => row.payload.message?.messageId === 'u')!.payload.message).not.toHaveProperty('turnUsage');
  });
  it('does not attach task credits after the active owner changes', () => {
    const f = fixture(); f.add('u', { turnUsage: usage() });
    f.store.setProjectionIdentity('test', { userId: 'other', scopeKey: 'personal' }, 'pc');
    f.store.setTaskCreditsProjectionSupported(true);
    expect(f.store.currentTaskUsage('s')).toBeUndefined();
    expect(f.store.taskCreditsBackfillEnabled('s')).toBe(false);
  });
  it('recognizes immutable usage payloads on downgrade without inspecting message text', () => {
    expect(hasTaskCreditsSnapshot({ facts: [{ payload: { session: { taskUsage: {} } } }] })).toBe(true);
    expect(hasTaskCreditsSnapshot(JSON.stringify({ records: [{ message: { turnUsage: {} } }] }))).toBe(true);
    expect(hasTaskCreditsSnapshot({ text: 'show turnUsage in a document' })).toBe(false);
  });
});
