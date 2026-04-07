/**
 * Unit tests for scheduledTask/migrate.ts
 *
 * Tests the one-time data-migration functions that move scheduled-task data
 * from the legacy SQLite schema into the OpenClaw gateway (JSONL + CronJobService).
 *
 * All dependencies are replaced with lightweight in-process fakes so the tests
 * run without a real SQLite file or OpenClaw gateway.
 *
 * Key behaviours under test:
 *   - migrateScheduledTasksToOpenclaw:
 *       - idempotency guard (kv flag already set -> no-op)
 *       - fresh install (no legacy table -> mark done, skip)
 *       - empty legacy table -> mark done, skip
 *       - valid task rows -> addJob called, kv flag set
 *       - invalid schedule_json -> task skipped, migration still completes
 *       - past one-time `at` task -> skipped (gateway would reject it)
 *       - gateway errors -> kv flag NOT set (allow retry next launch)
 *   - migrateScheduledTaskRunsToOpenclaw:
 *       - idempotency guard
 *       - no legacy runs table -> mark done, skip
 *       - run rows migrated to JSONL files in runs/ directory
 *       - duplicate timestamps deduplicated on re-run
 */
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateScheduledTasksToOpenclaw, migrateScheduledTaskRunsToOpenclaw } from './migrate';
import { MigrationKey } from './constants';
import type { ScheduledTaskInput } from './types';

// ---- fake helpers -----------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-migrate-test-'));
}
function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a fake better-sqlite3-style Database whose prepare() returns canned results.
 *
 * `tables` is a Set of table names that "exist".
 * `taskRows` / `runRows` / `taskNameRows` provide data for specific queries.
 */
function fakeDb({
  tables = new Set<string>(),
  taskRows = [] as Record<string, unknown>[],
  runRows = [] as Record<string, unknown>[],
  taskNameRows = [] as { id: string; name: string }[],
} = {}) {
  return {
    prepare(sql: string) {
      return {
        get(): unknown {
          if (sql.includes('sqlite_master') && sql.includes("'scheduled_tasks'")) {
            return tables.has('scheduled_tasks') ? { name: 'scheduled_tasks' } : undefined;
          }
          if (sql.includes('sqlite_master') && sql.includes("'scheduled_task_runs'")) {
            return tables.has('scheduled_task_runs') ? { name: 'scheduled_task_runs' } : undefined;
          }
          return undefined;
        },
        all(): unknown[] {
          // Task name rows (for run history migration) — match before the broader FROM scheduled_tasks
          if (sql.includes('SELECT id, name FROM scheduled_tasks')) {
            return taskNameRows;
          }
          // Legacy task rows
          if (sql.includes('FROM scheduled_tasks') && !sql.includes('task_runs') && !sql.includes('sqlite_master')) {
            return taskRows;
          }
          // Legacy run rows
          if (sql.includes('FROM scheduled_task_runs')) {
            return runRows;
          }
          return [];
        },
      };
    },
  };
}

function makeKv(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getKv: (key: string) => store[key],
    setKv: (key: string, val: string) => { store[key] = val; },
    store,
  };
}

function makeCronService() {
  const jobs: ScheduledTaskInput[] = [];
  let shouldThrow = false;
  return {
    addJob: async (input: ScheduledTaskInput) => {
      if (shouldThrow) throw new Error('gateway unavailable');
      jobs.push(input);
    },
    forceError: () => { shouldThrow = true; },
    jobs,
  };
}

// ==================== migrateScheduledTasksToOpenclaw ====================

test('migration tasks: idempotency guard — no-op when already done', async () => {
  const kv = makeKv({ [MigrationKey.TasksToOpenclaw]: 'true' });
  const cron = makeCronService();
  const db = fakeDb({ tables: new Set(['scheduled_tasks']) });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(cron.jobs.length).toBe(0);
});

