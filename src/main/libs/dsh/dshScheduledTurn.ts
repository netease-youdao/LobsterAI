import type { DshRuntimeAdapter } from '../agentEngine/dshRuntimeAdapter';

type ScheduledRuntime = Pick<DshRuntimeAdapter, 'on' | 'off' | 'startSession' | 'stopSession'>;

/** The start call submits a turn. Its completion, failure and chat-side stop arrive as session events. */
export async function runScheduledTurn(
  runtime: ScheduledRuntime, sessionId: string, agentId: string, prompt: string, signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise<boolean>((resolve, reject) => {
    const complete = (id: string) => {
      if (id !== sessionId) return;
      cleanup();
      resolve(false);
    };
    const stopped = (id: string) => {
      if (id !== sessionId) return;
      cleanup();
      resolve(true);
    };
    const fail = (id: string, message: string) => {
      if (id !== sessionId) return;
      cleanup();
      reject(new Error(message));
    };
    const abort = () => {
      try {
        runtime.stopSession(sessionId);
        stopped(sessionId);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const cleanup = () => {
      runtime.off('complete', complete);
      runtime.off('error', fail);
      runtime.off('sessionStopped', stopped);
      signal.removeEventListener('abort', abort);
    };
    runtime.on('complete', complete);
    runtime.on('error', fail);
    runtime.on('sessionStopped', stopped);
    signal.addEventListener('abort', abort, { once: true });
    void runtime.startSession(sessionId, prompt, { agentId, autoApprove: true }).catch(error => {
      cleanup();
      reject(error);
    });
  });
}
