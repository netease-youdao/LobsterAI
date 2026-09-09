import { ipcMain } from 'electron';

import {
  DeliveryMode as STDeliveryMode,
  IpcChannel as ScheduledTaskIpc,
  PayloadKind as STPayloadKind,
  SessionTarget as STSessionTarget,
} from '../../../scheduledTask/constants';
import type { CronJobService } from '../../../scheduledTask/cronJobService';
import type {
  ScheduledTask,
  ScheduledTaskDelivery,
  ScheduledTaskInput,
  ScheduledTaskPayload,
} from '../../../scheduledTask/types';
import { AgentId } from '../../../shared/agent/constants';
import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import {
  imConversationDisplayName,
  ImPeerKind,
  type ParsedImConversationId,
  parseImConversationId,
  type Platform,
  PlatformRegistry,
} from '../../../shared/platform';
import type { RemoteOwner } from '../../../shared/remote/constants';
import {
  dedupeConversationMappings,
  filterConversationMappingsForSelectedAccount,
  listScheduledTaskChannels,
  resolveConversationAgentIdFromMappings,
  resolveGroupDeliveryTargetFromSessions,
  resolveImDeliveryHintsFromSessions,
} from './helpers';

/** Matches auto-generated channel session titles, e.g. "[TG] group:123". */
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

function normalizeImAnnounceDeliveryTo(
  rawTo: string,
  mappings: readonly ConversationMappingForList[],
  platform: Platform,
): string {
  const parsed = parseImConversationId(rawTo);
  if (
    parsed.peerKind === ImPeerKind.Direct ||
    parsed.peerKind === ImPeerKind.Group ||
    parsed.peerKind === ImPeerKind.Channel
  ) {
    return parsed.peerId;
  }

  // Bare targets for case-sensitive group-id providers are already native ids.
  // Do not replace their case from a lowercased OpenClaw session mapping.
  if (CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(platform) && !rawTo.includes(':')) {
    return rawTo;
  }

  const peer = parsed.peerId.trim().toLowerCase();
  if (peer) {
    for (const mapping of mappings) {
      const mappingParsed = parseImConversationId(mapping.imConversationId);
      if (mappingParsed.peerId.trim().toLowerCase() !== peer) continue;
      return mappingParsed.peerId;
    }
  }

  const colonIdx = rawTo.lastIndexOf(':');
  if (colonIdx > 0) {
    return rawTo.slice(colonIdx + 1);
  }
  return rawTo;
}

