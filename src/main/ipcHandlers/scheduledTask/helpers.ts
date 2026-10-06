import { ImPeerKind, parseImConversationId, PlatformRegistry } from '../../../shared/platform';
import type { Platform } from '../../im/types';
import { resolveAgentBinding } from '../../libs/openclawChannelSessionSync';

export interface ScheduledTaskHelperDeps {
  getIMGatewayManager: () => {
    getConfig: () => Record<string, unknown> | null;
  } | null;
}

let deps: ScheduledTaskHelperDeps | null = null;

const WECOM_PLATFORM: Platform = 'wecom';

export function initScheduledTaskHelpers(d: ScheduledTaskHelperDeps): void {
  deps = d;
}

const MULTI_INSTANCE_CONFIG_KEYS = new Set(['dingtalk', 'feishu', 'nim', 'qq', 'wecom', 'telegram', 'discord', 'popo']);

function deriveNimRuntimeAccountId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const inst = value as { nimToken?: string; appKey?: string; account?: string };
  const nimToken = inst.nimToken?.trim();
  if (nimToken) {
    const delimiter = nimToken.includes('|') ? '|' : '-';
    const parts = nimToken.split(delimiter).map((part) => part.trim());
    if (parts.length === 3 && parts[0] && parts[1]) {
      return `${parts[0]}:${parts[1]}`;
    }
  }
  if (inst.appKey?.trim() && inst.account?.trim()) {
    return `${inst.appKey.trim()}:${inst.account.trim()}`;
  }
  return null;
}

function isConfigKeyEnabled(key: string, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;

  if (MULTI_INSTANCE_CONFIG_KEYS.has(key)) {
    const instances = (value as { instances?: unknown[] }).instances;
    if (!Array.isArray(instances) || instances.length === 0) return false;
    return instances.some(
      (inst) => inst && typeof inst === 'object' && (inst as { enabled?: boolean }).enabled,
    );
  }

  return (value as { enabled?: boolean }).enabled === true;
}

export function listScheduledTaskChannels(): Array<{
  value: string;
  label: string;
  accountId?: string;
  filterAccountId?: string;
}> {
  const manager = deps?.getIMGatewayManager();
  const config = manager?.getConfig();
  if (!config) {
    return [...PlatformRegistry.channelOptions()];
  }

  const configRecord = config as unknown as Record<string, unknown>;

  const enabledPlatforms = new Set<string>();
  // For multi-instance platforms: collect per-instance info (accountId + name).
  const instancesByPlatform = new Map<
    string,
    Array<{ accountId: string; instanceName: string; filterAccountId?: string }>
  >();

  for (const [key, value] of Object.entries(configRecord)) {
    if (!isConfigKeyEnabled(key, value)) continue;
    enabledPlatforms.add(key);

    if (MULTI_INSTANCE_CONFIG_KEYS.has(key)) {
      const instances = (value as { instances?: unknown[] }).instances ?? [];
      const entries = instances
        .filter((inst) => inst && typeof inst === 'object' && (inst as { enabled?: boolean }).enabled)
        .map((inst) => {
          const i = inst as { instanceId?: string; instanceName?: string };
          const nimAccountId = key === 'nim'
            ? ((i.instanceId ?? '').slice(0, 8) || deriveNimRuntimeAccountId(inst))
            : null;
          const accountId = nimAccountId ?? (i.instanceId ?? '').slice(0, 8);
          return {
            accountId,
            // Leave unnamed instances empty; the renderer falls back to an
            // ordinal label instead of exposing an account id fragment.
            instanceName: (i.instanceName ?? '').trim(),
            filterAccountId: accountId || undefined,
          };
        })
        .filter((e) => e.accountId);
      if (entries.length > 0) instancesByPlatform.set(key, entries);
    }
  }

  const result: Array<{
    value: string;
    label: string;
    accountId?: string;
    filterAccountId?: string;
  }> = [];

  for (const option of PlatformRegistry.channelOptions()) {
    const platform = PlatformRegistry.platformOfChannel(option.value);
    if (platform === undefined || !enabledPlatforms.has(platform)) continue;

    const instances = instancesByPlatform.get(platform);
    if (instances && instances.length > 0) {
      // Multi-instance: one option per enabled instance, each carrying its accountId.
      for (const inst of instances) {
        result.push({
          value: option.value,
          label: inst.instanceName,
          accountId: inst.accountId,
          filterAccountId: inst.filterAccountId,
        });
      }
    } else {
      result.push(option);
    }
  }

  return result;
}

