import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const LEGACY_CRON_DOCTOR_TIMEOUT_MS = 180_000;
const LOG_TAIL_LIMIT = 4_000;

export type LegacyCronMigrationRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type LegacyCronMigrationRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<LegacyCronMigrationRunResult>;

export type LegacyCronMigrationResult =
  | { status: 'skipped'; reason: 'no-legacy-cron-files' | 'missing-openclaw-cli' }
  | { status: 'migrated'; code: number | null }
  | { status: 'failed'; code: number | null; error?: string };

export function resolveLegacyCronStorePath(stateDir: string): string {
  return path.join(stateDir, 'cron', 'jobs.json');
}

function resolveLegacyCronStatePath(stateDir: string): string {
  return path.join(stateDir, 'cron', 'jobs-state.json');
}

function listLegacyCronRunLogPaths(stateDir: string): string[] {
  const runsDir = path.join(stateDir, 'cron', 'runs');
  try {
    return fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(runsDir, entry.name));
  } catch {
    return [];
  }
}

function legacyCronRunLogsExist(stateDir: string): boolean {
  return listLegacyCronRunLogPaths(stateDir).length > 0;
}

export function hasLegacyCronStorage(stateDir: string): boolean {
  return (
    fs.existsSync(resolveLegacyCronStorePath(stateDir)) ||
    fs.existsSync(resolveLegacyCronStatePath(stateDir)) ||
    legacyCronRunLogsExist(stateDir)
  );
}

const LEGACY_CRON_ARCHIVE_SUFFIX = '.migrated';

function resolveLegacyCronArchivePath(filePath: string): string {
  const preferred = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}`;
  if (!fs.existsSync(preferred)) {
    return preferred;
  }
  return `${preferred}-${Date.now()}`;
}

// The pinned OpenClaw runtime keeps cron jobs in its shared SQLite state
// (the configured cron.store path only acts as the store key); the legacy
// JSON/JSONL files are read solely by the doctor migration. Rename them after
// a successful doctor run so hasLegacyCronStorage() stops re-triggering the
// doctor on every startup.
export function archiveLegacyCronStorage(stateDir: string): string[] {
  const candidates = [
    resolveLegacyCronStorePath(stateDir),
    resolveLegacyCronStatePath(stateDir),
    ...listLegacyCronRunLogPaths(stateDir),
  ];
  const archived: string[] = [];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const archivePath = resolveLegacyCronArchivePath(filePath);
      fs.renameSync(filePath, archivePath);
      archived.push(archivePath);
    } catch (error) {
      console.warn(`[OpenClaw] Failed to archive legacy cron file: ${filePath}`, error);
    }
  }
  return archived;
}

function tailLog(text: string): string {
  if (text.length <= LOG_TAIL_LIMIT) {
    return text;
  }
  return text.slice(text.length - LOG_TAIL_LIMIT);
}

function resolveDoctorConfigPath(stateDir: string): string {
  return path.join(stateDir, '.lobsterai-cron-doctor-openclaw.json');
}

function writeDoctorCronConfig(stateDir: string): string {
  const configPath = resolveDoctorConfigPath(stateDir);
  const storePath = resolveLegacyCronStorePath(stateDir);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { mode: 'local' },
      cron: {
        enabled: true,
        store: storePath,
      },
    }, null, 2) + '\n',
    'utf8',
  );
  return configPath;
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<LegacyCronMigrationRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`OpenClaw legacy cron migration timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function migrateLegacyCronStorageWithDoctor(params: {
  stateDir: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: LegacyCronMigrationRunner;
}): Promise<LegacyCronMigrationResult> {
  if (!hasLegacyCronStorage(params.stateDir)) {
    return { status: 'skipped', reason: 'no-legacy-cron-files' };
  }

  const openclawCliPath = path.join(params.runtimeRoot, 'openclaw.mjs');
  if (!fs.existsSync(openclawCliPath)) {
    console.warn(`[OpenClaw] Legacy cron storage detected but OpenClaw CLI is missing: ${openclawCliPath}`);
    return { status: 'skipped', reason: 'missing-openclaw-cli' };
  }

  const runner = params.runner ?? runProcess;
  const doctorConfigPath = writeDoctorCronConfig(params.stateDir);
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    OPENCLAW_HOME: path.dirname(params.stateDir),
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: doctorConfigPath,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const args = [openclawCliPath, 'doctor', '--non-interactive', '--fix'];

  console.log(`[OpenClaw] Legacy cron storage detected; running official doctor migration: ${JSON.stringify(args.slice(1))}`);
  try {
    const result = await runner(params.electronNodeRuntimePath, args, {
      cwd: params.runtimeRoot,
      env,
      timeoutMs: LEGACY_CRON_DOCTOR_TIMEOUT_MS,
    });

    if (result.code === 0) {
      const archived = archiveLegacyCronStorage(params.stateDir);
      if (archived.length > 0) {
        console.log(
          '[OpenClaw] Legacy cron doctor migration completed; archived: '
          + archived.map((filePath) => path.basename(filePath)).join(', '),
        );
      } else {
        console.log('[OpenClaw] Legacy cron doctor migration completed.');
      }
      return { status: 'migrated', code: result.code };
    }

    console.warn(
      [
        `[OpenClaw] Legacy cron doctor migration failed with exit code ${result.code}.`,
        result.stderr ? `stderr tail:\n${tailLog(result.stderr)}` : '',
        result.stdout ? `stdout tail:\n${tailLog(result.stdout)}` : '',
      ].filter(Boolean).join('\n'),
    );
    return { status: 'failed', code: result.code };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenClaw] Legacy cron doctor migration failed before gateway startup:', error);
    return { status: 'failed', code: null, error: message };
  }
}