export interface ScheduledTaskHandlerDeps {
  captureRemoteOwner?: () => RemoteOwner | null;
  assertRemoteTaskOwner?: (jobId: string) => void;
  recordRemoteTaskOwner?: (jobId: string, owner: RemoteOwner | null) => void;
  getCronJobService: () => CronJobService;
  getIMGatewayManager: () => {
    getIMStore: () =>
      | {
          getSessionMapping: (
            conversationId: string,
            platform: string,
          ) =>
            | {
                coworkSessionId: string;
              }
            | undefined;
          getIMSettings?: () => {
            platformAgentBindings?: Record<string, string>;
          };
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
  /** Resolve a Cowork session title for conversation display names. */
  getCoworkSessionTitle: (sessionId: string) => string | null;
  getOpenClawRuntimeAdapter: () => {
    getGatewayClient: () => unknown;
    getEngineStatusSnapshot: () => { phase: OpenClawEnginePhase };
    connectGatewayIfNeeded: () => Promise<void>;
    fetchSessionByKey: (
      sessionKey: string,
      options?: { sessionId?: string | null },
    ) => Promise<unknown>;
  } | null;
}

/** Structural view of the OpenClaw gateway client needed for session lookups. */
interface GatewayRpcClient {
  request: <T>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ) => Promise<T>;
}

function asGatewayRpcClient(value: unknown): GatewayRpcClient | null {
  if (value && typeof (value as GatewayRpcClient).request === 'function') {
    return value as GatewayRpcClient;
  }
  return null;
}

function summarizeAccountId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length <= 16 ? trimmed : `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

function summarizeGroupMappings(
  mappings: readonly ConversationMappingForList[],
): Array<{ peerId: string; agentId: string }> {
  return mappings
    .map((mapping) => {
      const parsed = parseImConversationId(mapping.imConversationId);
      if (parsed.accountId || parsed.peerKind !== 'group') return null;
      return {
        peerId: summarizeAccountId(parsed.peerId) ?? parsed.peerId,
        agentId: mapping.agentId,
      };
    })
    .filter((entry): entry is { peerId: string; agentId: string } => Boolean(entry))
    .slice(0, 8);
}

function summarizeRelevantBindings(
  platformAgentBindings: Record<string, string> | undefined,
  platform: string,
  selectedAccountId: string | undefined,
): Array<{ key: string; agentId: string }> {
  if (!platformAgentBindings) return [];
  const selectedPrefix = selectedAccountId ? `${platform}:${selectedAccountId}` : null;
  return Object.entries(platformAgentBindings)
    .filter(([key]) => (
      key === platform ||
      (selectedPrefix ? key.startsWith(selectedPrefix) : key.startsWith(`${platform}:`))
    ))
    .map(([key, agentId]) => ({ key: summarizeAccountId(key) ?? key, agentId }))
    .slice(0, 8);
}

function logChannelConversationList(params: {
  channel: string;
  platform: string;
  accountId?: string;
  filterAccountId?: string;
  selectedAccountId?: string;
  platformAgentBindings?: Record<string, string>;
  rawMappings: readonly ConversationMappingForList[];
  filteredMappings: readonly ConversationMappingForList[];
  dedupedMappings: readonly ConversationMappingForList[];
}): void {
  const filteredSet = new Set(params.filteredMappings);
  const droppedMappings = params.rawMappings.filter(mapping => !filteredSet.has(mapping));
  console.debug(
    '[ScheduledTask] listed channel conversations:',
    JSON.stringify({
      channel: params.channel,
      platform: params.platform,
      accountId: summarizeAccountId(params.accountId),
      filterAccountId: summarizeAccountId(params.filterAccountId),
      selectedAccountId: summarizeAccountId(params.selectedAccountId),
      rawCount: params.rawMappings.length,
      filteredCount: params.filteredMappings.length,
      dedupedCount: params.dedupedMappings.length,
      bindingCount: Object.keys(params.platformAgentBindings ?? {}).length,
      rawGroups: summarizeGroupMappings(params.rawMappings),
      filteredGroups: summarizeGroupMappings(params.filteredMappings),
      dedupedGroups: summarizeGroupMappings(params.dedupedMappings),
      droppedGroups: summarizeGroupMappings(droppedMappings),
      relevantBindings: summarizeRelevantBindings(
        params.platformAgentBindings,
        params.platform,
        params.selectedAccountId,
      ),
    }),
  );
}

/**
 * Fast, local-only announce normalization. It never queries gateway session
 * history, so it is safe for background migration and manual-run repair.
 */
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
  const mappings = imStore?.listSessionMappings(platform) ?? [];
  const imSettings = imStore?.getIMSettings?.();

  normalizedInput.sessionTarget = STSessionTarget.Isolated;
  if (normalizedInput.payload?.kind === STPayloadKind.SystemEvent) {
    normalizedInput.payload = {
      kind: STPayloadKind.AgentTurn,
      message: normalizedInput.payload.text || '',
    };
  }

  // Strip conversation-id prefixes (e.g. "acc:direct:ou_xxx" -> "ou_xxx").
  // Outbound delivery targets must stay channel-native ids. For Feishu groups
  // this is the raw chat id (oc_xxx), not the OpenClaw session peer kind
  // marker (group:oc_xxx).
  const rawTo: string = delivery.to;
  const parsedConversation = parseImConversationId(rawTo);
  delivery.to = normalizeImAnnounceDeliveryTo(rawTo, mappings, platform);
  if (delivery.to !== rawTo) {
    console.debug(
      '[ScheduledTask] normalized IM delivery.to:',
      rawTo,
      '->',
      delivery.to,
    );
  }

  // IM conversations can be bound to a non-main agent. Run the job under that
  // agent so the gateway mirrors the delivered result into the conversation
  // session the LobsterAI record maps to, instead of a main-agent shadow
  // session that stays invisible in the UI.
  const existingAgentId = typeof normalizedInput.agentId === 'string'
    ? normalizedInput.agentId.trim()
    : '';
  if (!existingAgentId || existingAgentId === AgentId.Main) {
    try {
      const boundAgentId = resolveConversationAgentIdFromMappings(
        mappings,
        rawTo,
        parsedConversation.accountId ?? delivery.accountId,
        {
          platform,
          platformAgentBindings: imSettings?.platformAgentBindings,
        },
      );
      if (boundAgentId && boundAgentId !== AgentId.Main) {
        normalizedInput.agentId = boundAgentId;
        console.log(
          '[ScheduledTask] bound delivery job to conversation agent:',
          boundAgentId,
        );
      }
    } catch (error) {
      console.warn('[ScheduledTask] failed to resolve conversation agent binding:', error);
    }
  }

  return { platform, rawTo, parsedConversation };
}

function describeRunFilter(
  filter?: import('../../../scheduledTask/types').RunFilter,
): Record<string, string | undefined> | null {
  if (!filter) return null;
  return {
    startDate: filter.startDate,
    endDate: filter.endDate,
    status: filter.status,
  };
}

async function restoreAnnounceDeliveryHintsFromGateway(
  normalizedInput: Record<string, any>,
  context: AnnounceNormalizationContext,
  deps: Pick<ScheduledTaskHandlerDeps, 'getOpenClawRuntimeAdapter'>,
  options?: { casingOnly?: boolean },
): Promise<void> {
  const { getOpenClawRuntimeAdapter } = deps;
  const delivery = normalizedInput.delivery;
  if (!(delivery && delivery.mode === STDeliveryMode.Announce && delivery.channel && delivery.to)) {
    return;
  }

  // Conversation ids are lowercased session-key derivatives; case-sensitive
  // channels (e.g. weixin) silently drop sends to a wrong-case peer id, and a
  // missing accountId makes the cron delivery route into a fresh "default"
  // account session instead of the existing conversation. Restore both from
  // the gateway's session store, which keeps the original casing.
  try {
    if (await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter)) {
      const client = asGatewayRpcClient(getOpenClawRuntimeAdapter()?.getGatewayClient());
      if (client) {
        const result = await client.request<{ sessions?: unknown[] }>(
          'sessions.list',
          { includeGlobal: true, includeUnknown: true, limit: 500 },
          { timeoutMs: 10_000 },
        );
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        const selectedAccountId = typeof delivery.accountId === 'string'
          ? delivery.accountId
          : undefined;
        if (!options?.casingOnly) {
          const hints = resolveImDeliveryHintsFromSessions({
            sessions,
            channel: delivery.channel,
            peerId: delivery.to,
            preferredAccountId: context.parsedConversation.accountId,
          });
          if (hints) {
            if (hints.to !== delivery.to) {
              console.log(
                '[ScheduledTask] restored delivery.to casing from gateway session:',
                delivery.to,
                '->',
                hints.to,
              );
              delivery.to = hints.to;
            }
            if (!delivery.accountId && hints.accountId) {
              delivery.accountId = hints.accountId;
            }
          }
        }

        if (CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(context.platform)) {
          const nativeGroupTarget = resolveGroupDeliveryTargetFromSessions({
            sessions,
            platform: context.platform,
            peerId: delivery.to,
            preferredAccountId: selectedAccountId,
          });
          if (nativeGroupTarget && nativeGroupTarget !== delivery.to) {
            console.log(
              `[ScheduledTask] restored ${context.platform} group delivery.to casing from gateway origin:`,
              delivery.to,
              '->',
              nativeGroupTarget,
            );
            delivery.to = nativeGroupTarget;
          }
        }
      }
    }
  } catch (error) {
    console.warn('[ScheduledTask] failed to restore IM delivery target from gateway sessions:', error);
  }
}

async function primeAnnounceReplyRoute(
  context: AnnounceNormalizationContext,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager'>,
): Promise<void> {
  if (context.platform === 'dingtalk') {
    const { getIMGatewayManager } = deps;
    const imStore = getIMGatewayManager()?.getIMStore();
    const mapping = imStore?.getSessionMapping(context.rawTo, context.platform);
    if (mapping) {
      await getIMGatewayManager()!.primeConversationReplyRoute(
        context.platform,
        context.rawTo,
        mapping.coworkSessionId,
      );
    }
  }
}

/**
 * Normalizes an announce-mode delivery payload for OpenClaw native delivery.
 * Mutates `normalizedInput` in place: sets sessionTarget, converts SystemEvent
 * payloads to AgentTurn, strips IM subtype prefixes from delivery.to, restores
 * the channel-native target casing/account from gateway sessions, and primes
 * the DingTalk reply route when needed.
 */
async function applyAnnounceDeliveryNormalization(
  normalizedInput: Record<string, any>,
  deps: Pick<ScheduledTaskHandlerDeps, 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'>,
): Promise<void> {
  const context = applyLocalAnnounceDeliveryNormalization(normalizedInput, deps);
  if (!context) return;
  await restoreAnnounceDeliveryHintsFromGateway(normalizedInput, context, deps);
  await primeAnnounceReplyRoute(context, deps);
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

async function buildAnnounceNormalizationPatch(
  task: ScheduledTask,
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<Partial<ScheduledTaskInput> | null> {
  const normalizedInput: Record<string, any> = {
    sessionTarget: task.sessionTarget,
    payload: clonePayload(task.payload),
    delivery: cloneDelivery(task.delivery),
    agentId: task.agentId ?? undefined,
    sessionKey: task.sessionKey ?? undefined,
  };
  const context = applyLocalAnnounceDeliveryNormalization(normalizedInput, deps);
  if (!context) return null;
  const normalizedTo = typeof normalizedInput.delivery?.to === 'string'
    ? normalizedInput.delivery.to.trim()
    : '';
  if (
    CASE_SENSITIVE_GROUP_TARGET_PLATFORMS.has(context.platform) &&
    normalizedTo &&
    normalizedTo === normalizedTo.toLowerCase()
  ) {
    // Historical repair must only restore the case-sensitive native group id;
    // it must not infer or change account routing from gateway metadata.
    await restoreAnnounceDeliveryHintsFromGateway(normalizedInput, context, deps, {
      casingOnly: true,
    });
  }

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

async function migrateScheduledTaskAnnounceJob(
  task: ScheduledTask,
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getCronJobService' | 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<boolean> {
  const patch = await buildAnnounceNormalizationPatch(task, deps);
  if (!patch) return false;
  await deps.getCronJobService().updateJob(task.id, patch);
  console.log(
    '[ScheduledTask] migrated IM announce job:',
    JSON.stringify({
      id: task.id,
      deliveryChannel: task.delivery?.channel,
      deliveryTo: task.delivery?.to,
      patchedFields: Object.keys(patch),
    }),
  );
  return true;
}

export async function migrateScheduledTaskAnnounceJobs(
  deps: Pick<
    ScheduledTaskHandlerDeps,
    'getCronJobService' | 'getIMGatewayManager' | 'getOpenClawRuntimeAdapter'
  >,
): Promise<{ checked: number; updated: number }> {
  const tasks = await deps.getCronJobService().listJobs();
  let updated = 0;
  for (const task of tasks) {
    if (await migrateScheduledTaskAnnounceJob(task, deps)) {
      updated += 1;
    }
  }
  const result = { checked: tasks.length, updated };
  if (updated > 0) {
    console.log('[ScheduledTask] migrated existing IM announce jobs:', JSON.stringify(result));
  }
  return result;
}

async function ensureScheduledTaskGatewayClient(
  getOpenClawRuntimeAdapter: ScheduledTaskHandlerDeps['getOpenClawRuntimeAdapter'],
): Promise<boolean> {
  const adapter = getOpenClawRuntimeAdapter();
  if (!adapter) return false;
  if (adapter.getGatewayClient()) return true;

  // While the engine is still installing/starting, report not-ready instead
  // of blocking on gateway startup; the renderer reloads via the refresh
  // event after the first successful cron poll.
  if (adapter.getEngineStatusSnapshot().phase !== OpenClawEnginePhase.Running) {
    return false;
  }

  await adapter.connectGatewayIfNeeded();
  return Boolean(adapter.getGatewayClient());
}

export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const { getCronJobService, getIMGatewayManager, getOpenClawRuntimeAdapter, getCoworkSessionTitle } = deps;

  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    try {
      if (!(await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter))) {
        return { success: true, ready: false, tasks: [] };
      }
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
    const remoteOwner = deps.captureRemoteOwner?.() || null;
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.debug('[ScheduledTask] create input:', JSON.stringify(normalizedInput, null, 2));
      await applyAnnounceDeliveryNormalization(normalizedInput, {
        getIMGatewayManager,
        getOpenClawRuntimeAdapter,
      });

      const task = await getCronJobService().addJob(normalizedInput);
      if (task?.id) deps.recordRemoteTaskOwner?.(task.id, remoteOwner);
      console.log('[IPC][scheduledTask:create] result task id:', task?.id, 'name:', task?.name);
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
      deps.assertRemoteTaskOwner?.(id);
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      console.debug(
        '[ScheduledTask] update input id:',
        id,
        JSON.stringify(normalizedInput, null, 2),
      );
      await applyAnnounceDeliveryNormalization(normalizedInput, {
        getIMGatewayManager,
        getOpenClawRuntimeAdapter,
      });

      const task = await getCronJobService().updateJob(id, normalizedInput);
      console.log('[IPC][scheduledTask:update] result task id:', task?.id, 'name:', task?.name);
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
      deps.assertRemoteTaskOwner?.(id);
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
      deps.assertRemoteTaskOwner?.(id);
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
      deps.assertRemoteTaskOwner?.(id);
      const cronJobService = getCronJobService();
      const task = await cronJobService.getJob(id);
      if (task) {
        await migrateScheduledTaskAnnounceJob(task, {
          getCronJobService,
          getIMGatewayManager,
          getOpenClawRuntimeAdapter,
        });
      }
      await cronJobService.runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle(ScheduledTaskIpc.Stop, async (_event, _id: string) => {
    // OpenClaw doesn't expose a direct stop API for running cron jobs
    // The job will complete or timeout on its own
    return { success: true, result: false };
  });

  ipcMain.handle(
    ScheduledTaskIpc.ListRuns,
    async (
      _event,
      taskId: string,
      limit?: number,
      offset?: number,
      filter?: import('../../../scheduledTask/types').RunFilter,
    ) => {
      try {
        console.debug('[ScheduledTask] list job run history request:', JSON.stringify({
          taskId,
          limit,
          offset,
          filter: describeRunFilter(filter),
        }));
        const runs = await getCronJobService().listRuns(taskId, limit, offset, filter);
        console.debug('[ScheduledTask] list job run history result:', JSON.stringify({
          taskId,
          limit,
          offset,
          returnedCount: runs.length,
        }));
        return { success: true, runs };
      } catch (error) {
        console.warn('[ScheduledTask] list job run history failed:', JSON.stringify({
          taskId,
          limit,
          offset,
          filter: describeRunFilter(filter),
          error: error instanceof Error ? error.message : String(error),
        }));
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
    async (
      _event,
      limit?: number,
      offset?: number,
      filter?: import('../../../scheduledTask/types').RunFilter,
    ) => {
      try {
        console.debug('[ScheduledTask] list all run history request:', JSON.stringify({
          limit,
          offset,
          filter: describeRunFilter(filter),
        }));
        if (!(await ensureScheduledTaskGatewayClient(getOpenClawRuntimeAdapter))) {
          console.debug('[ScheduledTask] list all run history deferred; gateway is not ready.');
          return { success: true, ready: false, runs: [] };
        }
        const runs = await getCronJobService().listAllRuns(limit, offset, filter);
        console.debug('[ScheduledTask] list all run history result:', JSON.stringify({
          limit,
          offset,
          returnedCount: runs.length,
        }));
        return { success: true, ready: true, runs };
      } catch (error) {
        console.warn('[ScheduledTask] list all run history failed:', JSON.stringify({
          limit,
          offset,
          filter: describeRunFilter(filter),
          error: error instanceof Error ? error.message : String(error),
        }));
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list all runs',
        };
      }
    },
  );

  ipcMain.handle(
    ScheduledTaskIpc.ResolveSession,
    async (
      _event,
      input: string | { sessionId?: string | null; sessionKey?: string | null },
    ) => {
      try {
        const sessionKey = typeof input === 'string' ? input : (input.sessionKey ?? '');
        const sessionId = typeof input === 'string' ? null : (input.sessionId ?? null);
        if (!sessionKey) return { success: true, session: null };
        // Fetch session history from OpenClaw (returns transient session, not persisted)
        const session = await getOpenClawRuntimeAdapter()?.fetchSessionByKey(sessionKey, {
          sessionId,
        });
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
        const mappings = dedupeConversationMappings(filteredMappings);
        logChannelConversationList(
          {
            channel,
            platform,
            accountId,
            filterAccountId,
            selectedAccountId,
            platformAgentBindings,
            rawMappings,
            filteredMappings,
            dedupedMappings: mappings,
          },
        );
        const conversations = mappings.map(m => {
          const parsed = parseImConversationId(m.imConversationId);
          const sessionTitle = getCoworkSessionTitle(m.coworkSessionId)?.trim();
          // Channel-synced sessions get auto titles like "[TG] group:123"; only a
          // title the user renamed (no "[...] " prefix) beats the parsed peer id.
          const customTitle =
            sessionTitle && !AUTO_CHANNEL_TITLE_RE.test(sessionTitle) ? sessionTitle : undefined;
          return {
            conversationId: m.imConversationId,
            platform: m.platform,
            coworkSessionId: m.coworkSessionId,
            lastActiveAt: m.lastActiveAt,
            ...(parsed.peerKind ? { peerKind: parsed.peerKind } : {}),
            displayName: customTitle ?? imConversationDisplayName(m.imConversationId),
          };
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
