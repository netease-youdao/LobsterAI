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
  RunDeliveryStatus,
  SessionTarget,
  TaskStatus,
  WakeMode,
} from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import {
  migrateScheduledTaskAnnounceJobs,
  registerScheduledTaskHandlers,
  type ScheduledTaskHandlerDeps,
} from './handlers';

function makeDeps(
  enginePhase: OpenClawEnginePhase = OpenClawEnginePhase.Running,
  options: { gatewayClient?: unknown } = {},
) {
  let gatewayClient: unknown = options.gatewayClient ?? null;
  const cronJobService = {
    listJobs: vi.fn(async () => []),
    getJob: vi.fn(async () => null),
    listRuns: vi.fn(async () => []),
    listAllRuns: vi.fn(async () => []),
    addJob: vi.fn(async (input: { name?: string }) => ({ id: 'job-1', name: input?.name ?? '' })),
    updateJob: vi.fn(async (id: string, input: { name?: string }) => ({
      id,
      name: input?.name ?? '',
    })),
    runJob: vi.fn(async () => {}),
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
          lastTo: 'WxId_ZhangSan@im.wechat',
          lastAccountId: 'weixin-bot-1',
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
        to: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
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
      to: 'WxId_ZhangSan@im.wechat',
      accountId: 'weixin-bot-1',
    });
    expect(result).toEqual({ success: true, task: { id: 'job-1', name: '科技早报' } });
  });

  test('restores a WeCom group chat id from case-preserving origin metadata on create', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const request = vi.fn(async () => ({
      sessions: [
        {
          updatedAt: 2_000,
          origin: {
            provider: 'wecom',
            surface: 'wecom',
            chatType: 'group',
            to: `wecom:${nativeGroupId}`,
            accountId: 'wecom-bot-1',
          },
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    await handler?.(undefined, {
      name: 'wecom group',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'wecom',
        to: `group:${nativeGroupId.toLowerCase()}`,
        accountId: 'wecom-bot-1',
      },
    });

    const input = cronJobService.addJob.mock.calls[0][0] as {
      delivery: Record<string, unknown>;
    };
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'wecom',
      to: nativeGroupId,
      accountId: 'wecom-bot-1',
    });
  });

  test('restores a DingTalk group id from case-preserving origin metadata on create', async () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    const request = vi.fn(async () => ({
      sessions: [
        {
          origin: {
            provider: 'dingtalk-connector',
            chatType: 'group',
            to: nativeConversationId,
            accountId: 'dingtalk-bot-1',
          },
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    await handler?.(undefined, {
      name: 'dingtalk group',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'dingtalk-connector',
        to: `group:${nativeConversationId.toLowerCase()}`,
        accountId: 'dingtalk-bot-1',
      },
    });

    const input = cronJobService.addJob.mock.calls[0][0] as {
      delivery: Record<string, unknown>;
    };
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'dingtalk-connector',
      to: nativeConversationId,
      accountId: 'dingtalk-bot-1',
    });
  });

  test('repairs only the casing of an existing WeCom group target', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const request = vi.fn(async () => ({
      sessions: [
        {
          lastChannel: 'wecom',
          lastTo: nativeGroupId.toLowerCase(),
          lastAccountId: 'inferred-account-must-not-be-added',
          origin: {
            provider: 'wecom',
            chatType: 'group',
            to: `wecom:${nativeGroupId}`,
            accountId: 'wecom-bot-1',
          },
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    cronJobService.listJobs.mockResolvedValue([
      {
        id: 'legacy-wecom-job',
        name: 'legacy wecom group',
        description: '',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 13 * * *' },
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
        delivery: {
          mode: DeliveryMode.Announce,
          channel: 'wecom',
          to: nativeGroupId.toLowerCase(),
        },
        agentId: 'agent-wecom-bot-1',
        sessionKey: null,
        state: {},
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      },
    ]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 1 });
    expect(cronJobService.updateJob).toHaveBeenCalledWith('legacy-wecom-job', {
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'wecom',
        to: nativeGroupId,
      },
    });
  });

  test('preserves an existing native-case WeCom target when gateway hints are unavailable', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const { adapter, cronJobService, deps } = makeDeps(OpenClawEnginePhase.Starting);
    cronJobService.listJobs.mockResolvedValue([
      {
        id: 'native-wecom-job',
        name: 'native wecom group',
        description: '',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 13 * * *' },
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
        delivery: {
          mode: DeliveryMode.Announce,
          channel: 'wecom',
          to: nativeGroupId,
          accountId: 'wecom-bot-1',
        },
        agentId: 'agent-wecom-bot-1',
        sessionKey: null,
        state: {},
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      },
    ]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 0 });
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
    expect(adapter.connectGatewayIfNeeded).not.toHaveBeenCalled();
  });

  test('repairs only the casing of an existing DingTalk group target', async () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    const request = vi.fn(async () => ({
      sessions: [
        {
          origin: {
            provider: 'dingtalk-connector',
            chatType: 'group',
            to: nativeConversationId,
            accountId: 'dingtalk-bot-1',
          },
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    cronJobService.listJobs.mockResolvedValue([
      {
        id: 'legacy-dingtalk-job',
        name: 'legacy dingtalk group',
        description: '',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 13 * * *' },
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
        delivery: {
          mode: DeliveryMode.Announce,
          channel: 'dingtalk-connector',
          to: nativeConversationId.toLowerCase(),
          accountId: 'dingtalk-bot-1',
        },
        agentId: 'agent-dingtalk-bot-1',
        sessionKey: null,
        state: {},
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    ]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 1 });
    expect(cronJobService.updateJob).toHaveBeenCalledWith('legacy-dingtalk-job', {
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'dingtalk-connector',
        to: nativeConversationId,
        accountId: 'dingtalk-bot-1',
      },
    });
  });

  test('preserves an existing native-case DingTalk group target', async () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    const { adapter, cronJobService, deps } = makeDeps(OpenClawEnginePhase.Starting);
    cronJobService.listJobs.mockResolvedValue([
      {
        id: 'native-dingtalk-job',
        name: 'native dingtalk group',
        description: '',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 13 * * *' },
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
        delivery: {
          mode: DeliveryMode.Announce,
          channel: 'dingtalk-connector',
          to: nativeConversationId,
          accountId: 'dingtalk-bot-1',
        },
        agentId: 'agent-dingtalk-bot-1',
        sessionKey: null,
        state: {},
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      },
    ]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 0 });
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
    expect(adapter.connectGatewayIfNeeded).not.toHaveBeenCalled();
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
              imConversationId: 'popo-bot-1:direct:zhangsan@corp.example.com',
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
        to: 'popo-bot-1:direct:zhangsan@corp.example.com',
        accountId: 'popo-bot-1',
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
      to: 'zhangsan@corp.example.com',
      accountId: 'popo-bot-1',
    });
  });

  test('binds the job to the selected bot agent for account-less group IM targets', async () => {
    const { cronJobService, deps } = makeDeps();
    const boundDeps: ScheduledTaskHandlerDeps = {
      ...deps,
      getIMGatewayManager: () => ({
        getIMStore: () => ({
          getSessionMapping: () => undefined,
          getIMSettings: () => ({
            platformAgentBindings: {
              'feishu:feishu-bot-1': 'agent-feishu-bot-1',
            },
          }),
          listSessionMappings: () => [
            {
              imConversationId: 'group:oc_zhangsan_group',
              platform: 'feishu',
              coworkSessionId: 'cw-main-group',
              agentId: 'main',
              lastActiveAt: '3',
            },
            {
              imConversationId: 'group:oc_zhangsan_group',
              platform: 'feishu',
              coworkSessionId: 'cw-bot-1-group',
              agentId: 'agent-feishu-bot-1',
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
      name: 'feishu group',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'feishu',
        to: 'group:oc_zhangsan_group',
        accountId: 'feishu-bot-1',
      },
    });

    expect(cronJobService.addJob).toHaveBeenCalledTimes(1);
    const input = cronJobService.addJob.mock.calls[0][0] as {
      agentId?: string;
      delivery: Record<string, unknown>;
    };
    expect(input.agentId).toBe('agent-feishu-bot-1');
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'feishu',
      to: 'oc_zhangsan_group',
      accountId: 'feishu-bot-1',
    });
  });

  test('migrates an existing IM group job before manual run without gateway session lookup', async () => {
    const request = vi.fn(async () => ({ sessions: [] }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    cronJobService.getJob.mockResolvedValue({
      id: 'job-1',
      name: 'legacy feishu group',
      description: '',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 13 * * *' },
      sessionTarget: SessionTarget.Main,
      wakeMode: WakeMode.Now,
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'feishu',
        to: 'oc_zhangsan_group',
        accountId: 'feishu-bot-1',
      },
      agentId: 'main',
      sessionKey: null,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '2026-07-09T00:00:00.000Z',
      updatedAt: '2026-07-09T00:00:00.000Z',
    });
    const boundDeps: ScheduledTaskHandlerDeps = {
      ...deps,
      getIMGatewayManager: () => ({
        getIMStore: () => ({
          getSessionMapping: () => undefined,
          getIMSettings: () => ({
            platformAgentBindings: {
              'feishu:feishu-bot-1': 'agent-feishu-bot-1',
            },
          }),
          listSessionMappings: () => [
            {
              imConversationId: 'group:oc_zhangsan_group',
              platform: 'feishu',
              coworkSessionId: 'cw-main-group',
              agentId: 'main',
              lastActiveAt: '3',
            },
            {
              imConversationId: 'group:oc_zhangsan_group',
              platform: 'feishu',
              coworkSessionId: 'cw-bot-1-group',
              agentId: 'agent-feishu-bot-1',
              lastActiveAt: '2',
            },
          ],
        }),
        primeConversationReplyRoute: vi.fn(async () => {}),
      }),
    };
    registerScheduledTaskHandlers(boundDeps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.RunManually);
    const result = await handler?.(undefined, 'job-1');

    expect(result).toEqual({ success: true });
    expect(cronJobService.updateJob).toHaveBeenCalledWith('job-1', {
      sessionTarget: SessionTarget.Isolated,
      agentId: 'agent-feishu-bot-1',
    });
    expect(cronJobService.runJob).toHaveBeenCalledWith('job-1');
    expect(request).not.toHaveBeenCalled();
  });

  test('filters account-less group conversation options by the selected bot agent binding', async () => {
    const { deps } = makeDeps();
    const listSessionMappings = vi.fn(() => [
      {
        imConversationId: 'feishu-bot-1:direct:oc_zhangsan_group',
        platform: 'feishu',
        coworkSessionId: 'cw-poisoned-direct',
        agentId: 'agent-feishu-bot-1',
        lastActiveAt: '4',
      },
      {
        imConversationId: 'group:oc_zhangsan_group',
        platform: 'feishu',
        coworkSessionId: 'cw-main-group',
        agentId: 'main',
        lastActiveAt: '3',
      },
      {
        imConversationId: 'group:oc_zhangsan_group',
        platform: 'feishu',
        coworkSessionId: 'cw-bot-1-group',
        agentId: 'agent-feishu-bot-1',
        lastActiveAt: '2',
      },
      {
        imConversationId: 'feishu-bot-1:direct:ou_lisi',
        platform: 'feishu',
        coworkSessionId: 'cw-bot-1-dm',
        agentId: 'agent-feishu-bot-1',
        lastActiveAt: '1',
      },
    ]);
    const boundDeps: ScheduledTaskHandlerDeps = {
      ...deps,
      getIMGatewayManager: () => ({
        getIMStore: () => ({
          getSessionMapping: () => undefined,
          getIMSettings: () => ({
            platformAgentBindings: {
              'feishu:feishu-bot-1': 'agent-feishu-bot-1',
            },
          }),
          listSessionMappings,
        }),
        primeConversationReplyRoute: vi.fn(async () => {}),
      }),
    };
    registerScheduledTaskHandlers(boundDeps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.ListChannelConversations);
    const result = await handler?.(undefined, 'feishu', 'feishu-bot-1', 'feishu-bot-1');

    expect(listSessionMappings).toHaveBeenCalledWith('feishu', 'feishu-bot-1');
    expect(result).toEqual({
      success: true,
      conversations: [
        {
          conversationId: 'group:oc_zhangsan_group',
          platform: 'feishu',
          coworkSessionId: 'cw-bot-1-group',
          lastActiveAt: '2',
          peerKind: 'group',
          displayName: 'oc_zhangsan_group',
        },
        {
          conversationId: 'feishu-bot-1:direct:ou_lisi',
          platform: 'feishu',
          coworkSessionId: 'cw-bot-1-dm',
          lastActiveAt: '1',
          peerKind: 'direct',
          displayName: 'ou_lisi',
        },
      ],
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
        to: 'direct:wxid_zhangsan@im.wechat',
      },
    });

    expect(cronJobService.addJob).toHaveBeenCalledTimes(1);
    const input = cronJobService.addJob.mock.calls[0][0] as { delivery: Record<string, unknown> };
    expect(input.delivery).toEqual({
      mode: DeliveryMode.Announce,
      channel: 'openclaw-weixin',
      to: 'wxid_zhangsan@im.wechat',
    });
  });

  const weixinTaskState = {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runningAtMs: null,
    consecutiveErrors: 0,
  };

  function makeWeixinTask(to: string, agentId: string | null = 'main') {
    return {
      id: 'weixin-job',
      name: 'weixin report',
      description: '',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to,
        accountId: 'weixin-bot-1',
      },
      agentId,
      sessionKey: null,
      state: weixinTaskState,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
  }

  test('keeps the restored Weixin direct target casing when migrating before a manual run', async () => {
    const request = vi.fn(async () => ({ sessions: [] }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    cronJobService.getJob.mockResolvedValue(makeWeixinTask('WxId_ZhangSan@im.wechat'));
    const boundDeps: ScheduledTaskHandlerDeps = {
      ...deps,
      getIMGatewayManager: () => ({
        getIMStore: () => ({
          getSessionMapping: () => undefined,
          getIMSettings: () => ({ platformAgentBindings: {} }),
          listSessionMappings: () => [
            {
              imConversationId: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
              platform: 'weixin',
              coworkSessionId: 'cw-weixin-direct',
              agentId: 'main',
              lastActiveAt: '1',
            },
          ],
        }),
        primeConversationReplyRoute: vi.fn(async () => {}),
      }),
    };
    registerScheduledTaskHandlers(boundDeps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.RunManually);
    const result = await handler?.(undefined, 'weixin-job');

    expect(result).toEqual({ success: true });
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
    expect(cronJobService.runJob).toHaveBeenCalledWith('weixin-job');
    expect(request).not.toHaveBeenCalled();
  });

  test('repairs only the casing of an existing Weixin direct target', async () => {
    const request = vi.fn(async () => ({
      sessions: [
        {
          updatedAt: 2_000,
          lastChannel: 'openclaw-weixin',
          lastTo: 'WxId_ZhangSan@im.wechat',
          lastAccountId: 'weixin-bot-2',
        },
      ],
    }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    cronJobService.listJobs.mockResolvedValue([makeWeixinTask('wxid_zhangsan@im.wechat')]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 1 });
    expect(request).toHaveBeenCalledWith(
      'sessions.list',
      expect.objectContaining({ includeGlobal: true }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(cronJobService.updateJob).toHaveBeenCalledWith('weixin-job', {
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'WxId_ZhangSan@im.wechat',
        accountId: 'weixin-bot-1',
      },
    });
  });

  test('repairs the Weixin target casing and names the main agent before resending a saved report', async () => {
    const request = vi.fn(async (method: string) => (method === 'sessions.list'
      ? {
        sessions: [
          {
            updatedAt: 2_000,
            lastChannel: 'openclaw-weixin',
            lastTo: 'WxId_ZhangSan@im.wechat',
            lastAccountId: 'weixin-bot-1',
          },
        ],
      }
      : { messageId: 'accepted-1' }));
    const { cronJobService, deps } = makeDeps(OpenClawEnginePhase.Running, {
      gatewayClient: { request },
    });
    let stored = makeWeixinTask('wxid_zhangsan@im.wechat', null);
    cronJobService.getJob.mockImplementation(async () => stored);
    cronJobService.updateJob.mockImplementation(async (_id, patch) => {
      stored = { ...stored, ...patch };
      return stored;
    });
    cronJobService.listRuns.mockResolvedValue([
      {
        id: 'weixin-run',
        taskId: 'weixin-job',
        sessionId: null,
        sessionKey: null,
        status: TaskStatus.Success,
        startedAt: '',
        finishedAt: '',
        durationMs: 1,
        error: null,
        summary: 'saved report',
        deliveryStatus: RunDeliveryStatus.NotDelivered,
        deliveryError: 'WEIXIN_SEND_REJECTED ret=-3 errcode=0',
      },
    ]);
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.ResendWeixinReport);
    const result = await handler?.(undefined, 'weixin-job', 'weixin-run');

    expect(result).toEqual({ success: true });
    expect(cronJobService.updateJob).toHaveBeenCalledWith('weixin-job', {
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'WxId_ZhangSan@im.wechat',
        accountId: 'weixin-bot-1',
      },
    });
    expect(request).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({
        channel: 'openclaw-weixin',
        to: 'WxId_ZhangSan@im.wechat',
        accountId: 'weixin-bot-1',
        agentId: 'main',
        message: 'saved report',
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });
});
