export const CoworkSystemMessageKind = {
  EmptyResponse: 'empty_response',
  ContextCompaction: 'context_compaction',
  ForkCompactionSummary: 'fork_compaction_summary',
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

const INTERNAL_COMPACTION_SYSTEM_TEXT_RE = /^[\s`*_~"'()[\]{}<>.,!?;:=+\-]*compaction[\s`*_~"'()[\]{}<>.,!?;:=+\-]*$/i;

export const isInternalCompactionSystemText = (text: string): boolean => {
  return INTERNAL_COMPACTION_SYSTEM_TEXT_RE.test(text.trim());
};
