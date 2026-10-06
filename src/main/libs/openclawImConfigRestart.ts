import { OpenClawEnginePhase } from '../../shared/openclawEngine/constants';

type ImRestartReceipt = {
  fingerprint: string;
  gatewayGeneration: number;
};

/** Tracks IM config loaded by a completed supervisor restart, never by hot delivery. */
export class OpenClawImConfigRestartTracker {
  private syncedFingerprint: string | null = null;
  private receipt: ImRestartReceipt | null = null;

  constructor(private readonly deps: {
    getImConfigFingerprint: () => string;
    getGatewayGeneration: () => number | undefined;
  }) {}

  /** Call immediately before synchronous config rendering, after async preparation. */
  captureConfig(): string | null {
    let fingerprint: string | null = null;
    try {
      fingerprint = this.deps.getImConfigFingerprint();
    } catch {
      // Missing IM state must retain the existing restart behavior.
    }
    if (fingerprint !== this.syncedFingerprint || fingerprint === null) {
      this.receipt = null;
    }
    this.syncedFingerprint = fingerprint;
    return fingerprint;
  }

  isRestartSatisfied(requestFingerprint: string | undefined, configChanged: boolean): boolean {
    return !configChanged
      && requestFingerprint !== undefined
      && this.receipt !== null
      && this.receipt.fingerprint === requestFingerprint
      && this.receipt.fingerprint === this.syncedFingerprint
      && this.receipt.gatewayGeneration === this.deps.getGatewayGeneration();
  }

  async restartGateway<T extends { phase: OpenClawEnginePhase }>(
    fingerprint: string | null,
    restart: () => Promise<T>,
  ): Promise<T> {
    this.receipt = null;
    const previousGeneration = this.deps.getGatewayGeneration();
    const status = await restart();
    const gatewayGeneration = this.deps.getGatewayGeneration();
    if (
      status.phase === OpenClawEnginePhase.Running
      && fingerprint !== null
      && fingerprint === this.syncedFingerprint
      && previousGeneration !== undefined
      && gatewayGeneration !== undefined
      && gatewayGeneration > previousGeneration
    ) {
      // Use the snapshot rendered before restart, not IM edits made while awaiting it.
      this.receipt = { fingerprint, gatewayGeneration };
    }
    return status;
  }
}
