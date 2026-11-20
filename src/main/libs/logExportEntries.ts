import path from 'node:path';

import { app } from 'electron';

import { DSH_PROFILE_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import { getRecentComputerUseLogEntries } from '../computerUse/computerUseLogs';
import { getRecentMainLogEntries } from '../logger';
import { getCoworkLogPath } from './coworkLogger';
import type { LogArchiveEntry } from './logExport';

export function getLogExportEntries(): LogArchiveEntry[] {
  const dshLogPath = path.join(app.getPath('userData'), DSH_PROFILE_DIR_NAME, 'dsh.log');
  return [
    ...getRecentMainLogEntries(),
    { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
    ...getRecentComputerUseLogEntries(),
    { archiveName: 'dsh.log', filePath: dshLogPath },
    ...(process.platform === 'win32' ? [{
      archiveName: 'install-timing.log',
      filePath: path.join(app.getPath('appData'), 'LobsterAI', 'install-timing.log'),
    }] : []),
  ];
}
