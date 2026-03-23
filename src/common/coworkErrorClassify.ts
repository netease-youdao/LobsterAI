/**
 * Shared error classification rules for cowork API errors.
 * Used by both renderer (UI) and main process (IM replies).
 */

const ERROR_RULES: Array<[RegExp, string]> = [
  // Auth: Anthropic, DeepSeek, OpenAI, Gemini, HTTP 401
  [/authentication[_ ](error|fails?)|api[_ ]key.*(invalid|expired|not[_ ]valid)|invalid.*api.*key|incorrect.*api.*key|unauthorized|PERMISSION_DENIED|\b401\b/i, 'coworkErrorAuthInvalid'],
  // Rate limit: HTTP 429, Anthropic/DeepSeek overloaded, Gemini RESOURCE_EXHAUSTED
  // (must precede billing so "RESOURCE_EXHAUSTED: quota exceeded" maps to rate-limit)
  [/\b429\b|rate[_ ]limit|too many requests|overloaded|RESOURCE_EXHAUSTED/i, 'coworkErrorRateLimit'],
  // Billing: DeepSeek 402, OpenAI, OpenRouter, Qwen, StepFun
  [/insufficient.*(balance|quota|credits)|billing|quota[_ ]exceeded|Arrearage|account.*not.*in.*good.*standing|余额不足|\b402\b/i, 'coworkErrorInsufficientBalance'],
  // Input too long: context length, HTTP 413, Qwen, payload too large
  [/input.*too.*long|context.*length.*exceeded|range of input length|\b413\b|payload.*too.*large|request.*entity.*too.*large|max[_ ]tokens/i, 'coworkErrorInputTooLong'],
  // PDF processing failure
  [/could not process pdf/i, 'coworkErrorCouldNotProcessPdf'],
  // Model not found: standard, Qwen, Ollama
  [/model.*not.*(found|exist)/i, 'coworkErrorModelNotFound'],
  // Gateway / connection issues
  [/gateway.*disconnect|client disconnected/i, 'coworkErrorGatewayDisconnected'],
  [/service restart/i, 'coworkErrorServiceRestart'],
  [/gateway.*draining|draining.*restart/i, 'coworkErrorGatewayDraining'],
  // Content moderation: Qwen, StepFun 451, generic
  [/DataInspectionFailed|content.*(review|filter)|审核未通过|未通过.*审核|inappropriate.*content|\b451\b|flagged.*input/i, 'coworkErrorContentFiltered'],
  // Network errors
  [/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|could not connect|connection.*refused|network.*error/i, 'coworkErrorNetworkError'],
  // Server errors: HTTP 500/502/503
  [/internal.server.error|bad.gateway|service.unavailable|\b50[023]\b/i, 'coworkErrorServerError'],
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
