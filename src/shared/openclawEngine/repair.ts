export const OPENCLAW_REPAIR_ENTRY = 'openclaw-gateway-repair.mjs';
export const OPENCLAW_REPAIR_RESULT_PREFIX = 'LOBSTERAI_GATEWAY_REPAIR_RESULT=';

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

export const OPENCLAW_REPAIR_SNAPSHOT_MANIFEST = 'snapshot-manifest.json';
export const OPENCLAW_PLUGIN_SKILLS_DIRECTORY = 'plugin-skills';

export interface OpenClawRepairSnapshotManifest {
  version: 1;
  generatedPluginSkillLinks: Array<{ path: string; target: string }>;
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
