import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  OPENCLAW_REPAIR_ENTRY,
  OPENCLAW_REPAIR_RESULT_PREFIX,
  type OpenClawCompatibilityRepairReport,
  OpenClawRepairPhase,
  OpenClawRepairStage,
} from '../../shared/openclawEngine/repair';
import { OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import { isOpenClawBindingSchemaFailure, runOpenClawStartupCompatibility } from './openclawStartupCompatibility';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';

const REPAIR_TIMEOUT_MS = 300_000;
export const OPENCLAW_DOCTOR_REPAIR_ARGS = ['doctor', '--fix', '--non-interactive'] as const;

export class OpenClawRepairFailure extends Error {
  constructor(readonly stage: OpenClawRepairStage, message: string, readonly failurePath?: string) {
    super(message);
    this.name = 'OpenClawRepairFailure';
  }
}

async function atRepairStage<T>(stage: OpenClawRepairStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof OpenClawRepairFailure) throw error;
    throw new OpenClawRepairFailure(stage, error instanceof Error ? error.message : String(error),
      (error as NodeJS.ErrnoException)?.path);
  }
}

function repairEnvironment(env: NodeJS.ProcessEnv, stateDir: string, configPath: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ...env, OPENCLAW_HOME: path.dirname(stateDir), OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_SERVICE_REPAIR_POLICY: 'external', ELECTRON_RUN_AS_NODE: '1',
  };
  delete result.NODE_OPTIONS;
  delete result.NODE_PATH;
  return result;
}

const runRepair: StartupMigrationRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, {
    cwd: options.cwd, env: options.env, windowsHide: true, encoding: 'utf8',
    timeout: options.timeoutMs, maxBuffer: 1024 * 1024,
  }, (error, stdout, stderr) => {
    // Wait for close even on timeout before releasing the maintenance guard.
    if (error && (error.killed || typeof error.code !== 'number')) reject(error);
    else resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
  });
});

export function createOpenClawRepairBackupDirectory(baseDir: string): string {
  const root = path.join(baseDir, 'repair-backups');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
}

type StartupCompatibilityRepairOptions = Omit<Parameters<typeof runOpenClawStartupCompatibility>[0], 'mode'>;

async function runStartupCompatibilityRepair(
  params: StartupCompatibilityRepairOptions, mode: OpenClawStartupCompatibilityMode,
): Promise<void> {
  const result = await runOpenClawStartupCompatibility({
    ...params, mode, env: repairEnvironment(params.env, params.stateDir, params.configPath),
    runner: params.runner ?? runRepair,
  });
  if (result.status === OpenClawStartupMigrationStatus.Failed) {
    throw new Error(result.error || 'OpenClaw startup compatibility repair failed.');
  }
}

async function withBindingRecovery<T>(params: StartupCompatibilityRepairOptions, repair: () => Promise<T>): Promise<T> {
  try {
    return await repair();
  } catch (error) {
    if (!isOpenClawBindingSchemaFailure(error instanceof Error ? error.message : String(error), params.stateDir)) throw error;
    // The full repair also verifies schemas before gateway startup can perform
    // its recovery. Reuse that scoped helper and retry this stage only once.
    await runStartupCompatibilityRepair(params, OpenClawStartupCompatibilityMode.RepairBindings);
    return repair();
  }
}

export async function runOpenClawCompatibilityRepair(
  params: Parameters<typeof runCompatibilityRepairPhase>[0],
): Promise<OpenClawCompatibilityRepairReport> {
  return atRepairStage(params.phase, () => params.phase === OpenClawRepairPhase.Recovery
    ? withBindingRecovery(params, () => runCompatibilityRepairPhase(params))
    : runCompatibilityRepairPhase(params));
}

async function runCompatibilityRepairPhase(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  backupDir: string;
  phase: OpenClawRepairPhase;
  legacyConfigPath?: string;
  env: NodeJS.ProcessEnv;
  runner?: StartupMigrationRunner;
}): Promise<OpenClawCompatibilityRepairReport> {
  const entry = path.join(params.runtimeRoot, OPENCLAW_REPAIR_ENTRY);
  if (!fs.existsSync(entry)) throw new Error(`Bundled one-click repair helper is missing: ${entry}`);
  const requestPath = path.join(params.backupDir, `${params.phase}-request.json`);
  fs.writeFileSync(requestPath, JSON.stringify({
    phase: params.phase, backupDir: params.backupDir, legacyConfigPath: params.legacyConfigPath,
  }), { mode: 0o600 });
  // The app controls this helper's runtime. Shell-injected loaders/options must
  // not change its SQLite ABI or import code from outside the packaged runtime.
  const env = repairEnvironment(params.env, params.stateDir, params.configPath);
  const result = await (params.runner ?? runRepair)(params.electronNodeRuntimePath, [entry, requestPath], {
    cwd: params.runtimeRoot, env, timeoutMs: REPAIR_TIMEOUT_MS,
  });
  const line = result.stdout.split(/\r?\n/).findLast(value => value.startsWith(OPENCLAW_REPAIR_RESULT_PREFIX));
  let report: OpenClawCompatibilityRepairReport | undefined;
  if (line) {
    const value = JSON.parse(line.slice(OPENCLAW_REPAIR_RESULT_PREFIX.length));
    if (value?.phase === params.phase && typeof value.success === 'boolean'
      && [value.changes, value.backups].every(items => Array.isArray(items) && items.every(item => typeof item === 'string'))
      && (value.error === undefined || typeof value.error === 'string')
      && (value.failurePath === undefined || typeof value.failurePath === 'string')) report = value;
  }
  for (const change of report?.changes ?? []) console.log(`[OpenClawRepair] ${change}`);
  if (result.code !== 0 || !report?.success || report.error) {
    throw new OpenClawRepairFailure(params.phase,
      report?.error || result.stderr.trim().slice(-4000) || 'One-click repair did not report verified completion.', report?.failurePath);
  }
  return report;
}

export async function runOpenClawDoctorRepair(params: {
  runtimeRoot: string; stateDir: string; configPath: string; backupDir: string;
  electronNodeRuntimePath: string; env: NodeJS.ProcessEnv; runner?: StartupMigrationRunner;
}): Promise<{ code: number | null }> {
  // Migrate the shared schema before importing config into it. Doctor may then
  // remove retired JSON fields only after their canonical values are preserved.
  await atRepairStage(OpenClawRepairStage.Preparation, () => withBindingRecovery(params,
    () => runStartupCompatibilityRepair(params, OpenClawStartupCompatibilityMode.PrepareStartup)));
  return atRepairStage(OpenClawRepairStage.Doctor, async () => {
    const result = await (params.runner ?? runRepair)(params.electronNodeRuntimePath, [
      path.join(params.runtimeRoot, 'openclaw.mjs'), ...OPENCLAW_DOCTOR_REPAIR_ARGS,
    ], {
      cwd: params.runtimeRoot, env: repairEnvironment(params.env, params.stateDir, params.configPath), timeoutMs: REPAIR_TIMEOUT_MS,
    });
    fs.writeFileSync(path.join(params.backupDir, 'doctor.log'), result.stdout + '\n' + result.stderr, { mode: 0o600 });
    fs.writeFileSync(path.join(params.backupDir, 'doctor-result.json'), JSON.stringify({ code: result.code }), { mode: 0o600 });
    // A Doctor error may describe the orphan vectors/plugin payloads handled by
    // the next stages. Only verified schemas and a running gateway certify repair.
    console.log(`[OpenClawRepair] doctor --fix finished (exit code ${result.code}).`);
    return { code: result.code };
  });
}
