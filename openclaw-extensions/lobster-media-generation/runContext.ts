import { isLobsterAiDesktopSessionKey } from './sessionKey';

// Authenticated loopback protocol; never exposed as a model-callable tool.
export const MediaRunLifecycle = {
  Tool: 'lobsterai_media_run',
  Begin: 'begin',
  End: 'end',
} as const;

type RunContext = { sessionKey?: string; runId?: string; jobId?: string; trigger?: string; messageProvider?: string };
type Run = { sessionKey: string; runId: string; desktop: boolean; ready: Promise<boolean> };
const DESKTOP_MESSAGE_PROVIDER = 'webchat';
type LifecycleRequest = {
  tool: string;
  args: { action: string };
  context: { sessionKey: string; runId: string; toolCallId: string };
};

/** Correlate tools using trusted hook metadata, never model-supplied arguments. */
export class MediaRunContexts {
  private readonly runs = new Map<string, Run>();
  private readonly calls = new Map<string, Run>();

  constructor(private readonly send: (request: LifecycleRequest) => Promise<{ isError?: boolean }>) {}

  private key(sessionKey: string, id: string): string {
    return JSON.stringify([sessionKey, id]);
  }

  async begin(context: RunContext): Promise<void> {
    const { sessionKey, runId } = context;
    const scheduled = Boolean(context.jobId) || context.trigger === 'cron';
    if (!sessionKey || !runId) return;
    const key = this.key(sessionKey, runId);
    let run = this.runs.get(key);
    if (!run) {
      // chat.send can continue an IM session from the desktop. Its IPC owner and
      // selected media model remain authoritative even though the key is an IM key.
      const desktop = !scheduled && (isLobsterAiDesktopSessionKey(sessionKey)
        || context.messageProvider === DESKTOP_MESSAGE_PROVIDER);
      const ready = desktop ? Promise.resolve(true) : this.send({
        tool: MediaRunLifecycle.Tool, args: { action: MediaRunLifecycle.Begin },
        context: { sessionKey, runId, toolCallId: runId },
      }).then(result => !result.isError, () => false);
      run = { sessionKey, runId, desktop, ready };
      this.runs.set(key, run);
    }
    await run.ready;
  }

  async bindTool(context: RunContext & { toolCallId?: string }): Promise<boolean> {
    const { sessionKey, runId, toolCallId } = context;
    if (!sessionKey || !runId || !toolCallId) return isLobsterAiDesktopSessionKey(sessionKey);
    const run = this.runs.get(this.key(sessionKey, runId));
    if (!run) return isLobsterAiDesktopSessionKey(sessionKey);
    if (!await run.ready || this.runs.get(this.key(sessionKey, runId)) !== run) return false;
    const callKey = this.key(sessionKey, toolCallId);
    const existing = this.calls.get(callKey);
    if (existing && existing !== run) return false;
    this.calls.set(callKey, run);
    return true;
  }

  forTool(sessionKey: string, toolCallId: string): RunContext {
    const run = this.calls.get(this.key(sessionKey, toolCallId));
    if (!run && isLobsterAiDesktopSessionKey(sessionKey)) return {};
    if (!run) throw new Error('Media tool has no authenticated run context');
    return run.desktop ? {} : { runId: run.runId };
  }

  async end(context: RunContext): Promise<void> {
    const { sessionKey, runId } = context;
    if (!sessionKey || !runId) return;
    const key = this.key(sessionKey, runId);
    const run = this.runs.get(key);
    if (!run) return;
    this.runs.delete(key);
    for (const [callKey, call] of this.calls) {
      if (call === run) this.calls.delete(callKey);
    }
    // Wait for an in-flight begin so a late response cannot resurrect the run.
    await run.ready;
    if (run.desktop) return;
    await this.send({
      tool: MediaRunLifecycle.Tool, args: { action: MediaRunLifecycle.End },
      context: { sessionKey, runId, toolCallId: runId },
    }).catch(() => undefined);
  }
}
