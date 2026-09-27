export const DREAMING_RECOVERY_REPORT_VERSION = 1;
export const DREAMING_RECOVERY_DIRECTORY = 'startup-recovery-backups/memory-dreaming';
export const DREAMING_RECOVERY_LATEST_FILE = 'latest.json';

export const OpenClawDreamingStateFile = {
  DailyIngestion: 'daily-ingestion.json',
  SessionIngestion: 'session-ingestion.json',
  ShortTermRecall: 'short-term-recall.json',
  PhaseSignals: 'phase-signals.json',
} as const;
export type OpenClawDreamingStateFile = typeof OpenClawDreamingStateFile[keyof typeof OpenClawDreamingStateFile];

export const OpenClawDreamingStateLabel = {
  DailyIngestion: 'daily ingestion',
  SessionIngestion: 'session ingestion',
  ShortTermRecall: 'short-term recall',
  PhaseSignals: 'phase signals',
} as const;

export const OpenClawDreamingRecoveryOutcome = {
  NotApplicable: 'not_applicable',
  Recovered: 'recovered',
  Blocked: 'blocked',
} as const;
export type OpenClawDreamingRecoveryOutcome = typeof OpenClawDreamingRecoveryOutcome[keyof typeof OpenClawDreamingRecoveryOutcome];

export const OpenClawDreamingRecoveryStage = {
  BackedUp: 'backed_up',
  Isolated: 'isolated',
  Verified: 'verified',
} as const;
export type OpenClawDreamingRecoveryStage = typeof OpenClawDreamingRecoveryStage[keyof typeof OpenClawDreamingRecoveryStage];

export interface OpenClawDreamingRecoveryFile {
  sourcePath: string;
  agentIds: string[];
  fileName: OpenClawDreamingStateFile;
  backupPath: string;
  isolatedPath: string;
  sha256: string;
  size: number;
  stage: OpenClawDreamingRecoveryStage;
}

export interface OpenClawDreamingRecoveryReport {
  reportVersion: typeof DREAMING_RECOVERY_REPORT_VERSION;
  runtimeVersion: string;
  outcome: OpenClawDreamingRecoveryOutcome;
  manifestPath?: string;
  recordedAt?: string;
  files: OpenClawDreamingRecoveryFile[];
  blockers: string[];
}

/** Kept after startup and across app restarts; it does not authorize any repair. */
export interface OpenClawDreamingRecoverySummary {
  manifestPath: string;
  affectedWorkspaceCount: number;
  quarantinedFileCount: number;
  pendingFileCount: number;
  recordedAt: string;
}
