export type MediaStatusType = 'image' | 'video';

export type MediaStatusResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
};

export type MediaStatusUpdate = {
  content: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

export type MediaStatusPollPolicy = {
  timeoutMs: number;
  fastIntervalMs: number;
  slowIntervalMs: number;
  mediumIntervalMs: number;
  idleIntervalMs: number;
  fastPollCount: number;
  slowPollCount: number;
  mediumPollCount: number;
};

type PollLogger = (message: string) => void;

export type PollMediaStatusOptions = {
  mediaType: MediaStatusType;
  taskId: string;
  toolCallId: string;
  policy: MediaStatusPollPolicy;
  requestStatus: () => Promise<MediaStatusResponse>;
  onUpdate?: (result: MediaStatusUpdate) => void;
  signal?: AbortSignal;
  log?: PollLogger;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const readMediaStatusPollCount = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
);

export const extractMediaStatusResponseText = (response: MediaStatusResponse): string => (
  response.content
    .map(item => item.text)
    .filter(text => typeof text === 'string' && text.trim())
    .join('\n')
    .trim()
);

export const isTerminalMediaStatus = (status: string): boolean => TERMINAL_STATUSES.has(status);

export const getMediaStatusPollInterval = (
  policy: MediaStatusPollPolicy,
  completedPollCount: number,
): number => {
  if (completedPollCount < policy.fastPollCount) return policy.fastIntervalMs;
  if (completedPollCount < policy.fastPollCount + policy.slowPollCount) return policy.slowIntervalMs;
  if (
    completedPollCount
    < policy.fastPollCount + policy.slowPollCount + policy.mediumPollCount
  ) {
    return policy.mediumIntervalMs;
  }
  return policy.idleIntervalMs;
};

const waitForDelay = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(new DOMException('Polling aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Polling aborted.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const buildPollingStoppedResponse = (
  mediaType: MediaStatusType,
  taskId: string,
  upstreamTaskId: string | undefined,
  pollCount: number,
): MediaStatusResponse => ({
  content: [{
    type: 'text',
    text: `${mediaType === 'image' ? 'Image' : 'Video'} status polling stopped. The generation task may still be running.\nTask ID: ${upstreamTaskId || taskId}`,
  }],
  isError: true,
  details: {
    taskId,
    ...(upstreamTaskId ? { upstreamTaskId } : {}),
    status: 'polling_stopped',
    pollCount,
  },
});

const buildPollingTimeoutResponse = (
  mediaType: MediaStatusType,
  taskId: string,
  upstreamTaskId: string | undefined,
  pollCount: number,
  elapsedMs: number,
): MediaStatusResponse => ({
  content: [{
    type: 'text',
    text: `${mediaType === 'image' ? 'Image' : 'Video'} generation timed out after ${Math.max(1, Math.round(elapsedMs / 60_000))} minutes.\nTask ID: ${upstreamTaskId || taskId}\nYou can check status later with action="status".`,
  }],
  isError: true,
  details: {
    taskId,
    ...(upstreamTaskId ? { upstreamTaskId } : {}),
    status: 'timeout',
    pollCount,
  },
});

export async function pollMediaStatus(
  options: PollMediaStatusOptions,
): Promise<MediaStatusResponse> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForDelay;
  const startedAt = now();
  let pollCount = 0;
  let upstreamTaskId: string | undefined;
  let firstStatusOutput: string | undefined;
  let latestReportedPollCount = 0;

  options.log?.(`${options.mediaType} status polling started: toolCallId=${options.toolCallId} taskId=${options.taskId}`);

  while (true) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= options.policy.timeoutMs) {
      options.log?.(`${options.mediaType} status poll timeout: toolCallId=${options.toolCallId} taskId=${options.taskId} elapsedMs=${elapsedMs} pollCount=${pollCount}`);
      return buildPollingTimeoutResponse(
        options.mediaType,
        options.taskId,
        upstreamTaskId,
        latestReportedPollCount || pollCount,
        elapsedMs,
      );
    }

    if (options.signal?.aborted) {
      return buildPollingStoppedResponse(
        options.mediaType,
        options.taskId,
        upstreamTaskId,
        latestReportedPollCount || pollCount,
      );
    }

    if (pollCount > 0) {
      const interval = getMediaStatusPollInterval(options.policy, pollCount - 1);
      const remainingMs = Math.max(0, options.policy.timeoutMs - elapsedMs);
      try {
        await wait(Math.min(interval, remainingMs), options.signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return buildPollingStoppedResponse(
            options.mediaType,
            options.taskId,
            upstreamTaskId,
            latestReportedPollCount || pollCount,
          );
        }
        throw error;
      }
      if (now() - startedAt >= options.policy.timeoutMs) continue;
    }

    pollCount++;

    try {
      const statusResult = await options.requestStatus();
      const statusDetails = statusResult.details ?? {};
      const currentStatus = typeof statusDetails.status === 'string'
        ? statusDetails.status
        : undefined;
      if (statusResult.isError && !currentStatus) {
        throw new Error(
          extractMediaStatusResponseText(statusResult) || 'Status request failed without a task status.',
        );
      }
      const effectiveStatus = currentStatus;
      const reportedPollCount = readMediaStatusPollCount(statusDetails.pollCount) ?? pollCount;
      latestReportedPollCount = Math.max(latestReportedPollCount, reportedPollCount);
      if (!upstreamTaskId && statusDetails.upstreamTaskId) {
        upstreamTaskId = String(statusDetails.upstreamTaskId);
      }
      const statusOutput = extractMediaStatusResponseText(statusResult);
      if (!firstStatusOutput && statusOutput) firstStatusOutput = statusOutput;

      options.onUpdate?.({
        content: [{
          type: 'text',
          text: firstStatusOutput || `Task ID: ${upstreamTaskId || options.taskId}`,
        }],
        details: {
          taskId: options.taskId,
          ...(upstreamTaskId ? { upstreamTaskId } : {}),
          pollCount: latestReportedPollCount,
          ...(effectiveStatus ? { status: effectiveStatus } : {}),
          ...(firstStatusOutput ? { firstStatusOutput } : {}),
          isMediaStatusPolling: true,
          mediaType: options.mediaType,
        },
      });

      if (effectiveStatus && isTerminalMediaStatus(effectiveStatus)) {
        options.log?.(`${options.mediaType} status poll complete: toolCallId=${options.toolCallId} taskId=${options.taskId} status=${effectiveStatus} elapsedMs=${now() - startedAt} pollCount=${pollCount}`);
        return {
          ...statusResult,
          details: {
            ...statusResult.details,
            taskId: options.taskId,
            ...(upstreamTaskId ? { upstreamTaskId } : {}),
            status: effectiveStatus,
            pollCount: latestReportedPollCount,
          },
        };
      }

      if (pollCount % 6 === 0) {
        const progress = statusDetails.progress ?? 'unknown';
        options.log?.(`${options.mediaType} status poll progress: toolCallId=${options.toolCallId} taskId=${options.taskId} pollCount=${pollCount} progress=${String(progress)} elapsedMs=${now() - startedAt}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`${options.mediaType} status poll error (will retry): toolCallId=${options.toolCallId} taskId=${options.taskId} pollCount=${pollCount} error=${message}`);
    }
  }
}
