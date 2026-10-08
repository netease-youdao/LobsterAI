import {
  LibraryChangeReason,
  type LibraryChangeReason as LibraryChangeReasonValue,
} from '../../../shared/library/constants';
import type { LibraryChangedPayload } from '../../../shared/library/types';

export const LibraryRefreshTiming = {
  QuietWindowMs: 300,
  MaxWaitMs: 1_000,
  StableWindowMs: 1_000,
} as const;

export const LibraryRefreshOutcome = {
  Committed: 'committed',
  Invalidated: 'invalidated',
  Stopped: 'stopped',
} as const;
export type LibraryRefreshOutcome = typeof LibraryRefreshOutcome[keyof typeof LibraryRefreshOutcome];

export interface LibraryRefreshBatch {
  itemIds: string[];
  sessionIds: string[];
  reasons: LibraryChangeReasonValue[];
  eventCount: number;
  requiresAuthoritativeRefresh: boolean;
  immediateRetryAvailable: boolean;
}

interface LibraryRefreshScheduler {
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

interface LibraryRefreshCoordinatorOptions {
  onFlush: (batch: LibraryRefreshBatch) => Promise<LibraryRefreshOutcome | void>;
  onInvalidate?: (payload: LibraryChangedPayload) => void;
  onError?: (error: unknown) => void;
  quietWindowMs?: number;
  maxWaitMs?: number;
  stableWindowMs?: number;
  scheduler?: LibraryRefreshScheduler;
}

const defaultScheduler: LibraryRefreshScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
};

export class LibraryRefreshCoordinator {
  private readonly onFlush: LibraryRefreshCoordinatorOptions['onFlush'];
  private readonly onError?: LibraryRefreshCoordinatorOptions['onError'];
  private readonly onInvalidate?: LibraryRefreshCoordinatorOptions['onInvalidate'];
  private readonly quietWindowMs: number;
  private readonly maxWaitMs: number;
  private readonly stableWindowMs: number;
  private readonly scheduler: LibraryRefreshScheduler;
  private readonly itemIds = new Set<string>();
  private readonly sessionIds = new Set<string>();
  private readonly reasons = new Set<LibraryChangeReasonValue>();
  private eventCount = 0;
  private requiresAuthoritativeRefresh = false;
  private quietTimer?: ReturnType<typeof setTimeout>;
  private maxTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private busy = false;
  private inFlight = false;
  private disposed = false;
  private immediateRetryUsed = false;
  private backingOff = false;
  private resetGeneration = 0;

  constructor(options: LibraryRefreshCoordinatorOptions) {
    this.onFlush = options.onFlush;
    this.onError = options.onError;
    this.onInvalidate = options.onInvalidate;
    this.quietWindowMs = options.quietWindowMs ?? LibraryRefreshTiming.QuietWindowMs;
    this.maxWaitMs = options.maxWaitMs ?? LibraryRefreshTiming.MaxWaitMs;
    this.stableWindowMs = options.stableWindowMs ?? LibraryRefreshTiming.StableWindowMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  enqueue(payload: LibraryChangedPayload): void {
    if (this.disposed) return;
    this.onInvalidate?.(payload);
    this.eventCount += 1;
    this.reasons.add(payload.reason);
    const itemIds = payload.itemIds?.filter(Boolean) ?? [];
    for (const itemId of itemIds) this.itemIds.add(itemId);
    for (const sessionId of payload.sessionIds ?? []) if (sessionId) this.sessionIds.add(sessionId);
    if (payload.reason === LibraryChangeReason.Repair
      || payload.reason === LibraryChangeReason.SessionProjectionChanged || itemIds.length === 0) {
      this.requiresAuthoritativeRefresh = true;
    }
    if (this.active) this.schedule();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      this.clearTimers();
      return;
    }
    if (this.hasPendingBatch()) {
      if (this.backingOff) this.schedule();
      else this.requestFlush();
    }
  }

  /** Visibility and external reads are independent of event invalidation. */
  setBusy(busy: boolean): void {
    if (this.disposed || this.busy === busy) return;
    this.busy = busy;
    if (!busy && this.active && this.hasPendingBatch()) {
      if (this.backingOff) this.schedule();
      else this.requestFlush();
    }
  }

  resetRetries(): void {
    this.immediateRetryUsed = false;
    this.backingOff = false;
    this.clearTimers();
  }

