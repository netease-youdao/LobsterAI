import Database from 'better-sqlite3';
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
import { LobsterScheduler } from '../../scheduledTask/lobsterScheduler';
import {
  type CronJobServiceFacade,
  getCronJobService,
  initCronJobServiceManager,
} from './cronJobServiceManager';
import {
  migrateScheduledTaskAnnounceJobs,
  registerScheduledTaskHandlers,
  type ScheduledTaskHandlerDeps,
} from './handlers';

type TestMapping = {
  imConversationId: string;
  platform: string;
  coworkSessionId: string;
  agentId: string;
  lastActiveAt: string;
};

function makeDeps(options: {
  mappings?: TestMapping[];
  platformAgentBindings?: Record<string, string>;
  replyRoutes?: Record<string, { to: string; accountId: string }>;
  sendProactiveImMessage?: ScheduledTaskHandlerDeps['sendProactiveImMessage'];
} = {}) {
  const cronJobService = {
    listJobs: vi.fn(async () => [] as unknown[]),
    getJob: vi.fn(async () => null as unknown),
    listRuns: vi.fn(async () => [] as unknown[]),
    listAllRuns: vi.fn(async () => [] as unknown[]),
    countRuns: vi.fn(async () => 0),
    addJob: vi.fn(async (input: { name?: string }) => ({ id: 'job-1', name: input?.name ?? '' })),
    updateJob: vi.fn(async (id: string, input: { name?: string }) => ({
      id,
      name: input?.name ?? '',
    })),
    removeJob: vi.fn(async () => {}),
    toggleJob: vi.fn(async (id: string, enabled: boolean) => ({ id, enabled })),
    runJob: vi.fn(async () => {}),
    stopJob: vi.fn(async () => true),
  };

  const listSessionMappings = vi.fn((platform: string) =>
    (options.mappings ?? []).filter((m) => m.platform === platform),
  );

  const deps: ScheduledTaskHandlerDeps = {
    getCronJobService: () => cronJobService as unknown as CronJobServiceFacade,
    getIMGatewayManager: () => ({
      getIMStore: () => ({
        getSessionMapping: () => undefined,
        getConversationReplyRoute: (_platform, conversationId) => options.replyRoutes?.[conversationId] ?? null,
        getIMSettings: () => ({
          platformAgentBindings: options.platformAgentBindings ?? {},
        }),
        listSessionMappings,
      }),
      primeConversationReplyRoute: vi.fn(async () => {}),
    }),
    getCoworkSessionTitle: () => null,
    sendProactiveImMessage: options.sendProactiveImMessage,
  };

  return { cronJobService, deps, listSessionMappings };
}

const emptyTaskState = {
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
    state: emptyTaskState,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  };
}

beforeEach(() => {
  registeredHandlers.clear();
});

