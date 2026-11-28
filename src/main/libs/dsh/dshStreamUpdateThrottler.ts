export const DEFAULT_DSH_STREAM_EMIT_THROTTLE_MS = 100;
export const DEFAULT_DSH_STREAM_PERSIST_THROTTLE_MS = 250;

export interface DshStreamUpdateEntry {
  sessionId: string;
  messageId: string;
}

export interface DshStreamUpdateThrottlerOptions<TEntry extends DshStreamUpdateEntry> {
  /** Minimum interval between IPC/event emissions for the same message. */
  emitIntervalMs?: number;
  /** Minimum interval between SQLite store writes for the same message. */
  persistIntervalMs?: number;
  /** Deliver an update to event listeners / IPC. */
  onEmit: (entry: TEntry) => void;
  /** Persist an update to the backing store. */
  onPersist: (entry: TEntry) => void;
}

interface PendingLaneUpdate<TEntry extends DshStreamUpdateEntry> {
  entry: TEntry;
  timer: ReturnType<typeof setTimeout>;
}

class ThrottleLane<TEntry extends DshStreamUpdateEntry> {
  private readonly lastRunAt = new Map<string, number>();
  private readonly pending = new Map<string, PendingLaneUpdate<TEntry>>();

  constructor(
    private readonly intervalMs: number,
    private readonly deliver: (entry: TEntry) => void,
  ) {}

  schedule(entry: TEntry): void {
    const now = Date.now();
    const last = this.lastRunAt.get(entry.messageId);
    const elapsed = last === undefined ? this.intervalMs : Math.max(0, now - last);

    if (this.intervalMs <= 0 || elapsed >= this.intervalMs) {
      this.cancelPending(entry.messageId);
      this.lastRunAt.set(entry.messageId, now);
      this.deliver(entry);
      return;
    }

    const existing = this.pending.get(entry.messageId);
    if (existing) {
      existing.entry = entry;
      return;
    }

    const state: PendingLaneUpdate<TEntry> = {
      entry,
      timer: setTimeout(() => {
        if (this.pending.get(entry.messageId) !== state) return;
        this.pending.delete(entry.messageId);
        this.lastRunAt.set(entry.messageId, Date.now());
        this.deliver(state.entry);
      }, Math.max(1, this.intervalMs - elapsed)),
    };
    this.pending.set(entry.messageId, state);
  }

  clear(messageId: string): void {
    this.cancelPending(messageId);
    this.lastRunAt.delete(messageId);
  }

  clearAll(): void {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
    }
    this.pending.clear();
    this.lastRunAt.clear();
  }

  private cancelPending(messageId: string): void {
    const existing = this.pending.get(messageId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(messageId);
    }
  }
}

/**
 * Leading + trailing throttler for full-snapshot streaming message updates.
 *
 * DSH streams per-token deltas at hundreds of chunks per second while Cowork
 * persists and broadcasts full accumulated text snapshots. Throttling keeps
 * first-token latency at zero (leading edge), caps IPC and SQLite load so
 * control RPCs such as `stopSession` are never head-of-line blocked behind a
 * backlog of streaming frames, and guarantees callers can cancel pending timers
 * before emitting authoritative final updates.
 */
export class DshStreamUpdateThrottler<TEntry extends DshStreamUpdateEntry> {
  private readonly persistLane: ThrottleLane<TEntry>;
  private readonly emitLane: ThrottleLane<TEntry>;
  private readonly messageSessions = new Map<string, string>();

  constructor(options: DshStreamUpdateThrottlerOptions<TEntry>) {
    this.persistLane = new ThrottleLane(
      options.persistIntervalMs ?? DEFAULT_DSH_STREAM_PERSIST_THROTTLE_MS,
      options.onPersist,
    );
    this.emitLane = new ThrottleLane(
      options.emitIntervalMs ?? DEFAULT_DSH_STREAM_EMIT_THROTTLE_MS,
      options.onEmit,
    );
  }

  schedule(entry: TEntry): void {
    this.messageSessions.set(entry.messageId, entry.sessionId);
    this.persistLane.schedule(entry);
    this.emitLane.schedule(entry);
  }

  clearMessage(messageId: string): void {
    this.persistLane.clear(messageId);
    this.emitLane.clear(messageId);
    this.messageSessions.delete(messageId);
  }

  clearSession(sessionId: string): void {
    for (const [messageId, ownerSessionId] of [...this.messageSessions.entries()]) {
      if (ownerSessionId === sessionId) {
        this.clearMessage(messageId);
      }
    }
  }

  clearAll(): void {
    this.persistLane.clearAll();
    this.emitLane.clearAll();
    this.messageSessions.clear();
  }
}
