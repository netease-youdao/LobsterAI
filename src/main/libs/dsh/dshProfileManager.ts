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

export interface DshNodeToolchain {
  electronPath?: string;
  nodeShimDir?: string | null;
  npmBinDir?: string | null;
  gitBinDir?: string | null;
}

export interface EnsureDshLauncherOptions {
  dshHomeDir: string;
  runtimeDir: string;
  executablePath: string;
  toolchain?: DshNodeToolchain | null;
  baseEnv?: NodeJS.ProcessEnv;
  delimiter?: string;
  platform?: NodeJS.Platform;
}

export interface WriteDshCliShimOptions {
  binDir: string;
  electronPath: string;
  runtimeEntryPath: string;
  profileDir: string;
  dshHomeDir: string;
  launcherPath?: string | null;
  runtimeDir?: string | null;
  toolchain?: DshNodeToolchain | null;
  platform?: NodeJS.Platform;
}

/**
 * Returns isolated pnpm/npm store and cache environment variables pinned under
 * `<dshHomeDir>/cache/`. pnpm 11 reads `pnpm_config_*` (ignoring `npm_config_*`),
 * while older tools read `npm_config_*`, so both families are populated.
 */
export function buildIsolatedPnpmCacheEnv(
  dshHomeDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const pnpmStoreDir = pathImpl.join(dshHomeDir, 'cache', 'pnpm-store');
  const pnpmCacheDir = pathImpl.join(dshHomeDir, 'cache', 'pnpm-cache');
  const npmCacheDir = pathImpl.join(dshHomeDir, 'cache', 'npm-cache');
  return {
    pnpm_config_store_dir: pnpmStoreDir,
    pnpm_config_cache_dir: pnpmCacheDir,
    npm_config_store_dir: pnpmStoreDir,
    npm_config_cache: npmCacheDir,
  };
}

export function resolveDshLauncherPath(dshHomeDir: string): string {
  return path.join(dshHomeDir, DSH_LAUNCHER_DIR_NAME, DSH_LAUNCHER_FILENAME);
}

/**
 * Locates the bundled pnpm executable script inside `<runtimeDir>/package-manager/pnpm`,
 * or returns null when the runtime was built without bundled pnpm.
 */
export function resolveBundledPnpmEntry(runtimeDir: string): string | null {
  let resolvedRuntimeDir = runtimeDir;
  try {
    resolvedRuntimeDir = fs.realpathSync(runtimeDir);
  } catch {
    // Keep original path when runtimeDir does not exist yet.
  }
  const pnpmRoot = path.join(resolvedRuntimeDir, ...DSH_PNPM_PACKAGE_RELPATH.split('/'));
  const pkgPath = path.join(pnpmRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const binRelPath = parseDshPnpmBinRelPath(fs.readFileSync(pkgPath, 'utf8'));
    if (!binRelPath) return null;
    const entryPath = path.join(pnpmRoot, ...binRelPath.split('/'));
    return fs.existsSync(entryPath) ? entryPath : null;
  } catch {
    return null;
  }
}

/**
 * Writes `<dshHomeDir>/dsh-launcher/launch.mjs` wiring DSH's `runCli` with the
 * runtime's bundled pnpm so plugin operations succeed with no global `pnpm` on
 * `PATH`. Falls back to `<runtimeDir>/lib/bin.js` if pnpm is not bundled.
 */
export function ensureDshLauncher(options: EnsureDshLauncherOptions): string {
  let resolvedRuntimeDir = options.runtimeDir;
  try {
    resolvedRuntimeDir = fs.realpathSync(options.runtimeDir);
  } catch {
    // Fall back to provided path.
  }
  const runtimeEntryPath = path.join(resolvedRuntimeDir, ...DSH_RUNTIME_ENTRY_RELPATH.split('/'));
  const pnpmEntry = resolveBundledPnpmEntry(resolvedRuntimeDir);
  if (!pnpmEntry) {
    return runtimeEntryPath;
  }

  const packageManager = buildDshPackageManager({
    electronPath: options.toolchain?.electronPath ?? options.executablePath,
    pnpmEntry,
    nodeShimDir: options.toolchain?.nodeShimDir ?? null,
    npmBinDir: options.toolchain?.npmBinDir ?? null,
    gitBinDir: options.toolchain?.gitBinDir ?? null,
    baseEnv: options.baseEnv ?? process.env,
    delimiter: options.delimiter ?? path.delimiter,
  });
  Object.assign(packageManager.env, buildIsolatedPnpmCacheEnv(options.dshHomeDir, options.platform));

  const launcherPath = resolveDshLauncherPath(options.dshHomeDir);
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  writeIfChanged(
    launcherPath,
    buildDshLauncherSource(pathToFileURL(runtimeEntryPath).href, packageManager),
  );
  return launcherPath;
}

