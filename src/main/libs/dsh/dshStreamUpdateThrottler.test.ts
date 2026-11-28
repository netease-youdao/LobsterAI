import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { DshStreamUpdateThrottler } from './dshStreamUpdateThrottler';

interface TestEntry {
  sessionId: string;
  messageId: string;
  content: string;
}

describe('DshStreamUpdateThrottler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-28T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('emits leading update immediately and coalesces burst deltas into one trailing update per lane', () => {
    const persisted: TestEntry[] = [];
    const emitted: TestEntry[] = [];
    const throttler = new DshStreamUpdateThrottler<TestEntry>({
      emitIntervalMs: 100,
      persistIntervalMs: 250,
      onPersist: (entry) => persisted.push(entry),
      onEmit: (entry) => emitted.push(entry),
    });

    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 'A' });
    expect(persisted).toEqual([{ sessionId: 's1', messageId: 'm1', content: 'A' }]);
    expect(emitted).toEqual([{ sessionId: 's1', messageId: 'm1', content: 'A' }]);

    for (let i = 1; i <= 50; i += 1) {
      vi.advanceTimersByTime(1);
      throttler.schedule({ sessionId: 's1', messageId: 'm1', content: `A+${i}` });
    }

    // Within the first 50ms, no extra emits or SQLite writes should fire.
    expect(emitted).toHaveLength(1);
    expect(persisted).toHaveLength(1);

    // At 100ms total elapsed, emit lane flushes only the latest coalesced text.
    vi.advanceTimersByTime(50);
    expect(emitted).toEqual([
      { sessionId: 's1', messageId: 'm1', content: 'A' },
      { sessionId: 's1', messageId: 'm1', content: 'A+50' },
    ]);
    expect(persisted).toHaveLength(1);

    // At 250ms total elapsed, persist lane flushes the latest coalesced text.
    vi.advanceTimersByTime(150);
    expect(persisted).toEqual([
      { sessionId: 's1', messageId: 'm1', content: 'A' },
      { sessionId: 's1', messageId: 'm1', content: 'A+50' },
    ]);
  });

  test('clearMessage cancels pending trailing timers and resets leading-edge eligibility', () => {
    const persisted: TestEntry[] = [];
    const emitted: TestEntry[] = [];
    const throttler = new DshStreamUpdateThrottler<TestEntry>({
      emitIntervalMs: 100,
      persistIntervalMs: 250,
      onPersist: (entry) => persisted.push(entry),
      onEmit: (entry) => emitted.push(entry),
    });

    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 'first' });
    vi.advanceTimersByTime(10);
    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 'second' });

    throttler.clearMessage('m1');
    vi.advanceTimersByTime(500);

    // Pending trailing update for 'second' must never fire after clearMessage.
    expect(emitted).toEqual([{ sessionId: 's1', messageId: 'm1', content: 'first' }]);
    expect(persisted).toEqual([{ sessionId: 's1', messageId: 'm1', content: 'first' }]);

    // Reusing the same messageId (e.g. retry attempt) gets immediate leading-edge delivery again.
    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 'retry-1' });
    expect(emitted).toEqual([
      { sessionId: 's1', messageId: 'm1', content: 'first' },
      { sessionId: 's1', messageId: 'm1', content: 'retry-1' },
    ]);
  });

  test('clearSession cancels only the target session timers without affecting other sessions', () => {
    const emitted: TestEntry[] = [];
    const throttler = new DshStreamUpdateThrottler<TestEntry>({
      emitIntervalMs: 100,
      persistIntervalMs: 250,
      onPersist: () => undefined,
      onEmit: (entry) => emitted.push(entry),
    });

    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 's1-1' });
    throttler.schedule({ sessionId: 's2', messageId: 'm2', content: 's2-1' });
    vi.advanceTimersByTime(20);
    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: 's1-2' });
    throttler.schedule({ sessionId: 's2', messageId: 'm2', content: 's2-2' });

    throttler.clearSession('s1');
    vi.advanceTimersByTime(200);

    expect(emitted).toEqual([
      { sessionId: 's1', messageId: 'm1', content: 's1-1' },
      { sessionId: 's2', messageId: 'm2', content: 's2-1' },
      { sessionId: 's2', messageId: 'm2', content: 's2-2' },
    ]);
  });

  test('clearAll cancels every pending trailing timer across sessions', () => {
    const persisted: TestEntry[] = [];
    const emitted: TestEntry[] = [];
    const throttler = new DshStreamUpdateThrottler<TestEntry>({
      emitIntervalMs: 100,
      persistIntervalMs: 250,
      onPersist: (entry) => persisted.push(entry),
      onEmit: (entry) => emitted.push(entry),
    });

    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: '1' });
    throttler.schedule({ sessionId: 's2', messageId: 'm2', content: 'a' });
    vi.advanceTimersByTime(10);
    throttler.schedule({ sessionId: 's1', messageId: 'm1', content: '2' });
    throttler.schedule({ sessionId: 's2', messageId: 'm2', content: 'b' });

    throttler.clearAll();
    vi.advanceTimersByTime(500);

    expect(emitted).toHaveLength(2);
    expect(persisted).toHaveLength(2);
  });
});
