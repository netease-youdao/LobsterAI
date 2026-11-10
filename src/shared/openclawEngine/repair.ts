export const OPENCLAW_REPAIR_ENTRY = 'openclaw-gateway-repair.mjs';
export const OPENCLAW_REPAIR_RESULT_PREFIX = 'LOBSTERAI_GATEWAY_REPAIR_RESULT=';
export const OPENCLAW_REPAIR_PROGRESS_PREFIX = 'LOBSTERAI_GATEWAY_REPAIR_PROGRESS=';

export const OpenClawRepairPhase = {
  LockRecovery: 'lock-recovery',
  Snapshot: 'snapshot',
  Recovery: 'recovery',
  Plugins: 'plugins',
} as const;
export type OpenClawRepairPhase = typeof OpenClawRepairPhase[keyof typeof OpenClawRepairPhase];

export const OpenClawRepairStage = {
  ...OpenClawRepairPhase,
  Preparation: 'preparation',
  Doctor: 'doctor',
  Configuration: 'configuration',
  Gateway: 'gateway',
} as const;
export type OpenClawRepairStage = typeof OpenClawRepairStage[keyof typeof OpenClawRepairStage];

export const OpenClawRepairProgressStage = {
  /** Measuring what the snapshot will copy. */
  Scan: 'scan',
  /** Copying; totals are known. */
  Copy: 'copy',
} as const;
export type OpenClawRepairProgressStage = typeof OpenClawRepairProgressStage[keyof typeof OpenClawRepairProgressStage];

/**
 * Progress a repair helper prints on stdout while it works. `files`/`bytes`
 * count what the current stage has processed; the totals are present once the
 * scan has measured the work, and let the app size its wait from it.
 */
export interface OpenClawRepairProgress {
  phase: OpenClawRepairPhase;
  stage: OpenClawRepairProgressStage;
  files: number;
  bytes: number;
  totalFiles?: number;
  totalBytes?: number;
}

export function formatOpenClawRepairProgress(progress: OpenClawRepairProgress): string {
  return OPENCLAW_REPAIR_PROGRESS_PREFIX + JSON.stringify(progress);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Parses one stdout line; anything that is not a well-formed progress line yields undefined. */
export function parseOpenClawRepairProgress(line: string): OpenClawRepairProgress | undefined {
  if (!line.startsWith(OPENCLAW_REPAIR_PROGRESS_PREFIX)) return undefined;
  let value: Partial<Record<keyof OpenClawRepairProgress, unknown>>;
  try { value = JSON.parse(line.slice(OPENCLAW_REPAIR_PROGRESS_PREFIX.length)); } catch { return undefined; }
  if (!value || typeof value !== 'object'
    || !Object.values<unknown>(OpenClawRepairPhase).includes(value.phase)
    || !Object.values<unknown>(OpenClawRepairProgressStage).includes(value.stage)
    || !isCount(value.files) || !isCount(value.bytes)
    || (value.totalFiles !== undefined && !isCount(value.totalFiles))
    || (value.totalBytes !== undefined && !isCount(value.totalBytes))) return undefined;
  return value as OpenClawRepairProgress;
}

export const OPENCLAW_REPAIR_SNAPSHOT_MANIFEST = 'snapshot-manifest.json';
export const OPENCLAW_PLUGIN_SKILLS_DIRECTORY = 'plugin-skills';

export interface OpenClawRepairSnapshotManifest {
  version: 1;
  generatedPluginSkillLinks: Array<{ path: string; target: string }>;
  /** State-relative cache directories deliberately left out of the snapshot. */
  skippedRegenerablePaths: string[];
  /** State-relative session import archives left in place; absent in older snapshots. */
  skippedSessionImportArchivePaths?: string[];
  restoreInstructions: string;
}

export const OpenClawRepairPluginSource = {
  Npm: 'npm',
  Path: 'path',
} as const;

export interface OpenClawCompatibilityRepairReport {
  phase: OpenClawRepairPhase;
  success: boolean;
  changes: string[];
  backups: string[];
  error?: string;
  failurePath?: string;
}
