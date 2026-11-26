import type { RemoteConfigureRequest, RemoteSettingsApi, RemoteSettingsState } from '../../shared/remote/constants';

const Stage = { Requested: 'requested', Response: 'response', Failed: 'failed' } as const;
type Stage = typeof Stage[keyof typeof Stage];
const Scope = { Task: 'task', Connection: 'connection' } as const;
let sequence = 0;
let windowStarted = 0;
let attempts = 0;

/** User-initiated retries only. No polling logs, account data, paths, or raw errors. */
export async function configureRemoteWithRetryLog(api: Pick<RemoteSettingsApi, 'configure'>, changes: RemoteConfigureRequest): Promise<RemoteSettingsState> {
  if (!changes.retrySessionId && !changes.retry) return api.configure(changes);
  const request = sequence = sequence % 1_000_000_000 + 1;
  const scope = changes.retrySessionId ? Scope.Task : Scope.Connection;
  const sessionId = typeof changes.retrySessionId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(changes.retrySessionId) ? changes.retrySessionId : null;
  const write = (stage: Stage, result?: RemoteSettingsState): void => {
    try {
      const now = Date.now();
      if (now < windowStarted || now - windowStarted >= 60000) { windowStarted = now; attempts = 0; }
      if (attempts >= 40) return;
      attempts++;
      window.electron?.log?.fromRenderer?.('debug', 'RemoteSyncRetry', JSON.stringify({ request, scope, sessionId, stage,
        ...(result ? { accountChanged: result.accountEpoch !== changes.expectedAccountEpoch, initializationFailed: !!result.initializationFailure } : {}) }));
    } catch { /* Optional logging and older preload versions must not affect retry. */ }
  };
  write(Stage.Requested);
  try {
    const result = await api.configure(changes);
    write(Stage.Response, result);
    return result;
  } catch (error) {
    write(Stage.Failed);
    throw error;
  }
}
