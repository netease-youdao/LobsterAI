/** How long selection-hook may take to read a selection after its gesture, a simulated copy included. */
export const SELECTION_MISS_WAIT_MS = 2_000;
// The release and the selection arrive through separate native queues; a selection reported just
// before its release was handled still belongs to it.
const EARLY_SELECTION_MS = 200;

/**
 * Notices selecting gestures over text that no readable selection followed: the app did not give
 * selection-hook its text. One gesture is watched at a time; a newer one replaces it.
 */
export class SelectionMissTracker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolvedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly onMiss: (appId: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A selecting gesture over text in this app just ended. */
  expect(appId: string): void {
    this.cancel();
    if (this.now() - this.resolvedAt < EARLY_SELECTION_MS) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onMiss(appId);
    }, SELECTION_MISS_WAIT_MS);
  }

  /** A selection with text arrived, whether or not it was shown. */
  resolve(): void {
    this.resolvedAt = this.now();
    this.cancel();
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
