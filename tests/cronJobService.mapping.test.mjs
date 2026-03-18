import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mapGatewayJob,
  mapGatewayRun,
  mapGatewayTaskState,
} = require('../dist-electron/main/libs/cronJobService.js');

test('mapGatewayTaskState marks running jobs as running and preserves counters', () => {
  const state = mapGatewayTaskState({
    nextRunAtMs: 10,
    lastRunAtMs: 5,
    lastRunStatus: 'ok',
    lastError: 'boom',
    lastDurationMs: 3000,
    runningAtMs: 20,
    consecutiveErrors: 4,
  });

  assert.deepEqual(state, {
    nextRunAtMs: 10,
    lastRunAtMs: 5,
    lastStatus: 'running',
    lastError: 'boom',
    lastDurationMs: 3000,
    runningAtMs: 20,
    consecutiveErrors: 4,
  });
});

test('mapGatewayJob keeps native cron fields without legacy wrappers', () => {
  const job = mapGatewayJob({
    id: 'job-1',
    name: 'Morning brief',
    description: 'Send a summary',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: { kind: 'agentTurn', message: 'Summarize updates', timeoutSeconds: 45 },
    delivery: { mode: 'announce', channel: 'last', to: 'chat-1' },
    agentId: 'agent-42',
    sessionKey: 'session-1',
    state: {
      nextRunAtMs: 100,
      lastRunAtMs: 90,
      lastRunStatus: 'skipped',
    },
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
  });

  assert.equal(job.schedule.kind, 'cron');
  assert.equal(job.schedule.expr, '0 9 * * *');
  assert.equal(job.schedule.tz, 'Asia/Shanghai');
  assert.equal(job.payload.kind, 'agentTurn');
  assert.equal(job.payload.timeoutSeconds, 45);
  assert.deepEqual(job.delivery, {
    mode: 'announce',
    channel: 'last',
    to: 'chat-1',
  });
  assert.equal(job.agentId, 'agent-42');
  assert.equal(job.sessionKey, 'session-1');
  assert.equal(job.state.lastStatus, 'skipped');
});

test('mapGatewayRun translates gateway statuses including skipped', () => {
  const skipped = mapGatewayRun({
    ts: 1_700_000_200_000,
    jobId: 'job-1',
    action: 'finished',
    status: 'skipped',
    sessionId: 'session-a',
    sessionKey: 'session-key-a',
    runAtMs: 1_700_000_150_000,
    durationMs: 12_000,
  });

  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.sessionId, 'session-a');
  assert.equal(skipped.sessionKey, 'session-key-a');
  assert.equal(skipped.durationMs, 12_000);
  assert.notEqual(skipped.finishedAt, null);
});