describe('registerScheduledTaskHandlers', () => {
  test('lists scheduled tasks directly from the local scheduler', async () => {
    const { cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.List);
    expect(handler).toBeDefined();

    const result = await handler?.();

    expect(cronJobService.listJobs).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, ready: true, tasks: [] });
  });

  test('lists scheduled task run history directly from the local scheduler', async () => {
    const { cronJobService, deps } = makeDeps();
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.ListAllRuns);
    expect(handler).toBeDefined();

    const result = await handler?.(undefined, 20, 0);

    expect(cronJobService.listAllRuns).toHaveBeenCalledWith(20, 0, undefined);
    expect(result).toEqual({ success: true, ready: true, runs: [] });
  });

  test('restores IM delivery target casing from IM session mappings on create', async () => {
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: 'weixin-bot-1:direct:WxId_ZhangSan@im.wechat',
          platform: 'weixin',
          coworkSessionId: 'cw-1',
          agentId: 'main',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    });
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.Create);
    const result = await handler?.(undefined, {
      name: '科技早报',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 8 * * *' },
      payload: { kind: PayloadKind.AgentTurn, message: 'hi' },
      delivery: {
        mode: DeliveryMode.Announce,
        channel: 'openclaw-weixin',
        to: 'direct:wxid_zhangsan@im.wechat',
        accountId: 'weixin-bot-1',
      },
    });

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

  test('restores a WeCom group chat id casing from session mappings on create', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: `wecom-bot-1:group:${nativeGroupId}`,
          platform: 'wecom',
          coworkSessionId: 'cw-wecom',
          agentId: 'main',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ],
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

  test('restores a DingTalk group id casing from session mappings on create', async () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: `dingtalk-bot-1:group:${nativeConversationId}`,
          platform: 'dingtalk',
          coworkSessionId: 'cw-dt',
          agentId: 'main',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ],
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

  test('repairs only the casing of an existing WeCom group target during migration', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: `wecom-bot-1:group:${nativeGroupId}`,
          platform: 'wecom',
          coworkSessionId: 'cw-wecom',
          agentId: 'agent-wecom-bot-1',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ],
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
        state: emptyTaskState,
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

  test('preserves an existing native-case WeCom target when mappings are unavailable', async () => {
    const nativeGroupId = 'wrrQeUDgAAeLCVE2WB3A39jXRlrSVEyA';
    const { cronJobService, deps } = makeDeps();
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
        state: emptyTaskState,
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z',
      },
    ]);

    const result = await migrateScheduledTaskAnnounceJobs(deps);

    expect(result).toEqual({ checked: 1, updated: 0 });
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
  });

  test('repairs only the casing of an existing DingTalk group target during migration', async () => {
    const nativeConversationId = 'cid+wQbmjFBusv8Bld+Du9t1w==';
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: `dingtalk-bot-1:group:${nativeConversationId}`,
          platform: 'dingtalk',
          coworkSessionId: 'cw-dt',
          agentId: 'agent-dingtalk-bot-1',
          lastActiveAt: '2026-10-01T00:00:00.000Z',
        },
      ],
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
        state: emptyTaskState,
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

  test('migrates an existing IM group job before manual run', async () => {
    const { cronJobService, deps } = makeDeps({
      platformAgentBindings: {
        'feishu:feishu-bot-1': 'agent-feishu-bot-1',
      },
      mappings: [
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
    });
    cronJobService.getJob.mockResolvedValue({
      id: 'job-1',
      name: 'feishu group',
      description: '',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
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
      state: emptyTaskState,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:00.000Z',
    });
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.RunManually);
    const result = await handler?.(undefined, 'job-1');

    expect(result).toEqual({ success: true });
    expect(cronJobService.updateJob).toHaveBeenCalledWith('job-1', {
      sessionTarget: SessionTarget.Isolated,
      agentId: 'agent-feishu-bot-1',
    });
    expect(cronJobService.runJob).toHaveBeenCalledWith('job-1');
  });

  test('lists each Feishu topic once with its native thread, saved anchor and case intact', async () => {
    const native = 'group:oc_G:thread:omt_A';
    const alias = 'group:oc_G:thread:om_R';
    const other = 'group:oc_G:thread:omt_a';
    const targets = ['oc_G#__feishu_reply_to=om_R&__feishu_thread_id=omt_A', 'oc_G#__feishu_reply_to=om_S&__feishu_thread_id=omt_a'];
    const row = { platform: 'feishu', agentId: 'main', lastActiveAt: '10' };
    const { deps } = makeDeps({
      mappings: [
        { ...row, imConversationId: alias, coworkSessionId: 'A' },
        { ...row, imConversationId: native, coworkSessionId: 'A' },
        { ...row, imConversationId: other, coworkSessionId: 'B' },
      ],
      replyRoutes: {
        [alias]: { accountId: '12345678-bot', to: targets[0] },
        [native]: { accountId: '12345678-bot', to: targets[0] },
        [other]: { accountId: '12345678-bot', to: targets[1] },
      },
    });
    registerScheduledTaskHandlers(deps);
    const result = await registeredHandlers.get(ScheduledTaskIpc.ListChannelConversations)?.(null, 'feishu', '12345678') as {
      conversations: Array<{ conversationId: string }>;
    };
    expect(result.conversations.map(option => option.conversationId)).toEqual(targets);
  });

  test('filters account-less group conversation options by the selected bot agent binding', async () => {
    const { deps, listSessionMappings } = makeDeps({
      platformAgentBindings: {
        'feishu:feishu-bot-1': 'agent-feishu-bot-1',
      },
      mappings: [
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
      ],
    });
    registerScheduledTaskHandlers(deps);

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

  test('keeps the stripped delivery target when mappings are unavailable', async () => {
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

  test('keeps the restored Weixin direct target casing when migrating before a manual run', async () => {
    const { cronJobService, deps } = makeDeps({
      mappings: [
        {
          imConversationId: 'weixin-bot-1:direct:wxid_zhangsan@im.wechat',
          platform: 'weixin',
          coworkSessionId: 'cw-weixin-direct',
          agentId: 'main',
          lastActiveAt: '1',
        },
      ],
    });
    cronJobService.getJob.mockResolvedValue(makeWeixinTask('WxId_ZhangSan@im.wechat'));
    registerScheduledTaskHandlers(deps);

    const handler = registeredHandlers.get(ScheduledTaskIpc.RunManually);
    const result = await handler?.(undefined, 'weixin-job');

    expect(result).toEqual({ success: true });
    expect(cronJobService.updateJob).not.toHaveBeenCalled();
    expect(cronJobService.runJob).toHaveBeenCalledWith('weixin-job');
  });

  test('resends a saved Weixin report via the DSH channels bridge', async () => {
    const sendProactiveImMessage = vi.fn(async () => ({ messageId: 'accepted-1' }));
    const { cronJobService, deps } = makeDeps({ sendProactiveImMessage });
    cronJobService.getJob.mockResolvedValue(makeWeixinTask('WxId_ZhangSan@im.wechat', null));
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
    expect(sendProactiveImMessage).toHaveBeenCalledWith({
      platform: 'openclaw-weixin',
      instanceId: 'weixin-bot-1',
      chatId: 'WxId_ZhangSan@im.wechat',
      text: 'saved report',
    });
  });

  test('RunManually returns immediately without blocking on a pending DSH turn while propagating start errors', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    let resolveTurn!: (result: { sessionId: string; summary: string }) => void;
    const scheduler = new LobsterScheduler({
      db,
      executor: () => new Promise(resolve => {
        resolveTurn = resolve;
      }),
    });

    try {
      const task = scheduler.createTask({
        name: 'Long report',
        description: '',
        enabled: true,
        schedule: { kind: 'cron', expr: '0 9 * * *' },
        sessionTarget: SessionTarget.Isolated,
        wakeMode: WakeMode.Now,
        payload: { kind: PayloadKind.AgentTurn, message: 'Generate report' },
        delivery: { mode: DeliveryMode.None },
      });

      initCronJobServiceManager({ getScheduler: () => scheduler });
      registerScheduledTaskHandlers({
        getCronJobService,
        getIMGatewayManager: () => null,
        getCoworkSessionTitle: () => null,
      });

      const handler = registeredHandlers.get(ScheduledTaskIpc.RunManually)!;
      const runUpdates: Array<{ status: TaskStatus; summary?: string | null }> = [];
      scheduler.on('runUpdate', (evt: { run: { status: TaskStatus; summary?: string | null } }) => {
        runUpdates.push({ status: evt.run.status, summary: evt.run.summary });
      });

      // Returns immediately while executor is still pending!
      const startResult = await handler(undefined, task.id);
      expect(startResult).toEqual({ success: true });
      expect(scheduler.getTask(task.id)?.state.lastStatus).toBe(TaskStatus.Running);

      // Duplicate click while running fails immediately.
      const duplicateResult = await handler(undefined, task.id);
      expect(duplicateResult).toEqual({
        success: false,
        error: `Scheduled task "${task.id}" is already running`,
      });

      // Unknown task fails immediately.
      const missingResult = await handler(undefined, 'does-not-exist');
      expect(missingResult).toEqual({
        success: false,
        error: 'Scheduled task "does-not-exist" not found',
      });

      // Finish the background turn and confirm run history completes cleanly.
      const completed = new Promise<void>(resolve => {
        scheduler.on('runUpdate', (evt: { run: { status: TaskStatus } }) => {
          if (evt.run.status === TaskStatus.Success) resolve();
        });
      });
      resolveTurn({ sessionId: 'cw-long-1', summary: 'Report ready' });
      await completed;

      expect(scheduler.listRuns(task.id)[0]).toMatchObject({
        sessionId: 'cw-long-1',
        status: TaskStatus.Success,
        summary: 'Report ready',
      });
      expect(runUpdates.map(u => u.status)).toEqual([TaskStatus.Running, TaskStatus.Success]);
    } finally {
      scheduler.stop();
      db.close();
    }
  });
});
