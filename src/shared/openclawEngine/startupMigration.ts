export const OPENCLAW_STARTUP_MIGRATION_ENTRY = 'openclaw-startup-state-migration.mjs';
export const OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX = 'LOBSTERAI_STARTUP_MIGRATION_RESULT ';

export const OpenClawStartupMigrationStatus = {
  Skipped: 'skipped',
  Migrated: 'migrated',
  Failed: 'failed',
} as const;

export type OpenClawStartupMigrationStatus =
  typeof OpenClawStartupMigrationStatus[keyof typeof OpenClawStartupMigrationStatus];

export const OpenClawStartupMigrationOwner = {
  DeviceAuth: 'device-auth',
  DeviceIdentity: 'device-identity',
  ExecApprovals: 'exec-approvals',
  Workspace: 'workspace',
} as const;

export type OpenClawStartupMigrationOwner =
  typeof OpenClawStartupMigrationOwner[keyof typeof OpenClawStartupMigrationOwner];

export interface OpenClawStartupMigrationReport {
  status: OpenClawStartupMigrationStatus;
  sourceCount: number;
  sourceCounts: Record<OpenClawStartupMigrationOwner, number>;
  changes: string[];
  notices: string[];
  warnings: string[];
  remainingPaths: string[];
}
