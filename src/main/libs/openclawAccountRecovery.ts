export const AccountRecoveryPhase = {
  Fencing: 'fencing',
  WaitingAuth: 'waiting_auth_commit',
  Preparing: 'preparing_config',
  Starting: 'starting',
  Confirming: 'confirming',
  Complete: 'complete',
  Stopped: 'stopped',
  Failed: 'failed',
} as const;
export type AccountRecoveryPhase = typeof AccountRecoveryPhase[keyof typeof AccountRecoveryPhase];

export class AccountRecoveryCancelledError extends Error {
  constructor() {
    super('Account gateway recovery was superseded.');
    this.name = 'AccountRecoveryCancelledError';
  }
}

export interface AccountRecoveryContext {
  id: number;
  identity: string;
  isCurrent(): boolean;
  assertCurrent(): void;
}

export interface AccountRecoveryState {
  id: number;
  phase: AccountRecoveryPhase;
  attempt: number;
  error?: string;
}

interface RecoveryRequest {
  resume: boolean;
  fence(context: AccountRecoveryContext): Promise<void>;
}

interface RecoveryOperation extends AccountRecoveryContext, RecoveryRequest {
  controller: AbortController;
  promise: Promise<void>;
  phase: AccountRecoveryPhase;
  attempt: number;
  isolated: boolean;
  preparedRevision: number | null;
  settled: boolean;
  error?: string;
}

interface Dependencies {
  identity(): string;
  canRun(): boolean;
  allowCredentials(): void;
  prepare(context: AccountRecoveryContext): Promise<void>;
  start(context: AccountRecoveryContext): Promise<void>;
  confirm(context: AccountRecoveryContext): Promise<void>;
  complete(context: AccountRecoveryContext): void;
  changed(state: AccountRecoveryState): void;
  canRetry(error: unknown): boolean;
  retryDelayMs?(): number;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
const AUTH_COMMIT_TIMEOUT_MS = 30_000;

/** Owns recovery, not auth persistence, config RPCs or the gateway's process state. */
export class OpenClawAccountRecovery {
  private sequence = 0;
  private mutationRevision = 0;
  private mutationPending = false;
  private mutationError: Error | null = null;
  private authChanged = new Set<() => void>();
  private operation: RecoveryOperation | null = null;
  private cancelled = false;

  constructor(private readonly deps: Dependencies) {}

  get authRevision(): number { return this.mutationRevision; }
  get authMutationPending(): boolean { return this.mutationPending; }

  beginAuthMutation(): number {
    this.mutationPending = true;
    this.mutationError = null;
    if (this.active && this.operation) this.operation.preparedRevision = null;
    this.notifyAuthChanged();
    return ++this.mutationRevision;
  }

  isAuthMutationCurrent(revision: number): boolean {
    return revision === this.mutationRevision;
  }

  commitAuthMutation(revision: number): void {
    if (!this.isAuthMutationCurrent(revision)) return;
    this.mutationPending = false;
    this.mutationError = null;
    this.notifyAuthChanged();
  }

  failAuthMutation(revision: number, error: Error): void {
    if (!this.isAuthMutationCurrent(revision) || !this.mutationPending) return;
    this.mutationError = error;
    this.notifyAuthChanged();
  }

  get active(): boolean {
    return !this.cancelled && !!this.operation && this.operation.phase !== AccountRecoveryPhase.Complete
      && this.operation.phase !== AccountRecoveryPhase.Stopped;
  }

  get state(): AccountRecoveryState | null {
    const op = this.operation;
    return op ? { id: op.id, phase: op.phase, attempt: op.attempt, error: op.error } : null;
  }

  async waitForAuthState(): Promise<void> {
    await this.waitForAuthCommit(this.operation ?? {
      controller: new AbortController(), isCurrent: () => true,
    });
  }

  request(request: RecoveryRequest): Promise<void> {
    const previous = this.operation;
    previous?.controller.abort();
    this.cancelled = false;
    const id = ++this.sequence;
    const identity = this.deps.identity();
    const controller = new AbortController();
    const op: RecoveryOperation = {
      ...request,
      resume: request.resume || (!!previous?.resume && this.active),
      id, identity, controller,
      phase: AccountRecoveryPhase.Fencing, attempt: 0, isolated: false, preparedRevision: null, settled: false,
      promise: Promise.resolve(),
      isCurrent: () => this.operation === op && !controller.signal.aborted
        && !this.cancelled && identity === this.deps.identity(),
      assertCurrent: () => { if (!op.isCurrent()) throw new AccountRecoveryCancelledError(); },
    };
    this.operation = op;
    this.publish(op, AccountRecoveryPhase.Fencing);
    op.promise = this.run(op).finally(() => { op.settled = true; });
    // Callers may observe through wait(); fire-and-forget account listeners are safe.
    void op.promise.catch(() => {});
    return op.promise;
  }

  retry(): Promise<void> {
    const op = this.operation;
    if (!op || this.cancelled) return Promise.resolve();
    if (!op.settled || op.phase !== AccountRecoveryPhase.Failed) return this.wait();
    op.attempt = 0;
    op.settled = false;
    this.publish(op, AccountRecoveryPhase.WaitingAuth);
    op.promise = this.run(op).finally(() => { op.settled = true; });
    void op.promise.catch(() => {});
    return op.promise;
  }

