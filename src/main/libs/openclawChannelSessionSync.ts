/**
 * OpenClaw Channel Session Sync
 *
 * Discovers and maps sessions created by OpenClaw channel extensions (e.g. Telegram)
 * to local Cowork sessions so that conversations are visible in the LobsterAI UI.
 */

import { DeliveryMode as ScheduledTaskDeliveryMode } from '../../scheduledTask/constants';
import type { ScheduledTaskJobDelivery } from '../../scheduledTask/cronJobService';
import { parseImConversationId, PlatformRegistry } from '../../shared/platform';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { IMStore } from '../im/imStore';
import type { Platform } from '../im/types';

const LOBSTERAI_SESSION_PREFIX = 'lobsterai:';
export const DEFAULT_MANAGED_AGENT_ID = 'main';

export interface ManagedSessionKey {
  agentId: string | null;
  sessionId: string;
}

export function buildManagedSessionKey(
  sessionId: string,
  agentId = DEFAULT_MANAGED_AGENT_ID,
): string {
  const normalizedSessionId = sessionId.trim();
  const normalizedAgentId = agentId.trim() || DEFAULT_MANAGED_AGENT_ID;
  return `agent:${normalizedAgentId}:lobsterai:${normalizedSessionId}`;
}

export function parseManagedSessionKey(
  sessionKey: string | undefined | null,
): ManagedSessionKey | null {
  const raw = (sessionKey ?? '').trim();
  if (!raw) return null;

  if (raw.startsWith(LOBSTERAI_SESSION_PREFIX)) {
    const sessionId = raw.slice(LOBSTERAI_SESSION_PREFIX.length).trim();
    return sessionId ? { agentId: null, sessionId } : null;
  }

  if (!raw.startsWith('agent:')) {
    return null;
  }

  const parts = raw.split(':');
  if (parts.length < 4 || parts[0] !== 'agent' || parts[2] !== 'lobsterai') {
    return null;
  }

  const agentId = parts[1]?.trim();
  const sessionId = parts.slice(3).join(':').trim();
  if (!agentId || !sessionId) {
    return null;
  }

  return { agentId, sessionId };
}

export function isManagedSessionKey(sessionKey: string | undefined | null): boolean {
  return parseManagedSessionKey(sessionKey) !== null;
}

/** Parse a channel sessionKey into platform + conversationId.
 *  Supports three formats:
 *  - OpenClaw format: "agent:{agentId}:{platform}:{subtype}:{conversationId}"
 *  - JSON SessionContext format: "agent:{agentId}:openai-user:{jsonObject}"
 *    where jsonObject contains {"channel":"dingtalk-connector","accountid":"...","chattype":"...","peerid":"..."}
 *  - Legacy format:   "{platform}:{conversationId}"
 *  Exported for reuse by delivery target resolution.
 */
