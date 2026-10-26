import { RemoteInitializationFailure } from '../../shared/remote/constants';
import { RemoteIdentityError } from './installationIdentity';

type Failure = typeof RemoteInitializationFailure[keyof typeof RemoteInitializationFailure];
const AUTOMATIC_RETRY_MS = 30_000;
const MANUAL_RETRY_MS = 1000;

export class RemoteInitializationError extends Error {
  constructor(readonly failure: Failure) { super(failure); this.name = 'RemoteInitializationError'; }
}

interface Dependencies {
  initialize(): void;
  canRetry(): boolean;
  changed(): void;
  report(failure: Failure | null, attempt: number): void;
}

/** Retries the original files only. It never resets credentials or security evidence. */
export class RemoteInitializationRecovery {
  private currentFailure: Failure | undefined;
  private initialized = false;
  private initializing = false;
  private disposed = false;
  private attempts = 0;
  private lastAttemptAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: Dependencies) {}
  get failure(): Failure | undefined { return this.currentFailure; }

  ensure(manual = false): void { this.attempt(manual, false); }

  private attempt(manual: boolean, automatic: boolean): void {
    if (this.disposed) throw new RemoteInitializationError(this.currentFailure ?? RemoteInitializationFailure.DependencyUnavailable);
    if (this.initialized) return;
    if (this.currentFailure && !manual && !automatic) throw new RemoteInitializationError(this.currentFailure);
    if (this.initializing || Date.now() - this.lastAttemptAt < (manual ? MANUAL_RETRY_MS : AUTOMATIC_RETRY_MS)) {
      throw new RemoteInitializationError(this.currentFailure ?? RemoteInitializationFailure.DependencyUnavailable);
    }
    this.initializing = true;
    this.lastAttemptAt = Date.now();
    this.attempts++;
    const previous = this.currentFailure;
    try {
      this.deps.initialize();
      this.initialized = true;
      this.currentFailure = undefined;
      clearTimeout(this.timer); this.timer = undefined;
      if (previous) this.report(null);
    } catch (error) {
      this.currentFailure = error instanceof RemoteIdentityError ? error.failure : RemoteInitializationFailure.DependencyUnavailable;
      // Do not forward raw exceptions, paths, decrypted JSON or native cipher messages.
      if (previous !== this.currentFailure) this.report(this.currentFailure);
      this.schedule();
      throw new RemoteInitializationError(this.currentFailure);
    } finally {
      this.initializing = false;
      if (previous !== this.currentFailure) {
        try { this.deps.changed(); } catch { /* Optional settings listeners cannot affect recovery. */ }
      }
    }
  }

  private report(failure: Failure | null): void {
    try { this.deps.report(failure, this.attempts); } catch { /* Diagnostics are never execution evidence. */ }
  }

  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    // Invalid/unreadable identities require an explicit check after original material is restored.
    if (this.disposed || (this.currentFailure !== RemoteInitializationFailure.SecureStorageUnavailable
      && this.currentFailure !== RemoteInitializationFailure.LocalStorageUnavailable)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        if (!this.deps.canRetry()) { this.schedule(); return; }
        this.attempt(false, true);
      } catch {
        // A failed eligibility read also preserves the original files and retries within the same budget.
        if (!this.timer) this.schedule();
      }
    }, AUTOMATIC_RETRY_MS);
    this.timer.unref?.();
  }

  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.timer = undefined; }
}
