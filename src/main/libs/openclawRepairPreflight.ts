// Explicit Quick Repair only, after the gateway stops and its full snapshot succeeds.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { OPENCLAW_REPAIR_SNAPSHOT_MANIFEST, OpenClawRepairPhase } from '../../shared/openclawEngine/repair';
import {
  healOpenClawConfigUnrecognizedKeys,
  type OpenClawConfigSelfHealResult,
  OpenClawConfigSelfHealSkipReason,
  OpenClawConfigSelfHealStatus,
} from './openclawConfigSelfHeal';
import { isMissingUnaliasedPluginPath } from './openclawPluginRepairPaths';
import { assertOwnedRepairPath } from './openclawRepairPaths';
import { listLegacySessionStorePaths } from './openclawSessionLegacyMigration';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';
import { safelyReplaceTextFileSync } from './safeFileReplace';

const UTF8_BOM = '\uFEFF';
const THIRD_PARTY_EXTENSIONS_DIR = 'third-party-extensions';
// Do not infer ownership just from the final directory name: users can link
// arbitrary custom plugin directories with the same name.
const PREVIOUS_RUNTIME_EXTENSIONS = /[/\\](?:resources[/\\]cfmind|vendor[/\\]openclaw-runtime[/\\][^/\\]+)[/\\]third-party-extensions[/\\]*$/i;
export const OPENCLAW_REPAIR_PREFLIGHT_REPORT = 'preflight-report.json';

interface PreflightOptions {
  runtimeRoot: string;
  stateDir: string;
  configPath: string;
  backupDir: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: StartupMigrationRunner;
}

export interface OpenClawRepairPreflightReport {
  config?: OpenClawConfigSelfHealResult;
  replacedPluginLoadPaths: string[];
  repairedSessionStores: string[];
  quarantinedSessionStores: Array<{ originalPath: string; quarantinePath: string }>;
}

export function readOpenClawRepairQuarantinedStoreCount(backupDir?: string): number {
  if (!backupDir) return 0;
  const reportPath = path.join(backupDir, OPENCLAW_REPAIR_PREFLIGHT_REPORT);
  if (!fs.existsSync(reportPath)) return 0;
  try {
    const report: OpenClawRepairPreflightReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return report.quarantinedSessionStores.length;
  } catch (error) {
    console.warn('[OpenClawRepair] Could not read the session recovery report:', error);
    return 0;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

function parsesAsSessionStore(raw: string): boolean {
  try { return isRecord(JSON.parse(raw)); } catch { return false; }
}

function requireCompletedSnapshot(backupDir: string): void {
  const report = JSON.parse(fs.readFileSync(path.join(backupDir, `${OpenClawRepairPhase.Snapshot}-report.json`), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), 'utf8'));
  if (report.phase !== OpenClawRepairPhase.Snapshot || report.success !== true || manifest.version !== 1) {
    throw new Error('Quick Repair requires a completed state snapshot before repairing legacy files.');
  }
}

function readBackedUpFile(params: PreflightOptions, filePath: string): Buffer {
  assertOwnedRepairPath(params.stateDir, filePath);
  const backupPath = path.join(params.backupDir, 'original', path.relative(params.stateDir, filePath));
  assertOwnedRepairPath(params.backupDir, backupPath);
  const raw = fs.readFileSync(filePath);
  if (!raw.equals(fs.readFileSync(backupPath))) {
    throw new Error(`OpenClaw state changed after the repair snapshot: ${filePath}`);
  }
  return raw;
}

function replaceConfigPluginPaths(params: PreflightOptions, raw: Buffer): string[] {
  let config: unknown;
  try { config = JSON.parse(raw.toString('utf8')); } catch { return []; }
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.load)
    || !Array.isArray(config.plugins.load.paths)) return [];
  const currentPath = path.join(params.runtimeRoot, THIRD_PARTY_EXTENSIONS_DIR);
  if (!fs.existsSync(currentPath) || !fs.statSync(currentPath).isDirectory()) return [];
  const replaced: string[] = [];
  const paths = config.plugins.load.paths.filter((loadPath: unknown) => {
    if (typeof loadPath !== 'string' || !PREVIOUS_RUNTIME_EXTENSIONS.test(loadPath)
      || !isMissingUnaliasedPluginPath(loadPath)) return true;
    replaced.push(loadPath);
    return false;
  });
  if (!replaced.length) return [];
  if (!paths.includes(currentPath)) paths.push(currentPath);
  config.plugins.load.paths = paths;
  safelyReplaceTextFileSync({
    filePath: params.configPath, content: `${JSON.stringify(config, null, 2)}\n`,
    mode: fs.statSync(params.configPath).mode & 0o777, tempLabel: 'repair-plugin-paths',
  });
  return replaced;
}

/** Repair only backed-up files; failures remain blocking and preserve their originals. */
export async function runOpenClawRepairPreflight(params: PreflightOptions): Promise<OpenClawRepairPreflightReport> {
  requireCompletedSnapshot(params.backupDir);
  const report: OpenClawRepairPreflightReport = {
    replacedPluginLoadPaths: [], repairedSessionStores: [], quarantinedSessionStores: [],
  };
  try {
    // Check every candidate before making the first change. Snapshot failures,
    // permission errors and concurrent writes must never be treated as corruption.
    const configRaw = fs.existsSync(params.configPath) ? readBackedUpFile(params, params.configPath) : undefined;
    const stores = listLegacySessionStorePaths(params.stateDir)
      .map(storePath => ({ storePath, raw: readBackedUpFile(params, storePath) }));
    if (configRaw) {
      report.replacedPluginLoadPaths = replaceConfigPluginPaths(params, configRaw);
      report.config = await healOpenClawConfigUnrecognizedKeys(params);
      if (report.config.status === OpenClawConfigSelfHealStatus.Skipped
        && report.config.reason === OpenClawConfigSelfHealSkipReason.ConfigChanged) {
        throw new Error('OpenClaw config changed during Quick Repair.');
      }
    }
    for (const { storePath, raw } of stores) {
      const text = raw.toString('utf8');
      if (parsesAsSessionStore(text)) continue;
      // The CLI validation above is asynchronous. Recheck before changing stores.
      readBackedUpFile(params, storePath);
      if (text.startsWith(UTF8_BOM) && parsesAsSessionStore(text.slice(UTF8_BOM.length))) {
        safelyReplaceTextFileSync({
          filePath: storePath, content: text.slice(UTF8_BOM.length),
          mode: fs.statSync(storePath).mode & 0o777, tempLabel: 'repair-bom',
        });
        report.repairedSessionStores.push(storePath);
      } else {
        const quarantinePath = `${storePath}.unreadable-${randomUUID()}`;
        fs.renameSync(storePath, quarantinePath);
        report.quarantinedSessionStores.push({ originalPath: storePath, quarantinePath });
      }
    }
    if (report.quarantinedSessionStores.length) {
      console.warn(`[OpenClawRepair] Preserved ${report.quarantinedSessionStores.length} unreadable session indexes for manual recovery; backup: ${params.backupDir}`);
    }
    return report;
  } finally {
    // Keep the recovery locations even if a later candidate/stage fails.
    fs.writeFileSync(path.join(params.backupDir, OPENCLAW_REPAIR_PREFLIGHT_REPORT), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
