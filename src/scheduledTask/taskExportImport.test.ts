/**
 * Unit tests for taskExportImport.ts
 *
 * Tests focus on the pure / isolable logic:
 *  - toExportedTask (runtime-field stripping) – tested indirectly via exported helpers
 *  - defaultExportFilename format
 *  - manifest round-trip via JSZip (ZIP creation → parsing → field check)
 *  - parseImportFile error paths (invalid ZIP, missing manifest, bad version)
 *  - executeImport success + partial-failure counting
 *
 * Electron APIs (app, dialog, BrowserWindow) and cronJobService are mocked.
 */

import { test, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0-test' },
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  BrowserWindow: { getFocusedWindow: () => null },
}));

vi.mock('fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// mockAddJob must be defined inside the factory because vi.mock is hoisted.
// We retrieve the same shared fn via the module reference after import.
vi.mock('./cronJobService', () => {
  const mockAddJob = vi.fn();
  return {
    cronJobService: {
      listJobs: vi.fn(),
      addJob: mockAddJob,
    },
  };
});

// ─── Import SUT after mocks ───────────────────────────────────────────────────

import { exportTasks, parseImportFile, executeImport } from './taskExportImport';
import { dialog } from 'electron';
import * as fs from 'fs';
import { cronJobService } from './cronJobService';

// ─── Test data ────────────────────────────────────────────────────────────────

const baseTask = {
  id: 'task-1',
  agentId: 'agent-abc',
  state: {
    nextRunAtMs: 1000,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runningAtMs: null,
    consecutiveErrors: 0,
  },
  name: 'Nightly Report',
  description: 'Generates daily summary',
  enabled: true,
  schedule: { kind: 'cron' as const, expr: '0 22 * * *', tz: 'Asia/Shanghai' },
  sessionTarget: 'main' as const,
  wakeMode: 'normal' as const,
  payload: { kind: 'agentTurn' as const, message: 'run report', timeoutSeconds: 60 },
};

// ─── toExportedTask (via exportTasks) ────────────────────────────────────────

test('exportTasks strips runtime fields from task', async () => {
  vi.mocked(cronJobService.listJobs).mockResolvedValue([baseTask]);
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({
    canceled: false,
    filePath: '/tmp/test.lobstertasks',
  });

  let writtenBuffer: Buffer | undefined;
  vi.mocked(fs.writeFileSync).mockImplementation((_path, data) => {
    writtenBuffer = data as Buffer;
  });

  const outcome = await exportTasks(['task-1']);
  expect(outcome).toBe('success');

  // Parse the ZIP that was written
  expect(writtenBuffer).toBeDefined();
  const zip = await JSZip.loadAsync(writtenBuffer!);
  const manifestText = await zip.file('manifest.json')!.async('text');
  const manifest = JSON.parse(manifestText);

  expect(manifest.version).toBe(1);
  expect(manifest.tasks).toHaveLength(1);

  const exported = manifest.tasks[0];
  // Portable fields MUST be present
  expect(exported.name).toBe('Nightly Report');
  expect(exported.description).toBe('Generates daily summary');
  expect(exported.enabled).toBe(true);
  expect(exported.schedule).toEqual(baseTask.schedule);
  expect(exported.payload).toEqual(baseTask.payload);

  // Runtime / device-specific fields MUST be absent
  expect(exported.id).toBeUndefined();
  expect(exported.agentId).toBeUndefined();
  expect(exported.state).toBeUndefined();
});

// ─── exportTasks – cancelled dialog ──────────────────────────────────────────

test('exportTasks returns "cancelled" when save dialog is dismissed', async () => {
  vi.mocked(cronJobService.listJobs).mockResolvedValue([baseTask]);
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true });

  const outcome = await exportTasks(['task-1']);
  expect(outcome).toBe('cancelled');
  expect(fs.writeFileSync).not.toHaveBeenCalled();
});

// ─── exportTasks – no matching tasks ─────────────────────────────────────────

test('exportTasks throws when no tasks match the provided IDs', async () => {
  vi.mocked(cronJobService.listJobs).mockResolvedValue([baseTask]);

  await expect(exportTasks(['non-existent-id'])).rejects.toThrow(
    'No matching tasks found'
  );
});

// ─── defaultExportFilename (date format) ─────────────────────────────────────

test('exported manifest filename follows YYYY-MM-DD pattern', async () => {
  vi.mocked(cronJobService.listJobs).mockResolvedValue([baseTask]);
  let savedPath = '';
  vi.mocked(dialog.showSaveDialog).mockImplementation(async (_win, opts) => {
    savedPath = (opts as { defaultPath?: string }).defaultPath ?? '';
    return { canceled: true };
  });

  await exportTasks(['task-1']);
  expect(savedPath).toMatch(/^tasks-export-\d{4}-\d{2}-\d{2}\.lobstertasks$/);
});

// ─── manifest ZIP round-trip helper ──────────────────────────────────────────

async function buildZipBuffer(manifest: object): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ─── parseImportFile – valid file ────────────────────────────────────────────

