import { CoworkSystemMessageKind, ModelReconnectStatus } from '../../../common/coworkSystemMessages';
import type { CoworkMessageMetadata } from '../../coworkStore';
import { t } from '../../i18n';
import { ModelRetryPhase } from './constants';

/**
 * One `model_retry` agent event: the runtime resumes a model call whose stream
 * dropped before any visible output (zzz-openclaw-stream-drop-reconnect.patch).
 */
export type ModelRetryEvent = {
  phase: ModelRetryPhase;
  attempt: number;
  maxAttempts: number;
  delayMs?: number;
  error?: string;
  errorCode?: string;
};

/** Turn-scoped reconnect progress, persisted as one system message per drop. */
export type ModelReconnectState = {
  messageId: string | null;
  status: ModelReconnectStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: number;
  error?: string;
  errorCode?: string;
};

// Terminal copy the runtime surfaces when a dropped model call ends the turn:
// the incomplete-turn warning after tools ran, or the response timeout that a
// bare "terminated" stream error maps to.
const STREAM_DROP_TERMINAL_ERROR_PATTERNS = [
  /Agent couldn't generate a response/i,
  /LLM request timed out/i,
  /\bterminated\b/i,
];

const readPositiveInteger = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
);

const readText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

export function parseModelRetryEvent(data: unknown): ModelRetryEvent | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const phase = record.phase;
  if (phase !== ModelRetryPhase.Retrying && phase !== ModelRetryPhase.Exhausted) return null;
  const attempt = readPositiveInteger(record.attempt);
  const maxAttempts = readPositiveInteger(record.maxAttempts);
  if (attempt === null || maxAttempts === null) return null;
  const delayMs = typeof record.delayMs === 'number' && Number.isFinite(record.delayMs)
    ? Math.max(0, Math.round(record.delayMs))
    : undefined;
  const error = readText(record.error);
  const errorCode = readText(record.errorCode);
  return {
    phase,
    attempt,
    maxAttempts,
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(error ? { error } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

/**
 * Next reconnect state for a retry event. A retry after the row settled starts
 * a new drop, so it gets a fresh row.
 */
export function applyModelRetryEvent(
  current: ModelReconnectState | undefined,
  event: ModelRetryEvent,
  now: number,
): ModelReconnectState {
  const continuing = current?.status === ModelReconnectStatus.Retrying;
  return {
    messageId: continuing ? current.messageId : null,
    status: event.phase === ModelRetryPhase.Exhausted
      ? ModelReconnectStatus.Failed
      : ModelReconnectStatus.Retrying,
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    startedAt: continuing ? current.startedAt : now,
    ...(event.error ? { error: event.error } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
}

export function buildModelReconnectMetadata(
  state: ModelReconnectState,
  runId: string,
  now: number,
): CoworkMessageMetadata {
  return {
    kind: CoworkSystemMessageKind.ModelReconnect,
    status: state.status,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    runId,
    startedAt: state.startedAt,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    ...(state.status !== ModelReconnectStatus.Retrying ? { completedAt: now } : {}),
  };
}

/** Persisted fallback text; the renderer labels the row from its metadata. */
export function getModelReconnectContent(state: ModelReconnectState): string {
  switch (state.status) {
    case ModelReconnectStatus.Recovered:
      return 'Reconnected after the model connection dropped';
    case ModelReconnectStatus.Failed:
      return `Reconnect failed after ${state.attempt} attempts`;
    case ModelReconnectStatus.Stopped:
      return 'Reconnect stopped';
    case ModelReconnectStatus.Retrying:
    default:
      return `Reconnecting ${state.attempt}/${state.maxAttempts}`;
  }
}

/**
 * When the runtime gives up on a dropped stream it reports a generic incomplete
 * turn, a response timeout, or the last retry's own failure (such as the proxy's
 * 502 while the network settles). Say what happened instead, and keep the
 * runtime text plus the drop facts in the technical detail.
 */
export function resolveModelReconnectErrorOverride(
  state: ModelReconnectState | undefined,
  rawErrorMessage: string,
): { errorMessage: string; detailRawErrorMessage: string } | null {
  if (!state) return null;
  // Exhaustion is reported right before the run surfaces its error, so that
  // error is the reconnect failing. A pending reconnect only explains the
  // runtime's generic drop copy; a different error stays as it is.
  const reconnectEndedTurn = state.status === ModelReconnectStatus.Failed
    || (state.status === ModelReconnectStatus.Retrying
      && STREAM_DROP_TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(rawErrorMessage)));
  if (!reconnectEndedTurn) {
    return null;
  }
  const facts = [
    `reconnectAttempts=${state.attempt}/${state.maxAttempts}`,
    `streamError=${state.error ?? 'unknown'}`,
    `code=${state.errorCode ?? 'none'}`,
  ].join(' ');
  return {
    errorMessage: t('coworkErrorModelStreamInterrupted', { attempts: state.attempt }),
    detailRawErrorMessage: `${rawErrorMessage}\n${facts}`,
  };
}
