interface LoginExchangeContext {
  signal: AbortSignal;
  isCurrent: () => boolean;
}

interface PendingExchange {
  controller: AbortController;
  settled: Promise<void>;
}

/** Cancelling or retrying must settle an old exchange before another snapshots credentials. */
export class AuthLoginAttempt {
  private generation = 0;
  private cancelled = false;
  private exchange: PendingExchange | null = null;

  begin(): number {
    this.generation += 1;
    this.cancelled = false;
    this.exchange?.controller.abort();
    return this.generation;
  }

  cancel(): void {
    this.generation += 1;
    this.cancelled = true;
    this.exchange?.controller.abort();
  }

  acceptsCallback(): boolean {
    return !this.cancelled;
  }

  isCurrent(generation: number): boolean {
    return !this.cancelled && this.generation === generation;
  }

  async waitForExchange(): Promise<void> {
    await this.exchange?.settled;
  }

  async runExchange<T>(operation: (context: LoginExchangeContext) => Promise<T>): Promise<T> {
    const generation = this.generation;
    const previous = this.exchange;
    let finish = () => {};
    const exchange: PendingExchange = {
      controller: new AbortController(),
      settled: new Promise<void>(resolve => { finish = resolve; }),
    };
    this.exchange = exchange;
    previous?.controller.abort();
    const isCurrent = () => this.exchange === exchange
      && !exchange.controller.signal.aborted && this.isCurrent(generation);
    try {
      await previous?.settled;
      if (!isCurrent()) throw new Error('Login was cancelled or replaced');
      return await operation({ signal: exchange.controller.signal, isCurrent });
    } finally {
      if (this.exchange === exchange) this.exchange = null;
      finish();
    }
  }
}
