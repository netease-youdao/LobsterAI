import { PlatformRegistry } from '../platform';

export const WeixinPlugin = {
  Id: 'openclaw-weixin',
  LoginStart: 'web.login.start',
  LoginWait: 'web.login.wait',
} as const;

export const WEIXIN_QR_ACTIVATION_TIMEOUT_MS = 10 * 60_000;

export const WeixinQrLoginTimeout = {
  Start: 5 * 60_000,
  Wait: 8 * 60_000,
  RpcGrace: 10_000,
} as const;

/** Stable, redacted diagnostics emitted by the pinned Weixin plugin patch. */
export const WeixinDeliveryError = {
  Rejected: 'WEIXIN_SEND_REJECTED',
  ContextExpired: 'WEIXIN_CONTEXT_EXPIRED',
  AccountExpired: 'WEIXIN_ACCOUNT_EXPIRED',
  InvalidResponse: 'WEIXIN_SEND_INVALID_RESPONSE',
  HttpError: 'WEIXIN_SEND_HTTP_ERROR',
  Unknown: 'WEIXIN_SEND_UNCONFIRMED',
  ReportUnavailable: 'WEIXIN_REPORT_UNAVAILABLE',
} as const;

export function sanitizeWeixinDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bWEIXIN_[A-Z_]+(?: (?:ret|errcode|status)=-?\d+)*/);
  if (!match || !Object.values(WeixinDeliveryError).some(code => match[0].split(' ')[0] === code)) {
    return WeixinDeliveryError.Unknown;
  }
  return match[0];
}

/**
 * `sendmessage` business code Weixin returns once the conversation context
 * expired or the conversation hit its proactive-message cap.
 */
export const WEIXIN_SEND_CONTEXT_REJECTED_RET = -2;

/** Extracts the numeric `ret=` code from a sanitized Weixin delivery error. */
export function parseWeixinDeliveryRet(error: string): number | null {
  const match = error.match(/\bret=(-?\d+)\b/);
  return match ? Number(match[1]) : null;
}

/**
 * True when Weixin rejected a send because the user has not messaged the bot
 * recently (a community-observed window of roughly 24 hours) or the
 * conversation exhausted its proactive-message quota. Both recover only after
 * the user messages the bot again.
 */
export function isWeixinContextRejected(error: string): boolean {
  return error.startsWith(WeixinDeliveryError.Rejected)
    && parseWeixinDeliveryRet(error) === WEIXIN_SEND_CONTEXT_REJECTED_RET;
}

/** True for the Weixin channel id or its platform id. */
export function isWeixinChannel(channel: string | null | undefined): boolean {
  const value = channel?.trim();
  if (!value) return false;
  return value === WeixinPlugin.Id || value === PlatformRegistry.platformOfChannel(WeixinPlugin.Id);
}