  cancel(): void {
    if (this.operation) {
      this.operation.resume = false;
      this.publish(this.operation, AccountRecoveryPhase.Stopped);
    }
    this.cancelled = true;
    this.operation?.controller.abort();
    this.notifyAuthChanged();
  }

  /** Synchronous, immutable lease. The manager must never await the account fence. */
  captureStartPermit(): (() => boolean) | null {
    if (this.cancelled || this.mutationPending || !this.deps.canRun()) return null;
    const op = this.operation;
    // An already admitted same-owner process keeps its last committed inputs
    // during a profile refresh (including its crash retry). Only new admission
    // waits for the mutation. A real identity change replaces the operation.
    if (!op) return () => !this.cancelled && this.operation === null && this.deps.canRun();
    if (op.preparedRevision === null || !op.isCurrent()) return null;
    return () => op.isCurrent() && op.preparedRevision !== null && this.deps.canRun();
  }

  requestRunning(): void {
    const op = this.operation;
    if (!op || this.cancelled || !op.isCurrent()) return;
    op.resume = true;
    if (op.phase === AccountRecoveryPhase.Stopped && op.settled) {
      op.settled = false;
      this.publish(op, AccountRecoveryPhase.WaitingAuth);
      op.promise = this.run(op).finally(() => { op.settled = true; });
      void op.promise.catch(() => {});
    }
  }

  /** External callers wait before taking the adapter initialization lock. */
  async wait(): Promise<void> {
    while (this.operation) {
      const op = this.operation;
      try { await op.promise; } catch (error) {
        if (this.operation === op) throw error;
      }
      if (this.operation === op) return;
    }
  }

  private publish(op: RecoveryOperation, phase: AccountRecoveryPhase, error?: unknown): void {
    if (!op.isCurrent()) return;
    op.phase = phase;
    op.error = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    this.deps.changed({ id: op.id, phase, attempt: op.attempt, error: op.error });
  }

  private async run(op: RecoveryOperation): Promise<void> {
    while (op.isCurrent()) {
      try {
        if (!op.isolated) {
          this.publish(op, AccountRecoveryPhase.Fencing);
          await op.fence(op);
          op.assertCurrent();
          op.isolated = true;
        }
        this.publish(op, AccountRecoveryPhase.WaitingAuth);
        await this.waitForAuthCommit(op);
        op.assertCurrent();
        this.deps.allowCredentials();
        if (!this.deps.canRun()) throw new AccountRecoveryCancelledError();
        if (op.preparedRevision !== this.mutationRevision) {
          this.publish(op, AccountRecoveryPhase.Preparing);
          const revision = this.mutationRevision;
          await this.deps.prepare(op);
          op.assertCurrent();
          if (this.mutationPending || revision !== this.mutationRevision) continue;
          op.preparedRevision = revision;
        }
        if (!op.resume) {
          this.publish(op, AccountRecoveryPhase.Stopped);
          return;
        }
        this.publish(op, AccountRecoveryPhase.Starting);
        await this.deps.start(op);
        op.assertCurrent();
        if (this.mutationPending || op.preparedRevision !== this.mutationRevision) continue;
        this.publish(op, AccountRecoveryPhase.Confirming);
        await this.deps.confirm(op);
        op.assertCurrent();
        if (this.mutationPending || op.preparedRevision !== this.mutationRevision) continue;
        this.deps.complete(op);
        this.publish(op, AccountRecoveryPhase.Complete);
        return;
      } catch (error) {
        if (!op.isCurrent()) throw new AccountRecoveryCancelledError();
        if (this.mutationPending && !this.mutationError && op.phase !== AccountRecoveryPhase.WaitingAuth) continue;
        this.publish(op, AccountRecoveryPhase.Failed, error);
        if (error instanceof AccountRecoveryCancelledError || this.mutationError
          || !this.deps.canRetry(error) || op.attempt >= RETRY_DELAYS_MS.length) throw error;
        const delay = Math.max(RETRY_DELAYS_MS[op.attempt++], this.deps.retryDelayMs?.() ?? 0);
        await this.pause(op, delay);
      }
    }
    throw new AccountRecoveryCancelledError();
  }

  private notifyAuthChanged(): void {
    for (const notify of this.authChanged) notify();
  }

  private async waitForAuthCommit(op: Pick<RecoveryOperation, 'controller' | 'isCurrent'>): Promise<void> {
    if (this.mutationError) throw this.mutationError;
    if (!this.mutationPending) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.authChanged.delete(check);
        op.controller.signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new AccountRecoveryCancelledError());
      const check = () => {
        if (!op.isCurrent()) cancel();
        else if (this.mutationError) finish(this.mutationError);
        else if (!this.mutationPending) finish();
      };
      const timer = setTimeout(() => finish(new Error('Account state has not finished updating.')), AUTH_COMMIT_TIMEOUT_MS);
      timer.unref?.();
      this.authChanged.add(check);
      op.controller.signal.addEventListener('abort', cancel, { once: true });
      check();
    });
  }

  private pause(op: RecoveryOperation, delay: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(new AccountRecoveryCancelledError()); };
      const timer = setTimeout(() => {
        op.controller.signal.removeEventListener('abort', cancel);
        resolve();
      }, delay);
      timer.unref?.();
      op.controller.signal.addEventListener('abort', cancel, { once: true });
      if (!op.isCurrent()) cancel();
    });
  }
}
