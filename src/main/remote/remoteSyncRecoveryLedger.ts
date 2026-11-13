import { randomUUID } from 'crypto';

import { type RemoteSyncRecoveryDisplay,RemoteSyncRecoveryState } from '../../shared/remote/recovery';

export const RecoveryOutcome = { Pending: 'pending', Verified: 'verified', Blocked: 'blocked' } as const;
export type RecoveryOutcome = typeof RecoveryOutcome[keyof typeof RecoveryOutcome];
export const RecoveryBudget = { Version: 1, Day: 86400000, Rounds: 2, Evidence: 8, Bytes: 8192, Failures: 3, Lease: 30000 } as const;
export interface RecoveryRound {
  attemptId: string; failureKey: string; evidenceKey: string; contextKey: string; operationKey: string;
  startedAt: number; nextAt: number; failures: number; inflight: { token: string; until: number } | null;
  outcome: RecoveryOutcome; dependencyEpoch?: number; dependencyFailureEpoch?: number; waitingDependency?: boolean;
}
export interface RecoveryLedger { schemaVersion: 1; lastAt: number; times: number[]; rounds: RecoveryRound[] }
export interface RecoveryRoundInput { failureKey: string; evidenceKey: string; contextKey: string; operationKey: string; now: number; dependencyEpoch?: number }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);
const copy = (value: RecoveryLedger): RecoveryLedger => JSON.parse(JSON.stringify(value));

