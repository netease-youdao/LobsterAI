/**
 * Wall-clock time keeps running while the machine sleeps, so a wait measured
 * with Date.now() expires on the first check after wake even though the
 * process it waits on was frozen as well. AwakeClock counts only the time this
 * process was observably running: a gap between two observations far beyond
 * the caller's own check interval is a suspension (sleep, hibernation, a frozen
 * machine) and is left out. Callers observe at least every few seconds.
 */
export const SUSPENSION_GAP_MS = 15_000;

export class AwakeClock {
  private lastObservedAt: number;
  private awake = 0;
  private suspended = 0;

  constructor(startedAt: number, private readonly suspensionGapMs: number = SUSPENSION_GAP_MS) {
    this.lastObservedAt = startedAt;
  }

  /** Records an observation at `now` and returns the awake time since the start. */
  observe(now: number): number {
    const gap = now - this.lastObservedAt;
    this.lastObservedAt = now;
    if (gap > this.suspensionGapMs) {
      this.suspended += gap;
    } else if (gap > 0) {
      // A wall clock set backwards (negative gap) adds nothing.
      this.awake += gap;
    }
    return this.awake;
  }

  get awakeMs(): number {
    return this.awake;
  }

  /** Wall-clock time left out as suspension so far. */
  get suspendedMs(): number {
    return this.suspended;
  }
}
