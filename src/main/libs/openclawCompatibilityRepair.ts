import fs from 'node:fs';
import path from 'node:path';

import {
  OPENCLAW_REPAIR_ENTRY,
  OPENCLAW_REPAIR_RESULT_PREFIX,
  OPENCLAW_REPAIR_SNAPSHOT_MANIFEST,
  type OpenClawCompatibilityRepairReport,
  OpenClawRepairPhase,
  OpenClawRepairStage,
} from '../../shared/openclawEngine/repair';
import { OpenClawStartupCompatibilityMode } from '../../shared/openclawEngine/startupCompatibility';
import { OpenClawStartupMigrationStatus } from '../../shared/openclawEngine/startupMigration';
import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';
import { runOpenClawRepairPreflight } from './openclawRepairPreflight';
import { createOpenClawRepairRunner } from './openclawRepairProcess';
import { isRegenerableSnapshotPath, REGENERABLE_SNAPSHOT_PATH_MAX_DEPTH } from './openclawRepairSnapshotPaths';
import { isOpenClawBindingSchemaFailure, runOpenClawStartupCompatibility } from './openclawStartupCompatibility';
import type { StartupMigrationRunner } from './openclawStartupStateMigration';
import { removeTreeNoFollow } from './removeTreeNoFollow';

const REPAIR_TIMEOUT_MS = 300_000;
export const OPENCLAW_DOCTOR_REPAIR_ARGS = ['doctor', '--fix', '--non-interactive'] as const;

export class OpenClawRepairFailure extends Error {
  constructor(readonly stage: OpenClawRepairStage, message: string, readonly failurePath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenClawRepairFailure';
  }
}

async function atRepairStage<T>(stage: OpenClawRepairStage, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof OpenClawRepairFailure) throw error;
    throw new OpenClawRepairFailure(stage, error instanceof Error ? error.message : String(error),
      (error as NodeJS.ErrnoException)?.path, { cause: error });
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

const REPAIR_BACKUPS_DIRECTORY = 'repair-backups';
// Runs created below: an ISO timestamp with ':' and '.' replaced, then mkdtemp's suffix.
const REPAIR_BACKUP_RUN_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[^/\\]+$/;
/** Repair runs kept on disk, including the run that just finished. */
export const OPENCLAW_REPAIR_BACKUP_RETENTION = 2;
/** Runs older than this are removed even when within the retention count. */
export const OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// A run written to this recently may still be in progress: never touch it.
const REPAIR_BACKUP_IN_PROGRESS_GUARD_MS = 60 * 60 * 1000;
// Runs are renamed to this prefix before removal. A partly removed run then no
// longer matches REPAIR_BACKUP_RUN_NAME, so it cannot pass for an in-progress
// run, and the next prune finishes it.
const REPAIR_BACKUP_STAGED_PREFIX = '.lobsterai-stale-';

export function createOpenClawRepairBackupDirectory(baseDir: string): string {
  const root = path.join(baseDir, REPAIR_BACKUPS_DIRECTORY);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
}

export interface OpenClawRepairBackupPruneResult {
  removedRuns: string[];
  /** `<run>/original`-relative cache paths removed from retained runs. */
  strippedPaths: string[];
}

/** Drop caches that snapshots taken before the exclusion rules still contain. */
async function stripRegenerableSnapshotPaths(run: string, throttle: DiskCleanupThrottle): Promise<string[]> {
  const original = path.join(run, 'original');
  const stripped: string[] = [];
  async function visit(relative: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(original, relative), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      // Dirent never reports a link as a directory, so links are not followed.
      if (!entry.isDirectory()) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (isRegenerableSnapshotPath(child)) {
        await removeTreeNoFollow(path.join(original, child), () => throttle.step());
        stripped.push(child);
      } else if ((relative || entry.name === 'browser') && depth + 1 < REGENERABLE_SNAPSHOT_PATH_MAX_DEPTH) {
        await visit(child, depth + 1);
      }
    }
  }
  await visit('', 0);
  if (stripped.length) {
    const manifestPath = path.join(run, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST);
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      const recorded: unknown = manifest.skippedRegenerablePaths;
      manifest.skippedRegenerablePaths = [...new Set([...(Array.isArray(recorded) ? recorded : []), ...stripped])];
      await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    } catch (error) {
      // Failed snapshots have no manifest; there is nothing to annotate.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[OpenClawRepair] could not record stripped caches in ${manifestPath}:`, error);
      }
    }
  }
  return stripped;
}

function runCreatedAt(name: string, stats: fs.Stats): number {
  const match = REPAIR_BACKUP_RUN_NAME.exec(name);
  const parsed = match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
  return Number.isNaN(parsed) ? stats.mtimeMs : parsed;
}

/**
 * Bound `repair-backups/`: keep the newest runs (the current run included and
 * always kept), remove runs past the retention count or older than the age
 * limit, and strip regenerable caches from the runs that remain. A run written
 * within the last hour, other than the finished current run, may still be in
 * progress and is left untouched. Entries this module did not create are
 * ignored. Best-effort: failures are logged and skipped. With a throttle, a
 * stopped pass throws DiskCleanupStoppedError and the next prune resumes.
 */
