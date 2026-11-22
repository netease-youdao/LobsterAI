import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DeliveryMode,
  RunDeliveryStatus,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../scheduledTask/constants';
import {
  computeNextRunAtMs,
  LobsterScheduler,
  parseCronExpression,
} from './lobsterScheduler';

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

  test('supports standard cron macros, named months/weekdays, and 6-field expressions', () => {
    expect(parseCronExpression('@daily')).toEqual(parseCronExpression('0 0 * * *'));
    expect(parseCronExpression('@MIDNIGHT')).toEqual(parseCronExpression('0 0 * * *'));
    expect(parseCronExpression('@hourly')).toEqual(parseCronExpression('0 * * * *'));
    expect(parseCronExpression('@weekly')).toEqual(parseCronExpression('0 0 * * 0'));
    expect(parseCronExpression('@monthly')).toEqual(parseCronExpression('0 0 1 * *'));
    expect(parseCronExpression('@yearly')).toEqual(parseCronExpression('0 0 1 1 *'));
    expect(parseCronExpression('@annually')).toEqual(parseCronExpression('0 0 1 1 *'));

    const weekdays = parseCronExpression('30 9 * JAN-MAR MON-FRI');
    expect([...weekdays.months]).toEqual([1, 2, 3]);
    expect([...weekdays.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);

    const weekend = parseCronExpression('0 10 * dec fri-sun');
    expect([...weekend.months]).toEqual([12]);
    expect([...weekend.daysOfWeek].sort((a, b) => a - b)).toEqual([0, 5, 6]);

    // 6-field cron (leading seconds field) used by migrated legacy OpenClaw cron tasks.
    const sixField = parseCronExpression('0 30 9 * * MON-FRI');
    expect([...sixField.minutes]).toEqual([30]);
    expect([...sixField.hours]).toEqual([9]);
    expect([...sixField.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);

    // 2026-11-20 is Friday. Next MON-FRI 09:30 Asia/Shanghai after Friday 10:00 is Monday 2026-11-23 09:30+08:00.
    const friMorning = Date.parse('2026-11-20T02:00:00.000Z');
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '0 30 9 * * MON-FRI', tz: 'Asia/Shanghai' },
        friMorning,
      ),
    ).toBe(Date.parse('2026-11-23T01:30:00.000Z'));

    // @daily in Asia/Shanghai: next midnight after 2026-11-20 08:00+08:00 is 2026-11-21 00:00+08:00.
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '@daily', tz: 'Asia/Shanghai' },
        Date.parse('2026-11-20T00:00:00.000Z'),
      ),
    ).toBe(Date.parse('2026-11-20T16:00:00.000Z'));
  });

  test('computes Feb-29, yearly, and impossible crons with tz quickly without brute-force minute scanning', () => {
    const afterLeap = Date.parse('2024-03-01T00:00:00.000Z');
    const start = performance.now();

    const nextFeb29Shanghai = computeNextRunAtMs(
      { kind: 'cron', expr: '0 9 29 FEB *', tz: 'Asia/Shanghai' },
      afterLeap,
    );
    const nextFeb29NewYork = computeNextRunAtMs(
      { kind: 'cron', expr: '0 9 29 2 *', tz: 'America/New_York' },
      afterLeap,
    );
    const nextYearlyNy = computeNextRunAtMs(
      { kind: 'cron', expr: '@yearly', tz: 'America/New_York' },
      Date.parse('2026-01-01T06:00:00.000Z'),
    );
    const impossibleFeb31 = computeNextRunAtMs(
      { kind: 'cron', expr: '0 9 31 2 *', tz: 'Asia/Shanghai' },
      afterLeap,
    );
    const elapsedMs = performance.now() - start;

    // 2028-02-29 09:00 Asia/Shanghai = 2028-02-29T01:00:00Z
    expect(nextFeb29Shanghai).toBe(Date.parse('2028-02-29T01:00:00.000Z'));
    // 2028-02-29 09:00 EST (UTC-5) = 2028-02-29T14:00:00Z
    expect(nextFeb29NewYork).toBe(Date.parse('2028-02-29T14:00:00.000Z'));
    // 2027-01-01 00:00 EST (UTC-5) = 2027-01-01T05:00:00Z
    expect(nextYearlyNy).toBe(Date.parse('2027-01-01T05:00:00.000Z'));
    expect(impossibleFeb31).toBeNull();
    // Generous ceiling for loaded shared CI runners while still catching O(minutes) regressions.
    expect(elapsedMs).toBeLessThan(500);
  });

  test('handles America/New_York spring-forward and fall-back DST transitions accurately', () => {
    // 2026-03-08: DST springs forward at 02:00 EST -> 03:00 EDT.
    // 02:30 does not exist on 2026-03-08, so next 02:30 is 2026-03-09 02:30 EDT (UTC-4).
    const beforeSpring = Date.parse('2026-03-08T05:00:00.000Z'); // 00:00 EST
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '30 2 * * *', tz: 'America/New_York' },
        beforeSpring,
      ),
    ).toBe(Date.parse('2026-03-09T06:30:00.000Z'));

    // 09:00 on spring-forward day is 09:00 EDT (UTC-4) = 13:00Z.
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
        beforeSpring,
      ),
    ).toBe(Date.parse('2026-03-08T13:00:00.000Z'));

    // 2026-11-01: DST falls back at 02:00 EDT -> 01:00 EST.
    // After 01:30 EDT (05:30Z), the repeated 01:30 EST occurs at 06:30Z.
    const firstOneThirty = Date.parse('2026-11-01T05:30:00.000Z');
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '30 1 * * *', tz: 'America/New_York' },
        firstOneThirty,
      ),
    ).toBe(Date.parse('2026-11-01T06:30:00.000Z'));

    // 09:00 on fall-back day is 09:00 EST (UTC-5) = 14:00Z.
    expect(
      computeNextRunAtMs(
        { kind: 'cron', expr: '0 9 * * *', tz: 'America/New_York' },
        firstOneThirty,
      ),
    ).toBe(Date.parse('2026-11-01T14:00:00.000Z'));
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

  test('imports legacy jobs and runs idempotently while enforcing FK safety and backfilling lastRun state', () => {
    const nowMs = Date.parse('2026-11-20T02:00:00.000Z');
    const scheduler = new LobsterScheduler({
      db: createMemoryDb(),
      now: () => nowMs,
    });

    const importedJobs = scheduler.importLegacyJobs([
      {
        id: 'legacy-job-1',
        input: {
          name: 'Morning Briefing',
          description: 'Daily tech news',
          enabled: true,
          schedule: { kind: 'cron', expr: '30 8 * * 1,2,3,4,5', tz: 'Asia/Shanghai' },
          sessionTarget: SessionTarget.Isolated,
          wakeMode: WakeMode.Now,
          payload: { kind: 'agentTurn', message: 'Summarize news' },
          delivery: { mode: DeliveryMode.None },
        },
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-11-19T01:00:00.000Z',
      },
    ]);
    expect(importedJobs).toBe(1);

    const importedRuns = scheduler.importLegacyRuns([
      {
        id: 'legacy-run-1',
        taskId: 'legacy-job-1',
        status: TaskStatus.Success,
        startedAt: '2026-11-19T00:30:00.000Z',
        finishedAt: '2026-11-19T00:32:00.000Z',
        durationMs: 120_000,
        summary: 'Briefing complete',
      },
      {
        // Orphan run for a deleted/internal job must be skipped cleanly without FK violation.
        id: 'legacy-run-orphan',
        taskId: 'deleted-job-999',
        status: TaskStatus.Success,
        startedAt: '2026-11-19T00:30:00.000Z',
      },
      {
        // Duplicate timestamp for same task must be skipped.
        id: 'legacy-run-1-dup',
        taskId: 'legacy-job-1',
        status: TaskStatus.Success,
        startedAt: '2026-11-19T00:30:00.000Z',
      },
    ]);
    expect(importedRuns).toBe(1);

    const task = scheduler.getTask('legacy-job-1')!;
    expect(task.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(task.state.nextRunAtMs).toBeGreaterThan(nowMs);
    expect(task.state.lastRunAtMs).toBe(Date.parse('2026-11-19T00:30:00.000Z'));
    expect(task.state.lastStatus).toBe(TaskStatus.Success);
    expect(scheduler.countRuns('legacy-job-1')).toBe(1);

    // Re-importing is idempotent.
    expect(
      scheduler.importLegacyJobs([
        {
          id: 'legacy-job-1',
          input: {
            name: 'Changed Name',
            description: '',
            enabled: false,
            schedule: { kind: 'every', everyMs: 60_000 },
            sessionTarget: SessionTarget.Isolated,
            wakeMode: WakeMode.Now,
            payload: { kind: 'agentTurn', message: 'Other' },
          },
        },
      ]),
    ).toBe(0);
    expect(scheduler.getTask('legacy-job-1')!.name).toBe('Morning Briefing');
  });
});