export function parseChannelSessionKey(
  sessionKey: string,
): { platform: Platform; conversationId: string } | null {
  if (!sessionKey || isManagedSessionKey(sessionKey)) return null;

  // Handle OpenClaw format: agent:{agentId}:{platform}:{subtype}:{conversationId}
  // For HTTP-originating sessions (e.g. DingTalk plugin), the format is:
  //   agent:{agentId}:openai-user:{channel}:{conversationId}
  // where parts[2] is "openai-user" and the actual channel name is in parts[3].
  //
  // Since v0.7.5 dingtalk-connector, the format may also be JSON SessionContext:
  //   agent:{agentId}:openai-user:{"channel":"dingtalk-connector","accountid":"...","chattype":"...","peerid":"..."}
  if (sessionKey.startsWith('agent:')) {
    // Try JSON SessionContext format first:
    // Match "agent:{agentId}:{subtype}:{json}" where json starts with '{'
    const jsonIdx = sessionKey.indexOf(':{');
    if (jsonIdx > 0) {
      const jsonStr = sessionKey.slice(jsonIdx + 1);
      try {
        const ctx = JSON.parse(jsonStr);
        if (ctx && typeof ctx.channel === 'string') {
          const platform = PlatformRegistry.platformOfChannel(ctx.channel);
          if (platform) {
            // Build a stable conversationId from the JSON context fields
            const conversationId = ctx.peerid || ctx.conversationId || ctx.accountid || jsonStr;
            return { platform, conversationId };
          }
        }
      } catch {
        // Not valid JSON, fall through to colon-split parsing
      }
    }

    const parts = sessionKey.split(':');
    // Need at least: agent, agentId, platform, and one more segment
    if (parts.length >= 4) {
      let platform = PlatformRegistry.platformOfChannel(parts[2]);
      if (platform) {
        // Detect per-account-channel-peer format:
        //   agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}
        // vs per-channel-peer format:
        //   agent:{agentId}:{channel}:{peerKind}:{peerId}
        // If parts[3] is a peer kind ('direct','group','channel'), it's per-channel-peer.
        // Otherwise parts[3] is an accountId — keep it in conversationId so that
        // different accounts with the same peerId get separate sessions.
        const peerKinds = new Set(['direct', 'group', 'channel']);
        if (parts.length >= 6 && !peerKinds.has(parts[3])) {
          // per-account-channel-peer: include accountId in conversationId for isolation
          const conversationId = parts.slice(3).join(':');
          if (conversationId) return { platform, conversationId };
        }
        const conversationId = parts.slice(3).join(':');
        if (conversationId) return { platform, conversationId };
      }
      // Fallback: parts[2] may be a session subtype (e.g. "openai-user");
      // check parts[3] for the actual channel name.
      if (!platform && parts.length >= 5) {
        platform = PlatformRegistry.platformOfChannel(parts[3]);
        if (platform) {
          const conversationId = parts.slice(4).join(':');
          if (conversationId) return { platform, conversationId };
        }
      }
    }
    return null;
  }

  // Legacy format: {platform}:{conversationId}
  const colonIndex = sessionKey.indexOf(':');
  if (colonIndex <= 0) return null;

  const channelName = sessionKey.slice(0, colonIndex);
  const platform = PlatformRegistry.platformOfChannel(channelName);
  if (!platform) return null;

  const conversationId = sessionKey.slice(colonIndex + 1);
  if (!conversationId) return null;

  return { platform, conversationId };
}

/**
 * Extract the agentId from a gateway session key.
 * Key format: "agent:{agentId}:{channel}:..." → returns agentId.
 * Returns null for legacy keys or non-agent keys.
 */
export function extractAgentIdFromKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const secondColon = sessionKey.indexOf(':', 6); // skip "agent:"
  if (secondColon <= 6) return null;
  return sessionKey.slice(6, secondColon);
}

/**
 * Extract the accountId from a gateway session key (for multi-instance platforms).
 * Key format: "agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}"
 * Returns null if the key doesn't contain an accountId.
 */
export function extractAccountIdFromKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;

  // Try JSON SessionContext format first
  const jsonIdx = sessionKey.indexOf(':{');
  if (jsonIdx > 0) {
    const jsonStr = sessionKey.slice(jsonIdx + 1);
    try {
      const ctx = JSON.parse(jsonStr);
      if (ctx && typeof ctx.accountid === 'string') {
        return ctx.accountid;
      }
    } catch {
      // Not valid JSON
    }
    return null;
  }

  const parts = sessionKey.split(':');
  if (parts.length < 6) return null;
  // agent:{agentId}:{channel}:{accountId}:{peerKind}:{peerId}
  const peerKinds = new Set(['direct', 'group', 'channel']);
  if (!peerKinds.has(parts[3])) {
    // parts[3] is accountId (not a peerKind)
    return parts[3];
  }
  return null;
}

const MULTI_INSTANCE_PLATFORMS = new Set<Platform>(['dingtalk', 'feishu', 'qq', 'email', 'nim', 'wecom', 'telegram', 'discord', 'popo']);

/**
 * Resolve the agent binding for a platform, supporting per-instance bindings.
 * Checks for composite key `platform:instanceId` first (matching by accountId prefix),
 * then falls back to platform-level key, then 'main'.
 */
