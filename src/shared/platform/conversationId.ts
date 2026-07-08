/**
 * IM conversation ID parsing shared by main and renderer.
 *
 * Conversation IDs persisted in `im_session_mappings` derive from OpenClaw
 * session keys (see parseChannelSessionKey in openclawChannelSessionSync) and
 * come in three shapes:
 *   - "{peerKind}:{peerId}"                  e.g. "direct:alice@corp.example.com"
 *   - "{accountId}:{peerKind}:{peerId}"      e.g. "cebef798:direct:8368898190"
 *   - plain id                               e.g. "oc_a1b2c3" or "123456789"
 */

export const ImPeerKind = {
  Direct: 'direct',
  Group: 'group',
  Channel: 'channel',
} as const;
export type ImPeerKind = typeof ImPeerKind[keyof typeof ImPeerKind];

const PEER_KINDS = new Set<string>(Object.values(ImPeerKind));

export interface ParsedImConversationId {
  /** Bot account segment preceding the peer kind, when present. */
  accountId?: string;
  /** Recognized peer kind segment, when present. */
  peerKind?: ImPeerKind;
  /** Trailing peer identifier; the full input when no peer kind is found. */
  peerId: string;
}

/** Split a stored conversation ID into accountId / peerKind / peerId segments. */
export function parseImConversationId(conversationId: string): ParsedImConversationId {
  const raw = conversationId.trim();
  const segments = raw.split(':');
  for (let i = 0; i < segments.length - 1; i++) {
    if (PEER_KINDS.has(segments[i])) {
      const peerId = segments.slice(i + 1).join(':');
      if (!peerId) break;
      return {
        ...(i > 0 ? { accountId: segments.slice(0, i).join(':') } : {}),
        peerKind: segments[i] as ImPeerKind,
        peerId,
      };
    }
  }
  return { peerId: raw };
}

/**
 * Human-oriented rendering of a conversation ID: the peer identifier without
 * account prefix, peer-kind segment, or email-style domain suffix.
 * Falls back to the trimmed input when nothing recognizable is left.
 */
export function imConversationDisplayName(conversationId: string): string {
  const { peerId } = parseImConversationId(conversationId);
  const stripped = peerId.replace(/@[^:]+/g, '');
  return stripped || peerId || conversationId.trim();
}
