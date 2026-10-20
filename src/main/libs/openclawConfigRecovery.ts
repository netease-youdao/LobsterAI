import {
  hasOpenClawStartupInputChange,
  matchesOpenClawStartupInputs,
  type OpenClawConfigStartupInputs,
} from './openclawConfigRestartInputs';
import { type OpenClawConfigTarget, sameOpenClawConfigContent } from './openclawConfigTarget';

type RestartDemand = {
  requestId: string;
  ownerEpoch: string;
  reason: string;
  requestedAt: number;
  requiredAfterGeneration: number;
  inputs?: OpenClawConfigStartupInputs;
};

type StageStartupInputs = {
  inputs: OpenClawConfigStartupInputs;
  initialInputs: OpenClawConfigStartupInputs;
  reason: string;
  requestedAt?: number;
};

const CONFIG_RECOVERY_RESTART_INTERVAL_MS = 10 * 60 * 1_000;
/**
 * Persistent delivery failures tolerated after a recovery respawn: the first
 * may still race the fresh gateway's startup, the second shows a restart did
 * not help (e.g. an unwritable config file or a lock no restart releases).
 */
const PERSISTENT_FAILURES_AFTER_RESPAWN = 2;

/**
 * Pending application outlives an RPC, a disk no-op, and restart cooldowns.
 * Automatic recovery stops (stalls) once a fresh gateway still cannot confirm
 * the target: one respawned for recovery, or one that spawned from the target.
 * The target stays pending, so a later successful delivery still converges it.
 */
export class OpenClawConfigRecovery {
  private target: OpenClawConfigTarget | null = null;
  private appliedTarget: { raw: string; generation: number } | null = null;
  private restartDemand: RestartDemand | null = null;
  private desiredStartupInputs: OpenClawConfigStartupInputs | null = null;
  private startupInputSequence = 0;
  private ownerEpoch = '';
  private inputRevision = '';
  private gatewayStartupEvidence: {
    generation: number;
    revision: string | null;
    inputs: OpenClawConfigStartupInputs;
  } | null = null;
  private rejection: string | null = null;
  private lastRestartAt: number | null = null;
  private lastRestartRequestId: string | null = null;
  private nextRetryAt = 0;
  private respawnedForRecovery = false;
  private failuresAfterRespawn = 0;
  private spawnLoadedGeneration: number | null = null;
  private stallMessage: string | null = null;

  get pending(): boolean { return this.target !== null; }
  get requiresRespawn(): boolean { return this.restartDemand !== null; }
  get hasAttemptedRestartDemand(): boolean {
    return this.restartDemand !== null && this.lastRestartRequestId === this.restartDemand.requestId;
  }
  /** Opaque revision published only together with the stopped child's startup config. */
  get startupInputRevision(): string { return this.inputRevision; }
  get pendingRestartDemand(): Readonly<Omit<RestartDemand, 'inputs'>> | null {
    if (!this.restartDemand) return null;
    const { requestId, ownerEpoch, reason, requestedAt, requiredAfterGeneration } = this.restartDemand;
    return { requestId, ownerEpoch, reason, requestedAt, requiredAfterGeneration };
  }

  /** Account fences invalidate old targets/receipts as well as old restart demands. */
  resetForOwner(ownerEpoch: string): void {
    this.ownerEpoch = ownerEpoch;
    this.inputRevision = `${ownerEpoch}:${++this.startupInputSequence}`;
    this.target = null;
    this.appliedTarget = null;
    this.restartDemand = null;
    this.desiredStartupInputs = null;
    this.gatewayStartupEvidence = null;
    this.rejection = null;
    this.lastRestartAt = null;
    this.lastRestartRequestId = null;
    this.nextRetryAt = 0;
    this.respawnedForRecovery = false;
    this.failuresAfterRespawn = 0;
    this.spawnLoadedGeneration = null;
    this.stallMessage = null;
  }