export async function pruneOpenClawRepairBackups(
  baseDir: string, options: { currentBackupDir?: string; now?: number; throttle?: DiskCleanupThrottle } = {},
): Promise<OpenClawRepairBackupPruneResult> {
  const result: OpenClawRepairBackupPruneResult = { removedRuns: [], strippedPaths: [] };
  const root = path.join(baseDir, REPAIR_BACKUPS_DIRECTORY);
  const now = options.now ?? Date.now();
  const throttle = options.throttle ?? UNTHROTTLED_DISK_CLEANUP;
  const current = options.currentBackupDir ? path.resolve(options.currentBackupDir) : undefined;
  let runs: Array<{ run: string; createdAt: number; mtimeMs: number }>;
  let staged: string[];
  try {
    const allEntries = await fs.promises.readdir(root, { withFileTypes: true });
    staged = allEntries.filter(entry => entry.isDirectory() && entry.name.startsWith(REPAIR_BACKUP_STAGED_PREFIX))
      .map(entry => path.join(root, entry.name));
    const entries = allEntries.filter(entry => entry.isDirectory() && REPAIR_BACKUP_RUN_NAME.test(entry.name));
    runs = await Promise.all(entries.map(async (entry) => {
      const run = path.join(root, entry.name);
      const stats = await fs.promises.stat(run);
      return { run, createdAt: runCreatedAt(entry.name, stats), mtimeMs: stats.mtimeMs };
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[OpenClawRepair] could not list repair backups:', error);
    }
    return result;
  }
  // Finish removals an earlier, stopped prune staged.
  for (const stagedRun of staged) {
    try {
      await removeTreeNoFollow(stagedRun, () => throttle.step());
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClawRepair] could not finish removing repair backup ${stagedRun}:`, error);
    }
  }
  // Names start with the creation time, so a name sort is chronological.
  runs.sort((left, right) => (left.run < right.run ? 1 : -1));
  const isCurrent = (run: string) => path.resolve(run) === current;
  const inProgress = (mtimeMs: number) => now - mtimeMs < REPAIR_BACKUP_IN_PROGRESS_GUARD_MS;
  // Possibly in-progress runs take retention slots wherever their names sort.
  let retainedOthers = runs.filter(({ run, mtimeMs }) => !isCurrent(run) && inProgress(mtimeMs)).length;
  const retainedSlots = OPENCLAW_REPAIR_BACKUP_RETENTION - (current ? 1 : 0);
  const toStrip: string[] = [];
  for (const { run, createdAt, mtimeMs } of runs) {
    if (isCurrent(run)) {
      toStrip.push(run);
      continue;
    }
    if (inProgress(mtimeMs)) continue;
    if (retainedOthers < retainedSlots && now - createdAt <= OPENCLAW_REPAIR_BACKUP_MAX_AGE_MS) {
      retainedOthers += 1;
      toStrip.push(run);
      continue;
    }
    try {
      const stagedRun = path.join(root, `${REPAIR_BACKUP_STAGED_PREFIX}${path.basename(run)}`);
      await fs.promises.rename(run, stagedRun);
      // Snapshots recreate links and Windows junctions; never follow them.
      await removeTreeNoFollow(stagedRun, () => throttle.step());
      result.removedRuns.push(run);
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClawRepair] could not remove old repair backup ${run}:`, error);
    }
  }
  for (const run of toStrip) {
    try {
      result.strippedPaths.push(...(await stripRegenerableSnapshotPaths(run, throttle)).map(item => path.join(run, 'original', item)));
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClawRepair] could not strip caches from repair backup ${run}:`, error);
    }
  }
  return result;
}

type StartupCompatibilityRepairOptions = Omit<Parameters<typeof runOpenClawStartupCompatibility>[0], 'mode'> & { backupDir: string };

async function runStartupCompatibilityRepair(
  params: StartupCompatibilityRepairOptions, mode: OpenClawStartupCompatibilityMode,
): Promise<void> {
  const result = await runOpenClawStartupCompatibility({
    ...params, mode, env: repairEnvironment(params.env, params.stateDir, params.configPath),
    runner: params.runner ?? createOpenClawRepairRunner(params.backupDir),
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
  const result = await (params.runner ?? createOpenClawRepairRunner(params.backupDir))(params.electronNodeRuntimePath, [entry, requestPath], {
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
  const runner = params.runner ?? createOpenClawRepairRunner(params.backupDir);
  await atRepairStage(OpenClawRepairStage.Preparation, async () => {
    // Retired keys can block the validating writer in prepare-startup itself.
    // Only explicit repair may clear them, after a verified full snapshot.
    await runOpenClawRepairPreflight({
      ...params, env: repairEnvironment(params.env, params.stateDir, params.configPath), runner,
    });
    // Migrate schema/discovery before Doctor. The final plugin phase recovers
    // install records from the untouched snapshot if this writer strips them.
    await withBindingRecovery({ ...params, runner },
      () => runStartupCompatibilityRepair({ ...params, runner }, OpenClawStartupCompatibilityMode.PrepareStartup));
  });
  return atRepairStage(OpenClawRepairStage.Doctor, async () => {
    const result = await runner(params.electronNodeRuntimePath, [
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