  /** Share the retry allowance with failures observed by an external page read. */
  consumeImmediateRetry(): boolean {
    if (this.disposed || this.immediateRetryUsed) return false;
    this.immediateRetryUsed = true;
    return true;
  }

  /** Query changes discard queued work and prevent an old attempt requeueing. */
  resetPending(): void {
    this.resetGeneration += 1;
    this.resetRetries();
    this.resetPendingBatch();
  }

  flushNow(): void {
    if (this.disposed || !this.active || !this.hasPendingBatch()) return;
    this.requestFlush();
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.clearTimers();
    this.resetGeneration += 1;
    this.resetPendingBatch();
  }

  private schedule(): void {
    if (this.quietTimer !== undefined) this.scheduler.clearTimeout(this.quietTimer);
    if (this.backingOff && this.maxTimer !== undefined) {
      this.scheduler.clearTimeout(this.maxTimer);
      this.maxTimer = undefined;
    }
    this.quietTimer = this.scheduler.setTimeout(() => {
      this.quietTimer = undefined;
      if (this.backingOff) {
        this.backingOff = false;
        this.immediateRetryUsed = false;
      }
      this.requestFlush();
    }, this.backingOff ? this.stableWindowMs : this.quietWindowMs);
    if (!this.backingOff && this.maxTimer === undefined) {
      this.maxTimer = this.scheduler.setTimeout(() => {
        this.maxTimer = undefined;
        this.requestFlush();
      }, this.maxWaitMs);
    }
  }

  private requestFlush(): void {
    if (this.disposed || !this.active || !this.hasPendingBatch()) return;
    if (this.backingOff) {
      this.schedule();
      return;
    }
    if (this.inFlight || this.busy) {
      this.clearTimers();
      return;
    }
    this.clearTimers();
    const batch = this.takePendingBatch();
    this.inFlight = true;
    void this.runFlush(batch, this.resetGeneration);
  }

  private async runFlush(batch: LibraryRefreshBatch, generation: number): Promise<void> {
    let outcome: LibraryRefreshOutcome | void = LibraryRefreshOutcome.Stopped;
    try {
      outcome = await this.onFlush(batch);
    } catch (error) {
      this.onError?.(error);
    } finally {
      this.inFlight = false;
      if (!this.disposed && generation === this.resetGeneration) {
        if (outcome === LibraryRefreshOutcome.Invalidated) {
          this.requeueAuthoritative(batch);
          if (this.immediateRetryUsed) this.backingOff = true;
          else this.immediateRetryUsed = true;
        } else if (outcome !== LibraryRefreshOutcome.Stopped) {
          this.resetRetries();
        }
      }
      if (!this.disposed && this.active && this.hasPendingBatch()) {
        if (this.backingOff || outcome === LibraryRefreshOutcome.Stopped) this.schedule();
        else this.requestFlush();
      }
    }
  }

  private takePendingBatch(): LibraryRefreshBatch {
    const batch: LibraryRefreshBatch = {
      itemIds: [...this.itemIds],
      sessionIds: [...this.sessionIds],
      reasons: [...this.reasons],
      eventCount: this.eventCount,
      requiresAuthoritativeRefresh: this.requiresAuthoritativeRefresh,
      immediateRetryAvailable: !this.immediateRetryUsed,
    };
    this.resetPendingBatch();
    return batch;
  }

  private hasPendingBatch(): boolean {
    return this.eventCount > 0;
  }

  private resetPendingBatch(): void {
    this.itemIds.clear();
    this.sessionIds.clear();
    this.reasons.clear();
    this.eventCount = 0;
    this.requiresAuthoritativeRefresh = false;
  }

  private requeueAuthoritative(batch: LibraryRefreshBatch): void {
    for (const itemId of batch.itemIds) this.itemIds.add(itemId);
    for (const sessionId of batch.sessionIds) this.sessionIds.add(sessionId);
    for (const reason of batch.reasons) this.reasons.add(reason);
    this.eventCount = Math.max(1, this.eventCount);
    this.requiresAuthoritativeRefresh = true;
  }

  private clearTimers(): void {
    if (this.quietTimer !== undefined) this.scheduler.clearTimeout(this.quietTimer);
    if (this.maxTimer !== undefined) this.scheduler.clearTimeout(this.maxTimer);
    this.quietTimer = undefined;
    this.maxTimer = undefined;
  }
}