  observeGatewayStartup(
    generation: number,
    revision: string | null,
    inputs: OpenClawConfigStartupInputs | null,
  ): void {
    this.gatewayStartupEvidence = inputs ? { generation, revision, inputs } : null;
  }
  get error(): string | null { return this.rejection ?? this.stallMessage; }
  /** The gateway refused the target as invalid config; no retry can apply it. */
  get rejected(): boolean { return this.rejection !== null; }
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

  stage(
    target: OpenClawConfigTarget,
    requiresRespawn: boolean,
    generation: number,
    startup?: StageStartupInputs,
  ): void {
    if (!this.target || !sameOpenClawConfigContent(this.target.raw, target.raw)) {
      this.rejection = null;
      this.nextRetryAt = 0;
    }
    this.target = target;
    const inputsChanged = startup && hasOpenClawStartupInputChange(
      this.desiredStartupInputs ?? startup.initialInputs,
      startup.inputs,
      this.gatewayStartupEvidence?.inputs,
    );
    if (startup) this.desiredStartupInputs = startup.inputs;
    // Only a new input change or original explicit request advances the demand.
    // Polling and hot target changes retain its original generation and identity.
    if (requiresRespawn || inputsChanged) {
      this.inputRevision = `${this.ownerEpoch}:${++this.startupInputSequence}`;
      this.restartDemand = {
        requestId: this.inputRevision,
        ownerEpoch: this.ownerEpoch,
        reason: startup?.reason ?? 'explicit',
        requestedAt: startup?.requestedAt ?? Date.now(),
        requiredAfterGeneration: generation,
        inputs: startup?.inputs,
      };
    }
  }

  reject(target: OpenClawConfigTarget, message: string): void {
    if (this.target === target) this.rejection = message;
  }

  needsRespawn(generation: number): boolean {
    const demand = this.restartDemand;
    if (!demand) return false;
    if (generation <= demand.requiredAfterGeneration) return true;
    if (!demand.inputs) return false;
    const evidence = this.gatewayStartupEvidence;
    return !evidence || evidence.generation !== generation
      || evidence.revision !== demand.requestId
      || !matchesOpenClawStartupInputs(demand.inputs, evidence.inputs);
  }

  applied(target: OpenClawConfigTarget, generation: number): boolean {
    if (this.target !== target) return false;
    // A confirmed write cannot repair stale inputs in an already respawned
    // process. Keep that failure budget until the actual startup proof matches.
    if (this.needsRespawn(generation) && this.restartDemand?.inputs
      && generation > this.restartDemand.requiredAfterGeneration) return false;
    // Delivery works again; an outstanding original respawn still keeps the target.
    this.stallMessage = null;
    this.failuresAfterRespawn = 0;
    if (this.needsRespawn(generation)) return false;
    // Plugins and env load only at spawn, so content counts as applied only without a respawn demand.
    this.appliedTarget = { raw: target.raw, generation };
    this.target = null;
    this.restartDemand = null;
    this.rejection = null;
    this.respawnedForRecovery = false;
    return true;
  }

  canRestart(now = Date.now()): boolean {
    return this.lastRestartAt === null || now - this.lastRestartAt >= CONFIG_RECOVERY_RESTART_INTERVAL_MS;
  }

  restarted(now = Date.now()): void {
    this.lastRestartAt = now;
    this.lastRestartRequestId = this.restartDemand?.requestId ?? null;
    this.respawnedForRecovery = true;
    this.failuresAfterRespawn = 0;
  }

  /**
   * Whether the running generation loaded the pending target from disk when it
   * spawned and has confirmed no other content since. Another respawn would
   * only reload the same file, so the first such check per generation arms the
   * stall count, as a recovery respawn does.
   */
  loadedAtSpawn(target: OpenClawConfigTarget, spawnedRaw: string | null, generation: number): boolean {
    if (this.target !== target
      || spawnedRaw === null
      || this.needsRespawn(generation)
      || this.appliedTarget?.generation === generation
      || !sameOpenClawConfigContent(spawnedRaw, target.raw)) {
      return false;
    }
    if (this.spawnLoadedGeneration !== generation) {
      this.spawnLoadedGeneration = generation;
      this.respawnedForRecovery = true;
      this.failuresAfterRespawn = 0;
    }
    return true;
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