export function resolveAgentBinding(
  bindings: Record<string, string> | undefined,
  platform: Platform,
  accountId?: string | null,
): string {
  if (!bindings) return 'main';

  // For multi-instance platforms, try per-instance binding first
  if (MULTI_INSTANCE_PLATFORMS.has(platform) && accountId) {
    // Scan bindings for a key like `platform:instanceId` where instanceId starts with accountId
    const prefix = `${platform}:`;
    for (const key of Object.keys(bindings)) {
      if (key.startsWith(prefix)) {
        const instanceId = key.slice(prefix.length);
        if (instanceId === accountId || instanceId.startsWith(accountId)) {
          return bindings[key];
        }
      }
    }
  }

  // Fallback: platform-level binding (legacy or single-instance)
  return bindings[platform] || 'main';
}

/** Match OpenClaw main agent session keys like "agent:main:main" or "agent:secondary:main". */
const MAIN_AGENT_SESSION_RE = /^agent:[^:]+:main$/;

/**
 * Match cron-isolated session keys generated by the OpenClaw gateway.
 * Supported formats:
 *   - "cron:{jobId}"                    — when agentId is not set on the job
 *   - "agent:{agentId}:cron:{jobId}"    — when agentId is set on the job
 *   - "agent:{agentId}:cron:{jobId}:run:{runId}"
 */
const CRON_SESSION_KEY_RE = /^(?:cron:[^:\s]+|agent:[^:]+:cron:[^:\s]+(?::run:.+)?)$/i;

type CronSessionKeyInfo = {
  agentId: string | null;
  jobId: string;
  cacheKey: string;
};

function parseCronSessionKey(sessionKey: string): CronSessionKeyInfo | null {
  const legacyMatch = sessionKey.match(/^cron:([^:\s]+)$/i);
  if (legacyMatch) {
    const jobId = legacyMatch[1];
    return {
      agentId: null,
      jobId,
      cacheKey: `cron:${jobId}`,
    };
  }

  const agentMatch = sessionKey.match(/^agent:([^:]+):cron:([^:\s]+)(?::run:.+)?$/i);
  if (!agentMatch) return null;

  const agentId = agentMatch[1];
  const jobId = agentMatch[2];
  return {
    agentId,
    jobId,
    cacheKey: `agent:${agentId}:cron:${jobId}`,
  };
}

export function isCronSessionKey(sessionKey: string): boolean {
  return CRON_SESSION_KEY_RE.test(sessionKey) && parseCronSessionKey(sessionKey) !== null;
}

function getChannelTitlePrefix(platform: string): string {
  const i18nMap: Record<string, string> = {
    feishu: t('channelPrefixFeishu'),
    dingtalk: t('channelPrefixDingtalk'),
    wecom: t('channelPrefixWecom'),
    'wecom-openclaw-plugin': t('channelPrefixWecom'),
    nim: t('channelPrefixNim'),
    weixin: t('channelPrefixWeixin'),
    'netease-bee': t('channelPrefixNeteaseBee'),
  };
  const staticMap: Record<string, string> = {
    telegram: 'TG',
    discord: 'Discord',
    qq: 'QQ',
    popo: 'POPO',
    email: t('channelPrefixEmail'),
  };
  const label = i18nMap[platform] ?? staticMap[platform] ?? platform;
  return `[${label}]`;
}

const PEER_KIND_LABELS: Record<string, string> = {
  direct: '',
  group: 'group:',
  channel: 'ch:',
};

/**
 * Build a human-readable display name from a structured conversationId.
 *
 * conversationId formats (from parseChannelSessionKey):
 *   - "{peerKind}:{peerId}"                  e.g. "direct:alice@corp.example.com"
 *   - "{accountId}:{peerKind}:{peerId}"      e.g. "bot1:group:12345@popo.netease.com"
 *   - plain id                               e.g. "123456789"
 *
 * Steps:
 *   1. Strip email domain (@...) from the raw conversationId.
 *   2. Extract peerKind (direct/group/channel) and the trailing peerId.
 *   3. For "direct", show just the peerId; for "group"/"channel", add a short prefix.
 *   4. Truncate the final result to 20 characters if needed.
 *
 * @see https://docs.openclaw.ai/reference/session-management-compaction#session-keys-sessionkey
 */
