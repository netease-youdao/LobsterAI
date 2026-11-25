// Pure helpers for resolving human-friendly IM session titles and detecting
// legacy opaque WeChat iLink peer IDs (e.g. `o9cq809ZEC25-...@im.wechat`).

const OPAQUE_WEIXIN_DOMAIN_PEER_RE =
  /^(?:(?:direct|user|私聊):)?[a-z0-9_-]{8,}@im(?:\.wechat|\.(?:w(?:e(?:c(?:h(?:a(?:t)?)?)?)?)?)?)?$/i;

const OPAQUE_WEIXIN_OPENCLAW_PEER_RE =
  /^(?:(?:direct|user|私聊):)?o9cq[a-z0-9_-]{10,}$/i;

const WEIXIN_PEER_PREFIX_RE = /^(?:direct|user|私聊):/i;

export interface BuildWeixinSessionLabelParams {
  chatId: string;
  senderId?: string;
  senderName?: string;
  ownerUserId?: string;
  ownerLabel: string;
  contactLabelPrefix: string;
}

/**
 * Returns true when `value` looks like an opaque WeChat iLink user identifier
 * (including 32-character truncated variants such as `o9cq809...@im.` and
 * legacy OpenClaw stripped variants such as `私聊:o9cq809...`).
 */
export function isOpaqueWeixinPeerId(value: string | null | undefined): boolean {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return false;
  return (
    OPAQUE_WEIXIN_DOMAIN_PEER_RE.test(trimmed)
    || OPAQUE_WEIXIN_OPENCLAW_PEER_RE.test(trimmed)
  );
}

/**
 * Extract a short 4-character alphanumeric suffix from an opaque WeChat peer ID
 * so non-owner contacts can be distinguished without displaying raw 32-char IDs.
 */
export function extractWeixinPeerShortSuffix(peerId: string): string {
  const withoutPrefix = peerId.trim().replace(WEIXIN_PEER_PREFIX_RE, '');
  const localPart = withoutPrefix.split('@')[0] ?? '';
  const alnum = localPart.replace(/[^a-z0-9]/gi, '');
  if (!alnum) return '';
  return alnum.slice(-4);
}

/**
 * Build a human-readable label for a WeChat session:
 * 1. Explicit non-opaque `senderName` when available.
 * 2. `ownerLabel` (e.g. "我的微信" / "My WeChat") when the sender is the QR-scanned
 *    owner account or when no owner ID is recorded yet.
 * 3. `${contactLabelPrefix} · ${last4}` for distinct non-owner peers.
 */
export function buildWeixinSessionLabel(params: BuildWeixinSessionLabelParams): string {
  const trimmedName = params.senderName?.trim() ?? '';
  if (trimmedName && !isOpaqueWeixinPeerId(trimmedName)) {
    return trimmedName.slice(0, 32);
  }

  const normalizedOwner = params.ownerUserId?.trim().toLowerCase() ?? '';
  const normalizedSender = (params.senderId || params.chatId).trim().toLowerCase();
  const normalizedChat = params.chatId.trim().toLowerCase();

  if (!normalizedOwner || normalizedSender === normalizedOwner || normalizedChat === normalizedOwner) {
    return params.ownerLabel;
  }

  const suffix = extractWeixinPeerShortSuffix(params.senderId || params.chatId);
  return suffix ? `${params.contactLabelPrefix} · ${suffix}` : params.contactLabelPrefix;
}
