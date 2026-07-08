import { beforeEach, describe, expect, test, vi } from 'vitest';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

import {
  DeliveryMode,
  IpcChannel as ScheduledTaskIpc,
  PayloadKind,
  SessionTarget,
  WakeMode,
} from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import { registerScheduledTaskHandlers, type ScheduledTaskHandlerDeps } from './handlers';

function makeDeps(
  enginePhase: OpenClawEnginePhase = OpenClawEnginePhase.Running,
  options: { gatewayClient?: unknown } = {},
) {
  let gatewayClient: unknown = options.gatewayClient ?? null;
  const cronJobService = {
    listJobs: vi.fn(async () => []),
    listAllRuns: vi.fn(async () => []),
    addJob: vi.fn(async (input: { name?: string }) => ({ id: 'job-1', name: input?.name ?? '' })),
  };
  const adapter = {
    getGatewayClient: vi.fn(() => gatewayClient),
    getEngineStatusSnapshot: vi.fn(() => ({ phase: enginePhase })),
    connectGatewayIfNeeded: vi.fn(async () => {
      gatewayClient = {};
    }),
    fetchSessionByKey: vi.fn(async () => null),
  };
  const deps: ScheduledTaskHandlerDeps = {
    getCronJobService: () => cronJobService as unknown as CronJobService,
    getIMGatewayManager: () => null,
    getCoworkSessionTitle: () => null,
    getOpenClawRuntimeAdapter: () => adapter,
  };

  return { adapter, cronJobService, deps };
}

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerScheduledTaskHandlers', () => {
  test('connects the gateway client before listing scheduled tasks', async () => {
    const { adapter, cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.List);
    expect(handler).toBeDefined();

    const result = await handler?.();

    expect(adapter.connectGatewayIfNeeded).toHaveBeenCalledTimes(1);
    expect(cronJobService.listJobs).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, ready: true, tasks: [] });
  });

  test('connects the gateway client before listing scheduled task history', async () => {
    const { adapter, cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.ListAllRuns);
    expect(handler).toBeDefined();

    const result = await handler?.(undefined, 20, 0);

    expect(adapter.connectGatewayIfNeeded).toHaveBeenCalledTimes(1);
    expect(cronJobService.listAllRuns).toHaveBeenCalledWith(20, 0, undefined);
    expect(result).toEqual({ success: true, ready: true, runs: [] });
  });

  test('reports not-ready without blocking while the engine is still starting', async () => {
    const { adapter, cronJobService, deps } = makeDeps(OpenClawEnginePhase.Starting);
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.List);
    const result = await handler?.();

    expect(adapter.connectGatewayIfNeeded).not.toHaveBeenCalled();
    expect(cronJobService.listJobs).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, ready: false, tasks: [] });
  });

  test('restores IM delivery target casing and account from gateway sessions on create', async () => {
    const request = vi.fn(async () => ({
      sessions: [
        {
          updatedAt: 2_000,
          lastChannel: 'openclaw-weixin',
          lastTo: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
          lastAccountId: '91fcaf18cb3a-im-bot',
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    const result = await handler?.(undefined, {
      name: '科技早报',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      sessionTarget: SessionTarget.Main,
      wakeMode: WakeMode.Now,
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: '91fcaf18cb3a-im-bot:direct:o9cq809zec25-4jlkdw3ahtkpe9c@im.wechat',
      },
    });

    expect(request).toHaveBeenCalledWith(
      'sessions.list',
      expect.objectContaining({ includeGlobal: true }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(cronJobService.addJob).toHaveBeenCalledTimes(1);
    const input = cronJobService.addJob.mock.calls[0][0] as {
      sessionTarget: string;
      delivery: Record<string, unknown>;
    };
    expect(input.sessionTarget).toBe(SessionTarget.Isolated);
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'openclaw-weixin',
      to: 'o9cq809ZEC25-4jLkdw3AHTKPE9c@im.wechat',
      accountId: '91fcaf18cb3a-im-bot',
    });
    expect(result).toEqual({ success: true, task: { id: 'job-1', name: '科技早报' } });
  });

  test('binds the job to the conversation agent for agent-bound IM targets', async () => {
    const { cronJobService, deps } = makeDeps();
    const boundDeps: ScheduledTaskHandlerDeps = {
      ...deps,
      getIMGatewayManager: () => ({
        getIMStore: () => ({
          getSessionMapping: () => undefined,
          listSessionMappings: () => [
            {
              imConversationId: 'f1591db9:direct:bjwangning@corp.netease.com',
              platform: 'popo',
              coworkSessionId: 'cw-1',
              agentId: 'f15e78b0-agent',
              lastActiveAt: '2',
            },
          ],
        }),
        primeConversationReplyRoute: vi.fn(async () => {}),
      }),
    };
    registerScheduledTaskHandlers(boundDeps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    await handler?.(undefined, {
      name: '测试 popo',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'moltbot-popo',
        to: 'f1591db9:direct:bjwangning@corp.netease.com',
        accountId: 'f1591db9',
      },
    });

    expect(cronJobService.addJob).toHaveBeenCalledTimes(1);
    const input = cronJobService.addJob.mock.calls[0][0] as {
      agentId?: string;
      delivery: Record<string, unknown>;
    };
    expect(input.agentId).toBe('f15e78b0-agent');
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'moltbot-popo',
      to: 'bjwangning@corp.netease.com',
      accountId: 'f1591db9',
    });
  });

  test('keeps the stripped delivery target when gateway sessions are unavailable', async () => {
    const { cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    await handler?.(undefined, {
      name: 'weather',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'direct:o9cq809zec25-4jlkdw3ahtkpe9c@im.wechat',
      },
    });

    expect(cronJobService.addJob).toHaveBeenCalledTimes(1);
    const input = cronJobService.addJob.mock.calls[0][0] as { delivery: Record<string, unknown> };
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'openclaw-weixin',
      to: 'o9cq809zec25-4jlkdw3ahtkpe9c@im.wechat',
    });
  });
});
