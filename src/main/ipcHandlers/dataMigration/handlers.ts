import type Database from 'better-sqlite3';
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  type DataMigrationBackupResult,
  DataMigrationErrorCode,
  DataMigrationIpc,
  type DataMigrationLastRestoreResponse,
  type DataMigrationMissingPluginInfo,
  type DataMigrationPickArchiveResult,
  type DataMigrationPluginInstallOutcome,
  type DataMigrationPreviewRequest,
  type DataMigrationPreviewResult,
  type DataMigrationProgressEvent,
  DataMigrationProgressOperation,
  DataMigrationProgressPhase,
  type DataMigrationReinstallPluginsRequest,
  type DataMigrationReinstallPluginsResult,
  type DataMigrationRestoreRequest,
  type DataMigrationRestoreScheduleResult,
  DataMigrationRestoreStatus,
} from '../../../shared/dataMigration/constants';
import { APP_NAME, DB_FILENAME } from '../../appConstants';
import { t } from '../../i18n';
import {
  buildDataMigrationBackupFileName,
  consumeLastRestoreResultSync,
  createDataMigrationSqliteSnapshot,
  createMigrationArchive,
  ensureTarGzFileName,
  inspectMigrationArchive,
  isDataMigrationError,
  performDataMigrationRestore,
  previewMigrationArchive,
} from '../../libs/dataMigration/dataMigrationService';
import type { DshHostManager } from '../../libs/dsh/dshHostManager';
import type { DshNodeToolchain } from '../../libs/dsh/dshProfileManager';
import {
  runDshPluginCommand,
  setProfilePluginEnabled,
  validatePluginInstallSpecifier,
} from '../dshHost/pluginOperations';
import type { RestoreProgressWindowController } from './restoreProgressWindow';

const LOCAL_SPECIFIER_RE = /^(?:file:|link:|\/|\.\.?[/\\]|~\/|[a-zA-Z]:[/\\]|\\\\)/i;
const DIRECT_SPECIFIER_RE = /^(?:git\+|https?:\/\/|github:|gitlab:|bitbucket:|npm:|jsr:)/i;

export const resolvePluginInstallTarget = (
  plugin: DataMigrationMissingPluginInfo,
): { target: string | null; skippedLocalPath: boolean; error?: string } => {
  const name = plugin.name.trim();
  const rawSpec = (plugin.specifier ?? '').trim();

  if (LOCAL_SPECIFIER_RE.test(rawSpec)) {
    const resolvedLocal = rawSpec.startsWith('file:')
      ? rawSpec.slice('file:'.length)
      : rawSpec.startsWith('link:')
        ? rawSpec.slice('link:'.length)
        : rawSpec;
    if (!fs.existsSync(resolvedLocal)) {
      return {
        target: null,
        skippedLocalPath: true,
        error: `Local plugin path does not exist on this device: ${rawSpec}`,
      };
    }
    const validated = validatePluginInstallSpecifier(rawSpec);
    return validated
      ? { target: validated, skippedLocalPath: false }
      : { target: null, skippedLocalPath: false, error: `Invalid plugin specifier: ${rawSpec}` };
  }

  let candidate: string;
  if (!rawSpec || rawSpec === 'bundled' || rawSpec === '*') {
    candidate = name;
  } else if (DIRECT_SPECIFIER_RE.test(rawSpec)) {
    candidate = rawSpec;
  } else {
    candidate = `${name}@${rawSpec}`;
  }

  const validated = validatePluginInstallSpecifier(candidate);
  if (!validated) {
    return {
      target: null,
      skippedLocalPath: false,
      error: `Invalid plugin install specifier: ${candidate}`,
    };
  }
  return { target: validated, skippedLocalPath: false };
};

