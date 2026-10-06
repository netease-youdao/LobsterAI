export const OpenClawTranscriptSafetyLimit = {
  SoftBytes: 32 * 1024 * 1024,
  HardBytes: 64 * 1024 * 1024,
  SoftConfigValue: '32mb',
} as const;

export const OpenClawTranscriptSafetyStatus = {
  Safe: 'safe',
  CompactionRequired: 'compaction_required',
  Blocked: 'blocked',
  Unknown: 'unknown',
} as const;

export type OpenClawTranscriptSafetyStatus =
  typeof OpenClawTranscriptSafetyStatus[keyof typeof OpenClawTranscriptSafetyStatus];

export const OpenClawTranscriptSafetyErrorCode = {
  ActiveTranscriptOversized: 'OPENCLAW_ACTIVE_TRANSCRIPT_OVERSIZED',
} as const;

export type OpenClawTranscriptSafetyErrorCode =
  typeof OpenClawTranscriptSafetyErrorCode[keyof typeof OpenClawTranscriptSafetyErrorCode];
