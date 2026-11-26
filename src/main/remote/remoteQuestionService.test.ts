import { afterEach, describe, expect, test, vi } from 'vitest';

import type { QuestionAdapterOutcome, QuestionDecisionOptions, QuestionResponse, RemoteQuestionItem } from '../../shared/remote/questions';
import { RemoteQuestionService } from './remoteQuestionService';
import type { RemoteStore } from './remoteStore';

const questions: RemoteQuestionItem[] = [{ questionId: 'choice', header: 'Choice', question: 'Which?',
  options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, isOther: true, allowSkip: false }];
const result = (answer = 'A') => ({ behavior: 'allow' as const, updatedInput: { answers: { choice: [answer] } } });
function fixture(anonymous = false) {
  const values = new Map<string, unknown>();
  const store = {
    get: vi.fn((key: string) => structuredClone(values.get(key) ?? null)),
    put: vi.fn((key: string, value: unknown) => { values.set(key, structuredClone(value)); }),
    transaction: vi.fn((action: () => unknown) => { const previous = new Map(values); try { return action(); } catch (error) { values.clear(); previous.forEach((v, k) => values.set(k, v)); throw error; } }),
    updateQuestion: vi.fn(),
  };
  let binding = { runId: 'run-1', owner: anonymous ? null : { userId: 'user-1', scopeKey: 'personal' }, agentId: 'main', cwd: '/work' };
  const resolve = vi.fn(async (response: QuestionResponse): Promise<QuestionAdapterOutcome> => ({ kind: 'confirmed', status: response.action === 'answer' ? 'answered' : 'cancelled', answers: response.answers }));
  const reconcile = vi.fn(async (): Promise<QuestionAdapterOutcome> => ({ kind: 'unknown' }));
  const registration = { requestId: 'native:1', sessionId: 'session-1', kind: 'native' as const, createdAt: Date.now(), expiresAt: Date.now() + 60_000, questions, resolve, reconcile };
  const service = new RemoteQuestionService(store as unknown as RemoteStore, () => binding);
  const state = service.register(registration)!;
  const mobile = (submissionId = 'mobile-1'): QuestionDecisionOptions => ({ submissionId, source: 'mobile', expectedVersion: state.questionVersion, operationDigest: state.operationDigest, beforeDispatch: () => {} });
  return { service, state, mobile, store, values, resolve, reconcile, registration, switchRun: () => { binding = { ...binding, runId: 'run-2' }; } };
}
afterEach(() => vi.restoreAllMocks());

