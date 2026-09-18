import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { safelyReplaceTextFileSync } from './safeFileReplace';

export const LEGACY_PLUGIN_INSTALL_CONFIG_PATH = 'plugins.installs';
const LEGACY_PLUGIN_INSTALL_MIGRATION_TIMEOUT_MS = 2 * 60_000;
const PROCESS_KILL_GRACE_MS = 2_000;
const PROCESS_OUTPUT_TAIL_LIMIT = 4_000;

export const OpenClawPluginInstallMigrationStatus = {
  NotNeeded: 'not_needed',
  Migrated: 'migrated',
  Failed: 'failed',
} as const;

export type OpenClawPluginInstallMigrationStatus =
  typeof OpenClawPluginInstallMigrationStatus[keyof typeof OpenClawPluginInstallMigrationStatus];

export type OpenClawPluginInstallMigrationResult =
  | { status: typeof OpenClawPluginInstallMigrationStatus.NotNeeded }
  | { status: typeof OpenClawPluginInstallMigrationStatus.Migrated }
  | { status: typeof OpenClawPluginInstallMigrationStatus.Failed; error: string };

type MigrationProcessResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type MigrationProcessRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<MigrationProcessResult>;

const appendOutputTail = (current: string, chunk: unknown): string => {
  const next = current + String(chunk);
  return next.length <= PROCESS_OUTPUT_TAIL_LIMIT
    ? next
    : next.slice(next.length - PROCESS_OUTPUT_TAIL_LIMIT);
};

export function runOpenClawPluginInstallMigrationProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    killGraceMs?: number;
    spawnProcess?: typeof spawn;
  },
): Promise<MigrationProcessResult> {
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError: Error | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let killGraceTimeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killGraceTimeout) clearTimeout(killGraceTimeout);
      callback();
    };
    timeout = setTimeout(() => {
      const error = new Error(
        `OpenClaw plugin install migration timed out after ${options.timeoutMs}ms`,
      );
      timeoutError = error;
      if (!child.kill()) {
        finish(() => reject(error));
        return;
      }
      killGraceTimeout = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may have exited without delivering close yet.
        }
        finish(() => reject(error));
      }, options.killGraceMs ?? PROCESS_KILL_GRACE_MS);
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout = appendOutputTail(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendOutputTail(stderr, chunk);
    });
    child.on('close', (code) => {
      finish(() => {
        if (timeoutError) {
          reject(timeoutError);
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const inspectLegacyPluginInstallConfig = (
  raw: string,
): { valid: boolean; hasLegacyInstalls: boolean } => {
  try {
    const config = JSON.parse(raw) as unknown;
    if (!isRecord(config)) return { valid: false, hasLegacyInstalls: false };
    if (!isRecord(config.plugins)) return { valid: true, hasLegacyInstalls: false };
    return {
      valid: true,
      hasLegacyInstalls: Object.hasOwn(config.plugins, 'installs'),
    };
  } catch {
    return { valid: false, hasLegacyInstalls: false };
  }
};

export const hasLegacyPluginInstallConfig = (raw: string): boolean => (
  inspectLegacyPluginInstallConfig(raw).hasLegacyInstalls
);

const resolveOpenClawCliPath = (runtimeRoot: string): string | null => {
  const candidates = [
    path.join(runtimeRoot, 'openclaw.mjs'),
    path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
};

const restoreOriginalConfig = (
  configPath: string,
  originalRaw: string,
  originalMode: number,
): void => {
  let currentRaw: string | null = null;
  try {
    currentRaw = fs.readFileSync(configPath, 'utf8');
  } catch {
    // Missing or unreadable output still needs restoration below.
  }
  if (currentRaw === originalRaw) return;

  safelyReplaceTextFileSync({
    filePath: configPath,
    content: originalRaw,
    mode: originalMode,
    tempLabel: 'legacy-plugin-installs-restore',
  });
};

const describeProcessFailure = (result: MigrationProcessResult): string => {
  const output = result.stderr.trim() || result.stdout.trim();
  const suffix = output ? `: ${output}` : '';
  return `OpenClaw config migration exited with code ${String(result.code)}${suffix}`;
};

/**
 * Move the deprecated openclaw.json `plugins.installs` records through
 * OpenClaw's public config write path before LobsterAI overwrites the file.
 * OpenClaw persists those records in its installed-plugin SQLite index before
 * removing the legacy key. On any failure, the exact original config is put
 * back and LobsterAI's config sync must stop.
 */
export async function migrateLegacyOpenClawPluginInstalls(params: {
  configPath: string;
  stateDir: string;
  runtimeRoot: string | null;
  electronNodeRuntimePath: string;
  env: NodeJS.ProcessEnv;
  secretEnvVars?: Record<string, string>;
  runner?: MigrationProcessRunner;
}): Promise<OpenClawPluginInstallMigrationResult> {
  let originalRaw: string;
  let originalMode = 0o600;
  try {
    originalRaw = fs.readFileSync(params.configPath, 'utf8');
    originalMode = fs.statSync(params.configPath).mode & 0o777;
  } catch {
    return { status: OpenClawPluginInstallMigrationStatus.NotNeeded };
  }

  if (!hasLegacyPluginInstallConfig(originalRaw)) {
    return { status: OpenClawPluginInstallMigrationStatus.NotNeeded };
  }

  const restoreAndFail = (message: string): OpenClawPluginInstallMigrationResult => {
    try {
      restoreOriginalConfig(params.configPath, originalRaw, originalMode);
      return { status: OpenClawPluginInstallMigrationStatus.Failed, error: message };
    } catch (restoreError) {
      const detail = restoreError instanceof Error ? restoreError.message : String(restoreError);
      return {
        status: OpenClawPluginInstallMigrationStatus.Failed,
        error: `${message}; failed to restore original config: ${detail}`,
      };
    }
  };

  if (!params.runtimeRoot) {
    return restoreAndFail('OpenClaw runtime is unavailable for legacy plugin install migration');
  }
  const cliPath = resolveOpenClawCliPath(params.runtimeRoot);
  if (!cliPath) {
    return restoreAndFail(`OpenClaw CLI is unavailable in runtime: ${params.runtimeRoot}`);
  }

  const runner = params.runner ?? runOpenClawPluginInstallMigrationProcess;
  const env: NodeJS.ProcessEnv = {
    ...params.env,
    ...params.secretEnvVars,
    OPENCLAW_HOME: path.dirname(params.stateDir),
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    ELECTRON_RUN_AS_NODE: '1',
  };
  const args = [cliPath, 'config', 'unset', LEGACY_PLUGIN_INSTALL_CONFIG_PATH];

  console.log('[OpenClaw] Legacy plugins.installs detected; running official config migration.');
  try {
    const result = await runner(params.electronNodeRuntimePath, args, {
      cwd: params.runtimeRoot,
      env,
      timeoutMs: LEGACY_PLUGIN_INSTALL_MIGRATION_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      return restoreAndFail(describeProcessFailure(result));
    }

    let migratedRaw: string;
    try {
      migratedRaw = fs.readFileSync(params.configPath, 'utf8');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return restoreAndFail(`OpenClaw config migration output is unreadable: ${detail}`);
    }
    const migratedInspection = inspectLegacyPluginInstallConfig(migratedRaw);
    if (!migratedInspection.valid) {
      return restoreAndFail('OpenClaw config migration produced invalid JSON');
    }
    if (migratedInspection.hasLegacyInstalls) {
      return restoreAndFail('OpenClaw config migration completed without removing plugins.installs');
    }

    console.log('[OpenClaw] Legacy plugins.installs migrated into the plugin index.');
    return { status: OpenClawPluginInstallMigrationStatus.Migrated };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return restoreAndFail(`OpenClaw config migration failed: ${detail}`);
  }
}
