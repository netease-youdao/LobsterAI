type ConversationSearchLogLevel = 'debug' | 'warn';
const LOG_CLASSIFICATION_INPUT_LIMIT = 256;

const ConversationSearchLogEventCategory = {
  Highlight: 'highlight',
  Settle: 'settle',
  TargetWindow: 'target-window',
  Navigation: 'navigation',
  History: 'history',
  Lifecycle: 'lifecycle',
  Matching: 'matching',
  Other: 'other',
} as const;

type ConversationSearchLogEventCategory =
  typeof ConversationSearchLogEventCategory[keyof typeof ConversationSearchLogEventCategory];

const ConversationSearchErrorCategory = {
  Aborted: 'aborted',
  Timeout: 'timeout',
  Permission: 'permission',
  Network: 'network',
  Ipc: 'ipc',
  InvalidData: 'invalid-data',
  Unknown: 'unknown',
} as const;

type ConversationSearchErrorCategory =
  typeof ConversationSearchErrorCategory[keyof typeof ConversationSearchErrorCategory];

const getEventCategory = (message: string): ConversationSearchLogEventCategory => {
  const normalized = message.slice(0, LOG_CLASSIFICATION_INPUT_LIMIT).toLowerCase();
  if (normalized.includes('highlight')) return ConversationSearchLogEventCategory.Highlight;
  if (normalized.includes('settle') || normalized.includes('geometry')) {
    return ConversationSearchLogEventCategory.Settle;
  }
  if (normalized.includes('window')) return ConversationSearchLogEventCategory.TargetWindow;
  if (
    normalized.includes('navigation')
    || normalized.includes('fallback')
    || normalized.includes('target')
    || normalized.includes('conversation turn')
  ) {
    return ConversationSearchLogEventCategory.Navigation;
  }
  if (normalized.includes('history')) return ConversationSearchLogEventCategory.History;
  if (
    normalized.includes('opening')
    || normalized.includes('closing')
    || normalized.includes('resetting')
  ) {
    return ConversationSearchLogEventCategory.Lifecycle;
  }
  if (normalized.includes('search') || normalized.includes('result limit')) {
    return ConversationSearchLogEventCategory.Matching;
  }
  return ConversationSearchLogEventCategory.Other;
};

const readErrorField = (error: unknown, field: 'message' | 'name'): string => {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return '';
  try {
    const value = (error as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
};

const getSafeErrorType = (error: unknown): string => {
  const name = readErrorField(error, 'name');
  switch (name) {
    case 'AbortError':
    case 'AggregateError':
    case 'DOMException':
    case 'Error':
    case 'RangeError':
    case 'ReferenceError':
    case 'SyntaxError':
    case 'TimeoutError':
    case 'TypeError':
      return name;
    default:
      break;
  }

  if (error === null) return 'null';
  switch (typeof error) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'undefined':
      return typeof error;
    case 'object':
    case 'function':
      return 'object';
    default:
      return 'unknown';
  }
};

const getErrorCategory = (error: unknown): ConversationSearchErrorCategory => {
  const searchable = [
    typeof error === 'string' ? error.slice(0, LOG_CLASSIFICATION_INPUT_LIMIT) : '',
    readErrorField(error, 'name').slice(0, LOG_CLASSIFICATION_INPUT_LIMIT),
    readErrorField(error, 'message').slice(0, LOG_CLASSIFICATION_INPUT_LIMIT),
  ].join(' ').toLowerCase();

  if (/\babort(?:ed)?\b|\bcancel(?:led|ed|lation)?\b/.test(searchable)) {
    return ConversationSearchErrorCategory.Aborted;
  }
  if (/\btimeout\b|\btimed out\b/.test(searchable)) {
    return ConversationSearchErrorCategory.Timeout;
  }
  if (/\bpermission\b|\bdenied\b|\bforbidden\b|\bunauthori[sz]ed\b|\bnot allowed\b/.test(searchable)) {
    return ConversationSearchErrorCategory.Permission;
  }
  if (/\bnetwork\b|\bfetch\b|\boffline\b|\bsocket\b|\beconn\w*\b|\benotfound\b|\bdns\b/.test(searchable)) {
    return ConversationSearchErrorCategory.Network;
  }
  if (/\bipc\b|\bmessage port\b|\bchannel closed\b|\bmain process\b/.test(searchable)) {
    return ConversationSearchErrorCategory.Ipc;
  }
  if (/\bparse\b|\bmalformed\b|\binvalid\b|\bserialize\b|\bclone\b|\bjson\b|\brange\b/.test(searchable)) {
    return ConversationSearchErrorCategory.InvalidData;
  }
  return ConversationSearchErrorCategory.Unknown;
};

const getSafeLogMessage = (message: string, error?: unknown): string => {
  const fields = [`eventCategory=${getEventCategory(message)}`];
  if (error !== undefined) {
    fields.push(`errorType=${getSafeErrorType(error)}`);
    fields.push(`errorCategory=${getErrorCategory(error)}`);
  }
  return fields.join('; ');
};

const persistConversationSearchLog = (
  level: ConversationSearchLogLevel,
  message: string,
): void => {
  try {
    window.electron?.log?.fromRenderer?.(level, 'ConversationSearch', message);
  } catch {
    // Renderer logging is best-effort and must never affect search behavior.
  }
};

export const logConversationSearchDebug = (message: string): void => {
  const safeMessage = getSafeLogMessage(message);
  console.debug(`[ConversationSearch] ${safeMessage}`);
  persistConversationSearchLog('debug', safeMessage);
};

export const logConversationSearchWarning = (
  message: string,
  error?: unknown,
): void => {
  const safeMessage = getSafeLogMessage(message, error);
  console.warn(`[ConversationSearch] ${safeMessage}`);
  persistConversationSearchLog('warn', safeMessage);
};
