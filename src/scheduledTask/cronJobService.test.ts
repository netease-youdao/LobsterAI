import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  DeliveryMode,
  GatewayStatus,
  PayloadKind,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from './constants';
import {
  CronJobService,
  isInternalScheduledTaskJob,
  mapGatewayJob,
  mapGatewayRun,
  mapGatewayTaskState,
} from './cronJobService';

function makeGatewayJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'Morning brief',
    description: 'Send a summary',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    sessionTarget: SessionTarget.Isolated,
    wakeMode: WakeMode.Now,
    payload: { kind: PayloadKind.AgentTurn, message: 'Summarize updates' },
    delivery: { mode: DeliveryMode.None },
    agentId: null,
    sessionKey: null,
    state: {},
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
    ...overrides,
  };
}

describe('isInternalScheduledTaskJob', () => {
  test('detects memory-core managed descriptions', () => {
    expect(
      isInternalScheduledTaskJob(
        makeGatewayJob({
          description: '[managed-by=memory-core.short-term-promotion] Promote recalls',
        }),
      ),
    ).toBe(true);
  });

  test('detects memory-core payload sentinels', () => {
    expect(
      isInternalScheduledTaskJob(
        makeGatewayJob({
          description: '',
          payload: {
            kind: PayloadKind.AgentTurn,
            message: '__openclaw_memory_core_short_term_promotion_dream__',
          },
        }),
      ),
    ).toBe(true);
  });

  test('does not hide regular user tasks', () => {
    expect(isInternalScheduledTaskJob(makeGatewayJob())).toBe(false);
  });
});

describe('CronJobService internal task filtering', () => {
  test('hides memory-core tasks from the task list', async () => {
    const userJob = makeGatewayJob({ id: 'user-job', name: 'User task' });
    const internalJob = makeGatewayJob({
      id: 'dream-job',
      name: 'Memory Dreaming Promotion',
      description: '[managed-by=memory-core.short-term-promotion] Promote recalls',
      payload: {
        kind: PayloadKind.AgentTurn,
        message: '__openclaw_memory_core_short_term_promotion_dream__',
      },
    });
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>() => ({ jobs: [internalJob, userJob] }) as T,
      }),
      ensureGatewayReady: async () => {},
    });

    const jobs = await service.listJobs();

    expect(jobs.map(job => job.id)).toEqual(['user-job']);
  });

  test('hides memory-core runs from the global run history', async () => {
    const userJob1 = makeGatewayJob({ id: 'user-job-1', name: 'User task 1' });
    const userJob2 = makeGatewayJob({ id: 'user-job-2', name: 'User task 2' });
    const internalJob = makeGatewayJob({
      id: 'dream-job',
      name: 'Memory Dreaming Promotion',
      description: '[managed-by=memory-core.short-term-promotion] Promote recalls',
      payload: {
        kind: PayloadKind.AgentTurn,
        message: '__openclaw_memory_core_short_term_promotion_dream__',
      },
    });
    const entries = [
      { ts: 4, jobId: 'dream-job', status: GatewayStatus.Ok, runAtMs: 4 },
      { ts: 3, jobId: 'user-job-1', status: GatewayStatus.Ok, runAtMs: 3 },
      { ts: 2, jobId: 'dream-job', status: GatewayStatus.Ok, runAtMs: 2 },
      { ts: 1, jobId: 'user-job-2', status: GatewayStatus.Ok, runAtMs: 1 },
    ];
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>(method: string, params?: unknown) => {
          if (method === 'cron.list') {
            return { jobs: [internalJob, userJob1, userJob2] } as T;
          }
          if (method === 'cron.runs') {
            const runParams = params as { offset?: number; limit?: number } | undefined;
            const start = runParams?.offset ?? 0;
            const end = start + (runParams?.limit ?? entries.length);
            return { entries: entries.slice(start, end) } as T;
          }
          return {} as T;
        },
      }),
      ensureGatewayReady: async () => {},
    });

    const runs = await service.listAllRuns(2, 0);

    expect(runs.map(run => run.taskId)).toEqual(['user-job-1', 'user-job-2']);
    expect(runs.map(run => run.taskName)).toEqual(['User task 1', 'User task 2']);
  });

  test('applies global run offsets after internal runs are hidden', async () => {
    const userJob1 = makeGatewayJob({ id: 'user-job-1', name: 'User task 1' });
    const userJob2 = makeGatewayJob({ id: 'user-job-2', name: 'User task 2' });
    const internalJob = makeGatewayJob({
      id: 'dream-job',
      name: 'Memory Dreaming Promotion',
      description: '[managed-by=memory-core.short-term-promotion] Promote recalls',
    });
    const entries = [
      { ts: 3, jobId: 'user-job-1', status: GatewayStatus.Ok, runAtMs: 3 },
      { ts: 2, jobId: 'dream-job', status: GatewayStatus.Ok, runAtMs: 2 },
      { ts: 1, jobId: 'user-job-2', status: GatewayStatus.Ok, runAtMs: 1 },
    ];
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>(method: string, params?: unknown) => {
          if (method === 'cron.list') {
            return { jobs: [internalJob, userJob1, userJob2] } as T;
          }
          if (method === 'cron.runs') {
            const runParams = params as { offset?: number; limit?: number } | undefined;
            const start = runParams?.offset ?? 0;
            const end = start + (runParams?.limit ?? entries.length);
            return { entries: entries.slice(start, end) } as T;
          }
          return {} as T;
        },
      }),
      ensureGatewayReady: async () => {},
    });

    const runs = await service.listAllRuns(1, 1);

    expect(runs.map(run => run.taskId)).toEqual(['user-job-2']);
  });
});

