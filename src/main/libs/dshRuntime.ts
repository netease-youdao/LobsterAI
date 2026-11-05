// Pure helpers for locating, validating, and spawning the bundled DeepSeek
// Harness (dsh) runtime. No Electron imports here so the logic stays unit
// testable; dshEngineManager.ts owns process/Electron concerns.

import { DshEngineErrorCode, type DshInstallProgressState } from '../../shared/dshEngine/constants';

export const DSH_RUNTIME_ENTRY_RELPATH = 'lib/bin.js';

// The Cordis loader needs Node internals for its HMR/entry machinery. Its
// preferred supply (the node-addon-require-builtin native addon) loads but
// fails under Electron's Node build ("no compatible
// GetAlignedPointerFromEmbedderData symbol"), so every dsh child we spawn must
// carry this flag. dshProcessLauncher inserts it before the entry script while
// running Electron in Node mode on every platform.
export const DSH_NODE_EXEC_ARGV = ['--expose-internals'];

// The runtime build unpacks the pinned pnpm npm package here, outside dsh's own
// node_modules so it never joins dsh's dependency graph. Runtimes built before
// pnpm was bundled lack it; plugin installs then fall back to pnpm on PATH.
export const DSH_PNPM_PACKAGE_RELPATH = 'package-manager/pnpm';

// Written under userData on every start. `dsh web` run directly calls
// runCli() without a package manager, so this wrapper is how the bundled pnpm
// reaches dsh's plugin manager.
export const DSH_LAUNCHER_DIR_NAME = 'dsh-launcher';
export const DSH_LAUNCHER_FILENAME = 'launch.mjs';

const DSH_PLUGIN_LOAD_FAILURE_PATTERN =
  /(?:Cannot find package|ERR_MODULE_NOT_FOUND)[\s\S]{0,500}cordis-plugin-loader/i;

export interface DshRuntimeBuildInfo {
  target: string;
  dshVersion: string;
  patchHash: string;
  builtAt?: string;
  /** Version of the bundled pnpm; absent on runtimes built without one. */
  pnpmVersion?: string;
}

export interface DshRuntimeLayoutCheck {
  ok: boolean;
  missing: string[];
}

const REQUIRED_RUNTIME_PATHS = [
  DSH_RUNTIME_ENTRY_RELPATH,
  'node_modules',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
];

export function parseDshRuntimeBuildInfo(raw: string): DshRuntimeBuildInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.target !== 'string' || typeof record.dshVersion !== 'string' || typeof record.patchHash !== 'string') {
      return null;
    }
    return {
      target: record.target,
      dshVersion: record.dshVersion,
      patchHash: record.patchHash,
      builtAt: typeof record.builtAt === 'string' ? record.builtAt : undefined,
      ...(typeof record.pnpmVersion === 'string' ? { pnpmVersion: record.pnpmVersion } : {}),
    };
  } catch {
    return null;
  }
}

export function classifyDshStartupError(output: string, fallback: DshEngineErrorCode): DshEngineErrorCode {
  return DSH_PLUGIN_LOAD_FAILURE_PATTERN.test(output) ? DshEngineErrorCode.PluginLoadFailed : fallback;
}

export interface DshRuntimeCandidateContext {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  cwd: string;
  joinPath: (...segments: string[]) => string;
}

// Mirrors the OpenClaw runtime resolution order: packaged apps read the
// extraResources copy; dev builds read vendor/dsh-runtime/current.
export function resolveDshRuntimeCandidates(context: DshRuntimeCandidateContext): string[] {
  const { isPackaged, resourcesPath, appPath, cwd, joinPath } = context;
  if (isPackaged) {
    return [joinPath(resourcesPath, 'dsh')];
  }
  const candidates = [joinPath(appPath, 'vendor', 'dsh-runtime', 'current')];
  const fromCwd = joinPath(cwd, 'vendor', 'dsh-runtime', 'current');
  if (!candidates.includes(fromCwd)) candidates.push(fromCwd);
  return candidates;
}

export function validateDshRuntimeLayout(
  runtimeRoot: string,
  exists: (absolutePath: string) => boolean,
  joinPath: (...segments: string[]) => string
): DshRuntimeLayoutCheck {
  const missing = REQUIRED_RUNTIME_PATHS.filter((relPath) => !exists(joinPath(runtimeRoot, ...relPath.split('/'))));
  return { ok: missing.length === 0, missing };
}

export function dshInstallPercent(progress: DshInstallProgressState | null): number {
  if (!progress || progress.totalBytes <= 0) return 0;
  return Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100));
}

// A 36MB download reports progress per chunk — thousands of events. Publishing
// each one would push that many state updates through the IPC-facing listeners
// and repeat the same line in the log (the old 25% log printed 15 times), so a
// report only counts as news when the stage or the whole percent changed.
export function shouldPublishInstallProgress(
  previous: DshInstallProgressState | null,
  next: DshInstallProgressState
): boolean {
  if (!previous) return true;
  if (previous.stage !== next.stage) return true;
  return dshInstallPercent(previous) !== dshInstallPercent(next);
}

export interface DshSpawnEnvOptions {
  baseEnv: Record<string, string | undefined>;
  dshHome: string;
  telemetryDisabled?: boolean;
  timeZone?: string;
}

