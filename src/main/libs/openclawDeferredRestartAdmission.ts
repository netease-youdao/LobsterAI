/** How long a caller that needs the gateway waits for a queued restart to land. */
export const DEFERRED_RESTART_CALLER_WAIT_MS = 45_000;
export const DEFERRED_RESTART_CALLER_POLL_MS = 500;

export type DeferredRestartAdmission = {
  admitted: boolean;
  /** Config sync failure that blocked the caller, when one was observed. */
  error?: string;
};

export type DeferredRestartAdmissionDeps = {
  /** Reason of the queued deferred restart, or null when none is queued. */
  getDeferredReason: () => string | null;
  /** Same busy check the deferred-restart poller uses. */
  hasActiveWorkloads: (reason: string) => boolean;
  /** Runs the queued restart now; rejects when the resulting config sync fails. */
  runDeferredRestart: (reason: string) => Promise<void>;
  /** Waits for any config apply that is currently in flight. */
  waitForPendingApply: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
  pollMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error && error.message ? error.message : undefined;

/**
 * Decides whether a caller that needs the gateway (for example a new session)
 * may proceed while a config-driven gateway restart is deferred.
 *
 * The deferred restart only waits for the gateway to become idle, so an idle
 * gateway applies it immediately and admits the caller. While workloads are
 * active the caller waits a bounded time for the scheduled restart to land.
 */
export async function admitPastDeferredGatewayRestart(
  deps: DeferredRestartAdmissionDeps,
): Promise<DeferredRestartAdmission> {
  const reason = deps.getDeferredReason();
  if (!reason) return { admitted: true };

  if (!deps.hasActiveWorkloads(reason)) {
    try {
      await deps.runDeferredRestart(reason);
    } catch (error) {
      return { admitted: false, error: errorMessage(error) };
    }
  } else {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? defaultSleep;
    const deadline = now() + (deps.waitMs ?? DEFERRED_RESTART_CALLER_WAIT_MS);
    while (deps.getDeferredReason() && now() < deadline) {
      await sleep(deps.pollMs ?? DEFERRED_RESTART_CALLER_POLL_MS);
    }
  }

  // The restart may have been re-deferred because work started meanwhile.
  if (deps.getDeferredReason()) return { admitted: false };

  try {
    await deps.waitForPendingApply();
  } catch (error) {
    return { admitted: false, error: errorMessage(error) };
  }
  return { admitted: true };
}
