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

const padDatePart = (value: number): string => String(value).padStart(2, '0');

export function formatOpenClawBackupTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('')
    + '-'
    + [
      padDatePart(date.getHours()),
      padDatePart(date.getMinutes()),
      padDatePart(date.getSeconds()),
    ].join('');
}

export function resolveOpenClawConfigBackupPath(
  configPath: string,
  fileExists: (filePath: string) => boolean = fs.existsSync,
  now: Date = new Date(),
): string {
  const configDir = path.dirname(configPath);
  const preferredBackupPath = path.join(configDir, 'openclaw-bak.json');
  if (!fileExists(preferredBackupPath)) {
    return preferredBackupPath;
  }

  const timestamp = formatOpenClawBackupTimestamp(now);
  const timestampedBackupPath = path.join(configDir, `openclaw-bak-${timestamp}.json`);
  if (!fileExists(timestampedBackupPath)) {
    return timestampedBackupPath;
  }

  for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidatePath = path.join(configDir, `openclaw-bak-${timestamp}-${index}.json`);
    if (!fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error('Unable to allocate an OpenClaw config backup path.');
}

export function backupOpenClawConfig(configPath: string, backupDirectory?: string): OpenClawConfigBackupResult {
  if (!fs.existsSync(configPath)) {
    return { originalPath: configPath };
  }

  const backupPath = backupDirectory
    ? path.join(backupDirectory, 'openclaw.json') : resolveOpenClawConfigBackupPath(configPath);
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
