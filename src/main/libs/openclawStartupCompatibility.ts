import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';

import { DREAMING_RECOVERY_REPORT_VERSION, OpenClawDreamingRecoveryOutcome, type OpenClawDreamingRecoverySummary } from '../../shared/openclawEngine/dreamingRecovery';
import {
  OPENCLAW_CLI_ERROR_TYPE,
  OPENCLAW_LEGACY_DISCOVERY_KEY,
  OPENCLAW_STARTUP_COMPATIBILITY_ENTRY,
  OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX,
  OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
  OpenClawStartupCompatibilityMode,
} from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import { isDreamingRecoveryReport, summarizeDreamingRecovery } from './openclawDreamingRecovery';
import { runStartupMigration, type StartupMigrationRunner } from './openclawStartupStateMigration';

const ERROR_LIMIT = 2_000;

/** Read the actual CLI failure before considering human-readable warning lines. */
export function extractOpenClawCliFailure(stdout: string, stderr: string): string | undefined {
  const output = stripVTControlCharacters(stdout).trim();
  // JSON mode normally writes one envelope, but startup diagnostics can precede it.
  for (const candidate of [output, ...output.split(/\r?\n/).reverse()]) {
    try {
      const value = JSON.parse(candidate);
      if (value?.ok === false && value.error?.type === OPENCLAW_CLI_ERROR_TYPE
        && typeof value.error.message === 'string' && value.error.message.trim()) {
        return value.error.message.trim().slice(0, ERROR_LIMIT);
      }
    } catch { /* A diagnostic line is not a JSON envelope. */ }
  }
  const lines = stripVTControlCharacters(stderr).split(/\r?\n/);
  const reason = lines.findIndex(line => /^\s*(?:\[(?:stdout|stderr)\]\s*)?\[openclaw\] Reason:\s*\S/.test(line));
  if (reason < 0) return undefined;
  const cause = [lines[reason].replace(/^.*?\[openclaw\] Reason:\s*/, '').trim()];
  for (const line of lines.slice(reason + 1)) {
    const continuation = line.replace(/^\[(?:stdout|stderr)\]\s*/, '').trim();
    if (!continuation || /^(?:at\s|\[openclaw\]|Config warnings:)/.test(continuation)) break;
    cause.push(continuation);
  }
  return cause.join(' ').slice(0, ERROR_LIMIT);
}

export function hasLegacyOpenClawDiscovery(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const plugins = (config as { plugins?: unknown }).plugins;
  return Boolean(plugins && typeof plugins === 'object'
    && Object.hasOwn(plugins, OPENCLAW_LEGACY_DISCOVERY_KEY));
}

/** The pinned CLI's actual media migration failure, not plugin/config warnings. */
export function isOpenClawAgentMediaMigrationFailure(message: string | undefined): boolean {
  return typeof message === 'string'
    && /^OpenClaw agent database .+ uses schema version \d+; run openclaw doctor --fix to migrate persisted media before using it\.$/.test(message.trim());
}

/** Only the app's shared-state binding failure authorizes this recovery path. */
export function extractOpenClawBindingSchemaFailure(message: string | undefined, stateDir: string): string | undefined {
  if (!message) return undefined;
  const failure = stripVTControlCharacters(message).match(
    /SQLite schema is incomplete or noncanonical for ([^\r\n]+?):\s*column definitions differ for current_conversation_bindings(?:[.;\s]|$)/,
  );
  if (!failure) return undefined;
  const normalize = (value: string) => {
    const normalized = path.normalize(value.trim()).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(failure[1]) === normalize(path.join(stateDir, 'state', 'openclaw.sqlite')) ? failure[0].trim() : undefined;
}

export function isOpenClawBindingSchemaFailure(message: string | undefined, stateDir: string): boolean {
  return Boolean(extractOpenClawBindingSchemaFailure(message, stateDir));
}

export async function runOpenClawStartupCompatibility(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  mode: OpenClawStartupCompatibilityMode;
  runner?: StartupMigrationRunner;
}): Promise<{ status: OpenClawStartupMigrationStatus; error?: string; dreamingRecovery?: OpenClawDreamingRecoverySummary }> {
  let dreamingRecovery: OpenClawDreamingRecoverySummary | undefined;
  try {
    const entry = path.join(params.runtimeRoot, OPENCLAW_STARTUP_COMPATIBILITY_ENTRY);
    if (!fs.existsSync(entry)) throw new Error(`Bundled startup compatibility helper is missing: ${entry}`);
    const result = await (params.runner ?? runStartupMigration)(params.electronNodeRuntimePath, [entry, params.mode], {
      cwd: params.runtimeRoot,
      env: {
        ...params.env,
        OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: 180_000,
    });
    const line = result.stdout.split(/\r?\n/)
      .findLast(value => value.startsWith(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX));
    const report = line ? JSON.parse(line.slice(OPENCLAW_STARTUP_COMPATIBILITY_RESULT_PREFIX.length)) : null;
    if (!report || !Object.values(OpenClawStartupMigrationStatus).includes(report.status)
      || ![report.changes, report.backups].every(values => Array.isArray(values)
        && values.every(value => typeof value === 'string'))
      || (report.error !== undefined && typeof report.error !== 'string')) {
      throw new Error(`Startup compatibility did not report verified completion (exit code ${result.code}).`);
    }
    for (const backupPath of report.backups) console.log(`[OpenClaw] Startup compatibility backup: ${backupPath}`);
    for (const change of report.changes) console.log(`[OpenClaw] Startup compatibility: ${change}`);
    if (params.mode === OpenClawStartupCompatibilityMode.RepairDreamingState) {
      if (report.reportVersion !== DREAMING_RECOVERY_REPORT_VERSION || report.operation !== params.mode
        || report.runtimeVersion !== OPENCLAW_STARTUP_COMPATIBILITY_VERSION || !isDreamingRecoveryReport(report.dreaming)) {
        throw new Error(report.error || 'Dreaming recovery did not report verified completion.');
      }
      dreamingRecovery = summarizeDreamingRecovery(report.dreaming);
      // A cleanup/lock-release error may follow completed file isolation. Keep
      // that progress and the real error, while never continuing startup.
      if ((report.status === OpenClawStartupMigrationStatus.Migrated
          && report.dreaming.outcome !== OpenClawDreamingRecoveryOutcome.Recovered)
        || (report.status === OpenClawStartupMigrationStatus.Skipped
          && report.dreaming.outcome !== OpenClawDreamingRecoveryOutcome.NotApplicable)) {
        throw new Error('Dreaming recovery returned inconsistent completion status.');
      }
      if (report.status === OpenClawStartupMigrationStatus.Migrated
        && (!dreamingRecovery || dreamingRecovery.pendingFileCount > 0 || dreamingRecovery.quarantinedFileCount === 0)) {
        throw new Error('Dreaming recovery did not verify its isolated sources.');
      }
    }
    if (result.code !== 0 || report.status === OpenClawStartupMigrationStatus.Failed || report.error) {
      throw new Error(report.error || `Startup compatibility failed (exit code ${result.code}).`);
    }
    return { status: report.status, ...(dreamingRecovery ? { dreamingRecovery } : {}) };
  } catch (error) {
    console.error('[OpenClaw] Startup compatibility failed:', error);
    return { status: OpenClawStartupMigrationStatus.Failed, error: error instanceof Error ? error.message : String(error), ...(dreamingRecovery ? { dreamingRecovery } : {}) };
  }
}