export function buildChannelDisplayName(conversationId: string): string {
  // 1. Strip email domain
  const stripped = conversationId.replace(/@[^:]+/g, '');

  // 2. Try to extract peerKind from the segments
  const segments = stripped.split(':');
  for (let i = 0; i < segments.length; i++) {
    const kind = segments[i];
    if (kind in PEER_KIND_LABELS) {
      const peerId = segments.slice(i + 1).join(':') || stripped;
      const prefix = PEER_KIND_LABELS[kind];
      const display = `${prefix}${peerId}`;
      return display.length > 20 ? display.slice(0, 20) : display;
    }
  }

  // 3. Fallback: no recognized peerKind, use the stripped value as-is
  return stripped.length > 20 ? stripped.slice(-20) : stripped;
}

export interface ChannelSessionSyncDeps {
  coworkStore: CoworkStore;
  imStore: IMStore;
  getDefaultCwd: (agentId?: string) => string;
  /** Optional synchronous lookup: jobId → human-readable name (for cron session titles). */
  resolveJobName?: (jobId: string) => string | null;
  /** Optional synchronous lookup: jobId → delivery routing (to suppress local
   *  cron sessions for jobs that announce into an IM conversation). */
  resolveJobDelivery?: (jobId: string) => ScheduledTaskJobDelivery | null;
}

export class OpenClawChannelSessionSync {
  private readonly coworkStore: CoworkStore;
  private readonly imStore: IMStore;
  private readonly getDefaultCwd: (agentId?: string) => string;
  private readonly resolveJobName: ((jobId: string) => string | null) | null;
  private readonly resolveJobDelivery: ((jobId: string) => ScheduledTaskJobDelivery | null) | null;

  /** In-memory cache: openclawSessionKey → local sessionId. */
  private readonly syncedSessionKeys = new Map<string, string>();

  /** Keys that have been tried and are not recognized — avoids repeated log noise. */
  private readonly rejectedKeys = new Set<string>();

  /**
   * Sessions created because the agent binding changed.
   * These should skip syncFullChannelHistory to avoid pulling old gateway messages
   * into the new session — only future incremental messages will appear.
   */
  private readonly agentChangedSessionIds = new Set<string>();

  constructor(deps: ChannelSessionSyncDeps) {
    this.coworkStore = deps.coworkStore;
    this.imStore = deps.imStore;
    this.getDefaultCwd = deps.getDefaultCwd;
    this.resolveJobName = deps.resolveJobName ?? null;
    this.resolveJobDelivery = deps.resolveJobDelivery ?? null;
  }

  private updateLocalSessionCwdIfNeeded(session: CoworkSession, agentId: string): void {
    const resolvedCwd = this.getDefaultCwd(agentId).trim();
    if (!resolvedCwd || session.cwd === resolvedCwd) {
      return;
    }

    const updateSession = (this.coworkStore as { updateSession?: CoworkStore['updateSession'] }).updateSession;
    if (!updateSession) {
      return;
    }

    updateSession.call(this.coworkStore, session.id, { cwd: resolvedCwd }, { touchUpdatedAt: false });
    console.debug(
      `[ChannelSessionSync] corrected local session ${session.id} cwd for agent ${agentId} to ${resolvedCwd}`,
    );
  }

  /**
   * Check if a gateway session key belongs to the agent currently bound to its platform.
   * When users switch agent bindings, the gateway retains old sessions under the previous
   * agentId. This method filters them out so only the current agent's sessions are processed.
   */
  isCurrentBindingKey(sessionKey: string): boolean {
    const parsed = parseChannelSessionKey(sessionKey);
    if (!parsed) return true; // Not a channel key — let other logic handle it
    const keyAgentId = extractAgentIdFromKey(sessionKey);
    if (!keyAgentId) return true; // Legacy key without agentId — allow
    const imSettings = this.imStore.getIMSettings();
    const accountId = extractAccountIdFromKey(sessionKey);
    const currentAgentId = resolveAgentBinding(
      imSettings.platformAgentBindings,
      parsed.platform,
      accountId,
    );
    return keyAgentId === currentAgentId;
  }

  /**
   * Whether the session was created due to an agent binding change.
   * Such sessions should skip full history sync — only future messages matter.
   */
  isAgentChangedSession(sessionId: string): boolean {
    return this.agentChangedSessionIds.has(sessionId);
  }

