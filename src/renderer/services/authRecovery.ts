const AUTH_RECOVERY_DELAYS_MS = [1_000, 3_000, 8_000, 30_000, 60_000] as const;

/** Serializes recovery signals and retries temporary failures until resolved. */
export class AuthRecovery {
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued = false;
  private generation = 0;
  private attempt = 0;

  constructor(private readonly options: {
    recover: () => Promise<void>;
    shouldRetry: () => boolean;
    onError: (error: unknown) => void;
  }) {}

  request(): Promise<void> {
    this.clearTimer();
    if (this.pending) {
      this.queued = true;
      return this.pending;
    }
    const generation = this.generation;
    const pending = Promise.resolve().then(async () => {
      do {
        if (generation !== this.generation) return;
        this.queued = false;
        try {
          await this.options.recover();
        } catch (error) {
          this.options.onError(error);
        }
      } while (generation === this.generation && this.queued && this.options.shouldRetry());
    }).finally(() => {
      if (generation !== this.generation) return;
      this.pending = null;
      this.schedule();
    });
    this.pending = pending;
    return pending;
  }

  schedule(): void {
    if (!this.options.shouldRetry()) {
      this.attempt = 0;
      this.clearTimer();
      return;
    }
    if (this.pending || this.timer) return;
    const delay = AUTH_RECOVERY_DELAYS_MS[Math.min(this.attempt++, AUTH_RECOVERY_DELAYS_MS.length - 1)];
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.request();
    }, delay);
  }

  cancel(): void {
    this.generation += 1;
    this.pending = null;
    this.queued = false;
    this.attempt = 0;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
