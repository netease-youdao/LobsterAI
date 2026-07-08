/**
 * Shared error classification rules for cowork API errors.
 * Used by both renderer (UI) and main process (IM replies).
 */

export const CoworkErrorI18nKey = {
  AuthInvalid: 'coworkErrorAuthInvalid',
  OAuthInvalid: 'coworkErrorOAuthInvalid',
  ModelAccessDenied: 'coworkErrorModelAccessDenied',
  QuotaExhausted: 'coworkErrorQuotaExhausted',
  FreeQuotaExhausted: 'coworkErrorFreeQuotaExhausted',
  InsufficientBalance: 'coworkErrorInsufficientBalance',
  RateLimit: 'coworkErrorRateLimit',
  NetworkError: 'coworkErrorNetworkError',
  ServerError: 'coworkErrorServerError',
} as const;

const LOBSTERAI_QUOTA_EXHAUSTED_PATTERN =
  /\b4020[0-2]\b|(?:今日)?免费额度.*(用完|耗尽)|本月积分.*(用完|耗尽)|积分额度.*(用完|耗尽)|free.*quota.*(exhausted|used up|limit)|monthly.*credits?.*(exhausted|used up|limit)/i;

const API_KEY_PATTERN = String.raw`(?:api\s*key|api[_-]?key|apikey)`;
const UNAVAILABLE_NETWORK_CODE_PATTERN = String.raw`(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+)`;

const ERROR_RULES: Array<[RegExp, string]> = [
  // OAuth / token refresh failures. Must precede generic auth handling.
  [/oauth.*(invalid|expired|failed|error|scope|token|callback|authorization|not completed)|auth[_ ]refresh|refresh[_ ]timeout|callback[_ ](timeout|validation)|token.*(expired|invalid)|invalid.*token|authorization method/i, CoworkErrorI18nKey.OAuthInvalid],
  // Provider/model permission errors. Must precede generic auth handling.
  [/无权访问|没有权限|access denied|access.*forbidden|forbidden|permission denied|\b403\b|auth[_ ]scope/i, CoworkErrorI18nKey.ModelAccessDenied],
  // Auth: Anthropic, DeepSeek, OpenAI, Gemini, HTTP 401
  [new RegExp(`authentication[_ ](error|fails?)|${API_KEY_PATTERN}.*(invalid|expired|deleted|inactive|not[_ ]valid|not\\s+valid)|invalid.*${API_KEY_PATTERN}|incorrect.*${API_KEY_PATTERN}|unauthorized|PERMISSION_DENIED|\\b401\\b`, 'i'), CoworkErrorI18nKey.AuthInvalid],
  // LobsterAI plan/free quota. Must precede generic 402/billing handling.
  [LOBSTERAI_QUOTA_EXHAUSTED_PATTERN, CoworkErrorI18nKey.QuotaExhausted],
  // Rate limit: HTTP 429, Anthropic/DeepSeek overloaded, Gemini RESOURCE_EXHAUSTED
  // (must precede billing so "RESOURCE_EXHAUSTED: quota exceeded" maps to rate-limit)
  [/\b429\b|rate[_ ]limit|too many requests|overloaded|RESOURCE_EXHAUSTED/i, CoworkErrorI18nKey.RateLimit],
  // Billing: DeepSeek 402, OpenAI, OpenRouter, Qwen, StepFun
  [/insufficient.*(balance|quota|credits)|billing|quota[_ ]exceeded|Arrearage|account.*not.*in.*good.*standing|余额不足|\b402\b/i, CoworkErrorI18nKey.InsufficientBalance],
  // Oversized Cowork/OpenClaw gateway message payloads.
  [/chat\.send payload too large|max payload size exceeded|gateway closed \(1009\)|message too big/i, 'coworkErrorMessageTooLarge'],
  // Input too long: context length, HTTP 413, Qwen, payload too large
  [/input.*too.*long|context.*length.*exceeded|range of input length|\b413\b|payload.*too.*large|request.*entity.*too.*large|max[_ ]tokens/i, 'coworkErrorInputTooLong'],
  // PDF processing failure
  [/could not process pdf/i, 'coworkErrorCouldNotProcessPdf'],
  // Model not found: standard, Qwen, Ollama
  [/model.*not.*(found|exist)/i, 'coworkErrorModelNotFound'],
  // Gateway / connection issues
  [/gateway request timeout for sessions\.patch/i, 'coworkGatewaySessionSyncTimeout'],
  [/gateway.*disconnect|client disconnected/i, 'coworkErrorGatewayDisconnected'],
  [/service restart/i, 'coworkErrorServiceRestart'],
  [/gateway.*draining|draining.*restart/i, 'coworkErrorGatewayDraining'],
  // Content moderation: Qwen, StepFun 451, generic
  [/DataInspectionFailed|content.*(review|filter)|审核未通过|未通过.*审核|inappropriate.*content|\b451\b|flagged.*input/i, 'coworkErrorContentFiltered'],
  // Network errors
  [new RegExp(`${UNAVAILABLE_NETWORK_CODE_PATTERN}|fetch failed|ConnectTimeoutError|network request failed|socket (?:hang up|closed|reset)|connection.*(?:refused|reset|aborted|closed|timeout|timed out)|could not connect|network.*error|request.*timed out`, 'i'), CoworkErrorI18nKey.NetworkError],
  // Server errors: HTTP 500/502/503
  [/internal.server.error|bad.gateway|service.unavailable|\b50[023]\b/i, CoworkErrorI18nKey.ServerError],
  // Unknown / unclassified errors from upstream (OpenClaw wraps unrecognized errors)
  [/unknown error|an unknown error occurred/i, 'coworkErrorUnknown'],
];

/**
 * Classify an error string and return the matching i18n key.
 * Returns null if no rule matches (caller should fall back to the original error).
 */
export function classifyErrorKey(error: string): string | null {
  for (const [pattern, key] of ERROR_RULES) {
    if (pattern.test(error)) return key;
  }
  return null;
}

export function isLobsterAIQuotaExhaustedError(error: string): boolean {
  return LOBSTERAI_QUOTA_EXHAUSTED_PATTERN.test(error);
}
