import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalState } from '../../../shared/cowork/approval';
import { ApprovalDecisionService, type ApprovalPersistence, type ApprovalRegistration } from './approvalDecisionService';
const dbs: Database.Database[] = [];
const services: ApprovalDecisionService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.dispose(); vi.useRealTimers(); for (const db of dbs.splice(0)) db.close(); });
function setup() {
  const db = new Database(':memory:'); dbs.push(db); db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)');
  const storage: ApprovalPersistence = {
    get: <T>(key: string): T | null => { const row = db.prepare('SELECT value FROM state WHERE key=?').get(key) as { value: string } | undefined; return row ? JSON.parse(row.value) : null; },
    put: (key, value) => { db.prepare('INSERT OR REPLACE INTO state VALUES (?,?)').run(key, JSON.stringify(value)); },
    entries: <T>(prefix: string) => (db.prepare('SELECT key,value FROM state WHERE key LIKE ?').all(`${prefix}%`) as { key: string; value: string }[]).map(r => ({ key: r.key, value: JSON.parse(r.value) as T })),
    scanEntries: <T>(prefix: string, options: { after?: string; limit?: number } = {}) => {
      const rows = db.prepare('SELECT key,value FROM state WHERE key LIKE ? AND key>? ORDER BY key LIMIT ?')
        .all(`${prefix}%`, options.after ?? '', options.limit ?? 50) as Array<{ key: string; value: string }>;
      return { rows: rows.map(row => {
        try { return { key: row.key, state: 'valid' as const, value: JSON.parse(row.value) as T }; }
        catch { return { key: row.key, state: 'corrupt' as const, reason: 'STATE_RECORD_INVALID' }; }
      }), nextCursor: rows.length === (options.limit ?? 50) ? rows.at(-1)!.key : null };
    },
    transaction: operation => db.transaction(operation)(),
  };
  const states: ApprovalState[] = [];
  let binding = { runId: 'run', identity: { owner: 'user', agent: 'main' } };
  const request = vi.fn();
  const options = { persistence: storage, getGateway: () => ({ request }), getBinding: () => binding,
    emitState: (_id: string, state: ApprovalState) => { expect(db.inTransaction).toBe(true); states.push(state); },
    emitResolved: vi.fn(), emitRequest: vi.fn(), emitError: vi.fn(), continueSession: vi.fn(async (_id: string, _decision: 'approve' | 'deny', guard: () => void) => { guard(); }), isSessionActive: () => false };
  const make = () => {
    const service = new ApprovalDecisionService(options); services.push(service);
    service.setGatewayContract({ version: '2026.8.1', bootId: 'boot', methods: ['approval.get', 'approval.resolve', 'exec.approval.list', 'plugin.approval.list'] });
    service.configure({ enabled: true, projectionSupported: true });
    return service;
  };
  const service = make();
  const registration: ApprovalRegistration = { pending: { requestId: 'p', sessionId: 's', kind: 'exec' },
    rawRequest: { command: 'rm report.txt', cwd: '/workspace', sessionKey: 'agent:main:desktop:s' },
    permission: { requestId: 'p', toolName: 'Bash', toolInput: {} }, createdAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 60000,
    description: { title: '删除', summary: '删除 report.txt', remoteSafe: true } };
  const state = service.register(registration)!;
  const snapshot = (decision = 'allow-once', overrides = {}) => ({ id: 'p', presentation: { kind: 'exec' }, createdAtMs: registration.createdAtMs,
    expiresAtMs: registration.expiresAtMs, status: decision === 'deny' ? 'denied' : 'allowed', decision, resolvedAtMs: Date.now(),
    source: { sessionKey: registration.rawRequest.sessionKey }, ...overrides });
  const opts = (id = 'mobile', overrides = {}) => ({ submissionId: id, source: 'mobile' as const, expectedVersion: state.approvalVersion,
    operationDigest: state.operationDigest, beforeDispatch: () => {}, ...overrides });
  return { service, make, storage, db, states, registration, state, snapshot, opts, request, options, setBinding: () => { binding = { ...binding, identity: { owner: 'other', agent: 'main' } }; } };
}
describe('durable dual approval arbiter', () => {
  it('reserves before dispatch, arbitrates mobile versus local, retries without a second RPC', async () => {
    const f = setup(); let finish!: (value: unknown) => void;
    f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = f.service.submit('p', 'allow-once', f.opts());
    expect(f.service.getState('p')?.resolution.phase).toBe('submitting');
    expect(f.service.getState('p')?.approvalVersion).toBe('2');
    expect((await f.service.submit('p', 'deny', { submissionId: 'desktop', source: 'desktop' })).kind).toBe('known_not_applied');
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledOnce();
    finish({ applied: true, approval: f.snapshot() });
    expect((await first).kind).toBe('confirmed');
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('confirmed');
    expect((await f.service.submit('p', 'deny', f.opts())).reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.service.getState('p')?.resolution.source).toBe('mobile');
    expect(f.options.emitResolved).toHaveBeenCalledOnce();
  });
  it('same-decision external winner confirms facts but rejects this command', async () => {
    const f = setup(); f.request.mockResolvedValue({ applied: false, approval: f.snapshot() });
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('known_not_applied');
    expect(f.service.getState('p')?.status).toBe('approved');
    expect(f.service.getState('p')?.resolution.source).toBe('unknown');
  });
  it('merges resolved before ACK and duplicates without duplicate dismiss or continuation', async () => {
    vi.useFakeTimers(); const f = setup();
    f.request.mockImplementation(async () => {
      f.service.mergeResolved('p', 'allow-once', Date.now(), f.registration.rawRequest);
      f.service.mergeResolved('p', 'allow-once', Date.now(), f.registration.rawRequest);
      return { applied: true, approval: f.snapshot() };
    });
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('confirmed');
    expect(f.options.emitResolved).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.options.continueSession).toHaveBeenCalledOnce();
    f.service.mergeResolved('p', 'allow-once', Date.now(), f.registration.rawRequest);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.options.continueSession).toHaveBeenCalledOnce();
  });
  it('post-dispatch timeout remains unknown across TTL and reconstruction', async () => {
    const f = setup(); f.request.mockRejectedValue(new Error('connection lost'));
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('unknown');
    f.service.expire(Date.now() + 999999);
    expect(f.service.getState('p')?.status).toBe('pending');
    const recovered = f.make();
    expect(recovered.getState('p')?.resolution.phase).toBe('unknown');
    expect((await recovered.submit('p', 'deny', { submissionId: 'second', source: 'desktop' })).kind).toBe('known_not_applied');
    expect(f.request.mock.calls.filter(c => c[0] === 'approval.resolve')).toHaveLength(1);
  });
  it('persisted reserved release requires original receipt and exact pending proof', async () => {
    const f = setup();
    const waiting = f.service.submit('p', 'allow-once', f.opts('mobile', { beforeDispatch: () => new Promise(() => {}) }));
    void waiting;
    f.request.mockImplementation(async (method: string) => method.endsWith('.list')
      ? [{ id: 'p', request: f.registration.rawRequest, createdAtMs: f.registration.createdAtMs, expiresAtMs: f.registration.expiresAtMs }]
      : { approval: f.snapshot('', { status: 'pending' }) });
    const result = await f.service.reconcileSubmission('mobile', { canProveNeverDispatched: true });
    expect(result?.kind).toBe('known_not_applied');
    expect(f.service.getState('p')?.resolution.phase).toBe('idle');
    expect(f.service.getState('p')?.approvalVersion).toBe('3');
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('known_not_applied');
    expect(f.request.mock.calls.filter(c => c[0] === 'approval.resolve')).toHaveLength(0);
  });
  it('before-dispatch rechecks owner and guard; safely releases only never-dispatched reservation', async () => {
    const f = setup();
    const result = await f.service.submit('p', 'allow-once', f.opts('mobile', { beforeDispatch: () => { f.setBinding(); } }));
    expect(result.kind).toBe('known_not_applied'); expect(f.request).not.toHaveBeenCalled();
    expect(f.service.getState('p')?.remoteAllowed).toBe(false);
  });
  it('late trusted decision supplements cancellation without reopening or continuing', async () => {
    vi.useFakeTimers(); const f = setup(); f.request.mockRejectedValue(new Error('timeout'));
    await f.service.submit('p', 'allow-once', f.opts()); f.service.closeSession('s', 'run');
    const cancelledAt = f.service.getState('p')?.resolvedAt;
    f.service.mergeResolved('p', 'allow-once', Date.now(), f.registration.rawRequest);
    expect(f.service.getState('p')).toMatchObject({ status: 'cancelled', resolvedAt: cancelledAt, resolution: { confirmedDecision: 'approve' } });
    await vi.advanceTimersByTimeAsync(2000); expect(f.options.continueSession).not.toHaveBeenCalled();
  });
  it('does not trust wrong epoch, request, timestamps or mismatched snapshot', async () => {
    const f = setup();
    f.service.mergeResolved('p', 'deny', Date.now(), { ...f.registration.rawRequest, command: 'rm secrets' });
    expect(f.service.getState('p')?.status).toBe('pending');
    f.request.mockResolvedValue({ applied: true, approval: f.snapshot('allow-once', { expiresAtMs: 123 }) });
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('unknown');
  });
  it('updates inbox and public fact in the same SQLite transaction', async () => {
    const f = setup(); f.storage.put('inbox:mobile', { localSessionId: 's', runId: 'run', state: 'executing', claimToken: 'receipt' });
    f.request.mockResolvedValue({ applied: true, approval: f.snapshot('deny') });
    await f.service.submit('p', 'deny', f.opts());
    expect(f.storage.get('inbox:mobile')).toMatchObject({ state: 'applied', claimToken: 'receipt', result: { outcome: 'approval_applied' } });
    expect(f.service.getState('p')?.resolution.confirmedDecision).toBe('deny');
  });
  it('feature disable keeps in-flight ownership; stale versions do not dispatch', async () => {
    const f = setup(); f.service.configure({ enabled: false, projectionSupported: true });
    expect(f.service.getState('p')?.remoteAllowed).toBe(false);
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('known_not_applied');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('an anonymous local approval uses the same durable service', async () => {
    const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot('deny') });
    expect((await f.service.submit('p', 'deny')).kind).toBe('confirmed');
    expect(f.storage.entries('approvalResolution:')).toHaveLength(1);
  });
  it('uses a durable session continuation lane while asynchronous preparation has not marked active', async () => {
    vi.useFakeTimers(); const f = setup();
    const second = { ...f.registration, pending: { ...f.registration.pending, requestId: 'p2' }, permission: { ...f.registration.permission, requestId: 'p2' } };
    f.service.register(second);
    f.request.mockImplementation(async (_method: string, params: { id: string }) => ({ applied: true, approval: f.snapshot('allow-once', { id: params.id }) }));
    let finish!: () => void;
    f.options.continueSession.mockImplementation(async (_id, _decision, guard) => { await new Promise<void>(resolve => { finish = resolve; }); guard(); });
    await f.service.submit('p', 'allow-once'); await f.service.submit('p2', 'allow-once');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.options.continueSession).toHaveBeenCalledOnce();
    expect(f.storage.entries('approvalContinuationLane:s:')[0]?.value).toMatchObject({ phase: 'dispatching', members: ['p', 'p2'] });
    finish(); await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000); expect(f.options.continueSession).toHaveBeenCalledOnce();
  });
  it('an explicit stop between approval confirmation and continuation cancels the pending send', async () => {
    vi.useFakeTimers(); const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot() });
    await f.service.submit('p', 'allow-once'); f.service.closeSession('s', 'run');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.options.continueSession).not.toHaveBeenCalled(); expect(f.service.getState('p')?.status).toBe('approved');
  });
  it('rechecks the original owner/run after asynchronous continuation preparation', async () => {
    vi.useFakeTimers(); const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot() });
    const sent = vi.fn(); let finish!: () => void;
    f.options.continueSession.mockImplementation(async (_id, _decision, guard) => { await new Promise<void>(resolve => { finish = resolve; }); guard(); sent(); });
    await f.service.submit('p', 'allow-once'); await vi.advanceTimersByTimeAsync(1000);
    f.setBinding(); finish(); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(sent).not.toHaveBeenCalled();
    expect(f.storage.entries('approvalContinuationLane:s:')[0]?.value).toMatchObject({ phase: 'unknown' });
  });
  it('recovered idle state stays disabled until the same-epoch pending request is verified', async () => {
    const f = setup(); f.request.mockImplementation(async (method: string) => method.endsWith('.list')
      ? [{ id: 'p', request: f.registration.rawRequest, createdAtMs: f.registration.createdAtMs, expiresAtMs: f.registration.expiresAtMs }]
      : { approval: f.snapshot('', { status: 'pending' }) });
    const recovered = f.make();
    expect(recovered.getState('p')?.resolution.phase).toBe('unknown');
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(recovered.getState('p')?.resolution.phase).toBe('idle');
    expect(recovered.getState('p')?.approvalVersion).not.toBe('1');
  });
  it('rejects an applied ACK whose actual decision differs from the requested intent', async () => {
    const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot('deny') });
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('known_not_applied');
    expect(f.service.getState('p')?.resolution.confirmedDecision).toBe('deny');
  });

  it('isolates invalid JSON and unsupported versions during construction without rewriting evidence', () => {
    const f = setup();
    f.db.prepare('INSERT INTO state VALUES (?,?)').run('approvalResolution:broken', '{private evidence');
    const unsupported = { ...f.storage.get<Record<string, unknown>>('approvalResolution:p'), formatVersion: 2 };
    f.storage.put('approvalResolution:future', unsupported);
    const recovered = f.make();
    expect(recovered.supportsDualApproval()).toBe(true);
    expect(recovered.listPending().map(row => row.request.requestId)).toEqual(['p']);
    expect(() => recovered.getState('broken')).toThrow('Approval record integrity unavailable');
    expect(() => recovered.getState('future')).toThrow('Approval record integrity unavailable');
    expect(recovered.getState('absent')).toBeNull();
    expect(f.db.prepare('SELECT value FROM state WHERE key=?').get('approvalResolution:broken')).toEqual({ value: '{private evidence' });
    expect(f.storage.get('approvalResolution:future')).toEqual(unsupported);
  });
  it('advances safe scan pages past a corrupt prefix and still closes the healthy task', () => {
    const f = setup();
    for (let i = 0; i < 55; i++) f.db.prepare('INSERT INTO state VALUES (?,?)').run(`approvalResolution:bad${i}`, '{');
    const recovered = f.make();
    expect(recovered.listPending()).toHaveLength(1);
    recovered.closeSession('s', 'run');
    expect(recovered.getState('p')?.status).toBe('cancelled');
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM state WHERE value='{'").get()).toEqual({ count: 55 });
  });
  it('keeps malformed v1 schema strict in get and isolates it from another expiry', () => {
    const f = setup();
    f.storage.put('approvalResolution:broken', { formatVersion: 1, state: null });
    expect(() => f.service.getPending('broken')).toThrow('Approval record integrity unavailable');
    expect(() => f.service.expire(Date.now() + 999999)).not.toThrow();
    expect(f.service.getState('p')?.status).toBe('expired');
    expect(f.storage.get('approvalResolution:broken')).toEqual({ formatVersion: 1, state: null });
  });
  it('never interprets opaque approval evidence as no pending approvals for automatic continuation', async () => {
    vi.useFakeTimers(); const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot() });
    expect((await f.service.submit('p', 'allow-once', f.opts())).kind).toBe('confirmed');
    f.db.prepare('INSERT INTO state VALUES (?,?)').run('approvalResolution:opaque', '{');
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.options.continueSession).not.toHaveBeenCalled();
    expect(f.service.getState('p')?.status).toBe('approved');
    expect(f.storage.entries('approvalContinuationLane:')).toEqual([]);
  });
  it('limits a coherent corrupt identity to its own session during automatic continuation', async () => {
    vi.useFakeTimers(); const f = setup();
    const broken = f.storage.get<Record<string, any>>('approvalResolution:p')!;
    broken.pending = { ...broken.pending, requestId: 'broken', sessionId: 'other' };
    broken.state = { ...broken.state, requestId: 'broken', sessionId: 'other', approvalVersion: 'invalid' };
    f.storage.put('approvalResolution:broken', broken);
    f.request.mockResolvedValue({ applied: true, approval: f.snapshot() });
    await f.service.submit('p', 'allow-once', f.opts());
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.options.continueSession).toHaveBeenCalledOnce();
    expect(f.storage.get('approvalResolution:broken')).toEqual(broken);
  });
  it('rechecks opaque evidence after asynchronous continuation preparation', async () => {
    vi.useFakeTimers(); const f = setup(); f.request.mockResolvedValue({ applied: true, approval: f.snapshot() });
    const dispatched = vi.fn(); let finish!: () => void;
    f.options.continueSession.mockImplementation(async (_id, _decision, guard) => {
      await new Promise<void>(resolve => { finish = resolve; }); guard(); dispatched();
    });
    await f.service.submit('p', 'allow-once', f.opts()); await vi.advanceTimersByTimeAsync(1000);
    f.db.prepare('INSERT INTO state VALUES (?,?)').run('approvalResolution:opaque', '{');
    finish(); for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(dispatched).not.toHaveBeenCalled();
    expect(f.storage.entries('approvalContinuationLane:s:')[0]?.value).toMatchObject({ phase: 'unknown' });
  });
  it('does not classify database failures as corrupt rows or an empty approval catalog', () => {
    const f = setup(); const failure = new Error('SQLITE_IOERR');
    f.storage.scanEntries = () => { throw failure; };
    expect(() => f.service.listPending()).toThrow(failure);
    expect(() => f.make()).toThrow(failure);
  });

});
