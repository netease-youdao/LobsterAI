// Renderer service for the one-shot OpenClaw -> DSH v2 migration report modal.

import type { MigrationV2Report } from '@shared/migration/constants';

export const migrationV2Service = {
  getPendingReport(): Promise<MigrationV2Report | null> {
    return window.electron.migrationV2.getReport();
  },

  dismissReport(): Promise<{ ok: boolean }> {
    return window.electron.migrationV2.dismissReport();
  },

  openBackupDir(): Promise<{ ok: boolean; backupDir?: string }> {
    return window.electron.migrationV2.openBackupDir();
  },
};