test('parseImportFile returns tasks from a valid .lobstertasks file', async () => {
  const exportedTask = {
    name: 'Nightly Report',
    description: 'Generates daily summary',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 22 * * *', tz: 'Asia/Shanghai' },
    sessionTarget: 'main',
    wakeMode: 'normal',
    payload: { kind: 'agentTurn', message: 'run report', timeoutSeconds: 60 },
  };

  const validManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: '1.0.0',
    tasks: [exportedTask],
  };

  const zipBuf = await buildZipBuffer(validManifest);
  vi.mocked(fs.readFileSync).mockReturnValue(zipBuf);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/test.lobstertasks'],
  });

  const result = await parseImportFile();
  expect(result).not.toBeNull();
  expect(result!.tasks).toHaveLength(1);
  expect(result!.tasks[0].name).toBe('Nightly Report');
  expect(result!.filename).toBe('test.lobstertasks');
});

// ─── parseImportFile – user cancels ──────────────────────────────────────────

test('parseImportFile returns null when open dialog is cancelled', async () => {
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: true,
    filePaths: [],
  });

  const result = await parseImportFile();
  expect(result).toBeNull();
});

// ─── parseImportFile – invalid ZIP ───────────────────────────────────────────

test('parseImportFile throws on invalid ZIP data', async () => {
  vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('not a zip'));
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/bad.lobstertasks'],
  });

  await expect(parseImportFile()).rejects.toThrow('Invalid file format');
});

// ─── parseImportFile – missing manifest.json ─────────────────────────────────

test('parseImportFile throws when manifest.json is absent from ZIP', async () => {
  const zip = new JSZip();
  zip.file('other.txt', 'hello');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  vi.mocked(fs.readFileSync).mockReturnValue(buf);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/nomanifest.lobstertasks'],
  });

  await expect(parseImportFile()).rejects.toThrow('missing manifest.json');
});

// ─── parseImportFile – wrong version ─────────────────────────────────────────

test('parseImportFile throws for unsupported manifest version', async () => {
  const buf = await buildZipBuffer({ version: 99, exportedAt: '', appVersion: '', tasks: [] });

  vi.mocked(fs.readFileSync).mockReturnValue(buf);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/v99.lobstertasks'],
  });

  await expect(parseImportFile()).rejects.toThrow('Unsupported file format version');
});

// ─── parseImportFile – malformed JSON ────────────────────────────────────────

test('parseImportFile throws for malformed manifest JSON', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', '{ this is not json }');
  const buf = await zip.generateAsync({ type: 'nodebuffer' });

  vi.mocked(fs.readFileSync).mockReturnValue(buf);
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({
    canceled: false,
    filePaths: ['/tmp/badjson.lobstertasks'],
  });

  await expect(parseImportFile()).rejects.toThrow('malformed JSON');
});

// ─── executeImport – all succeed ─────────────────────────────────────────────

test('executeImport returns successCount equal to input length when all jobs succeed', async () => {
  vi.mocked(cronJobService.addJob).mockResolvedValue(undefined);

  const tasks = [
    {
      name: 'Task A',
      description: '',
      enabled: true,
      schedule: { kind: 'cron' as const, expr: '* * * * *' },
      sessionTarget: 'main' as const,
      wakeMode: 'normal' as const,
      payload: { kind: 'agentTurn' as const, message: 'hello' },
    },
    {
      name: 'Task B',
      description: '',
      enabled: false,
      schedule: { kind: 'cron' as const, expr: '* * * * *' },
      sessionTarget: 'main' as const,
      wakeMode: 'normal' as const,
      payload: { kind: 'agentTurn' as const, message: 'world' },
    },
  ];

  const result = await executeImport(tasks);
  expect(result.successCount).toBe(2);
  expect(result.failCount).toBe(0);
  expect(result.errors).toHaveLength(0);
});

// ─── executeImport – partial failure ─────────────────────────────────────────

test('executeImport counts failures individually and collects error messages', async () => {
  vi.mocked(cronJobService.addJob)
    .mockResolvedValueOnce(undefined) // Task A succeeds
    .mockRejectedValueOnce(new Error('DB locked')); // Task B fails

  const tasks = [
    {
      name: 'Task A',
      description: '',
      enabled: true,
      schedule: { kind: 'cron' as const, expr: '* * * * *' },
      sessionTarget: 'main' as const,
      wakeMode: 'normal' as const,
      payload: { kind: 'agentTurn' as const, message: 'a' },
    },
    {
      name: 'Task B',
      description: '',
      enabled: true,
      schedule: { kind: 'cron' as const, expr: '* * * * *' },
      sessionTarget: 'main' as const,
      wakeMode: 'normal' as const,
      payload: { kind: 'agentTurn' as const, message: 'b' },
    },
  ];

  const result = await executeImport(tasks);
  expect(result.successCount).toBe(1);
  expect(result.failCount).toBe(1);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('Task B');
  expect(result.errors[0]).toContain('DB locked');
});

// ─── executeImport – empty list ───────────────────────────────────────────────

test('executeImport with empty list returns all-zero counts', async () => {
  const result = await executeImport([]);
  expect(result.successCount).toBe(0);
  expect(result.failCount).toBe(0);
  expect(result.errors).toHaveLength(0);
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});