// Environment shared with the dsh child process. The process launcher adds
// ELECTRON_RUN_AS_NODE because that flag is part of how Electron itself is
// invoked, not dsh's application environment.
export function buildDshSpawnEnv(options: DshSpawnEnvOptions): Record<string, string> {
  const { baseEnv, dshHome, telemetryDisabled = true, timeZone } = options;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.DSH_HOME = dshHome;
  if (telemetryDisabled) env.DSH_TELEMETRY_DISABLED = '1';
  if (timeZone && !env.TZ) env.TZ = timeZone;
  return env;
}

// `--no-open`: since 0.1.5, `dsh web` hands its URL to the default browser
// unless told not to, and the workbench window is the only UI we want.
export function buildDshWebArgs(entryPath: string, port: number): string[] {
  return [entryPath, 'web', '--port', String(port), '--no-open'];
}

// Reads the pnpm entry script from the bundled package's own manifest, so a
// pnpm release that renames its bin (pnpm.cjs became pnpm.mjs) needs no code
// change. Returns the path relative to the package root, or null.
export function parseDshPnpmBinRelPath(packageJsonRaw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(packageJsonRaw);
    if (!parsed || typeof parsed !== 'object') return null;
    const bin = (parsed as Record<string, unknown>).bin;
    const relPath =
      typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? (bin as Record<string, unknown>).pnpm : undefined;
    if (typeof relPath !== 'string') return null;
    const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** The installation-owned package runtime dsh's plugin manager runs pnpm with. */
export interface DshPackageManager {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface DshPackageManagerOptions {
  /** Electron binary that runs pnpm in Node mode. */
  electronPath: string;
  /** Absolute path of the bundled pnpm entry script. */
  pnpmEntry: string;
  /** Directory holding LobsterAI's node/npm/npx shims, prepended to PATH. */
  nodeShimDir: string | null;
  /** Bundled npm bin directory the Windows npm/npx shims resolve through. */
  npmBinDir: string | null;
  /** Bundled Git cmd directory for Git-sourced plugins; null outside Windows. */
  gitBinDir: string | null;
  /** Environment the PATH extends; only its PATH entry is read. */
  baseEnv: Record<string, string | undefined>;
  delimiter: string;
}

// Git for Windows' cmd/git.exe locates its own helpers and DLLs. Exposing only
// cmd avoids putting Git's Unix tools (notably tar) ahead of Windows tools.
export function resolveDshBundledGitBinDir(
  resourcesDir: string,
  platform: NodeJS.Platform,
  exists: (absolutePath: string) => boolean,
  joinPath: (...segments: string[]) => string
): string | null {
  if (platform !== 'win32') return null;
  const gitBinDir = joinPath(resourcesDir, 'mingit', 'cmd');
  return exists(joinPath(gitBinDir, 'git.exe')) ? gitBinDir : null;
}

// pnpm runs as Electron in Node mode. Dependency build scripts call `node`,
// which a GUI-launched app does not have on PATH, so LobsterAI's node shim goes
// first, followed by bundled Git for github: and other Git-sourced plugins.
// dsh applies this environment only to its package-manager children and
// merges it after its own scrubbed environment, so PATH keeps the casing the
// base environment uses: on Windows that is usually `Path`, and a second
// `PATH` key would leave which one wins to the child's key ordering.
export function buildDshPackageManager(options: DshPackageManagerOptions): DshPackageManager {
  const { electronPath, pnpmEntry, nodeShimDir, npmBinDir, gitBinDir, baseEnv, delimiter } = options;
  const pathKey = Object.keys(baseEnv).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const basePath = baseEnv[pathKey] ?? '';
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    LOBSTERAI_ELECTRON_PATH: electronPath,
    [pathKey]: [nodeShimDir, gitBinDir, basePath].filter((entry): entry is string => !!entry).join(delimiter),
  };
  if (npmBinDir) env.LOBSTERAI_NPM_BIN_DIR = npmBinDir;
  return { command: electronPath, args: [pnpmEntry], env };
}

// The launcher statically imports the runtime entry so the module graph under
// the process entry still contains dsh itself: dsh's HMR treats that graph as
// host code that is never reloaded. A dynamic import() would leave dsh's own
// modules outside it. Importing the entry does not run it (it only starts
// itself as the main module); runCli then parses process.argv the same way.
export function buildDshLauncherSource(entryFileUrl: string, packageManager: DshPackageManager): string {
  return [
    '// Generated by LobsterAI on every DeepSeek Harness start; edits are overwritten.',
    '// Starts the dsh CLI with the package manager bundled in its runtime.',
    `import { runCli } from ${JSON.stringify(entryFileUrl)};`,
    '',
    `await runCli({ packageManager: ${JSON.stringify(packageManager, null, 2)} });`,
    '',
  ].join('\n');
}

// The child's cwd becomes the workbench's default session directory and the
// root for project-level skills, so it must be a real directory the user
// actually works in — never the runtime install directory, which would put new
// sessions outside every workspace and aim a workspace-write agent at our own
// vendored runtime. Candidates are tried in order; `fallback` is last resort.
export function resolveDshWorkingDirectory(
  candidates: ReadonlyArray<string | undefined | null>,
  isDirectory: (candidate: string) => boolean,
  fallback: string
): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (isDirectory(trimmed)) return trimmed;
  }
  return fallback;
}
