import { RemoteFileReason } from '../../shared/remote/files';

export const RemoteFileRetryPhase = {
  Backoff: 'backoff', Cooldown: 'cooldown', Waiting: 'waiting_dependency', Isolated: 'isolated',
} as const;
export interface RemoteFileRetryState {
  phase: typeof RemoteFileRetryPhase[keyof typeof RemoteFileRetryPhase];
  failures: number;
  nextRetryAt: number;
  policyVersion?: string;
  serverRetryAt?: number;
}
/** Preserve transport evidence without storing URLs, tokens, request bodies or raw response data. */
export class RemoteFileRequestError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly retryAfter?: string | null, readonly serverReason?: string) {
    super(message); this.name = 'RemoteFileRequestError';
  }
}
const waits = [30_000, 60_000, 120_000, 300_000];
const dependencies = new Set<string>([
  RemoteFileReason.Type, RemoteFileReason.Size, RemoteFileReason.Policy, 'INPUT_TOTAL_TOO_LARGE',
  'ACCOUNT_FILE_COUNT_LIMIT', 'UNBOUND_FILE_QUOTA_EXCEEDED', 'ACCOUNT_FILE_QUOTA_EXCEEDED',
  'TASK_FILE_QUOTA_EXCEEDED', 'FILE_QUOTA_INCONSISTENT', 'PRIVATE_INPUT_STORAGE_UNAVAILABLE',
]);
export function fileRetryAllowed(state: RemoteFileRetryState | undefined, now: number, policyVersion: string): boolean {
  if (!state) return true;
  if ((state.serverRetryAt || 0) > now) return false;
  if (state.phase === RemoteFileRetryPhase.Isolated) return false;
  return state.nextRetryAt <= now || state.phase === RemoteFileRetryPhase.Waiting && state.policyVersion !== policyVersion;
}
export function nextFileRetry(previous: RemoteFileRetryState | undefined, error: unknown, now: number,
  policyVersion: string, random = Math.random): RemoteFileRetryState {
  const reason = error instanceof RemoteFileRequestError ? error.serverReason || error.message : error instanceof Error ? error.message : '';
  const failures = (previous?.failures || 0) + 1;
  const waiting = dependencies.has(reason);
  const transient = error instanceof RemoteFileRequestError
    && (error.httpStatus === undefined || error.httpStatus === 429 || error.httpStatus >= 500);
  if (!waiting && !transient) return { phase: RemoteFileRetryPhase.Isolated, failures, nextRetryAt: 0, policyVersion };
  let phase: RemoteFileRetryState['phase'] = waiting ? RemoteFileRetryPhase.Waiting : failures >= 5 ? RemoteFileRetryPhase.Cooldown : RemoteFileRetryPhase.Backoff;
  let nextRetryAt = now + (phase === RemoteFileRetryPhase.Backoff
    ? waits[Math.min(failures - 1, waits.length - 1)] * (0.8 + random() * 0.4) : 900_000 + random() * 180_000);
  let serverRetryAt: number | undefined;
  if (error instanceof RemoteFileRequestError && error.retryAfter) {
    const text = error.retryAfter.trim();
    const deadline = /^\d+$/u.test(text) ? now + Number(text) * 1000 : Date.parse(text);
    if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) {
      phase = RemoteFileRetryPhase.Isolated; nextRetryAt = 0;
    } else { serverRetryAt = deadline; nextRetryAt = Math.max(nextRetryAt, deadline); }
  }
  return { phase, failures, nextRetryAt: Math.ceil(nextRetryAt), policyVersion, ...(serverRetryAt !== undefined ? { serverRetryAt } : {}) };
}