/** Minimal subset of a gateway `sessions.list` row used to restore IM delivery targets. */
interface GatewaySessionRowLike {
  updatedAt?: unknown;
  channel?: unknown;
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  deliveryContext?: { channel?: unknown; to?: unknown; accountId?: unknown } | null;
  origin?: {
    provider?: unknown;
    surface?: unknown;
    chatType?: unknown;
    to?: unknown;
    accountId?: unknown;
  } | null;
}

export interface ImDeliveryHints {
  /** Channel-native target id with its original casing. */
  to: string;
  /** Bot account that owns the conversation on the channel side. */
  accountId?: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isAccountlessGroupOrChannel(
  parsed: ReturnType<typeof parseImConversationId>,
): boolean {
  return !parsed.accountId && (
    parsed.peerKind === ImPeerKind.Group ||
    parsed.peerKind === ImPeerKind.Channel
  );
}

/**
 * Restores the channel-native delivery target from gateway session rows.
 *
 * Conversation ids in `im_session_mappings` derive from OpenClaw session keys,
 * which are canonicalized to lowercase. Some channels (e.g. weixin) route by
 * case-sensitive peer ids and echo per-conversation context tokens keyed by
 * the original id, so a lowercased `delivery.to` is accepted by the provider
 * but never reaches the user. Session entries keep the original casing in
 * `lastTo`/`deliveryContext`, so match the peer case-insensitively and return
 * the stored casing plus the account that owns the conversation.
 */
export function resolveImDeliveryHintsFromSessions(params: {
  sessions: readonly unknown[];
  channel: string;
  peerId: string;
  /** Account segment parsed from the picked conversation id, when present. */
  preferredAccountId?: string;
}): ImDeliveryHints | null {
  const platform = PlatformRegistry.platformOfChannel(params.channel);
  const requestedPeer = parseImConversationId(params.peerId);
  const peerLower = requestedPeer.peerId.trim().toLowerCase();
  if (!platform || !peerLower) return null;

  interface Candidate {
    to: string;
    accountId?: string;
    updatedAt: number;
  }
  const candidates: Candidate[] = [];
  for (const row of params.sessions) {
    if (!row || typeof row !== 'object') continue;
    const session = row as GatewaySessionRowLike;
    const context = session.deliveryContext;
    const rowChannel =
      asNonEmptyString(session.lastChannel) ??
      asNonEmptyString(context?.channel) ??
      asNonEmptyString(session.channel);
    if (!rowChannel || PlatformRegistry.platformOfChannel(rowChannel) !== platform) continue;
    const to = asNonEmptyString(session.lastTo) ?? asNonEmptyString(context?.to);
    const toPeer = to ? parseImConversationId(to).peerId : '';
    if (!to || toPeer.toLowerCase() !== peerLower) continue;
    candidates.push({
      to,
      accountId: asNonEmptyString(session.lastAccountId) ?? asNonEmptyString(context?.accountId),
      updatedAt:
        typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : 0,
    });
  }
  if (candidates.length === 0) return null;

  const preferred = params.preferredAccountId
    ? candidates.filter(candidate => candidate.accountId === params.preferredAccountId)
    : [];
  const pool = preferred.length > 0 ? preferred : candidates;
  // Inbound activity keeps the live conversation session freshest; sessions
  // from replaced bot accounts stop updating once the account is gone.
  pool.sort((a, b) => b.updatedAt - a.updatedAt);
  const best = pool[0];
  return { to: best.to, ...(best.accountId ? { accountId: best.accountId } : {}) };
}

/**
 * Restores a case-sensitive native group id from inbound session origin
 * metadata. OpenClaw lowercases channel peer ids in session keys, but providers
 * such as WeCom and DingTalk require their opaque group ids unchanged.
 *
 * This is deliberately narrower than `resolveImDeliveryHintsFromSessions`:
 * only group origins from the requested platform are considered, an explicitly
 * selected account must match, and conflicting native ids are rejected.
 */
export function resolveGroupDeliveryTargetFromSessions(params: {
  sessions: readonly unknown[];
  platform: Platform;
  peerId: string;
  preferredAccountId?: string;
}): string | null {
  const requestedPeer = parseImConversationId(params.peerId).peerId.trim().toLowerCase();
  const preferredAccountId = params.preferredAccountId?.trim();
  if (!requestedPeer) return null;

  const nativeTargets = new Set<string>();
  for (const row of params.sessions) {
    if (!row || typeof row !== 'object') continue;
    const origin = (row as GatewaySessionRowLike).origin;
    if (!origin || origin.chatType !== ImPeerKind.Group) continue;

    const originChannel = asNonEmptyString(origin.provider) ?? asNonEmptyString(origin.surface);
    if (!originChannel || PlatformRegistry.platformOfChannel(originChannel) !== params.platform) {
      continue;
    }

    const originAccountId = asNonEmptyString(origin.accountId);
    if (preferredAccountId && originAccountId !== preferredAccountId) continue;

    const originTo = asNonEmptyString(origin.to);
    if (!originTo) continue;
    const colonIndex = originTo.indexOf(':');
    const prefix = colonIndex > 0 ? originTo.slice(0, colonIndex) : '';
    const withoutChannel = prefix && PlatformRegistry.platformOfChannel(prefix) === params.platform
      ? originTo.slice(colonIndex + 1)
      : originTo;
    const parsedTarget = parseImConversationId(withoutChannel);
    if (parsedTarget.peerKind && parsedTarget.peerKind !== ImPeerKind.Group) continue;
    const nativePeer = parsedTarget.peerId.trim();
    if (!nativePeer || nativePeer.toLowerCase() !== requestedPeer) continue;
    nativeTargets.add(nativePeer);
  }

  return nativeTargets.size === 1 ? [...nativeTargets][0] : null;
}

/** Backward-compatible WeCom wrapper for existing callers and tests. */
export function resolveWecomGroupDeliveryTargetFromSessions(params: {
  sessions: readonly unknown[];
  peerId: string;
  preferredAccountId?: string;
}): string | null {
  return resolveGroupDeliveryTargetFromSessions({
    ...params,
    platform: WECOM_PLATFORM,
  });
}

/**
 * Resolves the agent bound to a delivery-target conversation from IM session
 * mappings (sorted by lastActiveAt DESC). IM conversations can be bound to a
 * non-main agent; a scheduled delivery must run under that agent so the
 * gateway mirrors the result into the same conversation session the LobsterAI
 * record maps to, instead of a main-agent shadow session.
 */
export function resolveConversationAgentIdFromMappings(
  mappings: ReadonlyArray<{ imConversationId: string; agentId?: string }>,
  to: string,
  preferredAccountId?: string,
  options?: {
    platform?: Platform;
    platformAgentBindings?: Record<string, string>;
  },
): string | null {
  const peer = parseImConversationId(to).peerId.trim().toLowerCase();
  if (!peer) return null;

  const preferredAgentId = preferredAccountId && options?.platform
    ? resolveAgentBinding(
      options.platformAgentBindings,
      options.platform,
      preferredAccountId,
    )
    : null;

  if (preferredAgentId) {
    for (const mapping of mappings) {
      const parsed = parseImConversationId(mapping.imConversationId);
      if (parsed.peerId.trim().toLowerCase() !== peer) continue;
      if (!isAccountlessGroupOrChannel(parsed)) continue;
      const agentId = mapping.agentId?.trim();
      if (agentId === preferredAgentId) return agentId;
    }
  }

  let firstMatch: string | null = null;
  for (const mapping of mappings) {
    const parsed = parseImConversationId(mapping.imConversationId);
    if (parsed.peerId.trim().toLowerCase() !== peer) continue;
    const agentId = mapping.agentId?.trim();
    if (!agentId) continue;
    if (preferredAccountId && parsed.accountId === preferredAccountId) return agentId;
    if (
      preferredAgentId &&
      isAccountlessGroupOrChannel(parsed) &&
      agentId === preferredAgentId
    ) {
      return agentId;
    }
    firstMatch = firstMatch ?? agentId;
  }
  return firstMatch;
}

/**
 * Collapses duplicate peer conversations for the notify-target list: bot
 * accounts get replaced over time but their mappings persist per account
 * prefix, and OpenClaw heartbeat pseudo-conversations are not valid delivery
 * targets. Input must be sorted by lastActiveAt DESC (listSessionMappings
 * order); the first (most recent) row per peer wins.
 */
export function dedupeConversationMappings<T extends { imConversationId: string; agentId?: string }>(
  mappings: readonly T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const mapping of mappings) {
    const parsed = parseImConversationId(mapping.imConversationId);
    if (parsed.peerId.toLowerCase().endsWith(':heartbeat')) continue;
    const key = `${mapping.agentId ?? ''}:${parsed.peerKind ?? ''}:${parsed.peerId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mapping);
  }
  return result;
}

/**
 * Narrows account-less group mappings for a selected multi-instance bot.
 *
 * OpenClaw's canonical group session keys are scoped by agent + channel +
 * group id, e.g. `agent:<agentId>:feishu:group:<chatId>`. They intentionally
 * do not include accountId, so persisted group conversation ids cannot be
 * filtered by account prefix like direct chats. When the scheduled-task form
 * already selected a bot instance, use that instance's current agent binding
 * as the best available group ownership signal.
 */
export function filterConversationMappingsForSelectedAccount<
  T extends { imConversationId: string; agentId?: string },
>(
  mappings: readonly T[],
  platform: Platform,
  accountId: string | undefined,
  platformAgentBindings: Record<string, string> | undefined,
): T[] {
  const selectedAccountId = accountId?.trim();
  if (!selectedAccountId) return [...mappings];
  if (!platformAgentBindings) return [...mappings];

  const selectedAgentId = resolveAgentBinding(
    platformAgentBindings,
    platform,
    selectedAccountId,
  );

  const filtered = mappings.filter((mapping) => {
    const parsed = parseImConversationId(mapping.imConversationId);
    if (parsed.accountId) return true;
    if (
      parsed.peerKind !== ImPeerKind.Group &&
      parsed.peerKind !== ImPeerKind.Channel
    ) {
      return true;
    }
    const mappingAgentId = mapping.agentId?.trim();
    return !mappingAgentId || mappingAgentId === selectedAgentId;
  });

  const accountlessGroupPeers = new Set(
    filtered
      .map((mapping) => parseImConversationId(mapping.imConversationId))
      .filter(isAccountlessGroupOrChannel)
      .map(parsed => parsed.peerId.trim().toLowerCase())
      .filter(Boolean),
  );

  if (accountlessGroupPeers.size === 0) return filtered;

  return filtered.filter((mapping) => {
    const parsed = parseImConversationId(mapping.imConversationId);
    if (!parsed.accountId || parsed.peerKind !== ImPeerKind.Direct) return true;
    return !accountlessGroupPeers.has(parsed.peerId.trim().toLowerCase());
  });
}
