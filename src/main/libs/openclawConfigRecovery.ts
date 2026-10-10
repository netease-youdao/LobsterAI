import { type OpenClawConfigTarget, sameOpenClawConfigContent } from './openclawConfigTarget';

const CONFIG_RECOVERY_RESTART_INTERVAL_MS = 10 * 60 * 1_000;
/**
 * Persistent delivery failures tolerated after a recovery respawn: the first
 * may still race the fresh gateway's startup, the second shows a restart did
 * not help (e.g. an unwritable config file or a lock no restart releases).
 */
const PERSISTENT_FAILURES_AFTER_RESPAWN = 2;

/**
 * A deferred restart demand is satisfied once a gateway process spawned after
 * the demand runs this exact config and environment: such a process loaded
 * every input, including state kept outside openclaw.json, as of its spawn.
 * Re-arming the demand at the current generation would restart it for nothing.
 */
export function isDeferredRestartSatisfied(params: {
  restartRequestedAt?: number;
  gatewayProcessStartedAt: number | null;
  configChanged: boolean;
  envChanged: boolean;
  bindingsChanged: boolean;
  restartImpact: boolean;
}): boolean {
  return params.restartRequestedAt !== undefined
    && params.gatewayProcessStartedAt !== null
    && params.gatewayProcessStartedAt > params.restartRequestedAt
    && !params.configChanged
    && !params.envChanged
    && !params.bindingsChanged
    && !params.restartImpact;
}

/**
 * Pending application outlives an RPC, a disk no-op, and restart cooldowns.
 * Automatic recovery stops (stalls) once a recovery respawn did not help; the
 * target stays pending, so a later successful delivery still converges it.
 */
export class OpenClawConfigRecovery {
  private target: OpenClawConfigTarget | null = null;
  private appliedTarget: { raw: string; generation: number } | null = null;
  private respawnRequired = false;
  private respawnAfterGeneration = 0;
  private rejection: string | null = null;
  private lastRestartAt: number | null = null;
  private nextRetryAt = 0;
  private respawnedForRecovery = false;
  private failuresAfterRespawn = 0;
  private stallMessage: string | null = null;

  get pending(): boolean { return this.target !== null; }
  get requiresRespawn(): boolean { return this.respawnRequired; }
  get error(): string | null { return this.rejection ?? this.stallMessage; }
  /** Automatic retries and restarts are exhausted; only a successful delivery resumes. */
  get stalled(): boolean { return this.rejection === null && this.stallMessage !== null; }
  /** Latest staged target that the running gateway has not confirmed applying yet. */
  get pendingTarget(): OpenClawConfigTarget | null { return this.target; }

  /**
   * Target content that this gateway generation confirmed applying, or null
   * when it never confirmed one (a fresh process, or one awaiting a respawn).
   */
  appliedRawFor(generation: number): string | null {
    return this.appliedTarget?.generation === generation ? this.appliedTarget.raw : null;
  }

  stage(target: OpenClawConfigTarget, requiresRespawn: boolean, generation: number): void {
    if (!this.target || !sameOpenClawConfigContent(this.target.raw, target.raw)) {
      this.rejection = null;
      this.nextRetryAt = 0;
    }
    this.target = target;
    // Later ordinary writes cannot cancel an environment/plugin respawn demand.
    this.respawnRequired ||= requiresRespawn;
    if (requiresRespawn) this.respawnAfterGeneration = generation;
  }

  reject(target: OpenClawConfigTarget, message: string): void {
    if (this.target === target) this.rejection = message;
  }

  needsRespawn(generation: number): boolean {
    return this.respawnRequired && generation <= this.respawnAfterGeneration;
  }

  applied(target: OpenClawConfigTarget, generation: number): boolean {
    if (this.target !== target) return false;
    // Delivery works again; an outstanding respawn demand still keeps the target.
    this.stallMessage = null;
    this.failuresAfterRespawn = 0;
    if (this.needsRespawn(generation)) return false;
    // Plugins and env load only at spawn, so content counts as applied only without a respawn demand.
    this.appliedTarget = { raw: target.raw, generation };
    this.target = null;
    this.respawnRequired = false;
    this.rejection = null;
    this.respawnedForRecovery = false;
    return true;
  }

  canRestart(now = Date.now()): boolean {
    return this.lastRestartAt === null || now - this.lastRestartAt >= CONFIG_RECOVERY_RESTART_INTERVAL_MS;
  }

  restarted(now = Date.now()): void {
    this.lastRestartAt = now;
    this.respawnedForRecovery = true;
    this.failuresAfterRespawn = 0;
  }

  /**
   * Count a delivery failure that a fresh gateway did not cure. Returns true
   * when the current target stalls: automatic recovery cannot apply it.
   */
  failedAfterRespawn(target: OpenClawConfigTarget, message: string): boolean {
    if (this.target !== target || !this.respawnedForRecovery) return false;
    this.failuresAfterRespawn += 1;
    if (this.failuresAfterRespawn < PERSISTENT_FAILURES_AFTER_RESPAWN) return false;
    this.stallMessage = message;
    return true;
  }

  retryAfter(delayMs: number): void { this.nextRetryAt = Date.now() + delayMs; }
  canRetry(now = Date.now()): boolean { return now >= this.nextRetryAt; }
}
