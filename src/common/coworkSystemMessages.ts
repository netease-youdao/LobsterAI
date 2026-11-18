export const CoworkSystemMessageKind = {
  EmptyResponse: 'empty_response',
  ContextCompaction: 'context_compaction',
  ForkCompactionSummary: 'fork_compaction_summary',
  ModelChanged: 'model_changed',
  ModelReconnect: 'model_reconnect',
} as const;
export type CoworkSystemMessageKind =
  typeof CoworkSystemMessageKind[keyof typeof CoworkSystemMessageKind];

export const ContextCompactionMode = {
  Auto: 'auto',
  Manual: 'manual',
} as const;
export type ContextCompactionMode =
  typeof ContextCompactionMode[keyof typeof ContextCompactionMode];

export const ContextCompactionStatus = {
  Running: 'running',
  Completed: 'completed',
  Retrying: 'retrying',
  Failed: 'failed',
} as const;
export type ContextCompactionStatus =
  typeof ContextCompactionStatus[keyof typeof ContextCompactionStatus];

/** State of the reconnect row shown while the runtime retries a dropped model stream. */
export const ModelReconnectStatus = {
  Retrying: 'retrying',
  Recovered: 'recovered',
  Failed: 'failed',
  Stopped: 'stopped',
} as const;
export type ModelReconnectStatus =
  typeof ModelReconnectStatus[keyof typeof ModelReconnectStatus];

/** Error-message metadata flag: the turn ended because reconnecting a dropped model stream failed. */
export const MODEL_STREAM_INTERRUPTED_ERROR_METADATA_KEY = 'modelStreamInterrupted';

export const isModelStreamInterruptedError = (metadata: Record<string, unknown> | undefined): boolean => (
  metadata?.[MODEL_STREAM_INTERRUPTED_ERROR_METADATA_KEY] === true
);

const INTERNAL_COMPACTION_SYSTEM_TEXT_RE = /^[\s`*_~"'()[\]{}<>.,!?;:=+\-]*compaction[\s`*_~"'()[\]{}<>.,!?;:=+\-]*$/i;

export const isInternalCompactionSystemText = (text: string): boolean => {
  return INTERNAL_COMPACTION_SYSTEM_TEXT_RE.test(text.trim());
};