describe('shared durable question arbiter', () => {
  test('publishes safe immutable form identity and confirms an anonymous local answer', async () => {
    const f = fixture(true);
    expect(f.state.questionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.state.operationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.store.updateQuestion.mock.calls[0][1]).not.toHaveProperty('requestId');
    const answer = await f.service.submit('native:1', result());
    expect(answer).toMatchObject({ kind: 'confirmed', status: 'answered', state: { resolution: { source: 'desktop' } } });
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('two ends racing with different answers only invoke the engine once', async () => {
    const f = fixture();
    let release!: () => void;
    f.resolve.mockImplementationOnce(async response => { await new Promise<void>(r => { release = r; }); return { kind: 'confirmed', status: 'answered', answers: response.answers }; });
    const local = f.service.submit('native:1', result('A'));
    const remote = await f.service.submit(f.state.questionId, result('B'), f.mobile());
    expect(remote.kind).toBe('known_not_applied');
    await Promise.resolve(); release();
    expect((await local).kind).toBe('confirmed');
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('mobile wins a race and a local click cannot fall through to a second resolver', async () => {
    const f = fixture();
    const mobile = f.service.submit(f.state.questionId, result(), f.mobile());
    expect((await f.service.submit('native:1', result('B'))).kind).toBe('known_not_applied');
    expect((await mobile).kind).toBe('confirmed');
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('the same immutable submission returns its receipt; a changed body conflicts', async () => {
    const f = fixture(); const options = f.mobile();
    await f.service.submit(f.state.questionId, result(), options);
    expect((await f.service.submit(f.state.questionId, result(), options)).kind).toBe('confirmed');
    expect((await f.service.submit(f.state.questionId, result('B'), options)).reason).toBe('IDEMPOTENCY_CONFLICT');
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('an unknown result remains reserved after restart and is never re-executed', async () => {
    const f = fixture(); f.resolve.mockRejectedValueOnce(new Error('RPC timeout'));
    expect((await f.service.submit(f.state.questionId, result(), f.mobile())).kind).toBe('unknown');
    const restarted = new RemoteQuestionService(f.store as unknown as RemoteStore, () => ({ runId: 'run-1', owner: { userId: 'user-1', scopeKey: 'personal' }, agentId: 'main', cwd: '/work' }));
    restarted.register(f.registration);
    expect((await restarted.reconcile('mobile-1'))?.kind).toBe('unknown');
    expect((await restarted.submit('native:1', result('B'))).kind).toBe('known_not_applied');
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('a terminal event does not prove a particular timed-out submission won', async () => {
    const f = fixture(); f.resolve.mockImplementationOnce(async () => { f.service.settle('native:1', { status: 'answered', answers: { choice: ['B'] } }); throw new Error('lost ACK'); });
    const response = await f.service.submit(f.state.questionId, result(), f.mobile());
    expect(response.kind).toBe('unknown');
    expect(f.service.getState('native:1')).toMatchObject({ status: 'answered', resolution: { phase: 'finished', answers: { choice: ['B'] } } });
  });
  test.each(['cancelled', 'expired', 'unavailable'] as const)('non-answer %s has no answer timestamp', status => {
    const f = fixture(); f.service.settle('native:1', { status });
    expect(f.service.getState('native:1')?.resolution).toMatchObject({ answeredAt: null, answers: null, phase: 'finished' });
  });
  test('expired MCP callback remains a known no-application with truthful expired state', async () => {
    const f = fixture(); f.resolve.mockImplementationOnce(() => { f.service.settle('native:1', { status: 'expired' }); return Promise.resolve({ kind: 'known_not_applied', status: 'expired' }); });
    expect(await f.service.submit('native:1', result())).toMatchObject({ kind: 'known_not_applied', status: 'expired', state: { resolution: { phase: 'finished', answeredAt: null } } });
  });
  test('binding changes while preparing prevent engine dispatch', async () => {
    const f = fixture();
    expect((await f.service.submit(f.state.questionId, result(), { ...f.mobile(), beforeDispatch: () => f.switchRun() })).kind).toBe('known_not_applied');
    expect(f.resolve).not.toHaveBeenCalled();
  });
  test('a projection failure never blocks desktop answers or loses core evidence', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.store.updateQuestion.mockImplementation(() => { throw new Error('derived data unavailable'); });
    expect((await f.service.submit('native:1', result())).kind).toBe('confirmed');
    expect(f.values.get(`questionDecision:${f.state.questionId}`)).toMatchObject({ state: { status: 'answered' } });
  });
  test('storage failure before a local answer keeps a live local arbiter and disables mobile', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.store.put.mockImplementation(() => { throw new Error('write failed'); });
    expect((await f.service.submit('native:1', result())).kind).toBe('confirmed');
    expect(f.service.getState('native:1')?.remoteAllowed).toBe(false);
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  test('storage failure before mobile dispatch is never downgraded to volatile remote execution', async () => {
    const f = fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.store.put.mockImplementation(() => { throw new Error('write failed'); });
    expect((await f.service.submit(f.state.questionId, result(), f.mobile())).kind).toBe('known_not_applied');
    expect(f.resolve).not.toHaveBeenCalled();
    expect((await f.service.submit('native:1', result())).kind).toBe('confirmed');
  });
  test('invalid or stale answers never reserve or dispatch', async () => {
    const f = fixture();
    expect((await f.service.submit(f.state.questionId, result(), { ...f.mobile(), expectedVersion: '100' })).kind).toBe('known_not_applied');
    expect((await f.service.submit('native:1', { behavior: 'allow', updatedInput: { answers: {} } })).kind).toBe('known_not_applied');
    expect(f.resolve).not.toHaveBeenCalled();
  });
  test('confirmed answers must match what was actually submitted', async () => {
    const f = fixture(); f.resolve.mockResolvedValueOnce({ kind: 'confirmed', status: 'answered', answers: { choice: ['B'] } });
    expect((await f.service.submit('native:1', result())).kind).toBe('unknown');
  });
});

test('event before confirmed RPC retains the first terminal timestamp and may refine attribution', async () => {
  const f = fixture(); let firstTimestamp: string | null = null;
  f.resolve.mockImplementationOnce(async response => {
    f.service.settle('native:1', { status: 'answered', answers: response.answers });
    firstTimestamp = f.service.getState('native:1')!.resolution.answeredAt;
    await new Promise(r => setTimeout(r, 2));
    return { kind: 'confirmed', status: 'answered', answers: response.answers };
  });
  const outcome = await f.service.submit('native:1', result());
  expect(outcome.state?.resolution).toMatchObject({ answeredAt: firstTimestamp, source: 'desktop', answers: { choice: ['A'] } });
});
test('reconciliation preserves the original terminal fact without claiming its submission won', async () => {
  const f = fixture(); f.resolve.mockRejectedValueOnce(new Error('lost response'));
  await f.service.submit(f.state.questionId, result(), f.mobile());
  f.service.settle('native:1', { status: 'answered', answers: { choice: ['A'] } });
  const first = f.service.getState('native:1')!.resolution.answeredAt;
  f.reconcile.mockResolvedValueOnce({ kind: 'unknown', status: 'answered', answers: { choice: ['A'] } });
  expect(await f.service.reconcile('mobile-1')).toMatchObject({ kind: 'unknown', state: { resolution: { answeredAt: first, source: 'unknown' } } });
});
test('a contradictory RPC receipt cannot replace an already settled winning answer', async () => {
  const f = fixture(); f.resolve.mockImplementationOnce(async response => {
    f.service.settle('native:1', { status: 'answered', answers: { choice: ['B'] } });
    return { kind: 'confirmed', status: 'answered', answers: response.answers };
  });
  expect(await f.service.submit('native:1', result())).toMatchObject({ kind: 'unknown', state: { resolution: { answers: { choice: ['B'] } } } });
});
test('unsubmitted transport suspension can reopen only on a fresh matching engine registration', () => {
  const f = fixture(); f.service.suspend('native:1');
  expect(f.service.getState('native:1')).toMatchObject({ remoteAllowed: false, resolution: { phase: 'unknown', source: null } });
  f.service.register(f.registration);
  expect(f.service.getState('native:1')).toMatchObject({ remoteAllowed: true, resolution: { phase: 'idle' } });
});
test('expiry and run closure retire unsubmitted forms but do not erase an uncertain dispatch', async () => {
  const f = fixture(); f.service.expire('native:1', Date.now() + 61_000);
  expect(f.service.getState('native:1')?.status).toBe('expired');
  const g = fixture(); g.resolve.mockRejectedValueOnce(new Error('timeout'));
  await g.service.submit(g.state.questionId, result(), g.mobile());
  g.service.expire('native:1', Date.now() + 61_000); g.service.closeSession('session-1', 'run-1');
  expect(g.service.getState('native:1')).toMatchObject({ status: 'pending', remoteAllowed: false, resolution: { phase: 'unknown' } });
});

test('unrelated remote cache read failure never captures ordinary local approval, but known questions retain arbitration', async () => {
  const f = fixture();
  f.store.get.mockImplementation(() => { throw new Error('derived read unavailable'); });
  expect(f.service.getState('ordinary-approval')).toBeNull();
  expect(f.service.getState('native:1')?.questionId).toBe(f.state.questionId);
  expect(f.service.getState(f.state.questionId)?.questionId).toBe(f.state.questionId);
});

test('anonymous forms stay locally answerable but cannot be answered by mobile', async () => {
  const f = fixture(true);
  expect(f.state.remoteAllowed).toBe(false);
  expect((await f.service.submit(f.state.questionId, result(), f.mobile())).kind).toBe('known_not_applied');
  expect((await f.service.submit('native:1', result())).kind).toBe('confirmed');
});
test('repeated expiry of an uncertain dispatch does not generate an endless projection stream', async () => {
  const f = fixture(); f.resolve.mockRejectedValueOnce(new Error('timeout'));
  await f.service.submit(f.state.questionId, result(), f.mobile());
  f.service.expirePending(Date.now() + 61_000);
  const version = f.service.getState('native:1')?.questionVersion;
  f.service.expirePending(Date.now() + 62_000);
  expect(f.service.getState('native:1')?.questionVersion).toBe(version);
});