describe('CronJobService gateway readiness', () => {
  test('polls immediately when the gateway becomes ready after polling started', async () => {
    let gatewayClient: { request: <T>() => Promise<T> } | null = null;
    const request = vi.fn(async <T>() => ({ jobs: [] }) as T);
    const service = new CronJobService({
      getGatewayClient: () => gatewayClient,
      ensureGatewayReady: async () => {},
    });

    service.startPolling();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();

    gatewayClient = { request };
    service.notifyGatewayReady();

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('cron.list', {
      includeDisabled: true,
      limit: 200,
    }));
    service.stopPolling();
  });
});

describe('CronJobService run history filtering', () => {
  test('filters global runs by application status after reading gateway entries', async () => {
    const job = makeGatewayJob({ id: 'job-1', name: 'User task' });
    const entries = [
      { ts: 4, jobId: 'job-1', status: GatewayStatus.Skipped, runAtMs: 4 },
      { ts: 3, jobId: 'job-1', status: GatewayStatus.Ok, runAtMs: 3 },
      {
        ts: 2,
        jobId: 'job-1',
        status: GatewayStatus.Error,
        runAtMs: 2,
        error: 'delivery failed',
        deliveryError: 'delivery failed',
      },
      { ts: 1, jobId: 'job-1', status: GatewayStatus.Error, runAtMs: 1, error: 'agent failed' },
    ];
    const runRequests: unknown[] = [];
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>(method: string, params?: unknown) => {
          if (method === 'cron.list') {
            return { jobs: [job] } as T;
          }
          if (method === 'cron.runs') {
            runRequests.push(params);
            return { entries } as T;
          }
          return {} as T;
        },
      }),
      ensureGatewayReady: async () => {},
    });

    const runs = await service.listAllRuns(10, 0, { status: TaskStatus.Success });

    expect(runs.map(run => run.id)).toEqual(['job-1-3', 'job-1-2']);
    expect(runRequests.every(params => !('status' in (params as Record<string, unknown>)))).toBe(
      true,
    );
  });

  test('applies job run offsets after status filtering', async () => {
    const job = makeGatewayJob({ id: 'job-1', name: 'User task' });
    const entries = [
      { ts: 4, jobId: 'job-1', status: GatewayStatus.Ok, runAtMs: 4 },
      { ts: 3, jobId: 'job-1', status: GatewayStatus.Error, runAtMs: 3 },
      { ts: 2, jobId: 'job-1', status: GatewayStatus.Ok, runAtMs: 2 },
    ];
    const runRequests: unknown[] = [];
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>(method: string, params?: unknown) => {
          if (method === 'cron.list') {
            return { jobs: [job] } as T;
          }
          if (method === 'cron.runs') {
            runRequests.push(params);
            return { entries } as T;
          }
          return {} as T;
        },
      }),
      ensureGatewayReady: async () => {},
    });

    const runs = await service.listRuns('job-1', 1, 1, { status: TaskStatus.Success });

    expect(runs.map(run => run.id)).toEqual(['job-1-2']);
    expect(runRequests.every(params => !('status' in (params as Record<string, unknown>)))).toBe(
      true,
    );
  });
});

