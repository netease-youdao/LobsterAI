import { ipcMain } from 'electron';

import {
  DeliveryMode as STDeliveryMode,
  IpcChannel as ScheduledTaskIpc,
  PayloadKind as STPayloadKind,
  SessionTarget as STSessionTarget,
} from '../../../scheduledTask/constants';
import type {
  RunFilter,
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
} from '../../../scheduledTask/types';
import { AgentId } from '../../../shared/agent/constants';
import { RetainedImPlatform } from '../../../shared/dshEngine/hostConstants';
import { buildFeishuTopicConversationId, formatFeishuReplyRoute, parseFeishuReplyRoute } from '../../../shared/im/feishuTopicRoute';
import { sanitizeWeixinDeliveryError } from '../../../shared/im/weixin';
import {
  imConversationDisplayName,
  ImPeerKind,
  type ParsedImConversationId,
  parseImConversationId,
  type Platform,
  PlatformRegistry,
} from '../../../shared/platform';
import type { CronJobServiceFacade } from './cronJobServiceManager';
import {
  dedupeConversationMappings,
  filterConversationMappingsForSelectedAccount,
  listScheduledTaskChannels,
  resolveConversationAgentIdFromMappings,
} from './helpers';
import { WeixinReportDelivery } from './weixinReportDelivery';

const AUTO_CHANNEL_TITLE_RE = /^\[[^\]]*\]\s/;
const DINGTALK_PLATFORM: Platform = 'dingtalk';
const WECOM_PLATFORM: Platform = 'wecom';
const CASE_SENSITIVE_GROUP_TARGET_PLATFORMS = new Set<Platform>([
  DINGTALK_PLATFORM,
  WECOM_PLATFORM,
]);

type ConversationMappingForList = {
  imConversationId: string;
  platform: string;
  coworkSessionId: string;
  agentId: string;
  lastActiveAt: string;
};

type AnnounceNormalizationContext = {
  platform: Platform;
  rawTo: string;
  parsedConversation: ParsedImConversationId;
};

function hasMixedCase(value: string): boolean {
  return value !== value.toLowerCase();
}

function normalizeImAnnounceDeliveryTo(
  rawTo: string,
  mappings: readonly ConversationMappingForList[],
  platform: Platform,
): string {
  if (platform === RetainedImPlatform.Feishu) {
    const route = parseFeishuReplyRoute(rawTo);
    if (route) return formatFeishuReplyRoute(route);
  }
  const parsed = parseImConversationId(rawTo);
  let candidate: string;
  if (
    parsed.peerKind === ImPeerKind.Direct ||
    parsed.peerKind === ImPeerKind.Group ||
    parsed.peerKind === ImPeerKind.Channel
  ) {
    candidate = parsed.peerId.trim();
  } else if (CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(platform) && !rawTo.includes(':')) {
    candidate = rawTo.trim();
  } else {
    const colonIdx = rawTo.lastIndexOf(':');
    candidate = colonIdx > 0 ? rawTo.slice(colonIdx + 1).trim() : rawTo.trim();
  }

  // Restore original mixed-case peer ID from im_session_mappings when the
  // incoming target was lowercased, without ever downgrading a mixed-case target.
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate && !hasMixedCase(candidate)) {
    for (const mapping of mappings) {
      const mappingParsed = parseImConversationId(mapping.imConversationId);
      const mappingPeer = mappingParsed.peerId.trim();
      if (mappingPeer.toLowerCase() === lowerCandidate && hasMixedCase(mappingPeer)) {
        return mappingPeer;
      }
    }
  }

  return candidate;
}