test('migration tasks: fresh install — no legacy table -> marks done', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb(); // no tables

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(kv.store[MigrationKey.TasksToOpenclaw]).toBe('true');
  expect(cron.jobs.length).toBe(0);
});

test('migration tasks: empty legacy table -> marks done without calling addJob', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb({ tables: new Set(['scheduled_tasks']), taskRows: [] });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(kv.store[MigrationKey.TasksToOpenclaw]).toBe('true');
  expect(cron.jobs.length).toBe(0);
});

test('migration tasks: valid cron task is migrated via addJob', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb({
    tables: new Set(['scheduled_tasks']),
    taskRows: [{
      id: 'task-1',
      name: 'Daily standup',
      description: 'Morning standup reminder',
      enabled: 1,
      schedule_json: JSON.stringify({ type: 'cron', expression: '0 9 * * 1-5' }),
      prompt: 'Remind me of the standup meeting',
      notify_platforms_json: '["dingtalk"]',
    }],
  });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(cron.jobs.length).toBe(1);
  expect(cron.jobs[0].name).toBe('Daily standup');
  expect(cron.jobs[0].schedule.kind).toBe('cron');
  expect((cron.jobs[0].schedule as { expr: string }).expr).toBe('0 9 * * 1-5');
  expect(kv.store[MigrationKey.TasksToOpenclaw]).toBe('true');
});

test('migration tasks: interval task is migrated with everyMs', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb({
    tables: new Set(['scheduled_tasks']),
    taskRows: [{
      id: 'task-2',
      name: 'Hourly check',
      description: '',
      enabled: 1,
      schedule_json: JSON.stringify({ type: 'interval', intervalMs: 3_600_000 }),
      prompt: 'Check emails',
      notify_platforms_json: '[]',
    }],
  });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(cron.jobs.length).toBe(1);
  expect(cron.jobs[0].schedule.kind).toBe('every');
  expect((cron.jobs[0].schedule as { everyMs: number }).everyMs).toBe(3_600_000);
});

test('migration tasks: past one-time "at" task is skipped (not sent to gateway)', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const pastTime = new Date(Date.now() - 86_400_000).toISOString(); // yesterday
  const db = fakeDb({
    tables: new Set(['scheduled_tasks']),
    taskRows: [{
      id: 'task-past',
      name: 'Expired reminder',
      description: '',
      enabled: 1,
      schedule_json: JSON.stringify({ type: 'at', datetime: pastTime }),
      prompt: 'Long gone reminder',
      notify_platforms_json: '[]',
    }],
  });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(cron.jobs.length).toBe(0);
  expect(kv.store[MigrationKey.TasksToOpenclaw]).toBe('true');
});

test('migration tasks: invalid schedule_json causes task to be skipped', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb({
    tables: new Set(['scheduled_tasks']),
    taskRows: [
      {
        id: 'bad-task',
        name: 'Bad schedule',
        description: '',
        enabled: 1,
        schedule_json: 'this is not json',
        prompt: 'will be skipped',
        notify_platforms_json: '[]',
      },
      {
        id: 'good-task',
        name: 'Good schedule',
        description: '',
        enabled: 1,
        schedule_json: JSON.stringify({ type: 'cron', expression: '0 8 * * *' }),
        prompt: 'Morning brief',
        notify_platforms_json: '[]',
      },
    ],
  });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(cron.jobs.length).toBe(1);
  expect(cron.jobs[0].name).toBe('Good schedule');
  expect(kv.store[MigrationKey.TasksToOpenclaw]).toBe('true');
});

test('migration tasks: gateway errors prevent kv flag from being set (allows retry)', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  cron.forceError();

  const db = fakeDb({
    tables: new Set(['scheduled_tasks']),
    taskRows: [{
      id: 'task-err',
      name: 'Will fail',
      description: '',
      enabled: 1,
      schedule_json: JSON.stringify({ type: 'cron', expression: '*/5 * * * *' }),
      prompt: 'periodic job',
      notify_platforms_json: '[]',
    }],
  });

  await migrateScheduledTasksToOpenclaw({ db: db as never, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron as never });

  expect(kv.store[MigrationKey.TasksToOpenclaw]).not.toBe('true');
});

