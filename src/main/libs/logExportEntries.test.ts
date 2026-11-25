import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { DSH_PROFILE_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import { exportLogsZip } from './logExport';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }));
vi.mock('../logger', () => ({ getRecentMainLogEntries: vi.fn(() => []) }));
vi.mock('../computerUse/computerUseLogs', () => ({ getRecentComputerUseLogEntries: vi.fn(() => []) }));
vi.mock('./coworkLogger', () => ({ getCoworkLogPath: vi.fn(() => '') }));

import { buildLogExportEntries } from './logExportEntries';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-log-export-entries-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('buildLogExportEntries', () => {
  test('omits absent optional log files so log export produces no missingEntries', async () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'appData');
    const mainLogPath = path.join(userDataDir, 'logs', 'main-2026-11-24.log');
    fs.mkdirSync(path.dirname(mainLogPath), { recursive: true });
    fs.writeFileSync(mainLogPath, 'main log line\n', 'utf8');

    const entries = buildLogExportEntries({
      mainLogEntries: [{ archiveName: 'main-2026-11-24.log', filePath: mainLogPath }],
      coworkLogPath: path.join(userDataDir, 'logs', 'cowork.log'),
      computerUseLogEntries: [],
      userDataDir,
      appDataDir,
      platform: 'win32',
    });

    expect(entries.map((entry) => entry.archiveName)).toEqual(['main-2026-11-24.log']);

    const zipPath = path.join(root, 'logs.zip');
    const result = await exportLogsZip({ outputPath: zipPath, entries });
    expect(result.missingEntries).toEqual([]);
    expect(fs.existsSync(zipPath)).toBe(true);
  });

  test('includes cowork.log, dsh.log, and Windows install-timing.log when present as files', () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'appData');
    const mainLogPath = path.join(userDataDir, 'logs', 'main-2026-11-24.log');
    const coworkLogPath = path.join(userDataDir, 'logs', 'cowork.log');
    const dshLogPath = path.join(userDataDir, DSH_PROFILE_DIR_NAME, 'dsh.log');
    const installTimingPath = path.join(appDataDir, 'LobsterAI', 'install-timing.log');

    for (const filePath of [mainLogPath, coworkLogPath, dshLogPath, installTimingPath]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'sample\n', 'utf8');
    }

    const winEntries = buildLogExportEntries({
      mainLogEntries: [{ archiveName: 'main-2026-11-24.log', filePath: mainLogPath }],
      coworkLogPath,
      computerUseLogEntries: [],
      userDataDir,
      appDataDir,
      platform: 'win32',
    });
    expect(winEntries.map((entry) => entry.archiveName)).toEqual([
      'main-2026-11-24.log',
      'cowork.log',
      'dsh.log',
      'install-timing.log',
    ]);

    const macEntries = buildLogExportEntries({
      mainLogEntries: [{ archiveName: 'main-2026-11-24.log', filePath: mainLogPath }],
      coworkLogPath,
      computerUseLogEntries: [],
      userDataDir,
      appDataDir,
      platform: 'darwin',
    });
    expect(macEntries.map((entry) => entry.archiveName)).toEqual([
      'main-2026-11-24.log',
      'cowork.log',
      'dsh.log',
    ]);
  });

  test('ignores directories at optional log paths', () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const appDataDir = path.join(root, 'appData');
    fs.mkdirSync(path.join(userDataDir, DSH_PROFILE_DIR_NAME, 'dsh.log'), { recursive: true });

    const entries = buildLogExportEntries({
      mainLogEntries: [],
      coworkLogPath: path.join(userDataDir, 'logs', 'cowork.log'),
      computerUseLogEntries: [],
      userDataDir,
      appDataDir,
      platform: 'win32',
    });
    expect(entries).toEqual([]);
  });
});
