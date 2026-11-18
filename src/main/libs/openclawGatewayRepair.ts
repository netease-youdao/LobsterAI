import fs from 'fs';
import path from 'path';

import { OpenClawEngineErrorCode } from '../../shared/openclawEngine/constants';
import { hasLegacyOpenClawDiscovery } from './openclawStartupCompatibility';

export interface OpenClawConfigBackupResult {
  originalPath: string;
  backupPath?: string;
}

export const OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR =
  'OpenClaw has active sessions or scheduled tasks. Stop them before repairing the gateway state.';

export function getOpenClawGatewayRepairBusyError(hasActiveWorkloads: boolean): string | null {
  return hasActiveWorkloads ? OPENCLAW_GATEWAY_REPAIR_BUSY_ERROR : null;
}

/** Move the config into the repair run's backup directory, which repair pruning bounds. */
export function backupOpenClawConfig(configPath: string, backupDirectory: string): OpenClawConfigBackupResult {
  if (!fs.existsSync(configPath)) {
    return { originalPath: configPath };
  }

  const backupPath = path.join(backupDirectory, 'openclaw.json');
  if (fs.existsSync(backupPath)) throw new Error(`OpenClaw config backup already exists: ${backupPath}`);
  fs.renameSync(configPath, backupPath);
  return {
    originalPath: configPath,
    backupPath,
  };
}

/** Quick Repair must retain compatibility migration sources until verified. */
export function preserveOpenClawConfigForStartupRecovery(configPath: string, errorCode?: OpenClawEngineErrorCode): boolean {
  if (errorCode === OpenClawEngineErrorCode.StartupCompatibilityFailed
    || errorCode === OpenClawEngineErrorCode.MemoryDreamingMigrationFailed
    || errorCode === OpenClawEngineErrorCode.StartupMigrationRefused) return true;
  try {
    return hasLegacyOpenClawDiscovery(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return false;
  }
}
