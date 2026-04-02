/**
 * Task export/import service for the scheduled tasks module.
 *
 * Handles:
 * - Exporting selected tasks into a `.lobstertasks` ZIP file
 * - Parsing a `.lobstertasks` file and returning the task list for preview
 * - Executing import by creating tasks via CronJobService
 */

import { app, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import JSZip from 'jszip';
import type { CronJobService } from './cronJobService';
import type {
  ScheduledTask,
  ExportedTask,
  ExportManifest,
  ImportResult,
} from './types';

/** Injected by IPC handlers — avoids a circular dependency on the singleton. */
let _getCronJobService: (() => CronJobService) | null = null;

export function initTaskExportImport(getCronJobService: () => CronJobService): void {
  _getCronJobService = getCronJobService;
}

function getService(): CronJobService {
  if (!_getCronJobService) {
    throw new Error('TaskExportImport not initialized. Call initTaskExportImport() first.');
  }
  return _getCronJobService();
}

const MANIFEST_VERSION = 1;
const FILE_EXTENSION = 'lobstertasks';

/**
 * Strip runtime fields from a ScheduledTask to produce an ExportedTask.
 */
function toExportedTask(task: ScheduledTask): ExportedTask {
  return {
    name: task.name,
    description: task.description,
    enabled: task.enabled,
    schedule: task.schedule,
    sessionTarget: task.sessionTarget,
    wakeMode: task.wakeMode,
    payload: task.payload,
    ...(task.delivery ? { delivery: task.delivery } : {}),
  };
}

/**
 * Build the default filename for export: tasks-export-YYYY-MM-DD.lobstertasks
 */
function defaultExportFilename(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `tasks-export-${yyyy}-${mm}-${dd}.${FILE_EXTENSION}`;
}

/**
 * Export selected tasks to a .lobstertasks ZIP file.
 *
 * @returns 'success' if written, 'cancelled' if user dismissed dialog, or throws on error
 */
export async function exportTasks(
  taskIds: string[]
): Promise<'success' | 'cancelled'> {
  // Query all tasks and filter by IDs
  const allTasks = await getService().listJobs();
  const idSet = new Set(taskIds);
  const selected = allTasks.filter((t: ScheduledTask) => idSet.has(t.id));

  if (selected.length === 0) {
    throw new Error('No matching tasks found for the given IDs');
  }

  // Build manifest
  const manifest: ExportManifest = {
    version: MANIFEST_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    tasks: selected.map(toExportedTask),
  };

  // Create ZIP
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  // Show save dialog
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = await dialog.showSaveDialog(
    focusedWindow ?? (undefined as unknown as BrowserWindow),
    {
      title: 'Export Tasks',
      defaultPath: defaultExportFilename(),
      filters: [
        { name: 'LobsterAI Tasks', extensions: [FILE_EXTENSION] },
      ],
    }
  );

  if (result.canceled || !result.filePath) {
    return 'cancelled';
  }

  // Write file
  fs.writeFileSync(result.filePath, zipBuffer);
  console.log(
    `[TaskExportImport] exported ${selected.length} tasks to ${result.filePath}`
  );
  return 'success';
}

/**
 * Open a file dialog, parse a .lobstertasks ZIP, and return the task list.
 *
 * @returns The parsed tasks and source filename, or null if user cancelled
 */
export async function parseImportFile(): Promise<{
  tasks: ExportedTask[];
  filename: string;
} | null> {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(
    focusedWindow ?? (undefined as unknown as BrowserWindow),
    {
      title: 'Import Tasks',
      filters: [
        { name: 'LobsterAI Tasks', extensions: [FILE_EXTENSION] },
      ],
      properties: ['openFile'],
    }
  );

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;

  // Read and parse ZIP
  const fileBuffer = fs.readFileSync(filePath);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(fileBuffer);
  } catch {
    throw new Error('Invalid file format: not a valid ZIP archive');
  }

  // Extract manifest
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid file: missing manifest.json');
  }

  const manifestText = await manifestFile.async('text');
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('Invalid manifest: malformed JSON');
  }

  // Validate
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `Unsupported file format version: ${manifest.version} (expected ${MANIFEST_VERSION})`
    );
  }

  if (!Array.isArray(manifest.tasks)) {
    throw new Error('Invalid manifest: tasks field is not an array');
  }

  console.log(
    `[TaskExportImport] parsed ${manifest.tasks.length} tasks from ${filename}`
  );
  return { tasks: manifest.tasks, filename };
}

/**
 * Import tasks by creating them via CronJobService.addJob.
 */
export async function executeImport(
  tasks: ExportedTask[]
): Promise<ImportResult> {
  let successCount = 0;
  let failCount = 0;
  const errors: string[] = [];

  for (const task of tasks) {
    try {
      await getService().addJob({
        name: task.name,
        description: task.description,
        enabled: task.enabled,
        schedule: task.schedule,
        sessionTarget: task.sessionTarget,
        wakeMode: task.wakeMode,
        payload: task.payload,
        delivery: task.delivery,
      });
      successCount++;
    } catch (err) {
      failCount++;
      const message =
        err instanceof Error ? err.message : String(err);
      errors.push(`Failed to import "${task.name}": ${message}`);
      console.error(
        `[TaskExportImport] failed to import task "${task.name}":`,
        err
      );
    }
  }

  console.log(
    `[TaskExportImport] import complete: ${successCount} succeeded, ${failCount} failed`
  );
  return { successCount, failCount, errors };
}
