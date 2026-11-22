// Pure helpers for preparing LobsterAI's App-Owned DSH Profile and built-in
// `dsh` CLI shim. Keeps user-installed DSH bundles and `cordis.patch.yml`
// intact across LobsterAI upgrades (no Electron imports; fully unit-testable).

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_PROFILE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildDshLauncherSource,
  buildDshPackageManager,
  DSH_LAUNCHER_DIR_NAME,
  DSH_LAUNCHER_FILENAME,
  DSH_NODE_EXEC_ARGV,
  DSH_PNPM_PACKAGE_RELPATH,
  DSH_RUNTIME_ENTRY_RELPATH,
  parseDshPnpmBinRelPath,
} from '../dshRuntime';

/** Tools the host supplies for bundled pnpm lifecycle scripts and Git-sourced plugins. */
export interface DshNodeToolchain {
  electronPath?: string;
  /** Directory with node/npm/npx shims, or null when unavailable. */
  nodeShimDir?: string | null;
  /** Bundled npm bin directory the Windows npm/npx shims resolve through. */
  npmBinDir?: string | null;
  /** Bundled Git cmd directory for Git-sourced plugins on Windows. */
  gitBinDir?: string | null;
}

export interface PrepareDshLaunchEntryOptions {
  runtimeDir: string;
  dshHomeDir: string;
  electronPath: string;
  toolchain?: DshNodeToolchain | null;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface PreparedDshLaunchEntry {
  entryPath: string;
  usesBundledPnpm: boolean;
  pnpmEntry: string | null;
}

const ISOLATED_DSH_STRIPPED_ENV_PATTERNS: readonly RegExp[] = [
  /^dsh_/i,
  /^deepseek_(?:api_key|base_url|search_base_url)$/i,
  /^pnpm_home$/i,
  /^(?:npm|pnpm)_config_(?:store_dir|cache|cache_dir|userconfig|globalconfig)$/i,
];

/**
 * Returns true if an inherited environment variable could leak state, credentials,
 * or package-manager configuration from a co-installed official `dsh` or global pnpm.
 */
export function shouldStripDshInheritedEnvKey(key: string): boolean {
  return ISOLATED_DSH_STRIPPED_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Build the base isolated environment shared by LobsterAI's embedded DSH host
 * process and `dsh plugin` child commands.
 */
export function buildIsolatedDshBaseEnv(params: {
  baseEnv?: NodeJS.ProcessEnv;
  dshHomeDir: string;
  skipElectronRunAsNode?: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(params.baseEnv ?? process.env)) {
    if (shouldStripDshInheritedEnvKey(key)) continue;
    env[key] = value;
  }

  const pnpmStoreDir = path.join(params.dshHomeDir, 'cache', 'pnpm-store');
  const pnpmCacheDir = path.join(params.dshHomeDir, 'cache', 'pnpm-cache');
  const npmCacheDir = path.join(params.dshHomeDir, 'cache', 'npm-cache');

  env.DSH_HOME = params.dshHomeDir;
  env.DSH_AGENTS_HOME = path.join(params.dshHomeDir, 'agents-home');
  env.DSH_TELEMETRY_DISABLED = '1';
  env.pnpm_config_store_dir = pnpmStoreDir;
  env.pnpm_config_cache_dir = pnpmCacheDir;
  env.npm_config_store_dir = pnpmStoreDir;
  env.npm_config_cache = npmCacheDir;

  if (!params.skipElectronRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return env;
}

/**
 * Locate the bundled pnpm entry script inside `<runtimeDir>/package-manager/pnpm`.
 * Returns null if the runtime was built without a bundled pnpm package.
 */
export function resolveBundledPnpmEntry(runtimeDir: string): string | null {
  const packageRoot = path.join(runtimeDir, ...DSH_PNPM_PACKAGE_RELPATH.split('/'));
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  const binRelPath = parseDshPnpmBinRelPath(raw);
  if (!binRelPath) {
    console.warn(`[DSH] Bundled pnpm at ${packageRoot} declares no usable bin entry`);
    return null;
  }
  const entry = path.join(packageRoot, ...binRelPath.split('/'));
  return fs.existsSync(entry) ? entry : null;
}

/**
 * Generate `<dshHomeDir>/dsh-launcher/launch.mjs` that imports `runCli` from
 * `<runtimeDir>/lib/bin.js` and wires the runtime's bundled pnpm via
 * `runCli({ packageManager })`. Falls back to the direct `lib/bin.js` entry
 * only when the runtime does not bundle pnpm or writing the launcher fails.
 */
export function prepareDshLaunchEntry(options: PrepareDshLaunchEntryOptions): PreparedDshLaunchEntry {
  const runtimeEntryPath = path.join(options.runtimeDir, ...DSH_RUNTIME_ENTRY_RELPATH.split('/'));
  const pnpmEntry = resolveBundledPnpmEntry(options.runtimeDir);
  if (!pnpmEntry) {
    return {
      entryPath: runtimeEntryPath,
      usesBundledPnpm: false,
      pnpmEntry: null,
    };
  }

  const canonicalEntryPath =
    process.platform === 'win32'
      ? safeRealpathNative(runtimeEntryPath)
      : path.resolve(runtimeEntryPath);
  const canonicalPnpmEntry =
    process.platform === 'win32'
      ? safeRealpathNative(pnpmEntry)
      : path.resolve(pnpmEntry);

  const packageManager = buildDshPackageManager({
    electronPath: options.toolchain?.electronPath ?? options.electronPath,
    pnpmEntry: canonicalPnpmEntry,
    nodeShimDir: options.toolchain?.nodeShimDir ?? null,
    npmBinDir: options.toolchain?.npmBinDir ?? null,
    gitBinDir: options.toolchain?.gitBinDir ?? null,
    baseEnv: options.baseEnv ?? process.env,
    delimiter: path.delimiter,
  });

  const launcherDir = path.join(options.dshHomeDir, DSH_LAUNCHER_DIR_NAME);
  const launcherPath = path.join(launcherDir, DSH_LAUNCHER_FILENAME);
  try {
    fs.mkdirSync(launcherDir, { recursive: true, mode: 0o700 });
    writeIfChanged(
      launcherPath,
      buildDshLauncherSource(pathToFileURL(canonicalEntryPath).href, packageManager),
    );
    return {
      entryPath: launcherPath,
      usesBundledPnpm: true,
      pnpmEntry: canonicalPnpmEntry,
    };
  } catch (error) {
    console.error('[DSH] Could not write bundled-pnpm launcher; falling back to direct runtime entry', error);
    return {
      entryPath: runtimeEntryPath,
      usesBundledPnpm: false,
      pnpmEntry: null,
    };
  }
}

export function resolveLobsterDshProfileDir(dshHomeDir: string): string {
  return path.join(dshHomeDir, 'profiles', DSH_PROFILE_NAME);
}

export interface DshProfileManifest {
  name: string;
  private: boolean;
  type?: string;
  dependencies?: Record<string, string>;
  dsh?: {
    profile?: {
      bundles?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface EnsureAppOwnedProfileOptions {
  /** Directory of LobsterAI's App-Owned Profile (e.g. `<userData>/dsh-profile`). */
  profileDir: string;
  /** Absolute path to the bundled `@lobsterai/dsh-bundle` directory. */
  hostBundleDir: string;
  /** Optional absolute path to `@lobsterai/dsh-channels` when enabled. */
  channelsBundleDir?: string | null;
}

export interface EnsureAppOwnedProfileResult {
  manifestPath: string;
  patchPath: string;
  bundles: string[];
  preservedUserBundles: string[];
}

export interface WriteDshCliShimOptions {
  binDir: string;
  electronPath: string;
  /** Prepared launcher or runtime entry path. Optional when `runtimeDir` is provided. */
  runtimeEntryPath?: string;
  /** When provided, generates `<dshHomeDir>/dsh-launcher/launch.mjs` for bundled pnpm. */
  runtimeDir?: string;
  toolchain?: DshNodeToolchain | null;
  baseEnv?: NodeJS.ProcessEnv;
  profileDir: string;
  dshHomeDir: string;
  platform?: NodeJS.Platform;
}

const CORE_MANAGED_BUNDLES = [
  DSH_BASE_BUNDLE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
] as const;

const ALL_MANAGED_BUNDLE_NAMES = new Set<string>([
  ...CORE_MANAGED_BUNDLES,
  DSH_CHANNELS_BUNDLE_NAME,
]);

/**
 * Pure merge of LobsterAI's required bundle stack with any existing profile
 * manifest. Always keeps core bundles first in deterministic order while
 * preserving every user-installed third-party or official optional bundle and
 * its dependency specifier across app upgrades.
 */
export function mergeAppOwnedProfileManifest(
  existing: Record<string, unknown> | null,
  options: {
    hostBundleDir: string;
    channelsBundleDir?: string | null;
  }
): {
  manifest: DshProfileManifest;
  bundles: string[];
  preservedUserBundles: string[];
} {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const existingDsh = isRecord(base.dsh) ? base.dsh : {};
  const existingProfile = isRecord(existingDsh.profile) ? existingDsh.profile : {};
  const existingBundles = Array.isArray(existingProfile.bundles)
    ? existingProfile.bundles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  const preservedUserBundles: string[] = [];
  const seen = new Set<string>();
  for (const name of existingBundles) {
    if (ALL_MANAGED_BUNDLE_NAMES.has(name) || seen.has(name)) continue;
    seen.add(name);
    preservedUserBundles.push(name);
  }

  const managedBundles: string[] = [...CORE_MANAGED_BUNDLES];
  if (options.channelsBundleDir) {
    managedBundles.push(DSH_CHANNELS_BUNDLE_NAME);
  }
  const bundles = [...managedBundles, ...preservedUserBundles];

  const existingDeps = isRecord(base.dependencies)
    ? Object.fromEntries(
      Object.entries(base.dependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
    : {};

  const dependencies: Record<string, string> = {
    ...existingDeps,
    [DSH_HOST_BUNDLE_NAME]: toFileSpecifier(options.hostBundleDir),
  };
  if (options.channelsBundleDir) {
    dependencies[DSH_CHANNELS_BUNDLE_NAME] = toFileSpecifier(options.channelsBundleDir);
  } else {
    delete dependencies[DSH_CHANNELS_BUNDLE_NAME];
  }

  const manifest: DshProfileManifest = {
    ...base,
    name: typeof base.name === 'string' && base.name.trim() ? base.name : 'lobsterai-dsh-profile',
    private: true,
    type: 'module',
    dependencies,
    dsh: {
      ...existingDsh,
      profile: {
        ...existingProfile,
        bundles,
      },
    },
  };

  return { manifest, bundles, preservedUserBundles };
}

/**
 * Ensures `<profileDir>/package.json` and `<profileDir>/cordis.patch.yml` exist
 * and are valid for `dsh-app-boot`. Never overwrites an existing user
 * `cordis.patch.yml`.
 */
export function ensureAppOwnedProfile(options: EnsureAppOwnedProfileOptions): EnsureAppOwnedProfileResult {
  const { profileDir, hostBundleDir, channelsBundleDir } = options;
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const manifestPath = path.join(profileDir, 'package.json');
  let existing: Record<string, unknown> | null = null;
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (isRecord(parsed)) existing = parsed;
    } catch (error) {
      console.warn(`[DSH Profile] Existing manifest at ${manifestPath} is unreadable; regenerating`, error);
    }
  }

  const { manifest, bundles, preservedUserBundles } = mergeAppOwnedProfileManifest(existing, {
    hostBundleDir,
    channelsBundleDir,
  });

  const nextManifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeIfChanged(manifestPath, nextManifestText);

  // dsh-app-boot rejects an empty or comment-only cordis.patch.yml; initialize
  // with `[]` only when missing so user customizations always survive upgrades.
  const patchPath = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(patchPath)) {
    fs.writeFileSync(patchPath, '[]\n', { mode: 0o600 });
  }

  // Link LobsterAI-managed local bundles into `<profileDir>/node_modules/` so
  // `dsh-app-boot` resolves them immediately without invoking pnpm or network.
  ensureScopedBundleLink(profileDir, DSH_HOST_BUNDLE_NAME, hostBundleDir);
  if (channelsBundleDir) {
    ensureScopedBundleLink(profileDir, DSH_CHANNELS_BUNDLE_NAME, channelsBundleDir);
  } else {
    removeScopedBundleLink(profileDir, DSH_CHANNELS_BUNDLE_NAME);
  }

  return { manifestPath, patchPath, bundles, preservedUserBundles };
}

/**
 * Generates a lightweight `dsh` CLI shim under `<dshHomeDir>/bin/` so power
 * users and community tutorials can invoke `dsh plugin add ...`, `dsh --dump-config`,
 * `dsh headless`, or `dsh acp` directly against LobsterAI's isolated runtime
 * and bundled pnpm launcher without inheriting official `dsh` environment state.
 */
export function writeDshCliShim(options: WriteDshCliShimOptions): string {
  const platform = options.platform ?? process.platform;
  const launchEntryPath = options.runtimeDir
    ? prepareDshLaunchEntry({
        runtimeDir: options.runtimeDir,
        dshHomeDir: options.dshHomeDir,
        electronPath: options.electronPath,
        toolchain: options.toolchain,
        baseEnv: options.baseEnv,
      }).entryPath
    : options.runtimeEntryPath;
  if (!launchEntryPath) {
    throw new Error('writeDshCliShim requires either runtimeEntryPath or runtimeDir');
  }

  fs.mkdirSync(options.binDir, { recursive: true });
  const execFlags = DSH_NODE_EXEC_ARGV.join(' ');
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const agentsHomeDir = pathImpl.join(options.dshHomeDir, 'agents-home');
  const pnpmStoreDir = pathImpl.join(options.dshHomeDir, 'cache', 'pnpm-store');
  const pnpmCacheDir = pathImpl.join(options.dshHomeDir, 'cache', 'pnpm-cache');
  const npmCacheDir = pathImpl.join(options.dshHomeDir, 'cache', 'npm-cache');

  if (platform === 'win32') {
    const shimPath = path.join(options.binDir, 'dsh.cmd');
    const launchCmd = `"${options.electronPath}" ${execFlags} "${launchEntryPath}"`;
    const content = [
      '@echo off',
      'setlocal EnableExtensions',
      'for /f "delims==" %%V in (\'set DSH_ 2^>nul\') do set "%%V="',
      'set "DEEPSEEK_API_KEY="',
      'set "DEEPSEEK_BASE_URL="',
      'set "DEEPSEEK_SEARCH_BASE_URL="',
      'set "PNPM_HOME="',
      'set "pnpm_config_store_dir="',
      'set "pnpm_config_cache_dir="',
      'set "pnpm_config_userconfig="',
      'set "pnpm_config_globalconfig="',
      'set "npm_config_userconfig="',
      'set "npm_config_globalconfig="',
      'set "npm_config_store_dir="',
      'set "npm_config_cache="',
      'set ELECTRON_RUN_AS_NODE=1',
      `set "DSH_HOME=${options.dshHomeDir}"`,
      `set "DSH_AGENTS_HOME=${agentsHomeDir}"`,
      'set "DSH_TELEMETRY_DISABLED=1"',
      `set "pnpm_config_store_dir=${pnpmStoreDir}"`,
      `set "pnpm_config_cache_dir=${pnpmCacheDir}"`,
      `set "npm_config_store_dir=${pnpmStoreDir}"`,
      `set "npm_config_cache=${npmCacheDir}"`,
      `set "LOBSTERAI_DSH_PROFILE_DIR=${options.profileDir}"`,
      'set "_DSH_HAS_PROFILE=0"',
      'set "_DSH_IS_HELP=0"',
      'call :scan_args %*',
      'if "%~1"=="" goto :run_default_profile',
      'if /i "%~1"=="plugin" goto :handle_plugin',
      'if "%_DSH_HAS_PROFILE%"=="1" goto :run_passthrough',
      'if "%~1"=="-V" goto :run_passthrough',
      'if "%~1"=="--version" goto :run_passthrough',
      'if "%~1"=="-h" goto :run_passthrough',
      'if "%~1"=="--help" goto :run_passthrough',
      'set "_DSH_FIRST=%~1"',
      'if "%_DSH_FIRST:~0,1%"=="-" goto :run_default_profile',
      'goto :run_passthrough',
      '',
      ':handle_plugin',
      'if "%_DSH_HAS_PROFILE%"=="1" goto :run_passthrough',
      'if "%_DSH_IS_HELP%"=="1" goto :run_passthrough',
      'shift',
      'set "_DSH_REST="',
      ':collect_rest',
      'if "%~1"=="" goto :run_plugin_default',
      'set "_DSH_REST=%_DSH_REST% %1"',
      'shift',
      'goto :collect_rest',
      '',
      ':run_plugin_default',
      `${launchCmd} plugin --profile ${DSH_PROFILE_NAME}%_DSH_REST%`,
      'exit /b %ERRORLEVEL%',
      '',
      ':run_default_profile',
      `${launchCmd} --profile ${DSH_PROFILE_NAME} %*`,
      'exit /b %ERRORLEVEL%',
      '',
      ':run_passthrough',
      `${launchCmd} %*`,
      'exit /b %ERRORLEVEL%',
      '',
      ':scan_args',
      'if "%~1"=="" goto :eof',
      'if /i "%~1"=="--profile" set "_DSH_HAS_PROFILE=1"',
      'set "_DSH_ARG=%~1"',
      'if /i "%_DSH_ARG:~0,10%"=="--profile=" set "_DSH_HAS_PROFILE=1"',
      'if "%~1"=="-h" set "_DSH_IS_HELP=1"',
      'if "%~1"=="--help" set "_DSH_IS_HELP=1"',
      'shift',
      'goto :scan_args',
      '',
    ].join('\r\n');
    writeIfChanged(shimPath, content);
    return shimPath;
  }

  const shimPath = path.join(options.binDir, 'dsh');
  const launchCmdPosix = `${shellQuotePosix(options.electronPath)} ${execFlags} ${shellQuotePosix(launchEntryPath)}`;
  const profileNamePosix = shellQuotePosix(DSH_PROFILE_NAME);
  const content = [
    '#!/bin/sh',
    'set -e',
    '_dsh_old_ifs="$IFS"',
    'IFS="',
    '"',
    'set -f',
    'for _dsh_line in $(export -p 2>/dev/null || true); do',
    '  _dsh_entry="${_dsh_line#export }"',
    '  _dsh_entry="${_dsh_entry#-x }"',
    '  case "$_dsh_entry" in',
    '    [Dd][Ss][Hh]_*=*)',
    '      _dsh_var="${_dsh_entry%%=*}"',
    '      unset "$_dsh_var" 2>/dev/null || true',
    '      ;;',
    '  esac',
    'done',
    'set +f',
    'IFS="$_dsh_old_ifs"',
    'unset _dsh_old_ifs _dsh_line _dsh_entry _dsh_var DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_SEARCH_BASE_URL PNPM_HOME pnpm_config_store_dir pnpm_config_cache_dir pnpm_config_userconfig pnpm_config_globalconfig PNPM_CONFIG_STORE_DIR PNPM_CONFIG_CACHE_DIR PNPM_CONFIG_USERCONFIG PNPM_CONFIG_GLOBALCONFIG npm_config_userconfig npm_config_globalconfig NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_STORE_DIR NPM_CONFIG_CACHE',
    'export ELECTRON_RUN_AS_NODE=1',
    `export DSH_HOME=${shellQuotePosix(options.dshHomeDir)}`,
    `export DSH_AGENTS_HOME=${shellQuotePosix(agentsHomeDir)}`,
    'export DSH_TELEMETRY_DISABLED=1',
    `export pnpm_config_store_dir=${shellQuotePosix(pnpmStoreDir)}`,
    `export pnpm_config_cache_dir=${shellQuotePosix(pnpmCacheDir)}`,
    `export npm_config_store_dir=${shellQuotePosix(pnpmStoreDir)}`,
    `export npm_config_cache=${shellQuotePosix(npmCacheDir)}`,
    `export LOBSTERAI_DSH_PROFILE_DIR=${shellQuotePosix(options.profileDir)}`,
    '_dsh_has_profile=0',
    'for _dsh_arg in "$@"; do',
    '  case "$_dsh_arg" in',
    '    --profile|--profile=*)',
    '      _dsh_has_profile=1',
    '      break',
    '      ;;',
    '  esac',
    'done',
    'if [ "$#" -eq 0 ]; then',
    `  exec ${launchCmdPosix} --profile ${profileNamePosix}`,
    'elif [ "$1" = "plugin" ]; then',
    '  if [ "$_dsh_has_profile" -eq 1 ]; then',
    `    exec ${launchCmdPosix} "$@"`,
    '  fi',
    '  _dsh_is_help=0',
    '  for _dsh_arg in "$@"; do',
    '    case "$_dsh_arg" in',
    '      -h|--help)',
    '        _dsh_is_help=1',
    '        break',
    '        ;;',
    '    esac',
    '  done',
    '  if [ "$_dsh_is_help" -eq 1 ]; then',
    `    exec ${launchCmdPosix} "$@"`,
    '  fi',
    '  shift',
    `  exec ${launchCmdPosix} plugin --profile ${profileNamePosix} "$@"`,
    'elif [ "$_dsh_has_profile" -eq 1 ]; then',
    `  exec ${launchCmdPosix} "$@"`,
    'else',
    '  case "$1" in',
    '    -V|--version|-h|--help)',
    `      exec ${launchCmdPosix} "$@"`,
    '      ;;',
    '    -*)',
    `      exec ${launchCmdPosix} --profile ${profileNamePosix} "$@"`,
    '      ;;',
    '    *)',
    `      exec ${launchCmdPosix} "$@"`,
    '      ;;',
    '  esac',
    'fi',
    '',
  ].join('\n');
  writeIfChanged(shimPath, content);
  try {
    fs.chmodSync(shimPath, 0o755);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  return shimPath;
}

function toFileSpecifier(dirPath: string): string {
  const resolved = path.resolve(dirPath).replace(/\\/g, '/');
  return `file:${resolved}`;
}

function resolveNodeModulesTarget(profileDir: string, packageName: string): string {
  return path.join(profileDir, 'node_modules', ...packageName.split('/'));
}

function ensureScopedBundleLink(profileDir: string, packageName: string, targetDir: string): void {
  const resolvedTarget = path.resolve(targetDir);
  const linkPath = resolveNodeModulesTarget(profileDir, packageName);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      if (currentTarget === resolvedTarget) return;
    }
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // Link does not exist yet.
  }
  fs.symlinkSync(resolvedTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function removeScopedBundleLink(profileDir: string, packageName: string): void {
  const linkPath = resolveNodeModulesTarget(profileDir, packageName);
  try {
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function writeIfChanged(filePath: string, content: string): void {
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return;
  } catch {
    // Missing or unreadable.
  }
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeRealpathNative(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}
