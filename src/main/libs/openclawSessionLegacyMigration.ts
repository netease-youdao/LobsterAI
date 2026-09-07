import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const LEGACY_SESSION_DOCTOR_TIMEOUT_MS = 300_000;
const LOG_TAIL_LIMIT = 4_000;

export type LegacySessionMigrationRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

export type LegacySessionMigrationRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<LegacySessionMigrationRunResult>;

export type LegacySessionMigrationResult =
  | { status: 'skipped'; reason: 'no-legacy-session-files' | 'missing-openclaw-cli' }
  | { status: 'migrated'; code: number | null; migratedPaths: string[] }
  | { status: 'failed'; code: number | null; error: string };

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function listLegacySessionStorePaths(stateDir: string): string[] {
  const candidates = [path.join(stateDir, 'sessions', 'sessions.json')];
  const agentsDir = path.join(stateDir, 'agents');

  try {
    const agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of agentEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      candidates.push(path.join(agentsDir, entry.name, 'sessions', 'sessions.json'));
    }
  } catch {
    // A missing or unreadable agents directory has no discoverable default stores.
  }

  return candidates.filter(fileExists);
}

function tailLog(text: string): string {
  return text.length <= LOG_TAIL_LIMIT ? text : text.slice(-LOG_TAIL_LIMIT);
}

export function runLegacySessionMigrationProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<LegacySessionMigrationRunResult> {
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
      reject(new Error(`OpenClaw legacy session migration timed out after ${options.timeoutMs}ms`));
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

export async function migrateLegacySessionStorageWithDoctor(params: {
  stateDir: string;
  configPath: string;
  runtimeRoot: string;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  runner?: LegacySessionMigrationRunner;
}): Promise<LegacySessionMigrationResult> {
  const legacyPaths = listLegacySessionStorePaths(params.stateDir);
  if (legacyPaths.length === 0) {
    return { status: 'skipped', reason: 'no-legacy-session-files' };
  }

  const openclawCliPath = path.join(params.runtimeRoot, 'openclaw.mjs');
  if (!fileExists(openclawCliPath)) {
    const error = `OpenClaw CLI is missing while legacy session storage still needs migration: ${openclawCliPath}`;
    console.warn(`[OpenClaw] ${error}`);
    return { status: 'skipped', reason: 'missing-openclaw-cli' };
  }

  const env: NodeJS.ProcessEnv = {
    ...params.env,
    OPENCLAW_HOME: path.dirname(params.stateDir),
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const args = [openclawCliPath, 'doctor', '--non-interactive', '--fix'];
  const runner = params.runner ?? runLegacySessionMigrationProcess;

  console.log(
    `[OpenClaw] Legacy session storage detected; running official doctor migration for ${legacyPaths.length} store(s).`,
  );

  try {
    const result = await runner(params.electronNodeRuntimePath, args, {
      cwd: params.runtimeRoot,
      env,
      timeoutMs: LEGACY_SESSION_DOCTOR_TIMEOUT_MS,
    });

    if (result.code !== 0) {
      const details = [
        `OpenClaw legacy session migration failed with exit code ${result.code}.`,
        result.stderr ? `stderr tail:\n${tailLog(result.stderr)}` : '',
        result.stdout ? `stdout tail:\n${tailLog(result.stdout)}` : '',
      ].filter(Boolean).join('\n');
      console.warn(`[OpenClaw] ${details}`);
      return { status: 'failed', code: result.code, error: details };
    }

    const remainingPaths = legacyPaths.filter(fileExists);
    if (remainingPaths.length > 0) {
      const error = `OpenClaw doctor completed but ${remainingPaths.length} legacy session store(s) remain.`;
      console.warn(`[OpenClaw] ${error}`);
      return { status: 'failed', code: result.code, error };
    }

    console.log(
      `[OpenClaw] Legacy session doctor migration completed for ${legacyPaths.length} store(s).`,
    );
    return { status: 'migrated', code: result.code, migratedPaths: legacyPaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[OpenClaw] Legacy session doctor migration failed before gateway startup:', error);
    return { status: 'failed', code: null, error: message };
  }
}