const recurringJob = {
  name: 'Cancellable task',
  enabled: false,
  schedule: { kind: 'every', everyMs: 60_000 },
  sessionTarget: SessionTarget.Isolated,
  wakeMode: WakeMode.Now,
  payload: { kind: 'agentTurn', message: 'Wait' },
} as const;

test('scheduler and chat stops both close the run, including late completion and duplicate run requests', async () => {
  const scheduler = new LobsterScheduler({
    db: createMemoryDb(),
    executor: (_task, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve({ sessionId: 'stopped-by-scheduler' }), { once: true });
    }),
  });
  const task = scheduler.createTask(recurringJob);
  const run = scheduler.runNow(task.id);
  await expect(scheduler.runNow(task.id)).rejects.toThrow('already running');
  expect(scheduler.stopTask(task.id)).toBe(true);
  expect(await run).toMatchObject({ status: TaskStatus.Stopped, sessionId: 'stopped-by-scheduler', finishedAt: expect.any(String) });
  expect(scheduler.getTask(task.id)?.state).toMatchObject({ runningAtMs: null, lastStatus: TaskStatus.Stopped });
  const chat = new LobsterScheduler({ db: createMemoryDb(), executor: async () => ({ stopped: true, sessionId: 'stopped-in-chat' }) });
  const other = chat.createTask(recurringJob);
  expect(await chat.runNow(other.id)).toMatchObject({ status: TaskStatus.Stopped, sessionId: 'stopped-in-chat' });
});