export interface ScheduledTaskHandlerDeps {
  getCronJobService: () => CronJobServiceFacade;
  getIMGatewayManager: () => {
    getIMStore: () =>
      | {
          getSessionMapping: (
            conversationId: string,
            platform: string,
          ) => { coworkSessionId: string } | undefined;
          getIMSettings?: () => {
            platformAgentBindings?: Record<string, string>;
          };
          getConversationReplyRoute: (platform: Platform, conversationId: string) => {
            to: string;
            accountId?: string;
          } | null;
          listSessionMappings: (
            platform: string,
            accountId?: string,
          ) => ConversationMappingForList[];
        }
      | undefined;
    primeConversationReplyRoute: (
      platform: string,
      conversationId: string,
      coworkSessionId: string,
    ) => Promise<void>;
  } | null;
  getCoworkSessionTitle: (sessionId: string) => string | null;
  getCoworkSession?: (sessionId: string) => unknown | null;
  sendProactiveImMessage?: (params: {
    platform: string;
    instanceId?: string;
    chatId: string;
    text: string;
  }) => Promise<unknown>;
}

function applyLocalAnnounceDeliveryNormalization(
  normalizedInput: Record<string, any>,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager'>,
): AnnounceNormalizationContext | null {
  const { getIMGatewayManager } = deps;
  const delivery = normalizedInput.delivery;
  if (!(delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to)) {
    return null;
  }
  const platform = PlatformRegistry.platformOfChannel(delivery.channel);
  if (!platform) return null;
  const imStore = getIMGatewayManager()?.getIMStore();
  const mappings = (platform === RetainedImPlatform.Feishu && delivery.accountId
    ? imStore?.listSessionMappings(platform, delivery.accountId)
    : imStore?.listSessionMappings(platform)) ?? [];
  const imSettings = imStore?.getIMSettings?.();

  normalizedInput.sessionTarget = STSessionTarget.Isolated;
  if (normalizedInput.payload?.kind === STPayloadKind.SystemEvent) {
    normalizedInput.payload = {
      kind: STPayloadKind.AgentTurn,
      message: normalizedInput.payload.text || '',
    };
  }

  const rawTo: string = delivery.to;
  const parsedConversation = parseImConversationId(rawTo);
  delivery.to = normalizeImAnnounceDeliveryTo(rawTo, mappings, platform);

  const existingAgentId = typeof normalizedInput.agentId === 'string'
    ? normalizedInput.agentId.trim()
    : '';
  if (!existingAgentId || existingAgentId === AgentId.Main) {
    try {
      const topic = platform === RetainedImPlatform.Feishu ? parseFeishuReplyRoute(rawTo) : null;
      const mappingTarget = topic?.threadId ? buildFeishuTopicConversationId(topic.chatId, topic.threadId) : rawTo;
      const boundAgentId = resolveConversationAgentIdFromMappings(
        mappings,
        mappingTarget,
        parsedConversation.accountId ?? delivery.accountId,
        {
          platform,
          platformAgentBindings: imSettings?.platformAgentBindings,
        },
      );
      if (boundAgentId && boundAgentId !== AgentId.Main) {
        normalizedInput.agentId = boundAgentId;
      }
    } catch (error) {
      console.warn('[ScheduledTask] failed to resolve conversation agent binding:', error);
    }
  }

  return { platform, rawTo, parsedConversation };
}

function cloneDelivery(delivery?: ScheduledTaskDelivery): ScheduledTaskDelivery | undefined {
  return delivery ? { ...delivery } : undefined;
}