export interface DataMigrationIpcDeps {
  getDatabase: () => Database.Database;
  hasActiveWorkloads: () => boolean;
  getDefaultWorkingDirectory: () => string;
  restoreProgressWindow: RestoreProgressWindowController;
  setRestoreLifecycleFlags: (state: {
    restoreInProgress?: boolean;
    cleanupInProgress?: boolean;
    cleanupFinished?: boolean;
    quitting?: boolean;
  }) => void;
  runAppCleanup: (reason: string, options?: { requireGatewayStopped?: boolean }) => Promise<void>;
  closeMemoryService: () => void;
  relaunchApp: () => void;
  exitApp: (code: number) => void;
  getDshHostManager: () => DshHostManager | null;
  getDshRuntimeDir: () => string;
  getDshExecutablePath: () => string;
  getDshNodeToolchain: () => DshNodeToolchain | null;
}

export function registerDataMigrationHandlers(deps: DataMigrationIpcDeps): void {
  const sendProgressToSender = (
    sender: Electron.WebContents,
    event: DataMigrationProgressEvent,
  ): void => {
    if (sender.isDestroyed()) return;
    try {
      sender.send(DataMigrationIpc.Progress, event);
    } catch {
      // Ignore closed renderer webContents.
    }
  };

  ipcMain.handle(
    DataMigrationIpc.Backup,
    async (event): Promise<DataMigrationBackupResult> => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      try {
        if (deps.hasActiveWorkloads()) {
          return {
            success: false,
            errorCode: DataMigrationErrorCode.ActiveWorkloads,
            error: t('dataMigrationBackupBlockedByActiveWorkloads'),
          };
        }

        const saveOptions = {
          title: t('dataMigrationBackupDialogTitle'),
          defaultPath: path.join(
            app.getPath('downloads'),
            buildDataMigrationBackupFileName(),
          ),
          filters: [{ name: t('dataMigrationBackupArchiveFilter'), extensions: ['gz'] }],
        };
        const saveResult = ownerWindow
          ? await dialog.showSaveDialog(ownerWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (saveResult.canceled || !saveResult.filePath) {
          return { success: true, canceled: true };
        }

        const outputPath = ensureTarGzFileName(saveResult.filePath);
        if (deps.hasActiveWorkloads()) {
          return {
            success: false,
            errorCode: DataMigrationErrorCode.ActiveWorkloads,
            error: t('dataMigrationBackupBlockedByActiveWorkloads'),
          };
        }

        const snapshotTempDir = await fs.promises.mkdtemp(
          path.join(os.tmpdir(), 'lobsterai-sqlite-snapshot-'),
        );
        try {
          sendProgressToSender(event.sender, {
            operation: DataMigrationProgressOperation.Backup,
            phase: DataMigrationProgressPhase.SnapshottingDatabase,
            percent: 10,
          });
          const sqliteSnapshotPath = path.join(snapshotTempDir, DB_FILENAME);
          await createDataMigrationSqliteSnapshot(deps.getDatabase(), sqliteSnapshotPath);

          const archive = await createMigrationArchive({
            userDataPath: app.getPath('userData'),
            outputPath,
            sqliteSnapshotPath,
            archiveKind: 'backup',
            appVersion: app.getVersion(),
            onProgress: (progress) => sendProgressToSender(event.sender, progress),
          });
          return {
            success: true,
            canceled: false,
            path: archive.outputPath,
            sizeBytes: archive.sizeBytes,
          };
        } finally {
          fs.rmSync(snapshotTempDir, { recursive: true, force: true });
        }
      } catch (error) {
        console.error('[DataMigration] backup failed:', error);
        return {
          success: false,
          errorCode: isDataMigrationError(error) ? error.code : undefined,
          error: error instanceof Error ? error.message : 'Failed to back up LobsterAI data',
        };
      }
    },
  );

  ipcMain.handle(
    DataMigrationIpc.PickRestoreArchive,
    async (event): Promise<DataMigrationPickArchiveResult> => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      try {
        const openOptions = {
          title: t('dataMigrationRestoreDialogTitle'),
          properties: ['openFile'] as 'openFile'[],
          filters: [
            {
              name: t('dataMigrationBackupArchiveFilter'),
              extensions: ['gz', 'tgz'],
            },
            { name: t('dataMigrationAllFilesFilter'), extensions: ['*'] },
          ],
        };
        const openResult = ownerWindow
          ? await dialog.showOpenDialog(ownerWindow, openOptions)
          : await dialog.showOpenDialog(openOptions);
        if (openResult.canceled || openResult.filePaths.length === 0) {
          return { success: true, canceled: true };
        }
        return {
          success: true,
          canceled: false,
          archivePath: openResult.filePaths[0],
        };
      } catch (error) {
        console.error('[DataMigration] failed to pick restore archive:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to open backup file dialog',
        };
      }
    },
  );

  ipcMain.handle(
    DataMigrationIpc.Preview,
    async (_event, request: DataMigrationPreviewRequest): Promise<DataMigrationPreviewResult> => {
      if (!request?.archivePath || typeof request.archivePath !== 'string') {
        return {
          success: false,
          errorCode: DataMigrationErrorCode.UnsupportedFormat,
          error: 'Backup archive path is required.',
        };
      }
      return previewMigrationArchive(request.archivePath);
    },
  );

  ipcMain.handle(
    DataMigrationIpc.Restore,
    async (event, request?: DataMigrationRestoreRequest): Promise<DataMigrationRestoreScheduleResult> => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      let rendererReleased = false;
      try {
        let archivePath = typeof request?.archivePath === 'string' && request.archivePath.trim()
          ? request.archivePath.trim()
          : '';

        if (!archivePath) {
          const openOptions = {
            title: t('dataMigrationRestoreDialogTitle'),
            properties: ['openFile'] as 'openFile'[],
            filters: [
              {
                name: t('dataMigrationBackupArchiveFilter'),
                extensions: ['gz', 'tgz'],
              },
              { name: t('dataMigrationAllFilesFilter'), extensions: ['*'] },
            ],
          };
          const openResult = ownerWindow
            ? await dialog.showOpenDialog(ownerWindow, openOptions)
            : await dialog.showOpenDialog(openOptions);
          if (openResult.canceled || openResult.filePaths.length === 0) {
            return { success: true, canceled: true };
          }
          archivePath = openResult.filePaths[0];
        }

        // Fast streaming validation before closing windows.
        await inspectMigrationArchive(archivePath);

        deps.setRestoreLifecycleFlags({
          restoreInProgress: true,
          cleanupInProgress: true,
          quitting: true,
        });
        await deps.restoreProgressWindow.releaseRendererWindows();
        rendererReleased = true;
        await deps.restoreProgressWindow.show();
        await deps.runAppCleanup('data migration restore', { requireGatewayStopped: true });
        try {
          deps.closeMemoryService();
        } catch (error) {
          console.warn('[DataMigration] failed to close memory service before restore:', error);
        }
        deps.setRestoreLifecycleFlags({
          cleanupFinished: true,
          cleanupInProgress: false,
        });

        const restoreResult = await performDataMigrationRestore({
          userDataPath: app.getPath('userData'),
          rollbackRootPath: path.join(app.getPath('appData'), `${APP_NAME}-migration-rollbacks`),
          archivePath,
          defaultWorkingDirectory: deps.getDefaultWorkingDirectory(),
          safeStorage,
          onProgress: (progress) => deps.restoreProgressWindow.updateProgress(progress),
        });

        const success = restoreResult.status === DataMigrationRestoreStatus.Success;
        console.log(
          `[DataMigration] restore finished with status ${restoreResult.status}; `
          + `rollback archive ${restoreResult.rollbackPath ?? 'was not created'}.`,
        );
        if (!success) {
          console.error('[DataMigration] restore failed:', restoreResult.error ?? 'Unknown restore error');
        }

        if (rendererReleased) {
          setTimeout(() => {
            deps.relaunchApp();
            deps.exitApp(0);
          }, 100);
        }

        return {
          success,
          scheduledRestart: rendererReleased,
          rollbackPath: restoreResult.rollbackPath,
          errorCode: restoreResult.errorCode,
          error: success ? undefined : restoreResult.error || 'Failed to import LobsterAI data backup',
        };
      } catch (error) {
        deps.setRestoreLifecycleFlags({ cleanupInProgress: false });
        const message = error instanceof Error ? error.message : 'Failed to import LobsterAI data backup';
        const errorCode = isDataMigrationError(error) ? error.code : DataMigrationErrorCode.RestoreFailed;
        console.error('[DataMigration] restore failed:', error);
        if (rendererReleased) {
          dialog.showErrorBox(t('dataMigrationRestoreDialogTitle'), message);
          setTimeout(() => {
            deps.relaunchApp();
            deps.exitApp(0);
          }, 100);
        } else {
          deps.setRestoreLifecycleFlags({
            restoreInProgress: false,
            quitting: false,
          });
        }
        return {
          success: false,
          scheduledRestart: rendererReleased,
          errorCode,
          error: message,
        };
      }
    },
  );

  ipcMain.handle(DataMigrationIpc.GetLastRestoreResult, async (): Promise<DataMigrationLastRestoreResponse> => {
    try {
      return {
        success: true,
        result: consumeLastRestoreResultSync(app.getPath('userData')),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read data migration result',
      };
    }
  });

  ipcMain.handle(
    DataMigrationIpc.ReinstallPlugins,
    async (_event, request: DataMigrationReinstallPluginsRequest): Promise<DataMigrationReinstallPluginsResult> => {
      const manager = deps.getDshHostManager();
      if (!manager) {
        return {
          success: false,
          results: [],
          error: 'DSH host manager is not initialized.',
        };
      }

      const plugins = Array.isArray(request?.plugins) ? request.plugins : [];
      if (plugins.length === 0) {
        return { success: true, results: [] };
      }

      const status = manager.getStatus();
      const toolchain = deps.getDshNodeToolchain() ?? manager.getNodeToolchain?.() ?? null;
      const results: DataMigrationPluginInstallOutcome[] = [];
      let anySucceeded = false;

      for (const plugin of plugins) {
        const resolved = resolvePluginInstallTarget(plugin);
        if (!resolved.target) {
          results.push({
            name: plugin.name,
            specifier: plugin.specifier,
            ok: false,
            skippedLocalPath: resolved.skippedLocalPath,
            error: resolved.error,
          });
          continue;
        }

        const cmdRes = await runDshPluginCommand({
          executablePath: deps.getDshExecutablePath(),
          runtimeDir: deps.getDshRuntimeDir(),
          dshHomeDir: status.dshHomeDir,
          nodeToolchain: toolchain,
          toolchain,
          args: ['add', resolved.target],
        });

        if (cmdRes.ok) {
          anySucceeded = true;
          if (!plugin.enabled) {
            try {
              setProfilePluginEnabled(status.profileDir, plugin.name, false);
            } catch (error) {
              console.warn(`[DataMigration] failed to restore disabled state for plugin ${plugin.name}:`, error);
            }
          }
          results.push({
            name: plugin.name,
            specifier: plugin.specifier,
            ok: true,
          });
        } else {
          results.push({
            name: plugin.name,
            specifier: plugin.specifier,
            ok: false,
            error: (cmdRes.stderr || cmdRes.stdout || `Exit code ${cmdRes.exitCode}`).trim(),
          });
        }
      }

      try {
        manager.ensureProfileIntegrity?.();
      } catch (error) {
        console.warn('[DataMigration] failed to re-ensure DSH profile integrity after plugin reinstall:', error);
      }

      if (anySucceeded) {
        await manager.restart().catch((error) => {
          console.warn('[DataMigration] failed to restart DSH host after plugin reinstall:', error);
        });
      }

      return {
        success: results.every(item => item.ok),
        results,
      };
    },
  );
}
