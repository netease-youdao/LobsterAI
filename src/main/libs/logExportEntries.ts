import path from 'node:path';

import { app } from 'electron';

import { getRecentComputerUseLogEntries } from '../computerUse/computerUseLogs';
import { getRecentMainLogEntries } from '../logger';
import { getCoworkLogPath } from './coworkLogger';
import type { LogArchiveEntry } from './logExport';
import { getRecentOpenClawDailyLogEntries } from './openclawDailyLogs';
import type { OpenClawEngineManager } from './openclawEngineManager';

export function getLogExportEntries(manager: OpenClawEngineManager): LogArchiveEntry[] {
  return [
    ...getRecentMainLogEntries(),
    { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
    ...getRecentComputerUseLogEntries(),
    ...manager.getRecentGatewayLogEntries(),
    ...getRecentOpenClawDailyLogEntries(manager.getOpenClawDailyLogDirs()),
    ...(process.platform === 'win32' ? [{
      archiveName: 'install-timing.log',
      filePath: path.join(app.getPath('appData'), 'LobsterAI', 'install-timing.log'),
    }] : []),
  ];
}
