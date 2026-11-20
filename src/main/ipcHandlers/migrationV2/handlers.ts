// IPC handlers exposing the v2 OpenClaw -> DSH offline migration report
// and one-click backup directory reveal to the renderer UI.

import type Database from 'better-sqlite3';
import { ipcMain, shell } from 'electron';
import * as fs from 'fs';

import { MigrationV2Ipc } from '../../../shared/migration/constants';
import {
  dismissMigrationV2Report,
  getPendingMigrationV2Report,
} from '../../migration/legacyOpenClawMigrator';

export interface MigrationV2IpcDeps {
  getDb: () => Database.Database | null;
}

export function registerMigrationV2Handlers(deps: MigrationV2IpcDeps): void {
  ipcMain.handle(MigrationV2Ipc.GetReport, () => {
    const db = deps.getDb();
    if (!db) return null;
    return getPendingMigrationV2Report(db);
  });

  ipcMain.handle(MigrationV2Ipc.DismissReport, () => {
    const db = deps.getDb();
    if (!db) return { ok: false };
    dismissMigrationV2Report(db);
    return { ok: true };
  });

  ipcMain.handle(MigrationV2Ipc.OpenBackupDir, async () => {
    const db = deps.getDb();
    if (!db) return { ok: false };
    const report = getPendingMigrationV2Report(db);
    const dir = report?.backupDir;
    if (dir && fs.existsSync(dir)) {
      await shell.openPath(dir);
      return { ok: true, backupDir: dir };
    }
    return { ok: false };
  });
}
