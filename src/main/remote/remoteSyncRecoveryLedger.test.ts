import { describe, expect, it } from 'vitest';

import { payloadHash } from './canonical';
import { finishRecoveryRequest, readRecoveryLedger, RecoveryBudget, recoveryDependencyEvidence, recoveryDisplay, RecoveryOutcome, RemoteRecoveryLimiter, reserveRecoveryRequest, reserveRecoveryRound } from './remoteSyncRecoveryLedger';
const input = (now = 100, evidence = 'a') => ({ now, failureKey: payloadHash('failure'), evidenceKey: payloadHash(evidence), contextKey: payloadHash('context'), operationKey: payloadHash('operation') });
const empty = () => readRecoveryLedger('{}')!;
describe('durable automatic recovery budget', () => {
  it('reserves once across restart and does not reuse evidence after 24 hours', () => {
    const first = reserveRecoveryRound(empty(), input())!;
    const restarted = reserveRecoveryRound(readRecoveryLedger(JSON.stringify(first.ledger))!, input(200))!;
    expect(restarted.round.attemptId).toBe(first.round.attemptId); expect(restarted.ledger.times).toEqual([100]);
    const request = reserveRecoveryRequest(restarted.ledger, first.round.attemptId, 200)!;
    const finished = finishRecoveryRequest(request.ledger, request.token, { success: true, now: 201, outcome: RecoveryOutcome.Blocked })!;
    expect(reserveRecoveryRound(finished, input(RecoveryBudget.Day * 2))).toBeNull();
  });
  it('charges crash-unknown requests and accepts new evidence after the third expired lease', () => {
    let { ledger, round } = reserveRecoveryRound(empty(), input())!;
    for (let index = 0; index < 3; index++) ledger = readRecoveryLedger(JSON.stringify(reserveRecoveryRequest(ledger, round.attemptId, 100 + index * RecoveryBudget.Lease)!.ledger))!;
    expect(reserveRecoveryRequest(ledger, round.attemptId, 100 + 3 * RecoveryBudget.Lease)).toBeNull();
    const changed = reserveRecoveryRound(ledger, input(100 + 3 * RecoveryBudget.Lease, 'capability-restored'))!;
    expect(changed.ledger.rounds[0].outcome).toBe(RecoveryOutcome.Blocked); expect(changed.ledger.times).toHaveLength(2);
  });
  it('rejects a late response after lease replacement without refunding the unknown request', () => {
    const first = reserveRecoveryRound(empty(), input())!;
    const a = reserveRecoveryRequest(first.ledger, first.round.attemptId, 100)!;
    const b = reserveRecoveryRequest(a.ledger, first.round.attemptId, 30100)!;
    expect(finishRecoveryRequest(b.ledger, a.token, { success: true, now: 30101 })).toBeNull();
    expect(finishRecoveryRequest(b.ledger, b.token, { success: true, now: 30101 })!.rounds[0].failures).toBe(1);
  });
  it('enforces two complete rounds in the rolling window independently of evidence changes', () => {
    let ledger = empty();
    for (let index = 0; index < 2; index++) {
      const round = reserveRecoveryRound(ledger, input(100 + index, String(index)))!;
      const request = reserveRecoveryRequest(round.ledger, round.round.attemptId, 100 + index)!;
      ledger = finishRecoveryRequest(request.ledger, request.token, { success: true, now: 100 + index, outcome: RecoveryOutcome.Blocked })!;
    }
    expect(reserveRecoveryRound(ledger, input(102, 'third'))).toBeNull();
    expect(reserveRecoveryRound(ledger, input(RecoveryBudget.Day + 101, 'third'))).not.toBeNull();
  });
  it('requires recovery newer than the final failure, not an earlier successful connection', () => {
    let { ledger, round } = reserveRecoveryRound(empty(), { ...input(), dependencyEpoch: 0 })!;
    for (let index = 0; index < 3; index++) {
      const request = reserveRecoveryRequest(ledger, round.attemptId, 100 + index, 1)!;
      ledger = finishRecoveryRequest(request.ledger, request.token, { success: false, now: 100 + index, dependencyFailure: true, dependencyEpoch: 1 })!;
    }
    expect(recoveryDependencyEvidence(ledger, input().failureKey, 1, 105)).toBe(0);
    expect(recoveryDependencyEvidence(ledger, input().failureKey, 2, 105)).toBe(2);
  });
  it('caps unresolved evidence at eight without eviction', () => {
    let ledger = empty();
    for (let index = 0; index < 8; index++) {
      const now = index * RecoveryBudget.Day + 100, round = reserveRecoveryRound(ledger, input(now, String(index)))!;
      const request = reserveRecoveryRequest(round.ledger, round.round.attemptId, now)!;
      ledger = finishRecoveryRequest(request.ledger, request.token, { success: true, now, outcome: RecoveryOutcome.Blocked })!;
    }
    expect(reserveRecoveryRound(ledger, input(10 * RecoveryBudget.Day, 'ninth'))).toBeNull();
    expect(ledger.rounds).toHaveLength(8);
  });
  it('fails closed on corrupt/future/oversized metadata and clock rollback', () => {
    expect(readRecoveryLedger('{')).toBeNull(); expect(readRecoveryLedger(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    expect(readRecoveryLedger(' '.repeat(8193))).toBeNull();
    const reserved = reserveRecoveryRound(empty(), input())!;
    expect(reserveRecoveryRequest(reserved.ledger, reserved.round.attemptId, 99)).toBeNull();
    expect(recoveryDisplay('{', 200)?.state).toBe('blocked');
  });
  it('keeps verified queries distinct from publication confirmation', () => {
    const round = reserveRecoveryRound(empty(), input())!, request = reserveRecoveryRequest(round.ledger, round.round.attemptId, 100)!;
    expect(recoveryDisplay(JSON.stringify(request.ledger), 101)?.state).toBe('checking');
    const verified = finishRecoveryRequest(request.ledger, request.token, { success: true, now: 102, outcome: RecoveryOutcome.Verified })!;
    expect(recoveryDisplay(JSON.stringify(verified), 103)?.state).toBe('recovering');
  });
  it('shares one in-flight permit and twelve requests across lanes', async () => {
    let now = 100; const limiter = new RemoteRecoveryLimiter(() => now); let release!: () => void;
    const ongoing = limiter.run('device', () => new Promise<void>(resolve => { release = resolve; }));
    expect(await limiter.run('device', async () => 1)).toEqual({ admitted: false }); release(); await ongoing;
    for (let index = 0; index < 11; index++) expect((await limiter.run(index % 2 ? 'legacy-json-context' : 'v3-scope-context', async () => index)).admitted).toBe(true);
    expect((await limiter.run('device', async () => 12)).admitted).toBe(false);
    now += 60000; expect((await limiter.run('device', async () => 13)).admitted).toBe(true);
  });
});
