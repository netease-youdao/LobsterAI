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

/**
 * Gateway startup stages, in order, recognized from the milestones the
 * gateway logs (OpenClaw v2026.8.1: src/cli/gateway-cli/run.ts,
 * src/gateway/server-runtime-state-prepare.ts and server-startup-post-attach.ts).
 * Before its first milestone the gateway loads modules and runs its own state
 * migrations, which is the longest and least predictable stretch.
 */
export const GatewayStartupStage = {
  Spawned: 'spawned',
  LoadingConfig: 'loading-config',
  StartingHttp: 'starting-http',
  StartingChannels: 'starting-channels',
} as const;
export type GatewayStartupStage = typeof GatewayStartupStage[keyof typeof GatewayStartupStage];

const GATEWAY_STARTUP_STAGE_ORDER: readonly GatewayStartupStage[] = [
  GatewayStartupStage.Spawned,
  GatewayStartupStage.LoadingConfig,
  GatewayStartupStage.StartingHttp,
  GatewayStartupStage.StartingChannels,
];

const GATEWAY_STARTUP_STAGE_MILESTONES: ReadonlyArray<[GatewayStartupStage, string]> = [
  [GatewayStartupStage.LoadingConfig, 'loading configuration'],
  [GatewayStartupStage.StartingHttp, 'starting HTTP server'],
  [GatewayStartupStage.StartingChannels, 'starting channels and sidecars'],
];

/** Each stage creeps from its floor toward (never reaching) its ceiling. */
const GATEWAY_STARTUP_STAGE_PROGRESS: Record<GatewayStartupStage, readonly [number, number]> = {
  [GatewayStartupStage.Spawned]: [20, 50],
  [GatewayStartupStage.LoadingConfig]: [55, 68],
  [GatewayStartupStage.StartingHttp]: [70, 83],
  [GatewayStartupStage.StartingChannels]: [85, 95],
};

/** Time for a stage to cover half of its remaining progress range. */
const GATEWAY_STARTUP_STAGE_HALF_LIFE_MS = 6_000;

/** The latest stage a chunk of gateway output announces, if any. */
export function resolveGatewayStartupStage(text: string): GatewayStartupStage | null {
  let stage: GatewayStartupStage | null = null;
  for (const [candidate, milestone] of GATEWAY_STARTUP_STAGE_MILESTONES) {
    if (text.includes(milestone)) stage = candidate;
  }
  return stage;
}

/** Stages only move forward; a repeated or older milestone keeps the current one. */
export function advanceGatewayStartupStage(
  current: GatewayStartupStage,
  next: GatewayStartupStage | null,
): GatewayStartupStage {
  if (!next) return current;
  return GATEWAY_STARTUP_STAGE_ORDER.indexOf(next) > GATEWAY_STARTUP_STAGE_ORDER.indexOf(current) ? next : current;
}

/**
 * Progress for a gateway in `stage` for `stageElapsedMs`. Milestones move it
 * in steps; between them it eases toward the next step, so a normal start
 * reads as progress instead of sitting near 10% for its whole duration.
 */
export function gatewayStartupProgressPercent(
  stage: GatewayStartupStage,
  stageElapsedMs: number,
): number {
  const [floor, ceiling] = GATEWAY_STARTUP_STAGE_PROGRESS[stage];
  const remaining = 0.5 ** (Math.max(0, stageElapsedMs) / GATEWAY_STARTUP_STAGE_HALF_LIFE_MS);
  return Math.min(ceiling - 1, Math.floor(floor + (ceiling - floor) * (1 - remaining)));
}