const PROFILE_PNPM_WORKSPACE = [
  'packages:',
  '  - .',
  '',
  'nodeLinker: hoisted',
  'autoInstallPeers: false',
  '',
].join('\n');

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

  // Matches dsh-app-boot's `initProfile`: pnpm >= 10 reads `nodeLinker` and
  // `autoInstallPeers` from `pnpm-workspace.yaml` (not `.npmrc`). Without
  // `autoInstallPeers: false`, `pnpm add` tries to fetch `@deepseek-ai/*`
  // runtime peers from the public npm registry and fails with 404. Never
  // overwrite an existing file so user `allowBuilds` approvals survive upgrades.
  const pnpmWorkspacePath = path.join(profileDir, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpmWorkspacePath)) {
    fs.writeFileSync(pnpmWorkspacePath, PROFILE_PNPM_WORKSPACE, { mode: 0o600 });
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
 * Generates a lightweight `dsh` CLI shim under `<profileDir>/bin/` so power
 * users and community tutorials can invoke `dsh plugin add ...`, `dsh --dump-config`,
 * `dsh headless`, or `dsh acp` directly against LobsterAI's runtime.
 */
export function writeDshCliShim(options: WriteDshCliShimOptions): string {
  const platform = options.platform ?? process.platform;
  fs.mkdirSync(options.binDir, { recursive: true });
  const execFlags = DSH_NODE_EXEC_ARGV.join(' ');
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const agentsHomeDir = pathImpl.join(options.dshHomeDir, 'agents-home');
  const cacheEnv = buildIsolatedPnpmCacheEnv(options.dshHomeDir, platform);
  const targetEntryPath =
    options.launcherPath
    || (options.runtimeDir
      ? ensureDshLauncher({
        dshHomeDir: options.dshHomeDir,
        runtimeDir: options.runtimeDir,
        executablePath: options.electronPath,
        toolchain: options.toolchain,
        platform,
      })
      : options.runtimeEntryPath);

  if (platform === 'win32') {
    const shimPath = path.join(options.binDir, 'dsh.cmd');
    const content = [
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `set "DSH_HOME=${options.dshHomeDir}"`,
      `set "DSH_AGENTS_HOME=${agentsHomeDir}"`,
      'set "DSH_TELEMETRY_DISABLED=1"',
      `set "pnpm_config_store_dir=${cacheEnv.pnpm_config_store_dir}"`,
      `set "pnpm_config_cache_dir=${cacheEnv.pnpm_config_cache_dir}"`,
      `set "npm_config_store_dir=${cacheEnv.npm_config_store_dir}"`,
      `set "npm_config_cache=${cacheEnv.npm_config_cache}"`,
      `set "LOBSTERAI_DSH_PROFILE_DIR=${options.profileDir}"`,
      `"${options.electronPath}" ${execFlags} "${targetEntryPath}" %*`,
      '',
    ].join('\r\n');
    writeIfChanged(shimPath, content);
    return shimPath;
  }

  const shimPath = path.join(options.binDir, 'dsh');
  const content = [
    '#!/bin/sh',
    'set -e',
    'export ELECTRON_RUN_AS_NODE=1',
    `export DSH_HOME=${shellQuotePosix(options.dshHomeDir)}`,
    `export DSH_AGENTS_HOME=${shellQuotePosix(agentsHomeDir)}`,
    'export DSH_TELEMETRY_DISABLED=1',
    `export pnpm_config_store_dir=${shellQuotePosix(cacheEnv.pnpm_config_store_dir)}`,
    `export pnpm_config_cache_dir=${shellQuotePosix(cacheEnv.pnpm_config_cache_dir)}`,
    `export npm_config_store_dir=${shellQuotePosix(cacheEnv.npm_config_store_dir)}`,
    `export npm_config_cache=${shellQuotePosix(cacheEnv.npm_config_cache)}`,
    `export LOBSTERAI_DSH_PROFILE_DIR=${shellQuotePosix(options.profileDir)}`,
    `exec ${shellQuotePosix(options.electronPath)} ${execFlags} ${shellQuotePosix(targetEntryPath)} "$@"`,
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
