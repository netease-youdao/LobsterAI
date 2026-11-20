import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DeliveryMode,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../scheduledTask/constants';
import { computeNextRunAtMs, LobsterScheduler } from './lobsterScheduler';

const openDbs: Database.Database[] = [];

function createMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()!.close();
  }
});

describe('computeNextRunAtMs', () => {
  test('computes cron schedule in an explicit IANA timezone', () => {
    // 2026-11-19T00:30:00Z = 2026-11-19 08:30 Asia/Shanghai
    const nowMs = Date.parse('2026-11-19T00:30:00.000Z');
    const nextMs = computeNextRunAtMs(
      { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      nowMs,
    );
    // 2026-11-19 09:00 Asia/Shanghai = 2026-11-19T01:00:00.000Z
    expect(nextMs).toBe(Date.parse('2026-11-19T01:00:00.000Z'));
  });

  test('computes every and one-shot at schedules', () => {
    const nowMs = 1_000_000;
    expect(computeNextRunAtMs({ kind: 'every', everyMs: 60_000, anchorMs: 970_000 }, nowMs)).toBe(1_030_000);
    expect(computeNextRunAtMs({ kind: 'at', at: new Date(nowMs + 5000).toISOString() }, nowMs)).toBe(nowMs + 5000);
    expect(computeNextRunAtMs({ kind: 'at', at: new Date(nowMs - 5000).toISOString() }, nowMs)).toBeNull();
  });
});

describe('LobsterScheduler', () => {
  test('persists CRUD, executes due tasks, records runs, and auto-disables one-shot jobs', async () => {
    let clock = Date.parse('2026-11-19T01:00:00.000Z');
    const executor = vi.fn(async (task) => ({
      sessionId: `cw-${task.id}`,
      summary: `Ran ${task.name}`,
    }));

    const scheduler = new LobsterScheduler({
      db: createMemoryDb(),
      executor,
      now: () => clock,
    });

    const created = scheduler.createTask({
      name: 'Morning Digest',
      description: 'Daily summary',
      enabled: true,
      schedule: { kind: 'at', at: '2026-11-19T01:05:00.000Z' },
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      payload: { kind: 'agentTurn', message: 'Summarize news' },
      delivery: { mode: DeliveryMode.None },
    });

    expect(scheduler.listTasks()).toHaveLength(1);
    expect(created.state.nextRunAtMs).toBe(Date.parse('2026-11-19T01:05:00.000Z'));

    // Before due time -> nothing fires.
    expect(await scheduler.tick()).toEqual([]);

    // Advance clock to due time -> executes once and disables one-shot task.
    clock = Date.parse('2026-11-19T01:05:00.000Z');
    expect(await scheduler.tick()).toEqual([created.id]);
    expect(executor).toHaveBeenCalledTimes(1);

    const after = scheduler.getTask(created.id)!;
    expect(after.enabled).toBe(false);
    expect(after.state.lastStatus).toBe(TaskStatus.Success);
    expect(after.state.nextRunAtMs).toBeNull();

    const runs = scheduler.listRuns(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].summary).toBe('Ran Morning Digest');
    expect(scheduler.listAllRuns()).toHaveLength(1);
  });

  test('skips overdue runs on startup when skipMissedJobs is enabled', () => {
    let clock = Date.parse('2026-11-19T01:00:00.000Z');
    const scheduler = new LobsterScheduler({
      db: createMemoryDb(),
      now: () => clock,
      skipMissedJobs: true,
    });

    const task = scheduler.createTask({
      name: 'Hourly Sync',
      description: '',
      enabled: true,
      schedule: { kind: 'every', everyMs: 3_600_000, anchorMs: clock },
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      payload: { kind: 'agentTurn', message: 'Sync' },
    });

    // Simulate laptop sleeping for 5 hours.
    clock += 5 * 3_600_000;
    const skipped = scheduler.reconcileMissedJobs();
    expect(skipped).toBe(1);
    const updated = scheduler.getTask(task.id)!;
    expect(updated.state.nextRunAtMs).toBeGreaterThan(clock);
  });
});
