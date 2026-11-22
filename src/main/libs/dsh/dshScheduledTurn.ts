import {
  DeliveryMode,
  PayloadKind,
  RunDeliveryStatus,
} from '../../../scheduledTask/constants';
import type { ScheduledTask } from '../../../scheduledTask/types';
import type { LobsterSchedulerRunResult } from '../../scheduledTask/lobsterScheduler';
import type { DshCoworkStorePort, DshRuntimeAdapter } from '../agentEngine/dshRuntimeAdapter';

type ScheduledRuntime = Pick<DshRuntimeAdapter, 'on' | 'off' | 'startSession' | 'stopSession'>;

export interface ExecuteDshScheduledTaskDeps {
  hostManager: {
    isReady(): boolean;
    start(): Promise<void>;
  };
  runtimeAdapter: ScheduledRuntime;
  coworkStore: Pick<DshCoworkStorePort, 'getSession'> & {
    createSession?: (
      title: string,
      cwd: string,
      systemPrompt?: string,
      executionMode?: 'auto' | 'local' | 'sandbox',
      activeSkillIds?: string[],
      agentId?: string,
      modelOverride?: string,
      options?: { scheduledTaskId?: string | null },
    ) => { id: string };
  };
  getDefaultCwd: (agentId?: string) => string;
  channelsBridge?: {
    sendProactiveMessage(params: {
      platform: string;
      instanceId?: string;
      chatId: string;
      text: string;
    }): Promise<unknown>;
  } | null;
  channelsBundleDir?: string | null;
  webhookTimeoutMs?: number;
}

export interface RunScheduledTurnOptions {
  timeoutSeconds?: number;
  timeoutMs?: number;
}

