import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { stripVTControlCharacters } from 'util';

import { inspectOpenClawPath, logOpenClawConfigLockDiagnostics } from './openclawConfigDiagnostics';

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

function summarizeDoctorFailure(stderr: string, stdout: string): string | undefined {
  const cleanLines = (text: string) => stripVTControlCharacters(text).split(/\r?\n/)
    .map(line => line.trim().replace(/^[│┃|]\s*/, '').replace(/\s*[│┃|]$/, '').trim());
  const stderrLines = cleanLines(stderr);
  const lines = [...stderrLines, ...cleanLines(stdout)];
  // Doctor writes boxed, wrapped validation errors to stdout. Prefer those
  // and actual exceptions over stderr warnings such as snapshot rotation.
  const exception = lines.find(line => /^(?:\w*Error\b|Cannot\b|Failed\b|Fatal\b|ERR_|file lock timeout|Config validation failed)/i.test(line));
  if (exception) return exception;
  try {
    const report = JSON.parse(stdout) as { targets?: Array<{ agentId?: string; issues?: Array<{ message?: string }> }> };
    const target = report.targets?.find(target => target.issues?.some(issue => typeof issue.message === 'string'));
    const issue = target?.issues?.find(issue => typeof issue.message === 'string');
    if (issue?.message) return `${target?.agentId ?? 'session'}: ${issue.message}`.slice(0, 1_000);
  } catch {
    // Generic doctor failures can still use boxed text instead of JSON.
  }
  const issueIndex = lines.findIndex(line => /^-?\s*[\w.[\]-]+:\s*invalid config\b/i.test(line));
  if (issueIndex >= 0) {
    const issue = [lines[issueIndex].replace(/^-\s*/, '')];
    for (const line of lines.slice(issueIndex + 1)) {
      if (!line || /^[-├╰╭╮╯└◇]|^No config changes|^Doctor\b/.test(line)) break;
      issue.push(line);
    }
    return issue.join(' ').slice(0, 1_000);
  }
  return lines.find(line => /^Doctor could not apply config fixes|^Doctor finished, but config fixes were not applied/i.test(line))
    ?? stderrLines.find(line => line && !/^(?:\[config\] warnings:|Config clobber snapshot cap reached|at\s)/.test(line));
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
    console.log(`[OpenClaw] Legacy session doctor process started: pid=${child.pid ?? 'unknown'} parentPid=${process.pid}`);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      console.error(`[OpenClaw] Legacy session doctor timed out: pid=${child.pid ?? 'unknown'} timeoutMs=${options.timeoutMs}`
        + `\nstderr tail:\n${tailLog(stderr)}\nstdout tail:\n${tailLog(stdout)}`);
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
    // Electron owns the gateway lifecycle; doctor must not install/start a
    // separate system service while migrating the app's data.
    OPENCLAW_SERVICE_REPAIR_POLICY: 'external',
    ELECTRON_RUN_AS_NODE: '1',
  };
  // Session import validates and archives legacy data itself. Generic
  // `doctor --fix` also rewrites IM config; in v2026.8.1 its generic QQ
  // repairs conflict with the official QQ 2.0 schema and abort migration.
  const args = [openclawCliPath, 'doctor', '--session-sqlite', 'import', '--session-sqlite-all-agents', '--json'];
  const runner = params.runner ?? runLegacySessionMigrationProcess;

  console.log(
    `[OpenClaw] Legacy session storage detected; running official doctor migration for ${legacyPaths.length} store(s).`,
  );
  const startedAt = Date.now();
  const storesBefore = legacyPaths.map(inspectOpenClawPath);
  console.log(`[OpenClaw] Legacy session migration input: ${JSON.stringify({
    appPid: process.pid, configPath: params.configPath, stores: storesBefore,
  })}`);
  logOpenClawConfigLockDiagnostics(params.configPath, 'legacy-session-migration:before', true);
  const logFailureDiagnostics = (): void => {
    logOpenClawConfigLockDiagnostics(params.configPath, 'legacy-session-migration:failed');
    console.error(`[OpenClaw] Legacy session migration stores: ${JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      before: storesBefore,
      after: legacyPaths.map(inspectOpenClawPath),
    })}`);
  };

  try {
    const result = await runner(params.electronNodeRuntimePath, args, {
      cwd: params.runtimeRoot,
      env,
      timeoutMs: LEGACY_SESSION_DOCTOR_TIMEOUT_MS,
    });
    console.log(`[OpenClaw] Legacy session doctor exited: code=${result.code} elapsedMs=${Date.now() - startedAt}`);

    if (result.code !== 0) {
      const failure = `OpenClaw legacy session migration failed with exit code ${result.code}.`;
      const details = [
        failure,
        result.stderr ? `stderr tail:\n${tailLog(result.stderr)}` : '',
        result.stdout ? `stdout tail:\n${tailLog(result.stdout)}` : '',
      ].filter(Boolean).join('\n');
      console.error(`[OpenClaw] ${details}`);
      logFailureDiagnostics();
      const cause = summarizeDoctorFailure(result.stderr, result.stdout);
      return { status: 'failed', code: result.code, error: cause ? `${cause}\n${failure}` : failure };
    }

    const remainingPaths = legacyPaths.filter(fileExists);
    if (remainingPaths.length > 0) {
      const error = `OpenClaw doctor completed but ${remainingPaths.length} legacy session store(s) remain.`;
      console.warn(`[OpenClaw] ${error}`);
      logFailureDiagnostics();
      console.error(`[OpenClaw] Legacy session doctor output with remaining stores:`
        + `\nstderr tail:\n${tailLog(result.stderr)}\nstdout tail:\n${tailLog(result.stdout)}`);
      return { status: 'failed', code: result.code, error };
    }

    console.log(
      `[OpenClaw] Legacy session doctor migration completed for ${legacyPaths.length} store(s).`,
    );
    return { status: 'migrated', code: result.code, migratedPaths: legacyPaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logFailureDiagnostics();
    console.error('[OpenClaw] Legacy session doctor migration failed before gateway startup:', error);
    return { status: 'failed', code: null, error: message };
  }
}
