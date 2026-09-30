import { remoteDiagnosticLog } from './remoteSyncLog';

/** Recover the queue after failure without releasing the latest execution barrier. */
export class RemoteAccountTransition {
  private tail: Promise<void> = Promise.resolve();
  private barrier: Promise<void> = Promise.resolve();
  private generation = 0;

  run(action: (current: () => boolean) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    const operation = this.tail.then(async () => {
      const current = (): boolean => generation === this.generation;
      if (!current()) return;
      remoteDiagnosticLog('desktop.account_transition.changed', { generation: String(generation), result: 'fencing' }, 'info');
      try {
        await action(current);
        if (current()) remoteDiagnosticLog('desktop.account_transition.changed', { generation: String(generation), result: 'success' }, 'info');
      } catch (error) {
        remoteDiagnosticLog('desktop.account_transition.changed', { generation: String(generation), result: 'unknown', reason: 'EXECUTION_UNKNOWN' }, 'error');
        throw error;
      }
    });
    this.barrier = operation;
    this.tail = operation.catch((): void => undefined);
    return operation;
  }

  async wait(): Promise<void> {
    while (true) {
      const barrier = this.barrier;
      try { await barrier; }
      catch (error) { if (barrier === this.barrier) throw error; }
      if (barrier === this.barrier) return;
    }
  }
}
