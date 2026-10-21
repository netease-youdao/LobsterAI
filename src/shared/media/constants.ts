export const MediaTaskStatus = {
  Pending: 'pending',
  Processing: 'processing',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Timeout: 'timeout',
  Cancelled: 'cancelled',
  Background: 'background',
  PollingStopped: 'polling_stopped',
} as const;

export const TERMINAL_MEDIA_TASK_STATUSES = new Set<string>([
  MediaTaskStatus.Succeeded, MediaTaskStatus.Failed, MediaTaskStatus.Timeout, MediaTaskStatus.Cancelled,
]);

export const MediaTaskPhase = {
  Queued: 'queued',
  Submitting: 'submitting',
  Generating: 'generating',
  Verifying: 'verifying',
  Fetching: 'fetching',
  Finished: 'finished',
} as const;

export const MediaProtocol = { Legacy: 1, Durable: 2 } as const;
export const MediaDeliveryStatus = { Pending: 'pending', Retrying: 'retrying', Saved: 'saved', Failed: 'failed' } as const;
export const MediaBillingStatus = { Reserved: 'reserved', Settled: 'settled', Refunded: 'refunded' } as const;
export const MEDIA_V2_TASKS_PATH = '/api/media/v2/tasks';
export const MEDIA_TASK_STORE_KEY = 'media.tasks.v2';
export const MEDIA_INTENT_STORE_KEY = 'media.intents.v2';