  /**
   * Try to resolve or create a local Cowork session for a channel-originated sessionKey.
   * Returns the local sessionId if the sessionKey belongs to a channel, or null if not.
   */
  resolveOrCreateSession(sessionKey: string): string | null {
    // 1. Skip LobsterAI-originated sessions
    if (isManagedSessionKey(sessionKey)) {
      console.log('[ChannelSessionSync] skipped: LobsterAI-originated session');
      return null;
    }

    // 2. Check in-memory cache
    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      return cached;
    }

    // 2b. Skip keys already known to be non-channel
    if (this.rejectedKeys.has(sessionKey)) {
      return null;
    }

    // 3. Parse channel info
    const parsed = parseChannelSessionKey(sessionKey);
    if (!parsed) {
      console.log('[ChannelSessionSync] parse failed: not a recognized channel key:', sessionKey);
      this.rejectedKeys.add(sessionKey);
      return null;
    }
    console.log(
      '[ChannelSessionSync] parsed: platform=',
      parsed.platform,
      'conversationId=',
      parsed.conversationId,
    );

    // 4. Check persistent mapping in im_session_mappings
    const existingMapping = this.imStore.getSessionMapping(parsed.conversationId, parsed.platform);
    console.log(
      '[ChannelSessionSync] existing mapping:',
      existingMapping
        ? `coworkSessionId=${existingMapping.coworkSessionId} agentId=${existingMapping.agentId}`
        : 'none',
    );
    if (existingMapping) {
      // Verify the Cowork session still exists
      const session = this.coworkStore.getSession(existingMapping.coworkSessionId);
      if (session) {
        // Check if the agent binding has changed since this mapping was created.
        // When platformAgentBindings changes, the mapping's agentId becomes stale.
        // Create a new session for the new agent and update the mapping.
        const imSettings = this.imStore.getIMSettings();
        const accountId = extractAccountIdFromKey(sessionKey);
        const currentAgentId = resolveAgentBinding(
          imSettings.platformAgentBindings,
          parsed.platform,
          accountId,
        );
        if (existingMapping.agentId !== currentAgentId) {
          console.log(
            '[ChannelSessionSync] agent binding changed:',
            existingMapping.agentId,
            '→',
            currentAgentId,
            '— creating new session',
          );
          const titlePrefix = getChannelTitlePrefix(parsed.platform);
          const title = `${titlePrefix} ${buildChannelDisplayName(parsed.conversationId)}`;
          const cwd = this.getDefaultCwd(currentAgentId);
          const newSession = this.coworkStore.createSession(
            title,
            cwd,
            '',
            'local',
            [],
            currentAgentId,
          );
          console.log('[ChannelSessionSync] created new session for agent change:', newSession.id);
          this.imStore.updateSessionMappingTarget(
            parsed.conversationId,
            parsed.platform,
            newSession.id,
            currentAgentId,
            sessionKey,
          );
          this.syncedSessionKeys.set(sessionKey, newSession.id);
          // Mark so pollChannelSessions skips full history sync for this session —
          // old gateway messages should not be pulled into the new session.
          this.agentChangedSessionIds.add(newSession.id);
          return newSession.id;
        }
        this.updateLocalSessionCwdIfNeeded(session, currentAgentId);
        console.log(
          '[ChannelSessionSync] existing cowork session found, reusing:',
          existingMapping.coworkSessionId,
        );
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        if (existingMapping.openClawSessionKey !== sessionKey) {
          this.imStore.updateSessionOpenClawSessionKey(parsed.conversationId, parsed.platform, sessionKey);
        }
        this.imStore.updateSessionLastActive(parsed.conversationId, parsed.platform);
        return existingMapping.coworkSessionId;
      }
      // Session was deleted, remove stale mapping
      console.log('[ChannelSessionSync] cowork session deleted, removing stale mapping');
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    // 5. Create new Cowork session
    const titlePrefix = getChannelTitlePrefix(parsed.platform);
    const title = `${titlePrefix} ${buildChannelDisplayName(parsed.conversationId)}`;
    // Look up the per-platform agent binding so the session is filed under the correct agent.
    const imSettings = this.imStore.getIMSettings();
    const accountId = extractAccountIdFromKey(sessionKey);
    const agentId = resolveAgentBinding(imSettings.platformAgentBindings, parsed.platform, accountId);
    const cwd = this.getDefaultCwd(agentId);
    console.log(
      '[ChannelSessionSync] creating new cowork session: title=',
      title,
      'cwd=',
      cwd,
      'agentId=',
      agentId,
    );

    const session = this.coworkStore.createSession(title, cwd, '', 'local', [], agentId);
    console.log(
      `[ChannelSessionSync] Created session for ${parsed.platform} conversation ${parsed.conversationId}: ${session.id}`,
    );

    // 6. Persist mapping
    this.imStore.createSessionMapping(parsed.conversationId, parsed.platform, session.id, agentId, sessionKey);
    console.log(
      '[ChannelSessionSync] persisted mapping: conversationId=',
      parsed.conversationId,
      '→ sessionId=',
      session.id,
    );

    // 7. Cache
    this.syncedSessionKeys.set(sessionKey, session.id);

    return session.id;
  }

