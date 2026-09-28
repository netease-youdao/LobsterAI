import { type OpenClawConfigTarget, sameOpenClawConfigContent } from './openclawConfigTarget';

const CONFIG_RECOVERY_RESTART_INTERVAL_MS = 10 * 60 * 1_000;

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

/** Pending application outlives an RPC, a disk no-op, and restart cooldowns. */
export class OpenClawConfigRecovery {
  private target: OpenClawConfigTarget | null = null;
  private respawnRequired = false;
  private respawnAfterGeneration = 0;
  private rejection: string | null = null;
  private lastRestartAt: number | null = null;
  private nextRetryAt = 0;

  get pending(): boolean { return this.target !== null; }
  get requiresRespawn(): boolean { return this.respawnRequired; }
  get error(): string | null { return this.rejection; }

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
    if (this.target !== target || this.needsRespawn(generation)) return false;
    this.target = null;
    this.respawnRequired = false;
    this.rejection = null;
    return true;
  }

  canRestart(now = Date.now()): boolean {
    return this.lastRestartAt === null || now - this.lastRestartAt >= CONFIG_RECOVERY_RESTART_INTERVAL_MS;
  }

  restarted(now = Date.now()): void { this.lastRestartAt = now; }

  retryAfter(delayMs: number): void { this.nextRetryAt = Date.now() + delayMs; }
  canRetry(now = Date.now()): boolean { return now >= this.nextRetryAt; }
}
