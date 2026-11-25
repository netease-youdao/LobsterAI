import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import { DSH_PROFILE_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import { getRecentComputerUseLogEntries } from '../computerUse/computerUseLogs';
import { getRecentMainLogEntries } from '../logger';
import { getCoworkLogPath } from './coworkLogger';
import type { LogArchiveEntry } from './logExport';

function isExistingRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function buildLogExportEntries(options: {
  mainLogEntries: LogArchiveEntry[];
  coworkLogPath: string;
  computerUseLogEntries: LogArchiveEntry[];
  userDataDir: string;
  appDataDir: string;
  platform?: NodeJS.Platform;
}): LogArchiveEntry[] {
  const platform = options.platform ?? process.platform;
  const optionalEntries: LogArchiveEntry[] = [
    { archiveName: 'dsh.log', filePath: path.join(options.userDataDir, DSH_PROFILE_DIR_NAME, 'dsh.log') },
    ...(platform === 'win32' ? [{
      archiveName: 'install-timing.log',
      filePath: path.join(options.appDataDir, 'LobsterAI', 'install-timing.log'),
    }] : []),
  ];

  return [
    ...options.mainLogEntries,
    ...(isExistingRegularFile(options.coworkLogPath)
      ? [{ archiveName: 'cowork.log', filePath: options.coworkLogPath }]
      : []),
    ...options.computerUseLogEntries,
    ...optionalEntries.filter((entry) => isExistingRegularFile(entry.filePath)),
  ];
}

export function getLogExportEntries(): LogArchiveEntry[] {
  return buildLogExportEntries({
    mainLogEntries: getRecentMainLogEntries(),
    coworkLogPath: getCoworkLogPath(),
    computerUseLogEntries: getRecentComputerUseLogEntries(),
    userDataDir: app.getPath('userData'),
    appDataDir: app.getPath('appData'),
  });
}
