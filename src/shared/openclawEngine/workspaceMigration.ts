export const OPENCLAW_WORKSPACE_MIGRATION_ENTRY = 'openclaw-workspace-state-migration.mjs';
export const OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX = 'LOBSTERAI_WORKSPACE_MIGRATION_RESULT ';

export const OpenClawWorkspaceMigrationStatus = {
  Skipped: 'skipped',
  Migrated: 'migrated',
  Failed: 'failed',
} as const;

export type OpenClawWorkspaceMigrationStatus =
  typeof OpenClawWorkspaceMigrationStatus[keyof typeof OpenClawWorkspaceMigrationStatus];

export interface OpenClawWorkspaceMigrationReport {
  status: OpenClawWorkspaceMigrationStatus;
  sourceCount: number;
  changes: string[];
  warnings: string[];
  remainingPaths: string[];
}