/** Pure, bounded decoder: invalid or future metadata never becomes an empty budget. */
export function readRecoveryLedger(raw: unknown): RecoveryLedger | null {
  if (raw === '{}') return { schemaVersion: 1, lastAt: 0, times: [], rounds: [] };
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > RecoveryBudget.Bytes) return null;
  try {
    const value = JSON.parse(raw) as RecoveryLedger;
    if (!value || value.schemaVersion !== RecoveryBudget.Version || !integer(value.lastAt)
      || !Array.isArray(value.times) || value.times.length > RecoveryBudget.Rounds || !value.times.every(time => integer(time) && time <= value.lastAt)
      || !Array.isArray(value.rounds) || value.rounds.length > RecoveryBudget.Evidence) return null;
    const ids = new Set<string>(), evidence = new Set<string>();
    for (const round of value.rounds) {
      if (!round || !uuid(round.attemptId) || ids.has(round.attemptId)
        || ![round.failureKey, round.evidenceKey, round.contextKey, round.operationKey].every(digest)
        || !integer(round.startedAt) || round.startedAt > value.lastAt || !integer(round.nextAt) || !integer(round.failures) || round.failures > RecoveryBudget.Failures
        || !Object.values(RecoveryOutcome).includes(round.outcome)
        || round.dependencyEpoch !== undefined && !integer(round.dependencyEpoch)
        || round.dependencyFailureEpoch !== undefined && !integer(round.dependencyFailureEpoch)
        || round.waitingDependency !== undefined && typeof round.waitingDependency !== 'boolean'
        || round.inflight !== null && (!round.inflight || !uuid(round.inflight.token) || !integer(round.inflight.until) || round.failures === 0 || round.outcome !== RecoveryOutcome.Pending)) return null;
      const key = `${round.failureKey}:${round.evidenceKey}`;
      if (evidence.has(key)) return null;
      ids.add(round.attemptId); evidence.add(key);
    }
    return value;
  } catch { return null; }
}
export function reserveRecoveryRound(input: RecoveryLedger, next: RecoveryRoundInput): { ledger: RecoveryLedger; round: RecoveryRound } | null {
  if (!integer(next.now) || next.now < input.lastAt || ![next.failureKey, next.evidenceKey, next.contextKey, next.operationKey].every(digest)) return null;
  const ledger = copy(input);
  for (const round of ledger.rounds) if (round.outcome === RecoveryOutcome.Pending && round.failures >= RecoveryBudget.Failures && (!round.inflight || round.inflight.until <= next.now)) { round.outcome = RecoveryOutcome.Blocked; round.inflight = null; round.waitingDependency = true; }
  const previous = ledger.rounds.find(round => round.failureKey === next.failureKey && round.evidenceKey === next.evidenceKey);
  if (previous) return previous.outcome === RecoveryOutcome.Pending && previous.contextKey === next.contextKey
    && previous.operationKey === next.operationKey ? { ledger, round: previous } : null;
  // An active round owns its opportunity, including after a crash or capability refresh.
  if (ledger.rounds.some(round => round.outcome === RecoveryOutcome.Pending) || ledger.rounds.length >= RecoveryBudget.Evidence) return null;
  ledger.times = ledger.times.filter(time => time > next.now - RecoveryBudget.Day);
  if (ledger.times.length >= RecoveryBudget.Rounds) return null;
  const round: RecoveryRound = { attemptId: randomUUID(), ...next, startedAt: next.now, nextAt: next.now,
    failures: 0, inflight: null, outcome: RecoveryOutcome.Pending, dependencyEpoch: next.dependencyEpoch ?? 0 };
  delete (round as RecoveryRound & { now?: number }).now;
  ledger.rounds.push(round); ledger.times.push(next.now); ledger.lastAt = next.now;
  return { ledger, round };
}
/** Reserve before I/O. Until confirmed, this request counts as a failed/unknown request. */
export function reserveRecoveryRequest(input: RecoveryLedger, attemptId: string, now: number, dependencyEpoch?: number): { ledger: RecoveryLedger; token: string } | null {
  if (!integer(now) || now < input.lastAt) return null;
  const ledger = copy(input), round = ledger.rounds.find(value => value.attemptId === attemptId);
  if (!round || round.outcome !== RecoveryOutcome.Pending || round.failures >= RecoveryBudget.Failures
    || round.nextAt > now || round.inflight && round.inflight.until > now) return null;
  const token = randomUUID();
  if (dependencyEpoch !== undefined) { if (!integer(dependencyEpoch)) return null; round.dependencyFailureEpoch = dependencyEpoch; }
  round.failures++; round.inflight = { token, until: now + RecoveryBudget.Lease };
  round.nextAt = round.inflight.until; ledger.lastAt = now;
  return { ledger, token };
}
export function finishRecoveryRequest(input: RecoveryLedger, token: string, result: { success: boolean; now: number; nextAt?: number; outcome?: RecoveryOutcome; dependencyFailure?: boolean; dependencyEpoch?: number }): RecoveryLedger | null {
  if (!integer(result.now) || result.now < input.lastAt) return null;
  const ledger = copy(input), round = ledger.rounds.find(value => value.inflight?.token === token);
  if (!round || round.outcome !== RecoveryOutcome.Pending || !round.inflight || round.inflight.until < result.now) return null;
  round.inflight = null;
  if (result.success) round.failures--;
  round.outcome = result.outcome ?? (round.failures >= RecoveryBudget.Failures ? RecoveryOutcome.Blocked : RecoveryOutcome.Pending);
  round.waitingDependency = round.outcome === RecoveryOutcome.Blocked && result.dependencyFailure === true;
  if (result.dependencyEpoch !== undefined) { if (!integer(result.dependencyEpoch)) return null; round.dependencyFailureEpoch = result.dependencyEpoch; }
  round.nextAt = Math.max(result.now, result.nextAt ?? result.now);
  ledger.lastAt = result.now;
  return ledger;
}
/** Only an inconclusive exhausted round may consume a later proven dependency transition. */
export function recoveryDependencyEvidence(ledger: RecoveryLedger, failureKey: string, epoch: number | null, now = Date.now()): number | null {
  if (!integer(epoch)) return null;
  const round = [...ledger.rounds].reverse().find(value => value.failureKey === failureKey);
  if (!round) return epoch;
  const exhaustedUnknown = round.outcome === RecoveryOutcome.Pending && round.failures >= RecoveryBudget.Failures
    && (!round.inflight || round.inflight.until <= now);
  return (round.waitingDependency || exhaustedUnknown) && epoch > (round.dependencyFailureEpoch ?? round.dependencyEpoch ?? 0)
    ? epoch : round.dependencyEpoch ?? 0;
}
export function recoveryDisplay(raw: unknown, now: number): RemoteSyncRecoveryDisplay | undefined {
  const ledger = readRecoveryLedger(raw);
  if (!ledger) return { state: RemoteSyncRecoveryState.Blocked };
  const round = ledger.rounds.at(-1);
  if (!round) return undefined;
  if (round.outcome === RecoveryOutcome.Verified) return { state: RemoteSyncRecoveryState.Recovering };
  if (round.outcome === RecoveryOutcome.Blocked || round.failures >= RecoveryBudget.Failures && (!round.inflight || round.inflight.until <= now)) return { state: RemoteSyncRecoveryState.Blocked };
  return round.inflight && round.inflight.until > now ? { state: RemoteSyncRecoveryState.Checking }
    : { state: RemoteSyncRecoveryState.Waiting, ...(round.nextAt > now ? { nextProbeAt: round.nextAt } : {}) };
}

/** One bridge-owned permit shared by legacy and every v3 lane; normal transport still applies. */
export class RemoteRecoveryLimiter {
  private active = false;
  private times: number[] = [];
  private lastAt = 0;
  constructor(private readonly now: () => number = Date.now) {}
  async run<T>(_scope: string, operation: () => Promise<T>): Promise<{ admitted: false } | { admitted: true; value: T }> {
    const now = this.now();
    if (this.active || now < this.lastAt) return { admitted: false };
    this.lastAt = now;
    const times = this.times.filter(time => time > now - 60000);
    if (times.length >= 12) return { admitted: false };
    this.times = [...times, now]; this.active = true;
    try { return { admitted: true, value: await operation() }; }
    finally { this.active = false; }
  }
}