  /**
   * Try to resolve (but NOT create) a local Cowork session for a channel sessionKey.
   * Used by polling to avoid creating empty sessions when no new messages have arrived.
   * Returns the local sessionId if found, or null if not mapped.
   */
  resolveSession(sessionKey: string): string | null {
    if (isManagedSessionKey(sessionKey)) return null;

    // Check in-memory cache
    const cronKey = parseCronSessionKey(sessionKey);
    const cached = this.syncedSessionKeys.get(cronKey?.cacheKey ?? sessionKey)
      ?? this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      this.syncedSessionKeys.set(sessionKey, cached);
      return cached;
    }

    if (this.rejectedKeys.has(sessionKey)) return null;

    // Parse channel info
    const parsed = parseChannelSessionKey(sessionKey);
    if (!parsed) {
      this.rejectedKeys.add(sessionKey);
      return null;
    }

    // Check persistent mapping
    const existingMapping = this.imStore.getSessionMapping(parsed.conversationId, parsed.platform);
    if (existingMapping) {
      const session = this.coworkStore.getSession(existingMapping.coworkSessionId);
      if (session) {
        this.updateLocalSessionCwdIfNeeded(session, existingMapping.agentId);
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        if (existingMapping.openClawSessionKey !== sessionKey) {
          this.imStore.updateSessionOpenClawSessionKey(parsed.conversationId, parsed.platform, sessionKey);
        }
        return existingMapping.coworkSessionId;
      }
      // Stale mapping, clean up
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    return null;
  }

  /**
   * Resolve the local conversation record for a channel delivery target
   * (e.g. a cron announce that just went out to `channel` + `to`).
   * Matches the peer id case-insensitively because conversation ids derive
   * from lowercased session keys while delivery targets keep native casing.
   * Returns null when no mapping with a usable OpenClaw session key exists.
   */
  resolveConversationByDeliveryTarget(
    channel: string,
    to: string,
    accountId?: string,
  ): { sessionId: string; sessionKey: string } | null {
    const platform = PlatformRegistry.platformOfChannel(channel);
    if (!platform) return null;
    const peer = parseImConversationId(to).peerId.trim().toLowerCase();
    if (!peer) return null;

    // Mappings are sorted by lastActiveAt DESC; the first match wins.
    for (const mapping of this.imStore.listSessionMappings(platform)) {
      const parsed = parseImConversationId(mapping.imConversationId);
      if (parsed.peerId.trim().toLowerCase() !== peer) continue;
      if (accountId && parsed.accountId && parsed.accountId !== accountId) continue;
      const sessionKey = mapping.openClawSessionKey?.trim();
      if (!sessionKey) continue;
      if (!this.coworkStore.getSession(mapping.coworkSessionId)) continue;
      return { sessionId: mapping.coworkSessionId, sessionKey };
    }
    return null;
  }

  getOpenClawSessionKeyForCoworkSession(sessionId: string): {
    isChannelSession: boolean;
    sessionKey: string | null;
  } {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return { isChannelSession: false, sessionKey: null };
    }

    const mapping = this.imStore.getSessionMappingByCoworkSessionId(normalizedSessionId);
    if (!mapping) {
      return { isChannelSession: false, sessionKey: null };
    }