test('startup closes an interrupted manual run of a disabled task without replaying it', () => {
  const db = createMemoryDb();
  const scheduler = new LobsterScheduler({ db, skipMissedJobs: false });
  const task = scheduler.createTask(recurringJob);
  const started = Date.now() - 1000;
  db.prepare('UPDATE lobster_scheduled_tasks SET state_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...task.state, lastStatus: TaskStatus.Running, runningAtMs: started }), task.id);
  db.prepare('INSERT INTO lobster_scheduled_task_runs (id, task_id, status, started_at) VALUES (?, ?, ?, ?)')
    .run('interrupted-run', task.id, TaskStatus.Running, new Date(started).toISOString());
  scheduler.start();
  try {
    expect(scheduler.listRuns(task.id)[0]).toMatchObject({ status: TaskStatus.Stopped, finishedAt: expect.any(String), durationMs: null });
    expect(scheduler.getTask(task.id)).toMatchObject({ enabled: false, state: { runningAtMs: null, lastStatus: TaskStatus.Stopped } });
  } finally {
    scheduler.stop();
  }
});

test('overlapping ticks do not replay a job completed while another job was pending', async () => {
  let clock = 100_000;
  const completions = new Map<string, () => void>();
  const scheduler = new LobsterScheduler({
    db: createMemoryDb(), now: () => clock,
    executor: task => new Promise(resolve => { completions.set(task.id, () => resolve({})); }),
  });
  const jobs = ['a', 'b'].map(name => scheduler.createTask({
    ...recurringJob, name, enabled: true, schedule: { kind: 'at', at: new Date(clock + 1000).toISOString() },
  }));
  clock += 1000;
  const firstTick = scheduler.tick();
  const first = [...completions.keys()][0];
  const secondTick = scheduler.tick();
  const second = [...completions.keys()].find(id => id !== first);
  expect(second).toBeDefined();
  completions.get(second!)!();
  await secondTick;
  completions.get(first)!();
  await firstTick;
  expect(jobs.map(task => scheduler.countRuns(task.id))).toEqual([1, 1]);
});

test('manual runNow on a future one-shot at task preserves enabled & future nextRunAtMs until scheduled tick fires', async () => {
  let clock = Date.parse('2026-11-22T01:00:00.000Z');
  const futureAt = '2026-11-22T05:00:00.000Z';
  const futureAtMs = Date.parse(futureAt);
  const statusEvents: Array<{ taskId: string; enabled?: boolean; nextRunAtMs: number | null }> = [];

  const scheduler = new LobsterScheduler({
    db: createMemoryDb(),
    now: () => clock,
    executor: async (task) => ({ sessionId: `cw-${task.id}`, summary: 'ok' }),
  });
  scheduler.on('statusUpdate', (evt: { taskId: string; enabled?: boolean; state: { nextRunAtMs: number | null } }) => {
    statusEvents.push({ taskId: evt.taskId, enabled: evt.enabled, nextRunAtMs: evt.state.nextRunAtMs });
  });

  const task = scheduler.createTask({
    ...recurringJob,
    name: 'Future reminder',
    enabled: true,
    schedule: { kind: 'at', at: futureAt },
  });

  // Manual test run 4 hours before scheduled time must NOT disable the task.
  const manualRun = await scheduler.runNow(task.id);
  expect(manualRun.status).toBe(TaskStatus.Success);

  const afterManual = scheduler.getTask(task.id)!;
  expect(afterManual.enabled).toBe(true);
  expect(afterManual.state.nextRunAtMs).toBe(futureAtMs);
  expect(statusEvents.at(-1)).toEqual({
    taskId: task.id,
    enabled: true,
    nextRunAtMs: futureAtMs,
  });

  // Scheduled tick at target time fires once and auto-disables with statusUpdate.enabled === false.
  clock = futureAtMs;
  expect(await scheduler.tick()).toEqual([task.id]);

  const afterScheduled = scheduler.getTask(task.id)!;
  expect(afterScheduled.enabled).toBe(false);
  expect(afterScheduled.state.nextRunAtMs).toBeNull();
  expect(statusEvents.at(-1)).toEqual({
    taskId: task.id,
    enabled: false,
    nextRunAtMs: null,
  });
  expect(scheduler.countRuns(task.id)).toBe(2);
});

test('reconcileMissedJobs disables expired one-shot at tasks and emits statusUpdate with enabled=false', () => {
  let clock = Date.parse('2026-11-22T01:00:00.000Z');
  const statusEvents: Array<{ taskId: string; enabled?: boolean; nextRunAtMs: number | null }> = [];
  const scheduler = new LobsterScheduler({
    db: createMemoryDb(),
    now: () => clock,
    skipMissedJobs: true,
  });
  scheduler.on('statusUpdate', (evt: { taskId: string; enabled?: boolean; state: { nextRunAtMs: number | null } }) => {
    statusEvents.push({ taskId: evt.taskId, enabled: evt.enabled, nextRunAtMs: evt.state.nextRunAtMs });
  });

  const oneShot = scheduler.createTask({
    ...recurringJob,
    name: 'Missed one-shot',
    enabled: true,
    schedule: { kind: 'at', at: '2026-11-22T01:30:00.000Z' },
  });

  // Laptop wakes 2 hours later.
  clock = Date.parse('2026-11-22T03:30:00.000Z');
  expect(scheduler.reconcileMissedJobs()).toBe(1);

  const updated = scheduler.getTask(oneShot.id)!;
  expect(updated.enabled).toBe(false);
  expect(updated.state.nextRunAtMs).toBeNull();
  expect(statusEvents.at(-1)).toEqual({
    taskId: oneShot.id,
    enabled: false,
    nextRunAtMs: null,
  });
});

test('startRunNow launches execution without blocking and records sessionId on executor error result', async () => {
  let finishExecutor!: (result: { sessionId: string; error: string; deliveryStatus: RunDeliveryStatus }) => void;
  const runEvents: Array<{ id: string; status: TaskStatus; taskName: string }> = [];

  const scheduler = new LobsterScheduler({
    db: createMemoryDb(),
    executor: () => new Promise(resolve => {
      finishExecutor = resolve;
    }),
  });
  scheduler.on('runUpdate', (evt: { run: { id: string; status: TaskStatus; taskName: string } }) => {
    runEvents.push({ id: evt.run.id, status: evt.run.status, taskName: evt.run.taskName });
  });

  const task = scheduler.createTask({ ...recurringJob, name: 'Background Job' });
  const { runId, completion } = scheduler.startRunNow(task.id);

  // Immediately marked running and duplicate start rejected while executor is still pending.
  expect(scheduler.getTask(task.id)?.state.lastStatus).toBe(TaskStatus.Running);
  expect(() => scheduler.startRunNow(task.id)).toThrow('already running');
  expect(runEvents).toEqual([{ id: runId, status: TaskStatus.Running, taskName: 'Background Job' }]);

  finishExecutor({
    sessionId: 'cw-timed-out-1',
    error: 'Scheduled task timed out after 5s',
    deliveryStatus: RunDeliveryStatus.NotRequested,
  });

  const finalRun = await completion;
  expect(finalRun).toMatchObject({
    id: runId,
    sessionId: 'cw-timed-out-1',
    status: TaskStatus.Error,
    error: 'Scheduled task timed out after 5s',
  });
  expect(scheduler.getTask(task.id)?.state.consecutiveErrors).toBe(1);
  expect(runEvents.at(-1)).toEqual({ id: runId, status: TaskStatus.Error, taskName: 'Background Job' });
});
