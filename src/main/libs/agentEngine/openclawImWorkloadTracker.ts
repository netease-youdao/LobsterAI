import { configDiagnosticDigest, ConfigWorkloadState } from '../openclawConfigObservation';

export const IM_POLL_ACTIVE_TTL_MS = 120_000;
export const IM_WORKLOAD_LIMIT = 1_000;
const SAMPLE_LIMIT = 3;

type ImWorkload = {
  sessionId: string;
  runId: string;
  lifecycleAt?: number;
  polledAt?: number;
  polledRunId?: string;
};

/** Additional evidence for automatic config restarts, never UI/ActiveTurn state. */
export class OpenClawImWorkloadTracker {
  private readonly runs = new Map<string, ImWorkload>();
  private readonly sessionRevisions = new Map<string, number>();
  private revision = 0;
  private resetRevision = 0;
  private lastPollAt: number | null = null;
  private overflowed = false;

  beginPoll(): number {
    return this.revision;
  }

  completePoll(revision: number, now = Date.now()): void {
    if (revision >= this.resetRevision) this.lastPollAt = now;
  }

  start(sessionKey: string, sessionId: string, runId: string, now = Date.now()): void {
    this.markSessionChanged(sessionId);
    this.put(sessionKey, { sessionId, runId, lifecycleAt: now });
  }

  end(sessionKey: string, runId: string): void {
    const current = this.runs.get(sessionKey);
    if (!current) return;
    const next = { ...current };
    // Match each source independently. A late terminal for a lifecycle run
    // must not clear a newer (or unidentified) polling observation.
    if (current.lifecycleAt !== undefined && (!current.runId || current.runId === runId)) {
      next.lifecycleAt = undefined;
    }
    if (current.polledAt !== undefined && current.polledRunId && current.polledRunId === runId) {
      next.polledAt = undefined;
    }
    if (next.lifecycleAt !== current.lifecycleAt || next.polledAt !== current.polledAt) {
      this.markSessionChanged(current.sessionId);
      this.retainOrDelete(sessionKey, next);
    }
  }

  poll(input: {
    revision: number;
    sessionKey: string;
    sessionId: string;
    hasActiveRun: unknown;
    terminal: boolean;
    runId: string;
    lifecycleTtlMs: number;
    now?: number;
  }): void {
    // A start/stop/delete during the request makes that snapshot obsolete.
    if (input.revision < this.resetRevision
      || input.revision < (this.sessionRevisions.get(input.sessionId) ?? 0)) return;
    const now = input.now ?? Date.now();
    const current = this.runs.get(input.sessionKey);
    if (input.hasActiveRun === true) {
      this.put(input.sessionKey, {
        ...current,
        sessionId: input.sessionId,
        runId: current?.runId ?? '',
        polledAt: now,
        polledRunId: input.runId,
      });
      return;
    }
    if (!current) return;
    const freshLifecycle = current.lifecycleAt !== undefined
      && now - current.lifecycleAt <= input.lifecycleTtlMs;
    if (input.hasActiveRun === false || input.terminal) {
      const next = { ...current };
      // Native IM is not fully represented by hasActiveRun. A persisted,
      // anonymous terminal cannot identify the current lifecycle run.
      if (!freshLifecycle || (input.terminal && input.runId && input.runId === current.runId)) {
        next.lifecycleAt = undefined;
      }
      if (!input.runId || !current.polledRunId || input.runId === current.polledRunId) {
        next.polledAt = undefined;
      }
      this.retainOrDelete(input.sessionKey, next);
    }
  }

  forgetSession(sessionId: string): void {
    this.markSessionChanged(sessionId);
    for (const [key, run] of this.runs) {
      if (run.sessionId === sessionId) this.runs.delete(key);
    }
  }

  reset(): void {
    this.resetRevision = ++this.revision;
    this.sessionRevisions.clear();
    this.runs.clear();
    this.lastPollAt = null;
    this.overflowed = false;
  }

  snapshot(lifecycleTtlMs: number, now = Date.now()) {
    let lifecycleActive = 0;
    let pollActive = 0;
    let activeSessions = 0;
    let staleSessions = 0;
    const samples: Array<{ session: string; run: string | null; ageMs: number }> = [];
    for (const item of this.runs.values()) {
      const lifecycleFresh = item.lifecycleAt !== undefined && now - item.lifecycleAt <= lifecycleTtlMs;
      const pollFresh = item.polledAt !== undefined && now - item.polledAt <= IM_POLL_ACTIVE_TTL_MS;
      if (lifecycleFresh) lifecycleActive += 1;
      if (pollFresh) pollActive += 1;
      if (lifecycleFresh || pollFresh) activeSessions += 1;
      else staleSessions += 1;
      if (samples.length < SAMPLE_LIMIT) {
        samples.push({
          session: configDiagnosticDigest(item.sessionId),
          run: (pollFresh ? item.polledRunId : item.runId)
            ? configDiagnosticDigest((pollFresh ? item.polledRunId : item.runId)!) : null,
          ageMs: Math.max(0, now - Math.max(item.lifecycleAt ?? 0, item.polledAt ?? 0)),
        });
      }
    }
    const pollAgeMs = this.lastPollAt === null ? null : Math.max(0, now - this.lastPollAt);
    const state = activeSessions > 0 ? ConfigWorkloadState.Busy
      : staleSessions > 0 || this.overflowed || pollAgeMs === null || pollAgeMs > IM_POLL_ACTIVE_TTL_MS
        ? ConfigWorkloadState.Unknown : ConfigWorkloadState.Idle;
    return { state, activeSessions, lifecycleActive, pollActive, staleSessions, pollAgeMs, overflowed: this.overflowed, samples };
  }

  private put(key: string, run: ImWorkload): void {
    this.runs.delete(key);
    this.runs.set(key, run);
    if (this.runs.size > IM_WORKLOAD_LIMIT) {
      this.runs.delete(this.runs.keys().next().value!);
      this.overflowed = true;
    }
  }

  private retainOrDelete(key: string, run: ImWorkload): void {
    if (run.lifecycleAt === undefined && run.polledAt === undefined) this.runs.delete(key);
    else this.runs.set(key, run);
  }

  private markSessionChanged(sessionId: string): void {
    this.sessionRevisions.delete(sessionId);
    this.sessionRevisions.set(sessionId, ++this.revision);
    if (this.sessionRevisions.size > IM_WORKLOAD_LIMIT) {
      const oldest = this.sessionRevisions.entries().next().value!;
      this.sessionRevisions.delete(oldest[0]);
      // Bound deletion tombstones without letting a very old poll revive them.
      this.resetRevision = Math.max(this.resetRevision, oldest[1]);
    }
  }
}