// ==================== migrateScheduledTaskRunsToOpenclaw ====================

test('migration runs: idempotency guard — no-op when already done', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv({ [MigrationKey.RunsToOpenclaw]: 'true' });
    const db = fakeDb({ tables: new Set(['scheduled_task_runs']) });

    await migrateScheduledTaskRunsToOpenclaw({
      db: db as never, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    // No JSONL files written
    const runsDir = path.join(dir, 'cron', 'runs');
    expect(!fs.existsSync(runsDir) || fs.readdirSync(runsDir).length === 0).toBe(true);
  } finally {
    cleanupDir(dir);
  }
});

test('migration runs: no legacy table -> marks done', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv();
    const db = fakeDb(); // no tables

    await migrateScheduledTaskRunsToOpenclaw({
      db: db as never, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    expect(kv.store[MigrationKey.RunsToOpenclaw]).toBe('true');
  } finally {
    cleanupDir(dir);
  }
});

test('migration runs: run rows written to per-task JSONL files', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv();
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    const finishedAt = new Date(Date.now() - 4_000).toISOString();

    const db = fakeDb({
      tables: new Set(['scheduled_task_runs', 'scheduled_tasks']),
      runRows: [{
        id: 'run-1',
        task_id: 'task-abc',
        session_id: 'sess-xyz',
        status: 'success',
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: 1000,
        error: null,
      }],
    });

    await migrateScheduledTaskRunsToOpenclaw({
      db: db as never, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const jsonlPath = path.join(dir, 'cron', 'runs', 'task-abc.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.jobId).toBe('task-abc');
    expect(entry.action).toBe('finished');
    expect(entry.status).toBe('ok');
    expect(entry.sessionId).toBe('sess-xyz');
    expect(entry.durationMs).toBe(1000);
    expect(kv.store[MigrationKey.RunsToOpenclaw]).toBe('true');
  } finally {
    cleanupDir(dir);
  }
});

test('migration runs: duplicate timestamps are not written twice on re-run', async () => {
  const dir = makeTmpDir();
  try {
    const finishedAt = new Date(Date.now() - 2_000).toISOString();
    const finishedMs = new Date(finishedAt).getTime();

    // Pre-write the JSONL with the same timestamp
    const runsDir = path.join(dir, 'cron', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const jsonlPath = path.join(runsDir, 'task-dup.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({ ts: finishedMs, jobId: 'task-dup', action: 'finished', status: 'ok' }) + '\n');

    const kv = makeKv();
    const db = fakeDb({
      tables: new Set(['scheduled_task_runs']),
      runRows: [{
        id: 'run-dup',
        task_id: 'task-dup',
        session_id: null,
        status: 'success',
        started_at: new Date(finishedMs - 1000).toISOString(),
        finished_at: finishedAt,
        duration_ms: 1000,
        error: null,
      }],
    });

    await migrateScheduledTaskRunsToOpenclaw({
      db: db as never, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  } finally {
    cleanupDir(dir);
  }
});

test('migration runs: error status maps to "error" in JSONL', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv();
    const startedAt = new Date(Date.now() - 10_000).toISOString();
    const finishedAt = new Date(Date.now() - 9_000).toISOString();

    const db = fakeDb({
      tables: new Set(['scheduled_task_runs']),
      runRows: [{
        id: 'run-err',
        task_id: 'task-err',
        session_id: null,
        status: 'error',
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: 1000,
        error: 'timeout exceeded',
      }],
    });

    await migrateScheduledTaskRunsToOpenclaw({
      db: db as never, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const jsonlPath = path.join(dir, 'cron', 'runs', 'task-err.jsonl');
    const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim());
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('timeout exceeded');
  } finally {
    cleanupDir(dir);
  }
});