export interface ScheduledTaskWebhookPayload {
  taskId: string;
  taskName: string;
  sessionId: string;
  summary: string;
  text: string;
  completedAt: string;
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 15_000;
const MAX_WEBHOOK_ERROR_SNIPPET = 300;

function resolveTimeoutMs(options?: RunScheduledTurnOptions): { timeoutMs?: number; label?: string } {
  if (
    typeof options?.timeoutMs === 'number'
    && Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
  ) {
    const ms = Math.max(1, Math.round(options.timeoutMs));
    return { timeoutMs: ms, label: ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms` };
  }
  if (
    typeof options?.timeoutSeconds === 'number'
    && Number.isFinite(options.timeoutSeconds)
    && options.timeoutSeconds > 0
  ) {
    return {
      timeoutMs: Math.max(1, Math.round(options.timeoutSeconds * 1000)),
      label: `${options.timeoutSeconds}s`,
    };
  }
  return {};
}

/** The start call submits a turn. Its completion, failure and chat-side stop arrive as session events. */
export async function runScheduledTurn(
  runtime: ScheduledRuntime,
  sessionId: string,
  agentId: string,
  prompt: string,
  signal: AbortSignal,
  options?: RunScheduledTurnOptions,
): Promise<boolean> {
  if (signal.aborted) return true;
  const { timeoutMs, label } = resolveTimeoutMs(options);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      runtime.off('complete', complete);
      runtime.off('error', fail);
      runtime.off('sessionStopped', stopped);
      signal.removeEventListener('abort', abort);
    };
    const complete = (id: string) => {
      if (settled || id !== sessionId) return;
      settled = true;
      cleanup();
      resolve(false);
    };
    const stopped = (id: string) => {
      if (settled || id !== sessionId) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = (id: string, message: string) => {
      if (settled || id !== sessionId) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const abort = () => {
      if (settled) return;
      try {
        runtime.stopSession(sessionId);
        stopped(sessionId);
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    };

    runtime.on('complete', complete);
    runtime.on('error', fail);
    runtime.on('sessionStopped', stopped);
    signal.addEventListener('abort', abort, { once: true });

    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          runtime.stopSession(sessionId);
        } catch {
          // Best-effort cancellation of timed-out DSH turn.
        }
        reject(new Error(`Scheduled task timed out after ${label}`));
      }, timeoutMs);
    }

    void runtime.startSession(sessionId, prompt, { agentId, autoApprove: true }).catch(error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

/**
 * Deliver a scheduled task completion payload to an HTTP(S) webhook endpoint.
 */
export async function deliverScheduledTaskWebhook(
  rawUrl: string | undefined,
  payload: ScheduledTaskWebhookPayload,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<void> {
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!url) {
    throw new Error('Webhook delivery URL is missing');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Webhook URL must use http or https protocol: "${url}"`);
  }

  const timeoutMs =
    typeof options?.timeoutMs === 'number'
    && Number.isFinite(options.timeoutMs)
    && options.timeoutMs > 0
      ? Math.max(1, Math.round(options.timeoutMs))
      : DEFAULT_WEBHOOK_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    controller.abort(options?.signal?.reason ?? new Error('Webhook delivery aborted'));
  };
  if (options?.signal) {
    if (options.signal.aborted) {
      onParentAbort();
    } else {
      options.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Webhook delivery timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(parsed.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'LobsterAI-Scheduler/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const snippet = bodyText.trim().slice(0, MAX_WEBHOOK_ERROR_SNIPPET);
      throw new Error(
        `Webhook returned HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
      );
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`Webhook delivery timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Full execution handler for `LobsterScheduler` backed by DSH:
 * creates a `[定时]` Cowork session carrying `modelOverride` & `scheduledTaskId`,
 * runs the auto-approved turn with `timeoutSeconds`, and performs Announce or
 * Webhook delivery.
 */
export async function executeDshScheduledTask(
  deps: ExecuteDshScheduledTaskDeps,
  task: ScheduledTask,
  signal: AbortSignal,
): Promise<LobsterSchedulerRunResult> {
  signal.throwIfAborted();
  if (!deps.hostManager.isReady()) {
    await deps.hostManager.start();
  }
  signal.throwIfAborted();

  const { payload } = task;
  const promptText = payload.kind === PayloadKind.AgentTurn ? payload.message : payload.text;
  const modelOverride =
    payload.kind === PayloadKind.AgentTurn
    && typeof payload.model === 'string'
    && payload.model.trim().length > 0
      ? payload.model.trim()
      : undefined;
  const timeoutSeconds =
    payload.kind === PayloadKind.AgentTurn
    && typeof payload.timeoutSeconds === 'number'
    && Number.isFinite(payload.timeoutSeconds)
    && payload.timeoutSeconds > 0
      ? payload.timeoutSeconds
      : undefined;

  const agentId = task.agentId || 'main';
  const cwd = deps.getDefaultCwd(agentId);

  const sessionId = deps.coworkStore.createSession?.(
    `[定时] ${task.name}`,
    cwd,
    undefined,
    'auto',
    undefined,
    agentId,
    modelOverride,
    { scheduledTaskId: task.id },
  ).id;
  if (!sessionId) throw new Error('Unable to create a Cowork session for the scheduled task.');

  let stopped = false;
  try {
    stopped = await runScheduledTurn(
      deps.runtimeAdapter,
      sessionId,
      agentId,
      promptText,
      signal,
      { timeoutSeconds },
    );
  } catch (error) {
    if (signal.aborted) {
      return { sessionId, stopped: true, deliveryStatus: RunDeliveryStatus.NotRequested };
    }
    return {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
      deliveryStatus: RunDeliveryStatus.NotRequested,
    };
  }
  if (stopped || signal.aborted) {
    return { sessionId, stopped: true, deliveryStatus: RunDeliveryStatus.NotRequested };
  }

  const session = deps.coworkStore.getSession(sessionId);
  const lastAssistant = [...(session?.messages ?? [])]
    .reverse()
    .find((m) => m.type === 'assistant' && m.content.trim().length > 0);
  const summary = lastAssistant?.content.trim() ?? '';

  let deliveryStatus: RunDeliveryStatus = RunDeliveryStatus.NotRequested;
  let deliveryError: string | null = null;
  if (
    task.delivery.mode === DeliveryMode.Announce
    && task.delivery.channel
    && task.delivery.to
    && deps.channelsBundleDir
    && deps.channelsBridge
  ) {
    try {
      await deps.channelsBridge.sendProactiveMessage({
        platform: task.delivery.channel,
        instanceId: task.delivery.accountId,
        chatId: task.delivery.to,
        text: summary || `[${task.name}] Completed.`,
      });
      deliveryStatus = RunDeliveryStatus.Delivered;
    } catch (error) {
      deliveryStatus = RunDeliveryStatus.NotDelivered;
      deliveryError = error instanceof Error ? error.message : String(error);
    }
  } else if (task.delivery.mode === DeliveryMode.Webhook) {
    try {
      await deliverScheduledTaskWebhook(
        task.delivery.to,
        {
          taskId: task.id,
          taskName: task.name,
          sessionId,
          summary,
          text: summary || `[${task.name}] Completed.`,
          completedAt: new Date().toISOString(),
        },
        { timeoutMs: deps.webhookTimeoutMs, signal },
      );
      deliveryStatus = RunDeliveryStatus.Delivered;
    } catch (error) {
      deliveryStatus = RunDeliveryStatus.NotDelivered;
      deliveryError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    sessionId,
    summary,
    deliveryStatus,
    deliveryError,
  };
}