    const sessionKey = mapping.openClawSessionKey?.trim() || null;
    return { isChannelSession: true, sessionKey };
  }

  /** Check whether a sessionKey belongs to a recognized channel, main agent, or cron session. */
  isChannelSessionKey(sessionKey: string): boolean {
    if (!sessionKey || isManagedSessionKey(sessionKey)) return false;
    if (parseChannelSessionKey(sessionKey) !== null) return true;
    if (MAIN_AGENT_SESSION_RE.test(sessionKey)) return true;
    if (isCronSessionKey(sessionKey)) return true;
    return false;
  }

  /**
   * Resolve or create a local Cowork session for the OpenClaw main agent session
   * (e.g. "agent:main:main"). This handles events that flow through the main session
   * rather than per-channel sessions.
   */
  resolveOrCreateMainAgentSession(sessionKey: string): string | null {
    if (isManagedSessionKey(sessionKey)) return null;
    if (!MAIN_AGENT_SESSION_RE.test(sessionKey)) return null;

    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      return cached;
    }

    const cwd = this.getDefaultCwd('main');
    console.log('[ChannelSessionSync] creating main agent session: key=', sessionKey, 'cwd=', cwd);
    const session = this.coworkStore.createSession('[OpenClaw]', cwd, '', 'local');
    console.log('[ChannelSessionSync] created main agent session:', session.id);

    this.syncedSessionKeys.set(sessionKey, session.id);
    return session.id;
  }

  /**
   * Resolve or create a local Cowork session for an OpenClaw cron-isolated session key.
   * Supported formats:
   *   - "cron:{jobId}"
   *   - "agent:{agentId}:cron:{jobId}"
   *   - "agent:{agentId}:cron:{jobId}:run:{runId}"
   * Each cron job gets one persistent local session that is reused across runs,
   * keeping the full run history in a single conversation.
   */
  resolveOrCreateCronSession(sessionKey: string): string | null {
    const cronKey = parseCronSessionKey(sessionKey);
    if (!cronKey) return null;

    // Jobs that announce their result into an IM conversation don't get a
    // local "[定时]" session: the delivered message lands in the IM
    // conversation record, and a per-job session here would duplicate it.
    // Run transcripts stay accessible from the scheduled-task run history.
    const delivery = this.resolveJobDelivery?.(cronKey.jobId) ?? null;
    if (
      delivery?.mode === ScheduledTaskDeliveryMode.Announce &&
      delivery.channel &&
      PlatformRegistry.isIMChannel(delivery.channel)
    ) {
      return null;
    }

    const cached = this.syncedSessionKeys.get(cronKey.cacheKey)
      ?? this.syncedSessionKeys.get(sessionKey);
    if (cached) {
      this.syncedSessionKeys.set(sessionKey, cached);
      return cached;
    }

    const jobId = cronKey.jobId;
    // Prefer the human-readable job name for the session title; fall back to a short UUID prefix.
    const jobName = this.resolveJobName?.(jobId) ?? null;
    const cronLabel = t('cronSessionPrefix');
    const title = jobName
      ? `[${cronLabel}] ${jobName}`
      : `[${cronLabel}] ${jobId.length > 8 ? jobId.slice(0, 8) : jobId}`;
    const agentId = cronKey.agentId || 'main';
    const cwd = this.getDefaultCwd(agentId);
    console.log(
      '[ChannelSessionSync] creating cron session: key=',
      sessionKey,
      'title=',
      title,
      'cwd=',
      cwd,
    );
    const session = this.coworkStore.createSession(title, cwd, '', 'local', [], agentId);
    console.log('[ChannelSessionSync] created cron session:', session.id);

    this.syncedSessionKeys.set(cronKey.cacheKey, session.id);
    this.syncedSessionKeys.set(sessionKey, session.id);
    return session.id;
  }
  clearCache(): void {
    this.syncedSessionKeys.clear();
    this.rejectedKeys.clear();
  }

  /**
   * Purge in-memory cache entries for a deleted session so that
   * new messages with the same sessionKey can create a fresh session.
   */
  onSessionDeleted(sessionId: string): void {
    for (const [key, id] of this.syncedSessionKeys.entries()) {
      if (id === sessionId) {
        this.syncedSessionKeys.delete(key);
        // Also remove from rejectedKeys in case it was previously rejected,
        // so that re-discovery can succeed.
        this.rejectedKeys.delete(key);
      }
    }
  }
}
