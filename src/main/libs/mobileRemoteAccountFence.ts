import { RemoteAccountTransition } from '../remote/remoteAccountTransition';

type Isolate = (current: () => boolean) => Promise<void>;

/** Retry isolation of the latest identity. A failed or superseded attempt never releases the barrier. */
export class MobileRemoteAccountFence {
  private action: Isolate | undefined;
  private pending: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private attempts = 0;

  constructor(private readonly transition: RemoteAccountTransition) {}

  change(action: Isolate): void {
    this.dispose();
    this.action = action;
    void this.run().catch((): void => undefined);
  }

  retry(): Promise<void> {
    this.attempts = 0;
    return this.pending ?? this.run();
  }

  private run(): Promise<void> {
    clearTimeout(this.retryTimer);
    if (!this.action) return Promise.resolve();
    const revision = this.revision;
    const work = this.transition.run(this.action);
    this.pending = work;
    void work.then(() => {
      if (this.revision === revision) this.dispose();
    }, error => {
      if (this.revision !== revision) return;
      this.pending = undefined;
      console.warn('[RemoteAccount] Account isolation requires recovery', error);
      if (this.attempts++ < 3) {
        this.retryTimer = setTimeout(() => { void this.run().catch((): void => undefined); }, 1000 * 2 ** this.attempts);
        this.retryTimer.unref?.();
      }
    });
    return work;
  }

  dispose(): void {
    this.revision++;
    clearTimeout(this.retryTimer);
    this.action = undefined;
    this.pending = undefined;
    this.attempts = 0;
  }
}
