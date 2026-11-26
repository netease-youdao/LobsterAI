import { type ChildProcess, fork } from 'child_process';
import { randomUUID } from 'crypto';

import { remotePerformance, RemotePerformanceEvent as PerformanceEvent, RemotePerformanceOutcome as PerformanceOutcome, RemotePerformanceReason as PerformanceReason, RemotePerformanceStage as PerformanceStage } from './remotePerformanceLog';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

interface HistoryReply<T> { jobId: string; result?: T; error?: string }
/** Encoding has a separate OS process: native heap failure and cancellation cannot kill the control runtime. */
export class RemoteHistoryJob {
  private child: ChildProcess | null = null;
  private cancelCurrent: (() => void) | null = null;
  constructor(private readonly guardPath = remoteWorkerPath(RemoteWorkerFile.HistoryGuard)) {}
  cancel(): void { this.cancelCurrent?.(); }

  run<T>(workerPath: string, input: unknown, options: {
    timeoutMs: number; memoryMb: number; current: () => boolean; prefix: 'REMOTE_PROJECTION' | 'REMOTE_IMPORT' | 'REMOTE_LIVE_ENCODER' | 'REMOTE_DISPLAY_HEALTH';
    resultLimitBytes?: number;
  }): Promise<T> {
    const current = (): boolean => { try { return options.current(); } catch { return false; } };
    if (this.child || !current()) return Promise.reject(new Error(`${options.prefix}_CONTEXT_CHANGED`));
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) return Promise.reject(new Error(`${options.prefix}_BUDGET`));
    return new Promise((resolve, reject) => {
      const jobId = randomUUID();
      const stage = options.prefix === 'REMOTE_PROJECTION' ? PerformanceStage.ProjectionWorker : options.prefix === 'REMOTE_IMPORT' ? PerformanceStage.ImportWorker
        : options.prefix === 'REMOTE_LIVE_ENCODER' ? PerformanceStage.LiveWorker : PerformanceStage.DisplayWorker;
      const startedAt = performance.now(), finishDiagnostic = remotePerformance.begin(stage);
      let child: ChildProcess;
      try { child = fork(workerPath, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: [`--max-old-space-size=${options.memoryMb}`, '--require', this.guardPath],
        // fd 4 belongs to this exact parent lifetime, avoiding PID reuse and orphan writers.
        stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'overlapped'], serialization: 'json',
      }); } catch (error) { finishDiagnostic(PerformanceOutcome.Failed, { reason: PerformanceReason.Spawn }); throw error; }
      remotePerformance.event(stage, PerformanceEvent.Spawn, { workerPid: child.pid, reason: PerformanceReason.Spawn });
      this.child = child;
      let settled = false, killStartedAt: number | undefined;
      const finish = (error: Error | null, value?: T, reason: PerformanceReason = PerformanceReason.None): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(guard);
        if (reason === PerformanceReason.Aborted || reason === PerformanceReason.ContextChanged) remotePerformance.event(stage, PerformanceEvent.Instant,
          { workerPid: child.pid, reason, outcome: PerformanceOutcome.Cancelled, elapsedMs: performance.now() - startedAt });
        const complete = (): void => {
          if (this.child === child) { this.child = null; this.cancelCurrent = null; }
          const fields = { workerPid: child.pid, reason, ...(killStartedAt !== undefined ? { exitWaitMs: performance.now() - killStartedAt } : {}) };
          if (error) {
            finishDiagnostic(reason === PerformanceReason.Aborted || reason === PerformanceReason.ContextChanged ? PerformanceOutcome.Cancelled : PerformanceOutcome.Failed, fields);
            reject(error);
          } else if (!current()) {
            finishDiagnostic(PerformanceOutcome.Cancelled, { ...fields, reason: PerformanceReason.ContextChanged });
            reject(new Error(`${options.prefix}_CONTEXT_CHANGED`));
          } else { finishDiagnostic(PerformanceOutcome.Succeeded, fields); resolve(value!); }
        };
        // Do not release the encoding lane while a timed-out child is still consuming memory or holding a read transaction.
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) complete();
        else { child.once('exit', complete); killStartedAt = performance.now(); child.kill('SIGKILL'); }
      };
      const timer = setTimeout(() => finish(new Error(`${options.prefix}_BUDGET`), undefined, PerformanceReason.Timeout), options.timeoutMs);
      const guard = setInterval(() => { if (!current()) finish(new Error(`${options.prefix}_CONTEXT_CHANGED`), undefined, PerformanceReason.ContextChanged); }, 100);
      this.cancelCurrent = () => finish(new Error(`${options.prefix}_CONTEXT_CHANGED`), undefined, PerformanceReason.Aborted);
      child.once('message', (message: HistoryReply<T>) => {
        if (!message || message.jobId !== jobId || Buffer.byteLength(JSON.stringify(message)) > (options.resultLimitBytes ?? 2 * 1024 * 1024))
          finish(new Error(`${options.prefix}_INVALID_RESULT`), undefined, PerformanceReason.InvalidResult);
        else if (message.error) finish(new Error(message.error), undefined, PerformanceReason.ChildError);
        else if (!Object.prototype.hasOwnProperty.call(message, 'result')) finish(new Error(`${options.prefix}_INVALID_RESULT`), undefined, PerformanceReason.InvalidResult);
        else finish(null, message.result);
      });
      child.once('error', error => finish(error, undefined, PerformanceReason.ChildError));
      child.once('exit', (code, signal) => {
        remotePerformance.event(stage, PerformanceEvent.Exit, { workerPid: child.pid, exitCode: code ?? undefined, elapsedMs: performance.now() - startedAt,
          ...(killStartedAt !== undefined ? { killToExitMs: performance.now() - killStartedAt } : {}), reason: PerformanceReason.WorkerExit });
        finish(new Error(`${options.prefix}_${signal === 'SIGABRT' ? 'BUDGET' : 'WORKER_EXIT'}`), undefined, signal === 'SIGABRT' ? PerformanceReason.Budget : PerformanceReason.WorkerExit);
      });
      child.send({ type: 'remote.history.job', jobId, input }, error => { if (error) finish(error, undefined, PerformanceReason.IpcError); });
    });
  }
}
