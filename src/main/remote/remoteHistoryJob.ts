import { type ChildProcess, fork } from 'child_process';
import { randomUUID } from 'crypto';

interface HistoryReply<T> { jobId: string; result?: T; error?: string }
/** Encoding has a separate OS process: native heap failure and cancellation cannot kill the control runtime. */
export class RemoteHistoryJob {
  private child: ChildProcess | null = null;
  private cancelCurrent: (() => void) | null = null;
  cancel(): void { this.cancelCurrent?.(); }

  run<T>(workerPath: string, input: unknown, options: {
    timeoutMs: number; memoryMb: number; current: () => boolean; prefix: 'REMOTE_PROJECTION' | 'REMOTE_IMPORT' | 'REMOTE_LIVE_ENCODER';
    resultLimitBytes?: number;
  }): Promise<T> {
    const current = (): boolean => { try { return options.current(); } catch { return false; } };
    if (this.child || !current()) return Promise.reject(new Error(`${options.prefix}_CONTEXT_CHANGED`));
    if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) return Promise.reject(new Error(`${options.prefix}_BUDGET`));
    return new Promise((resolve, reject) => {
      const jobId = randomUUID();
      const child = fork(workerPath, [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [`--max-old-space-size=${options.memoryMb}`],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
      this.child = child;
      let settled = false;
      const finish = (error: Error | null, value?: T): void => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(guard);
        const complete = (): void => {
          if (this.child === child) { this.child = null; this.cancelCurrent = null; }
          if (error) reject(error);
          else if (!current()) reject(new Error(`${options.prefix}_CONTEXT_CHANGED`));
          else resolve(value!);
        };
        // Do not release the encoding lane while a timed-out child is still consuming memory or holding a read transaction.
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) complete();
        else { child.once('exit', complete); child.kill('SIGKILL'); }
      };
      const timer = setTimeout(() => finish(new Error(`${options.prefix}_BUDGET`)), options.timeoutMs);
      const guard = setInterval(() => { if (!current()) finish(new Error(`${options.prefix}_CONTEXT_CHANGED`)); }, 100);
      this.cancelCurrent = () => finish(new Error(`${options.prefix}_CONTEXT_CHANGED`));
      child.once('message', (message: HistoryReply<T>) => {
        if (!message || message.jobId !== jobId || Buffer.byteLength(JSON.stringify(message)) > (options.resultLimitBytes ?? 2 * 1024 * 1024))
          finish(new Error(`${options.prefix}_INVALID_RESULT`));
        else if (message.error) finish(new Error(message.error));
        else if (!Object.prototype.hasOwnProperty.call(message, 'result')) finish(new Error(`${options.prefix}_INVALID_RESULT`));
        else finish(null, message.result);
      });
      child.once('error', error => finish(error));
      child.once('exit', (_code, signal) => finish(new Error(`${options.prefix}_${signal === 'SIGABRT' ? 'BUDGET' : 'WORKER_EXIT'}`)));
      child.send({ type: 'remote.history.job', jobId, input }, error => { if (error) finish(error); });
    });
  }
}