describe('CronJobService delivery cache', () => {
  test('caches delivery routing on add and update for synchronous lookups', async () => {
    const added = makeGatewayJob({
      id: 'wx-job',
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      },
    });
    const updated = makeGatewayJob({ id: 'wx-job', delivery: { mode: DeliveryMode.None } });
    const service = new CronJobService({
      getGatewayClient: () => ({
        request: async <T>(method: string) => (method === 'cron.add' ? added : updated) as T,
      }),
      ensureGatewayReady: async () => {},
    });

    await service.addJob({
      name: 'WeChat brief',
      description: '',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      payload: { kind: PayloadKind.AgentTurn, message: 'brief' },
      delivery: { mode: DeliveryMode.Announce, channel: 'openclaw-weixin', to: 'x@im.wechat' },
    });
    expect(service.getJobDeliverySync('wx-job')).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'openclaw-weixin',
    });

    await service.updateJob('wx-job', { delivery: { mode: DeliveryMode.None } });
    expect(service.getJobDeliverySync('wx-job')).toEqual({ mode: DeliveryMode.None });

    expect(service.getJobDeliverySync('missing-job')).toBeNull();
  });
});

describe('mapGatewayRun', () => {
  const baseEntry = {
    ts: 1700000000000,
    jobId: 'job-1',
    status: GatewayStatus.Ok,
    sessionId: 'sess-1',
    runAtMs: 1699999990000,
    durationMs: 10000,
    summary: 'All good',
  };

  test('maps ok status to success', () => {
    const run = mapGatewayRun(baseEntry);
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
    expect(run.summary).toBe('All good');
  });

  test('maps error status to error', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'something broke',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('something broke');
  });

  test('maps running action to running', () => {
    const run = mapGatewayRun({ ...baseEntry, action: 'started' });
    expect(run.status).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error to success', () => {
    const deliveryError = '⚠️ ✉️ Message failed';
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: deliveryError,
      deliveryStatus: 'not-delivered',
      deliveryError,
      summary: 'Agent produced a valid summary',
    });
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
    expect(run.summary).toBe('Agent produced a valid summary');
    expect(run.deliveryError).toBe(deliveryError);
  });

  test('does not suppress error when error differs from deliveryError', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'agent crashed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('agent crashed');
  });

  test('does not suppress error when no deliveryError is present', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'timeout',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('timeout');
  });
});

describe('mapGatewayJob', () => {
  test('keeps native cron fields without legacy wrappers', () => {
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

    expect(job.schedule.kind).toBe('cron');
    expect((job.schedule as { expr: string }).expr).toBe('0 9 * * *');
    expect((job.schedule as { tz: string }).tz).toBe('Asia/Shanghai');
    expect(job.payload.kind).toBe('agentTurn');
    expect((job.payload as { timeoutSeconds: number }).timeoutSeconds).toBe(45);
    expect(job.delivery).toEqual({
      mode: 'announce',
      channel: 'last',
      to: 'chat-1',
    });
    expect(job.agentId).toBe('agent-42');
    expect(job.sessionKey).toBe('session-1');
    expect(job.state.lastStatus).toBe('skipped');
  });

  test('strips stale channel/to when delivery mode is none', () => {
    // The gateway patch-merges delivery on cron.update and cannot clear a
    // previously-set channel/to, so a job switched to "不通知" still returns
    // the old target. mapGatewayJob must drop it so the edit form shows none.
    const job = mapGatewayJob(
      makeGatewayJob({
        delivery: {
          mode: DeliveryMode.None,
          channel: 'moltbot-popo',
          to: 'liucong03@corp.netease.com',
          accountId: 'acc-1',
          bestEffort: true,
        },
      }),
    );

    expect(job.delivery).toEqual({ mode: DeliveryMode.None });
  });

  test('does not infer channel from sessionKey when delivery mode is none', () => {
    const job = mapGatewayJob(
      makeGatewayJob({
        delivery: { mode: DeliveryMode.None },
        sessionKey: 'popo:ou_someuser',
      }),
    );

    expect(job.delivery).toEqual({ mode: DeliveryMode.None });
  });
});

describe('mapGatewayTaskState', () => {
  test('maps ok status to success', () => {
    const state = mapGatewayTaskState(
      { lastRunStatus: GatewayStatus.Ok, lastRunAtMs: 1700000000000 },
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('maps error status to error', () => {
    const state = mapGatewayTaskState(
      { lastRunStatus: GatewayStatus.Error, lastError: 'fail' },
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('fail');
  });

  test('maps running state', () => {
    const state = mapGatewayTaskState(
      { runningAtMs: Date.now(), lastRunStatus: GatewayStatus.Ok },
    );
    expect(state.lastStatus).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error when delivery mode is none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('does not suppress delivery error when delivery mode is announce', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.Announce,
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('⚠️ ✉️ Message failed');
  });

  test('does not suppress non-delivery errors even for mode none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: 'agent timeout',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('agent timeout');
  });
});
