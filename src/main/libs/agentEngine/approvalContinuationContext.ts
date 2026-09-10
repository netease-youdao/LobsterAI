import { AsyncLocalStorage } from 'node:async_hooks';
const guards = new AsyncLocalStorage<() => void>();
/** Keeps the original approval owner/run guard through asynchronous prompt and gateway setup. */
export function withApprovalContinuationGuard<T>(guard: () => void, operation: () => T): T {
  return guards.run(guard, operation);
}
export function assertApprovalContinuationAllowed(): void { guards.getStore()?.(); }
