import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  OPENCLAW_WORKSPACE_MIGRATION_ENTRY,
  OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX,
  type OpenClawWorkspaceMigrationReport,
  OpenClawWorkspaceMigrationStatus,
} from '../../shared/openclawEngine/workspaceMigration';

const WORKSPACE_MIGRATION_TIMEOUT_MS = 180_000;
const LOG_TAIL_LIMIT = 4_000;

export type WorkspaceMigrationRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runWorkspaceMigration: WorkspaceMigrationRunner = (command, args, options) => new Promise((resolve, reject) => {
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

function parseReport(stdout: string): OpenClawWorkspaceMigrationReport | null {
  const line = stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX));
  if (!line) return null;
  try {
    const report = JSON.parse(line.slice(OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX.length));
    if (!report || !Object.values(OpenClawWorkspaceMigrationStatus).includes(report.status)
      || !Number.isSafeInteger(report.sourceCount) || report.sourceCount < 0
      || ![report.changes, report.warnings, report.remainingPaths].every(
        values => Array.isArray(values) && values.every(value => typeof value === 'string'),
      )) return null;
    return report as OpenClawWorkspaceMigrationReport;
  } catch {
    return null;
  }
}

export async function migrateLegacyWorkspaceStateBeforeStartup(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: WorkspaceMigrationRunner;
}): Promise<{ status: OpenClawWorkspaceMigrationStatus; error?: string }> {
  const entryPath = path.join(params.runtimeRoot, OPENCLAW_WORKSPACE_MIGRATION_ENTRY);
  try {
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Bundled workspace migration helper is missing: ${entryPath}`);
    }
    const result = await (params.runner ?? runWorkspaceMigration)(params.electronNodeRuntimePath, [entryPath], {
      cwd: params.runtimeRoot,
      env: {
        ...params.env,
        OPENCLAW_HOME: path.dirname(params.stateDir),
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_CONFIG_PATH: params.configPath,
        OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
        ELECTRON_RUN_AS_NODE: '1',
      },
      timeoutMs: WORKSPACE_MIGRATION_TIMEOUT_MS,
    });
    const report = parseReport(result.stdout);
    if (result.code !== 0 || !report || report.status === OpenClawWorkspaceMigrationStatus.Failed
      || report.warnings.length > 0 || report.remainingPaths.length > 0) {
      const detail = report
        ? [...report.warnings, ...report.remainingPaths.map(value => `Unmigrated workspace state: ${value}`)].join('\n')
        : result.stderr.trim().slice(-LOG_TAIL_LIMIT);
      throw new Error(detail || `Workspace migration did not report verified completion (exit code ${result.code}).`);
    }
    if (report.status === OpenClawWorkspaceMigrationStatus.Migrated) {
      console.log(`[OpenClaw] Migrated ${report.sourceCount} legacy workspace state source(s) to SQLite.`);
    }
    return { status: report.status };
  } catch (error) {
    console.error('[OpenClaw] Workspace state migration failed before gateway startup:', error);
    return {
      status: OpenClawWorkspaceMigrationStatus.Failed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
