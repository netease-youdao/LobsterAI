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
 *       • idempotency guard (kv flag already set → no-op)
 *       • fresh install (no legacy table → mark done, skip)
 *       • empty legacy table → mark done, skip
 *       • valid task rows → addJob called, kv flag set
 *       • invalid schedule_json → task skipped, migration still completes
 *       • past one-time `at` task → skipped (gateway would reject it)
 *       • gateway errors → kv flag NOT set (allow retry next launch)
 *   - migrateScheduledTaskRunsToOpenclaw:
 *       • idempotency guard
 *       • no legacy runs table → mark done, skip
 *       • run rows migrated to JSONL files in runs/ directory
 *       • duplicate timestamps deduplicated on re-run
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  migrateScheduledTasksToOpenclaw,
  migrateScheduledTaskRunsToOpenclaw,
} = require('../dist-electron/scheduled-task/migrate.js');
const { MigrationKey } = require('../dist-electron/scheduled-task/constants.js');

// ---- fake helpers -----------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-migrate-test-'));
}
function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a fake sql.js-style Database whose exec() returns canned results.
 *
 * `tables` is a Set of table names that "exist".
 * `rows` is keyed by a string prefix of the SQL query so we can distinguish
 * the table-check query from the data-select query.
 */
function fakeDb({ tables = new Set(), taskRows = [], runRows = [], taskNameRows = [] } = {}) {
  return {
    exec(sql) {
      // Table existence check
      if (sql.includes("sqlite_master") && sql.includes("'scheduled_tasks'")) {
        return tables.has('scheduled_tasks')
          ? [{ columns: ['name'], values: [['scheduled_tasks']] }]
          : [];
      }
      if (sql.includes("sqlite_master") && sql.includes("'scheduled_task_runs'")) {
        return tables.has('scheduled_task_runs')
          ? [{ columns: ['name'], values: [['scheduled_task_runs']] }]
          : [];
      }
      // Legacy task rows
      if (sql.includes('FROM scheduled_tasks') && !sql.includes('task_runs') && !sql.includes('sqlite_master')) {
        if (taskRows.length === 0) return [];
        const cols = ['id', 'name', 'description', 'enabled', 'schedule_json', 'prompt', 'notify_platforms_json'];
        return [{
          columns: cols,
          values: taskRows.map((r) => cols.map((c) => r[c] ?? null)),
        }];
      }
      // Task name rows (for run history migration)
      if (sql.includes('SELECT id, name FROM scheduled_tasks')) {
        if (taskNameRows.length === 0) return [];
        return [{ columns: ['id', 'name'], values: taskNameRows.map((r) => [r.id, r.name]) }];
      }
      // Legacy run rows
      if (sql.includes('FROM scheduled_task_runs')) {
        if (runRows.length === 0) return [];
        const cols = ['id', 'task_id', 'session_id', 'status', 'started_at', 'finished_at', 'duration_ms', 'error'];
        return [{
          columns: cols,
          values: runRows.map((r) => cols.map((c) => r[c] ?? null)),
        }];
      }
      return [];
    },
  };
}

function makeKv(initial = {}) {
  const store = { ...initial };
  return {
    getKv: (key) => store[key],
    setKv: (key, val) => { store[key] = val; },
    store,
  };
}

function makeCronService() {
  const jobs = [];
  let shouldThrow = false;
  return {
    addJob: async (input) => {
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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(cron.jobs.length, 0, 'addJob must not be called when already migrated');
});

test('migration tasks: fresh install — no legacy table → marks done', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb(); // no tables

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(kv.store[MigrationKey.TasksToOpenclaw], 'true');
  assert.equal(cron.jobs.length, 0);
});

test('migration tasks: empty legacy table → marks done without calling addJob', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  const db = fakeDb({ tables: new Set(['scheduled_tasks']), taskRows: [] });

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(kv.store[MigrationKey.TasksToOpenclaw], 'true');
  assert.equal(cron.jobs.length, 0);
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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(cron.jobs.length, 1);
  assert.equal(cron.jobs[0].name, 'Daily standup');
  assert.equal(cron.jobs[0].schedule.kind, 'cron');
  assert.equal(cron.jobs[0].schedule.expr, '0 9 * * 1-5');
  assert.equal(kv.store[MigrationKey.TasksToOpenclaw], 'true');
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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(cron.jobs.length, 1);
  assert.equal(cron.jobs[0].schedule.kind, 'every');
  assert.equal(cron.jobs[0].schedule.everyMs, 3_600_000);
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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(cron.jobs.length, 0, 'past one-time task must be skipped');
  assert.equal(kv.store[MigrationKey.TasksToOpenclaw], 'true');
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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.equal(cron.jobs.length, 1, 'only the valid task should be migrated');
  assert.equal(cron.jobs[0].name, 'Good schedule');
  assert.equal(kv.store[MigrationKey.TasksToOpenclaw], 'true');
});

test('migration tasks: gateway errors prevent kv flag from being set (allows retry)', async () => {
  const kv = makeKv();
  const cron = makeCronService();
  cron.forceError();  // All addJob calls will throw

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

  await migrateScheduledTasksToOpenclaw({ db, getKv: kv.getKv, setKv: kv.setKv, cronJobService: cron });

  assert.notEqual(kv.store[MigrationKey.TasksToOpenclaw], 'true',
    'flag must NOT be set when gateway errors occur (to allow retry on next launch)');
});

// ==================== migrateScheduledTaskRunsToOpenclaw ====================

test('migration runs: idempotency guard — no-op when already done', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv({ [MigrationKey.RunsToOpenclaw]: 'true' });
    const db = fakeDb({ tables: new Set(['scheduled_task_runs']) });

    await migrateScheduledTaskRunsToOpenclaw({
      db, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    // No JSONL files written
    const runsDir = path.join(dir, 'cron', 'runs');
    assert.ok(!fs.existsSync(runsDir) || fs.readdirSync(runsDir).length === 0);
  } finally {
    cleanupDir(dir);
  }
});

test('migration runs: no legacy table → marks done', async () => {
  const dir = makeTmpDir();
  try {
    const kv = makeKv();
    const db = fakeDb(); // no tables

    await migrateScheduledTaskRunsToOpenclaw({
      db, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    assert.equal(kv.store[MigrationKey.RunsToOpenclaw], 'true');
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
      db, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const jsonlPath = path.join(dir, 'cron', 'runs', 'task-abc.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'JSONL file should be created for task-abc');

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.jobId, 'task-abc');
    assert.equal(entry.action, 'finished');
    assert.equal(entry.status, 'ok');
    assert.equal(entry.sessionId, 'sess-xyz');
    assert.equal(entry.durationMs, 1000);
    assert.equal(kv.store[MigrationKey.RunsToOpenclaw], 'true');
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
      db, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'duplicate timestamp should not be appended again');
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
      db, getKv: kv.getKv, setKv: kv.setKv, openclawStateDir: dir,
    });

    const jsonlPath = path.join(dir, 'cron', 'runs', 'task-err.jsonl');
    const entry = JSON.parse(fs.readFileSync(jsonlPath, 'utf-8').trim());
    assert.equal(entry.status, 'error');
    assert.equal(entry.error, 'timeout exceeded');
  } finally {
    cleanupDir(dir);
  }
});
