export interface AuthGateLifecycleDeps {
  isBlocked: () => boolean;
  startDshAndScheduler: () => Promise<void>;
  startImGateways: () => Promise<void>;
  stopCoworkSessions: () => void;
  stopSchedulerPolling: () => void;
  stopImGateways: () => Promise<void>;
  suspendDsh: () => Promise<void>;
  setCompanionAuthBlocked: (blocked: boolean) => void;
  refreshTrayMenu: () => void;
  log?: {
    info: (message: string) => void;
    warn: (message: string, error?: unknown) => void;
  };
}

/**
 * Coordinates runtime services (DSH host, Cowork sessions, LobsterScheduler,
 * IM gateways, Desktop Companion, and Tray) across forced-login gate transitions.
 *
 * Transitions are serialized onto a promise queue and guarded by an epoch
 * counter so rapid logout -> login (or login -> logout) cannot leave background
 * services in an inconsistent state.
 */
export class AuthGateLifecycleCoordinator {
  private readonly deps: AuthGateLifecycleDeps;
  private transitionEpoch = 0;
  private queue: Promise<void> = Promise.resolve();
  private servicesActive = false;

  constructor(deps: AuthGateLifecycleDeps) {
    this.deps = deps;
  }

  markServicesActive(active: boolean): void {
    this.servicesActive = active;
  }

  isServicesActive(): boolean {
    return this.servicesActive;
  }

  /**
   * Synchronize immediate UI surfaces (Desktop Companion and Tray) right away
   * and enqueue the corresponding background service transition.
   */
  syncState(reason: string): Promise<void> {
    const immediateBlocked = this.deps.isBlocked();
    this.applySurfaceState(immediateBlocked);

    const targetEpoch = ++this.transitionEpoch;
    const step = this.queue.then(async () => {
      if (targetEpoch !== this.transitionEpoch) {
        return;
      }

      const blocked = this.deps.isBlocked();
      this.applySurfaceState(blocked);

      if (blocked) {
        await this.performSuspend(reason);
      } else {
        await this.performResume(reason, targetEpoch);
      }
    });

    this.queue = step.catch((): void => undefined);
    return step;
  }

  private applySurfaceState(blocked: boolean): void {
    try {
      this.deps.setCompanionAuthBlocked(blocked);
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to update Desktop Companion auth gate state:', error);
    }
    try {
      this.deps.refreshTrayMenu();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to refresh tray menu for auth gate state:', error);
    }
  }

  private async performSuspend(reason: string): Promise<void> {
    this.deps.log?.info(`[AuthGate] Suspending background runtime services (reason=${reason})`);
    this.servicesActive = false;

    try {
      this.deps.stopCoworkSessions();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to stop active Cowork sessions:', error);
    }

    try {
      this.deps.stopSchedulerPolling();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to stop scheduled task polling:', error);
    }

    try {
      await this.deps.stopImGateways();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to stop IM gateways:', error);
    }

    try {
      await this.deps.suspendDsh();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to suspend DSH host:', error);
    }
  }

  private async performResume(reason: string, epoch: number): Promise<void> {
    if (this.servicesActive) {
      return;
    }

    this.deps.log?.info(`[AuthGate] Starting authorized runtime services (reason=${reason})`);
    this.servicesActive = true;

    try {
      await this.deps.startDshAndScheduler();
    } catch (error) {
      this.servicesActive = false;
      this.deps.log?.warn('[AuthGate] Failed to start DSH and scheduler after login:', error);
      return;
    }

    if (epoch !== this.transitionEpoch || this.deps.isBlocked()) {
      this.servicesActive = false;
      return;
    }

    try {
      await this.deps.startImGateways();
    } catch (error) {
      this.deps.log?.warn('[AuthGate] Failed to start IM gateways after login:', error);
    }
  }
}
