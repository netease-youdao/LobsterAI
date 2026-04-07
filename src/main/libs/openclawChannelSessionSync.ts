/**
 * OpenClaw Channel Session Sync
 *
 * Discovers and maps sessions created by OpenClaw channel extensions (e.g. Telegram)
 * to local Cowork sessions so that conversations are visible in the LobsterAI UI.
 */

import type { CoworkStore } from '../coworkStore';
import type { IMStore } from '../im/imStore';
import type { Platform } from '../im/types';
import { PlatformRegistry } from '../../shared/platform';
import { t } from '../i18n';
import { session } from '@electron/remote';


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

export function parseManagedSessionKey(sessionKey: string | undefined | null): ManagedSessionKey | null {
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
export function parseChannelSessionKey(sessionKey: string): { platform: Platform; conversationId: string } | null {
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

const MULTI_INSTANCE_PLATFORMS = new Set<Platform>(['dingtalk', 'feishu', 'qq']);

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
        if (instanceId.startsWith(accountId)) {
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
 * Two formats:
 *   - "cron:{jobId}"                    — when agentId is not set on the job
 *   - "agent:{agentId}:cron:{jobId}"    — when agentId is set on the job
 */
const CRON_SESSION_KEY_RE = /^(?:agent:[^:]+:)?cron:[0-9a-f-]+$/i;

export function isCronSessionKey(sessionKey: string): boolean {
  return CRON_SESSION_KEY_RE.test(sessionKey);
}

/** Extract the jobId from a cron session key (either format). */
function extractCronJobId(sessionKey: string): string {
  const idx = sessionKey.lastIndexOf('cron:');
  return idx >= 0 ? sessionKey.slice(idx + 'cron:'.length) : sessionKey;
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
  };
  const label = i18nMap[platform] ?? staticMap[platform] ?? platform;
  return `[${label}]`;
}

export interface ChannelSessionSyncDeps {
  coworkStore: CoworkStore;
  imStore: IMStore;
  getDefaultCwd: () => string;
  /** Optional synchronous lookup: jobId → human-readable name (for cron session titles). */
  resolveJobName?: (jobId: string) => string | null;
}

export class OpenClawChannelSessionSync {
  private readonly coworkStore: CoworkStore;
  private readonly imStore: IMStore;
  private readonly getDefaultCwd: () => string;
  private readonly resolveJobName: ((jobId: string) => string | null) | null;

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
    const currentAgentId = resolveAgentBinding(imSettings.platformAgentBindings, parsed.platform, accountId);
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
    console.log('[ChannelSessionSync] parsed: platform=', parsed.platform, 'conversationId=', parsed.conversationId);

    // 4. Check persistent mapping in im_session_mappings
    const existingMapping = this.imStore.getSessionMapping(parsed.conversationId, parsed.platform);
    console.log('[ChannelSessionSync] existing mapping:', existingMapping ? `coworkSessionId=${existingMapping.coworkSessionId} agentId=${existingMapping.agentId}` : 'none');
    if (existingMapping) {
      // Verify the Cowork session still exists
      const session = this.coworkStore.getSession(existingMapping.coworkSessionId);
      if (session) {
        // Check if the agent binding has changed since this mapping was created.
        // When platformAgentBindings changes, the mapping's agentId becomes stale.
        // Create a new session for the new agent and update the mapping.
        const imSettings = this.imStore.getIMSettings();
        const accountId = extractAccountIdFromKey(sessionKey);
        const currentAgentId = resolveAgentBinding(imSettings.platformAgentBindings, parsed.platform, accountId);
        if (existingMapping.agentId !== currentAgentId) {
          console.log('[ChannelSessionSync] agent binding changed:', existingMapping.agentId, '→', currentAgentId, '— creating new session');
          const titlePrefix = getChannelTitlePrefix(parsed.platform);
          const displayId = parsed.conversationId.includes('@')
            ? parsed.conversationId.split('@')[0]
            : parsed.conversationId;
          const shortId = displayId.length > 12 ? displayId.slice(-12) : displayId;
          const title = `${titlePrefix} ${shortId}`;
          const cwd = this.getDefaultCwd();
          const newSession = this.coworkStore.createSession(title, cwd, '', 'local', [], currentAgentId);
          console.log('[ChannelSessionSync] created new session for agent change:', newSession.id);
          this.imStore.updateSessionMappingTarget(parsed.conversationId, parsed.platform, newSession.id, currentAgentId);
          this.syncedSessionKeys.set(sessionKey, newSession.id);
          // Mark so pollChannelSessions skips full history sync for this session —
          // old gateway messages should not be pulled into the new session.
          this.agentChangedSessionIds.add(newSession.id);
          return newSession.id;
        }
        console.log('[ChannelSessionSync] existing cowork session found, reusing:', existingMapping.coworkSessionId);
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        this.imStore.updateSessionLastActive(parsed.conversationId, parsed.platform);
        return existingMapping.coworkSessionId;
      }
      // Session was deleted, remove stale mapping
      console.log('[ChannelSessionSync] cowork session deleted, removing stale mapping');
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    // 5. Create new Cowork session
    const titlePrefix = getChannelTitlePrefix(parsed.platform);
    // For conversationIds that look like email addresses (e.g. POPO),
    // use the local part before '@' as the display name.
    const displayId = parsed.conversationId.includes('@')
      ? parsed.conversationId.split('@')[0]
      : parsed.conversationId;
    const shortId = displayId.length > 12
      ? displayId.slice(-12)
      : displayId;
    const title = `${titlePrefix} ${shortId}`;
    const cwd = this.getDefaultCwd();
    // Look up the per-platform agent binding so the session is filed under the correct agent.
    const imSettings = this.imStore.getIMSettings();
    const accountId = extractAccountIdFromKey(sessionKey);
    const agentId = resolveAgentBinding(imSettings.platformAgentBindings, parsed.platform, accountId);
    console.log('[ChannelSessionSync] creating new cowork session: title=', title, 'cwd=', cwd, 'agentId=', agentId);

    const session = this.coworkStore.createSession(title, cwd, '', 'local', [], agentId);
    console.log(
      `[ChannelSessionSync] Created session for ${parsed.platform} conversation ${parsed.conversationId}: ${session.id}`,
    );

    // 6. Persist mapping
    this.imStore.createSessionMapping(parsed.conversationId, parsed.platform, session.id, agentId);
    console.log('[ChannelSessionSync] persisted mapping: conversationId=', parsed.conversationId, '→ sessionId=', session.id);

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
    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) return cached;

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
        this.syncedSessionKeys.set(sessionKey, existingMapping.coworkSessionId);
        return existingMapping.coworkSessionId;
      }
      // Stale mapping, clean up
      this.imStore.deleteSessionMapping(parsed.conversationId, parsed.platform);
    }

    return null;
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

    const cwd = this.getDefaultCwd();
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
   * Each cron job gets one persistent local session that is reused across runs,
   * keeping the full run history in a single conversation.
   */
  resolveOrCreateCronSession(sessionKey: string): string | null {
    if (!isCronSessionKey(sessionKey)) return null;

    const cached = this.syncedSessionKeys.get(sessionKey);
    if (cached) return cached;

    const jobId = extractCronJobId(sessionKey);
    // Prefer the human-readable job name for the session title; fall back to a short UUID prefix.
    const jobName = this.resolveJobName?.(jobId) ?? null;
    const cronLabel = t('cronSessionPrefix');
    const title = jobName ? `[${cronLabel}] ${jobName}` : `[${cronLabel}] ${jobId.length > 8 ? jobId.slice(0, 8) : jobId}`;
    const cwd = this.getDefaultCwd();
    console.log('[ChannelSessionSync] creating cron session: key=', sessionKey, 'title=', title, 'cwd=', cwd);
    const session = this.coworkStore.createSession(title, cwd, '', 'local');
    console.log('[ChannelSessionSync] created cron session:', session.id);

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
