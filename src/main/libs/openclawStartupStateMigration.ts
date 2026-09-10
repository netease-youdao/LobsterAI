import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  OPENCLAW_STARTUP_MIGRATION_ENTRY,
  OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX,
  OpenClawStartupMigrationOwner,
  type OpenClawStartupMigrationReport,
  OpenClawStartupMigrationStatus,
} from '../../shared/openclawEngine/startupMigration';

const STARTUP_MIGRATION_TIMEOUT_MS = 180_000;
const LOG_TAIL_LIMIT = 4_000;

export type StartupMigrationRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runStartupMigration: StartupMigrationRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    // execFile waits for the child to close, including after a timeout, before
    // allowing a retry to start another SQLite writer.
    if (error && (error.killed || typeof error.code !== 'number')) {
      reject(error);
    } else {
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    }
  });
});

function parseReport(stdout: string): OpenClawStartupMigrationReport | null {
  const line = stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX));
  if (!line) return null;
  try {
    const report = JSON.parse(line.slice(OPENCLAW_STARTUP_MIGRATION_RESULT_PREFIX.length));
    if (!report || !Object.values(OpenClawStartupMigrationStatus).includes(report.status)
      || !Number.isSafeInteger(report.sourceCount) || report.sourceCount < 0
      || !report.sourceCounts || typeof report.sourceCounts !== 'object' || Array.isArray(report.sourceCounts)
      || Object.keys(report.sourceCounts).length !== Object.keys(OpenClawStartupMigrationOwner).length
      || !Object.values(OpenClawStartupMigrationOwner).every(owner =>
        Number.isSafeInteger(report.sourceCounts[owner]) && report.sourceCounts[owner] >= 0)
      || Object.values(OpenClawStartupMigrationOwner).reduce((total, owner) => total + report.sourceCounts[owner], 0)
        !== report.sourceCount
      || ![report.changes, report.notices, report.warnings, report.remainingPaths].every(
        values => Array.isArray(values) && values.every(value => typeof value === 'string'),
      )) return null;
    return report as OpenClawStartupMigrationReport;
  } catch {
    return null;
  }
}

export async function migrateLegacyStateBeforeStartup(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: StartupMigrationRunner;
}): Promise<{ status: OpenClawStartupMigrationStatus; error?: string }> {
  const entryPath = path.join(params.runtimeRoot, OPENCLAW_STARTUP_MIGRATION_ENTRY);
  try {
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Bundled startup migration helper is missing: ${entryPath}`);
    }
    const result = await (params.runner ?? runStartupMigration)(params.electronNodeRuntimePath, [entryPath], {
      cwd: params.runtimeRoot,
      env: {
        ...params.env,
        OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: STARTUP_MIGRATION_TIMEOUT_MS,
    });
    const report = parseReport(result.stdout);
    if (report) {
      console.log('[OpenClaw] Startup state migration checked:', { status: report.status, sourceCounts: report.sourceCounts });
    }
    // Keep backup locations visible even when another source blocks this run.
    for (const change of report?.changes ?? []) {
      console.log('[OpenClaw] Startup state migration: ' + change);
    }
    for (const notice of report?.notices ?? []) {
      console.log('[OpenClaw] Startup state migration: ' + notice);
    }
    if (result.code !== 0 || !report || report.status === OpenClawStartupMigrationStatus.Failed
      || report.warnings.length > 0 || report.remainingPaths.length > 0) {
      const detail = report
        ? [...report.warnings, ...report.remainingPaths.map(value => `Unmigrated startup state: ${value}`)].join('\n')
        : result.stderr.trim().slice(-LOG_TAIL_LIMIT);
      throw new Error(detail || `Startup migration did not report verified completion (exit code ${result.code}).`);
    }
    return { status: report.status };
  } catch (error) {
    console.error('[OpenClaw] Startup state migration failed before gateway startup:', error);
    return {
      status: OpenClawStartupMigrationStatus.Failed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