function clonePayload(payload: ScheduledTaskPayload): ScheduledTaskPayload {
  return { ...payload };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function buildAnnounceNormalizationPatch(
  task: ScheduledTask,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager'>,
): Partial<ScheduledTaskInput> | null {
  const normalizedInput: Record<string, any> = {
    sessionTarget: task.sessionTarget,
    payload: clonePayload(task.payload),
    delivery: cloneDelivery(task.delivery),
    agentId: task.agentId ?? undefined,
    sessionKey: task.sessionKey ?? undefined,
  };
  const context = applyLocalAnnounceDeliveryNormalization(normalizedInput, deps);
  if (!context) return null;

  const patch: Partial<ScheduledTaskInput> = {};
  if (normalizedInput.sessionTarget !== task.sessionTarget) {
    patch.sessionTarget = normalizedInput.sessionTarget;
  }
  if (stableJson(normalizedInput.payload) !== stableJson(task.payload)) {
    patch.payload = normalizedInput.payload;
  }
  if (stableJson(normalizedInput.delivery) !== stableJson(task.delivery)) {
    patch.delivery = normalizedInput.delivery;
  }
  if (
    normalizedInput.agentId !== undefined &&
    normalizedInput.agentId !== (task.agentId ?? undefined)
  ) {
    patch.agentId = normalizedInput.agentId;
  }
  if (
    normalizedInput.sessionKey !== undefined &&
    normalizedInput.sessionKey !== (task.sessionKey ?? undefined)
  ) {
    patch.sessionKey = normalizedInput.sessionKey;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export async function migrateScheduledTaskAnnounceJobs(
  deps: Pick<ScheduledTaskHandlerDeps, 'getCronJobService' | 'getIMGatewayManager'>,
): Promise<{ checked: number; updated: number }> {
  const tasks = await deps.getCronJobService().listJobs();
  let updated = 0;
  for (const task of tasks) {
    const patch = buildAnnounceNormalizationPatch(task, deps);
    if (patch) {
      await deps.getCronJobService().updateJob(task.id, patch);
      updated += 1;
    }
  }
  return { checked: tasks.length, updated };
}

export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const {
    getCronJobService,
    getIMGatewayManager,
    getCoworkSessionTitle,
    getCoworkSession,
    sendProactiveImMessage,
  } = deps;

  const weixinReportDelivery = new WeixinReportDelivery({
    getJob: id => getCronJobService().getJob(id),
    listRuns: (id, limit, offset) => getCronJobService().listRuns(id, limit, offset),
    send: async (params: Record<string, unknown>) => {
      if (!sendProactiveImMessage) {
        throw new Error('IM channels delivery bridge is not available');
      }
      return sendProactiveImMessage({
        platform: String(params.channel ?? 'weixin'),
        instanceId: typeof params.accountId === 'string' ? params.accountId : undefined,
        chatId: String(params.to ?? ''),
        text: String(params.message ?? ''),
      });
    },
  });

  ipcMain.handle(ScheduledTaskIpc.ResendWeixinReport, async (_event, taskId: string, runId: string) => {
    try {
      await weixinReportDelivery.resend(taskId, runId);
      return { success: true };
    } catch (error) {
      return { success: false, error: sanitizeWeixinDeliveryError(error) };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    try {
      const tasks = await getCronJobService().listJobs();
      return { success: true, ready: true, tasks };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list tasks',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Get, async (_event, id: string) => {
    try {
      const task = await getCronJobService().getJob(id);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Create, async (_event, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      applyLocalAnnounceDeliveryNormalization(normalizedInput, { getIMGatewayManager });
      const task = await getCronJobService().addJob(normalizedInput as ScheduledTaskInput);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Update, async (_event, id: string, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      applyLocalAnnounceDeliveryNormalization(normalizedInput, { getIMGatewayManager });
      const task = await getCronJobService().updateJob(id, normalizedInput as Partial<ScheduledTaskInput>);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Delete, async (_event, id: string) => {
    try {
      await getCronJobService().removeJob(id);
      return { success: true, result: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Toggle, async (_event, id: string, enabled: boolean) => {
    try {
      const task = await getCronJobService().toggleJob(id, enabled);
      return { success: true, task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to toggle task',
      };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.RunManually, async (_event, id: string) => {
    try {
      const existing = await getCronJobService().getJob(id);
      if (existing) {
        const patch = buildAnnounceNormalizationPatch(existing, { getIMGatewayManager });
        if (patch) {
          await getCronJobService().updateJob(id, patch);
        }
      }
      await getCronJobService().runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Stop, async (_event, id: string) => {
    try {
      const stopped = await getCronJobService().stopJob(id);
      return { success: true, result: stopped };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop task',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListRuns,
    async (_event, taskId: string, limit?: number, offset?: number, filter?: RunFilter) => {
      try {
        const runs = await getCronJobService().listRuns(taskId, limit, offset, filter);
        return { success: true, runs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list runs',
        };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.CountRuns, async (_event, taskId: string) => {
    try {
      const count = await getCronJobService().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to count runs',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListAllRuns,
    async (_event, limit?: number, offset?: number, filter?: RunFilter) => {
      try {
        const runs = await getCronJobService().listAllRuns(limit, offset, filter);
        return { success: true, ready: true, runs };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list all runs',
        };
      }
    },
  );

  ipcMain.handle(
    ScheduledTaskIpc.ResolveSession,
    async (_event, input: string | { sessionId?: string | null; sessionKey?: string | null }) => {
      try {
        const sessionId = typeof input === 'string' ? input : (input.sessionId ?? input.sessionKey ?? null);
        if (!sessionId || !getCoworkSession) return { success: true, session: null };
        const session = getCoworkSession(sessionId);
        return { success: true, session: session ?? null };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to resolve session',
        };
      }
    },
  );

  ipcMain.handle(ScheduledTaskIpc.ListChannels, async () => {
    try {
      return { success: true, channels: listScheduledTaskChannels() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list channels',
      };
    }
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListChannelConversations,
    async (_event, channel: string, accountId?: string, filterAccountId?: string) => {
      try {
        const platform = PlatformRegistry.platformOfChannel(channel);
        if (!platform) return { success: true, conversations: [] };
        const imStore = getIMGatewayManager()?.getIMStore();
        if (!imStore) return { success: true, conversations: [] };
        const selectedAccountId = filterAccountId ?? accountId;
        const imSettings = imStore.getIMSettings?.();
        const platformAgentBindings = imSettings
          ? (imSettings.platformAgentBindings ?? {})
          : undefined;
        const rawMappings = imStore.listSessionMappings(platform, selectedAccountId);
        const filteredMappings = filterConversationMappingsForSelectedAccount(
          rawMappings,
          platform,
          selectedAccountId,
          platformAgentBindings,
        );
        const mappings = dedupeConversationMappings(filteredMappings, platform);
        const listedTopics = new Set<string>();
        const conversations = mappings.flatMap(m => {
          const parsed = parseImConversationId(m.imConversationId);
          const topic = platform === RetainedImPlatform.Feishu ? parseFeishuReplyRoute(m.imConversationId) : null;
          const cachedRoute = topic && imStore.getConversationReplyRoute(m.platform as Platform, m.imConversationId);
          if (selectedAccountId && cachedRoute?.accountId && cachedRoute.accountId !== selectedAccountId
            && cachedRoute.accountId.slice(0, 8) !== selectedAccountId
            && selectedAccountId.slice(0, 8) !== cachedRoute.accountId) return [];
          const deliveryRoute = cachedRoute ? parseFeishuReplyRoute(cachedRoute.to) : topic;
          // A native thread ID alone is not a Feishu message that can be
          // replied to. Once a message arrives, its route is saved on disk.
          if (topic && !deliveryRoute?.replyToMessageId) return [];
          if (topic) {
            if (listedTopics.has(m.coworkSessionId)) return [];
            listedTopics.add(m.coworkSessionId);
          }
          const sessionTitle = getCoworkSessionTitle(m.coworkSessionId)?.trim();
          const customTitle =
            sessionTitle && !AUTO_CHANNEL_TITLE_RE.test(sessionTitle) ? sessionTitle : undefined;
          return [{
            conversationId: deliveryRoute ? formatFeishuReplyRoute(deliveryRoute) : m.imConversationId,
            platform: m.platform,
            coworkSessionId: m.coworkSessionId,
            lastActiveAt: m.lastActiveAt,
            ...(parsed.peerKind ? { peerKind: parsed.peerKind } : {}),
            displayName: customTitle ?? imConversationDisplayName(m.imConversationId),
          }];
        });
        return { success: true, conversations };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list conversations',
        };
      }
    },
  );
}
