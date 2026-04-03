import { ipcMain } from 'electron';
import {
  IpcChannel as ScheduledTaskIpc,
  DeliveryMode as STDeliveryMode,
  SessionTarget as STSessionTarget,
  PayloadKind as STPayloadKind,
} from '../../../scheduledTask/constants';
import { PlatformRegistry } from '../../../shared/platform';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import { listScheduledTaskChannels } from './helpers';

export interface ScheduledTaskHandlerDeps {
  getCronJobService: () => CronJobService;
  getIMGatewayManager: () => {
    getIMStore: () => {
      getSessionMapping: (conversationId: string, platform: string) => {
        coworkSessionId: string;
      } | undefined;
      listSessionMappings: (platform: string) => Array<{
        imConversationId: string;
        platform: string;
        coworkSessionId: string;
        lastActiveAt: string;
      }>;
    } | undefined;
    primeConversationReplyRoute: (
      platform: string,
      conversationId: string,
      coworkSessionId: string,
    ) => Promise<void>;
  } | null;
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => unknown;
    fetchSessionByKey: (sessionKey: string) => Promise<unknown>;
  } | null;
}

export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const { getCronJobService, getIMGatewayManager, getOpenClawRuntimeAdapter } = deps;

  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    try {
      // If OpenClaw gateway is not connected yet, return empty list immediately
      // to avoid blocking the renderer init. Tasks will be loaded later via the
      // onRefresh listener when the gateway becomes available.
      if (!getOpenClawRuntimeAdapter()?.getGatewayClient()) {
        return { success: true, tasks: [] };
      }
      const tasks = await getCronJobService().listJobs();
      return { success: true, tasks };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list tasks' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Get, async (_event, id: string) => {
    try {
      const task = await getCronJobService().getJob(id);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Create, async (_event, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.log('[IPC][scheduledTask:create] normalizedInput:', JSON.stringify(normalizedInput, null, 2));
      console.log('[IPC][scheduledTask:create] delivery:', JSON.stringify(normalizedInput.delivery, null, 2));

      // When an IM conversation is selected as notification target, let OpenClaw
      // handle delivery natively via its announce mechanism. We keep
      // sessionTarget='isolated' and delivery.mode='announce' so OpenClaw runs
      // the agent in an isolated cron session and delivers the result through
      // its outbound channel adapter (e.g. feishu plugin).
      //
      // DingTalk still needs the reply route primed so the outbound adapter
      // can locate the correct conversation.
      const delivery = normalizedInput.delivery;
      if (delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to) {
        const platform = PlatformRegistry.platformOfChannel(delivery.channel);
        if (platform) {
          console.log('[IPC][scheduledTask:create] IM notification target detected, using OpenClaw native announce delivery.',
            JSON.stringify({ channel: delivery.channel, to: delivery.to, platform }));
          normalizedInput.sessionTarget = STSessionTarget.Isolated;
          if (normalizedInput.payload?.kind === STPayloadKind.SystemEvent) {
            normalizedInput.payload = {
              kind: STPayloadKind.AgentTurn,
              message: normalizedInput.payload.text || '',
            };
          }
          // Strip IM subtype prefix from delivery.to before passing to OpenClaw.
          // LobsterAI stores conversationIds with subtype prefixes (e.g. "direct:ou_xxx",
          // "group:oc_xxx") but OpenClaw channel adapters expect raw platform IDs
          // (e.g. "ou_xxx", "oc_xxx").
          const rawTo = delivery.to;
          const colonIdx = rawTo.indexOf(':');
          if (colonIdx > 0) {
            delivery.to = rawTo.slice(colonIdx + 1);
            console.log('[IPC][scheduledTask:create] stripped IM subtype prefix from delivery.to:',
              rawTo, '->', delivery.to);
          }
          if (platform === 'dingtalk') {
            const imStore = getIMGatewayManager()?.getIMStore();
            const mapping = imStore?.getSessionMapping(rawTo, platform);
            if (mapping) {
              await getIMGatewayManager()!.primeConversationReplyRoute(
                platform, rawTo, mapping.coworkSessionId,
              );
            }
          }
        }
      }

      const task = await getCronJobService().addJob(normalizedInput);
      console.log('[IPC][scheduledTask:create] result task id:', task?.id, 'name:', task?.name);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Update, async (_event, id: string, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.log('[IPC][scheduledTask:update] id:', id, 'normalizedInput:', JSON.stringify(normalizedInput, null, 2));
      console.log('[IPC][scheduledTask:update] delivery:', JSON.stringify(normalizedInput.delivery, null, 2));

      // Same OpenClaw native announce delivery logic as create handler.
      const delivery = normalizedInput.delivery;
      if (delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to) {
        const platform = PlatformRegistry.platformOfChannel(delivery.channel);
        if (platform) {
          console.log('[IPC][scheduledTask:update] IM notification target detected, using OpenClaw native announce delivery.',
            JSON.stringify({ channel: delivery.channel, to: delivery.to, platform }));
          normalizedInput.sessionTarget = STSessionTarget.Isolated;
          if (normalizedInput.payload?.kind === STPayloadKind.SystemEvent) {
            normalizedInput.payload = {
              kind: STPayloadKind.AgentTurn,
              message: normalizedInput.payload.text || '',
            };
          }
          // Strip IM subtype prefix (e.g. "direct:ou_xxx" -> "ou_xxx")
          const rawTo = delivery.to;
          const colonIdx = rawTo.indexOf(':');
          if (colonIdx > 0) {
            delivery.to = rawTo.slice(colonIdx + 1);
            console.log('[IPC][scheduledTask:update] stripped IM subtype prefix from delivery.to:',
              rawTo, '->', delivery.to);
          }
          if (platform === 'dingtalk') {
            const imStore = getIMGatewayManager()?.getIMStore();
            const mapping = imStore?.getSessionMapping(rawTo, platform);
            if (mapping) {
              await getIMGatewayManager()!.primeConversationReplyRoute(
                platform, rawTo, mapping.coworkSessionId,
              );
            }
          }
        }
      }

      const task = await getCronJobService().updateJob(id, normalizedInput);
      console.log('[IPC][scheduledTask:update] result task id:', task?.id, 'name:', task?.name);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Delete, async (_event, id: string) => {
    try {
      await getCronJobService().removeJob(id);
      return { success: true, result: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Toggle, async (_event, id: string, enabled: boolean) => {
    try {
      const task = await getCronJobService().toggleJob(id, enabled);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.RunManually, async (_event, id: string) => {
    try {
      await getCronJobService().runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Stop, async (_event, _id: string) => {
    try {
      // OpenClaw doesn't expose a direct stop API for running cron jobs
      // The job will complete or timeout on its own
      return { success: true, result: false };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop task' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ListRuns, async (_event, taskId: string, limit?: number, offset?: number) => {
    try {
      const runs = await getCronJobService().listRuns(taskId, limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list runs' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.CountRuns, async (_event, taskId: string) => {
    try {
      const count = await getCronJobService().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to count runs' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ListAllRuns, async (_event, limit?: number, offset?: number) => {
    try {
      const runs = await getCronJobService().listAllRuns(limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list all runs' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ResolveSession, async (_event, sessionKey: string) => {
    try {
      if (!sessionKey) return { success: true, session: null };
      // Fetch session history from OpenClaw (returns transient session, not persisted)
      const session = await getOpenClawRuntimeAdapter()?.fetchSessionByKey(sessionKey);
      return { success: true, session: session ?? null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve session' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ListChannels, async () => {
    try {
      return { success: true, channels: listScheduledTaskChannels() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list channels' };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.ListChannelConversations, async (_event, channel: string) => {
    try {
      console.log('[IPC][listChannelConversations] channel:', channel);
      const platform = PlatformRegistry.platformOfChannel(channel);
      console.log('[IPC][listChannelConversations] resolved platform:', platform);
      if (!platform) {
        console.log('[IPC][listChannelConversations] no platform mapping, returning empty');
        return { success: true, conversations: [] };
      }
      const imStore = getIMGatewayManager()?.getIMStore();
      if (!imStore) {
        console.log('[IPC][listChannelConversations] no imStore available, returning empty');
        return { success: true, conversations: [] };
      }
      const mappings = imStore.listSessionMappings(platform);
      console.log('[IPC][listChannelConversations] found', mappings.length, 'session mappings for platform:', platform);
      const conversations = mappings.map((m) => ({
        conversationId: m.imConversationId,
        platform: m.platform,
        coworkSessionId: m.coworkSessionId,
        lastActiveAt: m.lastActiveAt,
      }));
      console.log('[IPC][listChannelConversations] conversations:', JSON.stringify(conversations, null, 2));
      return { success: true, conversations };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list conversations' };
    }
  });
}
