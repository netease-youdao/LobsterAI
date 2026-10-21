/**
 * Readiness wait policy for a gateway that is still starting.
 *
 * A fixed deadline stopped gateways that were still loading on slow disks
 * (2026-09-26 field logs: ready at 304s, stopped at 300s, restarted cold and
 * stopped again). Past the base deadline the wait continues while the gateway
 * keeps producing output, and ends once it has been silent for the idle
 * window or the absolute limit is reached.
 */
export interface GatewayStartupWaitPolicy {
  /** A gateway that becomes ready within this time is never judged. */
  baseTimeoutMs: number;
  /** Past the base deadline, the longest silence tolerated before giving up. */
  idleTimeoutMs: number;
  /** Absolute limit, even for a gateway that keeps producing output. */
  maxWaitMs: number;
}

export const DEFAULT_GATEWAY_STARTUP_WAIT_POLICY: Readonly<GatewayStartupWaitPolicy> = {
  baseTimeoutMs: 300_000,
  // The longest silent stretch in a slow start that did become ready was 188s.
  idleTimeoutMs: 240_000,
  maxWaitMs: 900_000,
};

export const GatewayStartupWaitOutcome = {
  /** Still within the base deadline. */
  Waiting: 'waiting',
  /** Past the base deadline, but the gateway produced output recently. */
  Extended: 'extended',
  /** Past the base deadline and silent for the whole idle window. */
  Stalled: 'stalled',
  /** The absolute limit was reached. */
  LimitReached: 'limit-reached',
} as const;
export type GatewayStartupWaitOutcome = typeof GatewayStartupWaitOutcome[keyof typeof GatewayStartupWaitOutcome];

/**
 * @param elapsedMs time since the wait began
 * @param silentMs time since the gateway last produced output, or since the
 *   wait began when it has produced none
 */
export function evaluateGatewayStartupWait(
  elapsedMs: number,
  silentMs: number,
  policy: GatewayStartupWaitPolicy = DEFAULT_GATEWAY_STARTUP_WAIT_POLICY,
): GatewayStartupWaitOutcome {
  if (elapsedMs < policy.baseTimeoutMs) return GatewayStartupWaitOutcome.Waiting;
  if (elapsedMs >= policy.maxWaitMs) return GatewayStartupWaitOutcome.LimitReached;
  return silentMs < policy.idleTimeoutMs ? GatewayStartupWaitOutcome.Extended : GatewayStartupWaitOutcome.Stalled;
}

export function isGatewayStartupWaitOver(outcome: GatewayStartupWaitOutcome): boolean {
  return outcome === GatewayStartupWaitOutcome.Stalled || outcome === GatewayStartupWaitOutcome.LimitReached;
}

/** 10-90% across the base deadline, then creeping toward 95% while extended. */
export function gatewayStartupProgressPercent(
  elapsedMs: number,
  policy: GatewayStartupWaitPolicy = DEFAULT_GATEWAY_STARTUP_WAIT_POLICY,
): number {
  if (elapsedMs <= policy.baseTimeoutMs) {
    return Math.min(90, 10 + Math.round((elapsedMs / policy.baseTimeoutMs) * 80));
  }
  const extension = Math.max(1, policy.maxWaitMs - policy.baseTimeoutMs);
  return Math.min(95, 90 + Math.round(((elapsedMs - policy.baseTimeoutMs) / extension) * 5));
}
