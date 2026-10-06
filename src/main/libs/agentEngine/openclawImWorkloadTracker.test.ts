import { describe, expect, test } from 'vitest';

import { ConfigWorkloadState } from '../openclawConfigObservation';
import { IM_POLL_ACTIVE_TTL_MS, IM_WORKLOAD_LIMIT, OpenClawImWorkloadTracker } from './openclawImWorkloadTracker';

const LIFECYCLE_TTL = 60_000;
const KEY = 'agent:main:moltbot-popo:synthetic:direct:user';

function poll(tracker: OpenClawImWorkloadTracker, overrides = {}) {
  tracker.poll({
    revision: tracker.beginPoll(), sessionKey: KEY, sessionId: 'session',
    hasActiveRun: true, terminal: false, runId: '', lifecycleTtlMs: LIFECYCLE_TTL, now: 1_000,
    ...overrides,
  });
}

describe('automatic config restart IM evidence', () => {
  test('polling active is protective even without a lifecycle or local turn', () => {
    const tracker = new OpenClawImWorkloadTracker();
    poll(tracker);
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001)).toMatchObject({
      state: ConfigWorkloadState.Busy, activeSessions: 1, pollActive: 1, lifecycleActive: 0,
    });
    poll(tracker, { hasActiveRun: false, now: 2_000 });
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).activeSessions).toBe(0);
  });

  test('fresh native lifecycle survives a chat-only false and anonymous persisted terminal', () => {
    const tracker = new OpenClawImWorkloadTracker();
    tracker.start(KEY, 'session', 'new-run', 1_000);
    poll(tracker, { hasActiveRun: false, terminal: true, now: 2_000 });
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).lifecycleActive).toBe(1);
    tracker.end(KEY, 'old-run');
    tracker.end(KEY, '');
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).activeSessions).toBe(1);
    tracker.end(KEY, 'new-run');
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).activeSessions).toBe(0);
  });

  test('a terminal poll identifying the current run releases lifecycle evidence', () => {
    const tracker = new OpenClawImWorkloadTracker();
    tracker.start(KEY, 'session', 'run', 1_000);
    poll(tracker, { hasActiveRun: false, terminal: true, runId: 'run', now: 2_000 });
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).activeSessions).toBe(0);
  });

  test('old poll completion cannot erase a new lifecycle or resurrect stopped/deleted work', () => {
    const tracker = new OpenClawImWorkloadTracker();
    const revision = tracker.beginPoll();
    tracker.start(KEY, 'session', 'new-run', 1_000);
    poll(tracker, { revision, hasActiveRun: false, terminal: true, runId: 'new-run' });
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001).activeSessions).toBe(1);
    const stopRevision = tracker.beginPoll();
    tracker.forgetSession('session');
    poll(tracker, { revision: stopRevision });
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001).activeSessions).toBe(0);
  });

  test('connection reset rejects old results and requires fresh observation', () => {
    const tracker = new OpenClawImWorkloadTracker();
    const revision = tracker.beginPoll();
    poll(tracker);
    tracker.reset();
    poll(tracker, { revision });
    tracker.completePoll(revision, 1_000);
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001)).toMatchObject({
      state: ConfigWorkloadState.Unknown, activeSessions: 0, pollAgeMs: null,
    });
    tracker.completePoll(tracker.beginPoll(), 1_001);
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_002).state).toBe(ConfigWorkloadState.Idle);
  });

  test('an unrelated conversation event does not discard another IM active poll', () => {
    const tracker = new OpenClawImWorkloadTracker();
    const revision = tracker.beginPoll();
    tracker.start('other-key', 'other-session', 'other-run', 1_000);
    tracker.end('other-key', 'other-run');
    poll(tracker, { revision });
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001).pollActive).toBe(1);
  });

  test('evicting deletion fences still rejects polls older than the evicted stop', () => {
    const tracker = new OpenClawImWorkloadTracker();
    const revision = tracker.beginPoll();
    for (let index = 0; index < IM_WORKLOAD_LIMIT + 1; index += 1) {
      tracker.forgetSession(`session-${index}`);
    }
    poll(tracker, { revision, sessionId: 'session-0' });
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001).activeSessions).toBe(0);
  });

  test('a late lifecycle end cannot erase a newer or unidentified polled run', () => {
    const tracker = new OpenClawImWorkloadTracker();
    tracker.start(KEY, 'session', 'old-run', 1_000);
    poll(tracker, { runId: 'new-run', now: 2_000 });
    tracker.end(KEY, 'old-run');
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001)).toMatchObject({ lifecycleActive: 0, pollActive: 1 });
    tracker.end(KEY, 'new-run');
    expect(tracker.snapshot(LIFECYCLE_TTL, 2_001).activeSessions).toBe(0);
    poll(tracker, { now: 3_000 });
    tracker.end(KEY, 'old-run');
    expect(tracker.snapshot(LIFECYCLE_TTL, 3_001).pollActive).toBe(1);
    poll(tracker, { hasActiveRun: false, now: 4_000 });
    expect(tracker.snapshot(LIFECYCLE_TTL, 4_001).activeSessions).toBe(0);
  });

  test('stale evidence becomes unknown, not fresh busy or proven idle', () => {
    const tracker = new OpenClawImWorkloadTracker();
    tracker.start(KEY, 'session', 'run', 1_000);
    poll(tracker);
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_000 + IM_POLL_ACTIVE_TTL_MS + 1)).toMatchObject({
      state: ConfigWorkloadState.Unknown, activeSessions: 0, staleSessions: 1,
    });
    poll(tracker, { hasActiveRun: undefined, terminal: false, now: 500_000 });
    expect(tracker.snapshot(LIFECYCLE_TTL, 500_001).state).toBe(ConfigWorkloadState.Unknown);
  });

  test('counts a lifecycle plus polling only once and keeps independent conversations', () => {
    const tracker = new OpenClawImWorkloadTracker();
    tracker.start(KEY, 'session', 'run', 1_000);
    poll(tracker);
    tracker.start('another-key', 'another-session', 'another-run', 1_000);
    tracker.forgetSession('another-session');
    expect(tracker.snapshot(LIFECYCLE_TTL, 1_001)).toMatchObject({
      activeSessions: 1, lifecycleActive: 1, pollActive: 1,
    });
  });

  test('limits retained evidence and never logs raw identities', () => {
    const tracker = new OpenClawImWorkloadTracker();
    for (let index = 0; index < IM_WORKLOAD_LIMIT + 5; index += 1) {
      tracker.start(`secret-key-${index}`, `secret-session-${index}`, `secret-run-${index}`, 1_000);
    }
    const snapshot = tracker.snapshot(LIFECYCLE_TTL, 1_001);
    expect(snapshot.activeSessions).toBe(IM_WORKLOAD_LIMIT);
    expect(snapshot.overflowed).toBe(true);
    expect(snapshot.samples).toHaveLength(3);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
