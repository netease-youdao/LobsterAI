// Pure Node operations for managing LobsterAI's DSH App-Owned Profile plugins
// (listing, enable/disable toggling, specifier validation, and bundled-pnpm CLI
// invocation). Kept free of Electron imports so unit and live-runtime E2E tests
// can exercise it directly under Node Vitest.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_PROFILE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildIsolatedDshBaseEnv,
  type DshNodeToolchain,
  ensureDshLauncher,
} from '../../libs/dsh/dshProfileManager';
import { DSH_NODE_EXEC_ARGV } from '../../libs/dshRuntime';

export interface DshProfilePluginInfo {
  name: string;
  specifier: string;
  managed: boolean;
  enabled: boolean;
}

export interface SetProfilePluginEnabledResult {
  ok: boolean;
  changed?: boolean;
  enabled?: boolean;
  error?: string;
  plugins: DshProfilePluginInfo[];
}

export interface RunDshPluginCommandOptions {
  executablePath: string;
  runtimeDir: string;
  dshHomeDir: string;
  args: string[];
  nodeToolchain?: DshNodeToolchain | null;
  toolchain?: DshNodeToolchain | null;
  baseEnv?: NodeJS.ProcessEnv;
  skipElectronRunAsNode?: boolean;
  cwd?: string;
}

export interface RunDshPluginCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MANAGED_BUNDLES = new Set<string>([
  DSH_BASE_BUNDLE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
]);

const UNSAFE_SPECIFIER_CHARS = /[;&|<>`$\x00-\x1f\x7f]/;
const UNSAFE_PACKAGE_NAME_CHARS = /[\s;&|<>`$\x00-\x1f\x7f]/;
const LOCAL_PATH_SPECIFIER_PREFIX = /^(?:file:|link:|\/|\.\.?[/\\]|~\/|[a-zA-Z]:[/\\]|\\\\)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

export function isManagedDshBundle(name: string): boolean {
  return MANAGED_BUNDLES.has(name) || name.startsWith('@lobsterai/');
}

/**
 * Validates a plugin install specifier (`npm` package, git URL, tarball URL, or
 * local path — including local paths that contain spaces) while rejecting
 * leading `-` option flags (CLI flag injection) and shell metacharacters or
 * control characters.
 */
export function validatePluginInstallSpecifier(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const spec = raw.trim();
  if (!spec) return null;
  if (spec.startsWith('-')) return null;
  if (UNSAFE_SPECIFIER_CHARS.test(spec)) return null;
  if (/\s/.test(spec) && !LOCAL_PATH_SPECIFIER_PREFIX.test(spec)) {
    return null;
  }
  return spec;
}

/**
 * Validates a removable/toggleable user plugin package name. Rejects built-in
 * managed bundles, leading `-` flags, whitespace, and shell metacharacters.
 */
export function validatePluginPackageName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name) return null;
  if (name.startsWith('-')) return null;
  if (UNSAFE_PACKAGE_NAME_CHARS.test(name)) return null;
  if (isManagedDshBundle(name)) return null;
  return name;
}

/**
 * Reads all profile plugins by combining `pkg.dsh.profile.bundles` (enabled
 * layers) with `pkg.dependencies` and `pkg.optionalDependencies` so user
 * plugins disabled in either LobsterAI UI or the DSH Ecosystem Web View remain
 * listed with `enabled: false` instead of vanishing.
 */
export function readInstalledProfilePlugins(profileDir: string): DshProfilePluginInfo[] {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!isRecord(parsed)) return [];
    const dsh = isRecord(parsed.dsh) ? parsed.dsh : {};
    const profile = isRecord(dsh.profile) ? dsh.profile : {};
    const rawBundles = Array.isArray(profile.bundles) ? profile.bundles : [];

    const bundles: string[] = [];
    const bundleSet = new Set<string>();
    for (const item of rawBundles) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || bundleSet.has(trimmed)) continue;
      bundleSet.add(trimmed);
      bundles.push(trimmed);
    }

    const allDeps: Record<string, string> = {
      ...readStringMap(parsed.optionalDependencies),
      ...readStringMap(parsed.dependencies),
    };

    const plugins: DshProfilePluginInfo[] = [];
    for (const name of bundles) {
      plugins.push({
        name,
        specifier: allDeps[name] ?? 'bundled',
        managed: isManagedDshBundle(name),
        enabled: true,
      });
    }

    for (const [name, specifier] of Object.entries(allDeps)) {
      if (bundleSet.has(name) || isManagedDshBundle(name)) continue;
      plugins.push({
        name,
        specifier,
        managed: false,
        enabled: false,
      });
    }

    return plugins;
  } catch {
    return [];
  }
}

/**
 * Enables or disables an installed user plugin in `<profileDir>/package.json`
 * by adding or removing it from `dsh.profile.bundles` while keeping its
 * dependency entry intact. Built-in managed bundles and uninstalled packages
 * are rejected.
 */
export function setProfilePluginEnabled(
  profileDir: string,
  packageName: string,
  enabled: boolean,
): SetProfilePluginEnabledResult {
  const name = validatePluginPackageName(packageName);
  if (!name) {
    return {
      ok: false,
      error: 'Cannot toggle managed or invalid plugin package',
      plugins: readInstalledProfilePlugins(profileDir),
    };
  }

  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return {
      ok: false,
      error: 'DSH profile manifest not found',
      plugins: [],
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!isRecord(raw)) {
      return {
        ok: false,
        error: 'DSH profile manifest is invalid',
        plugins: [],
      };
    }
    parsed = raw;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      plugins: [],
    };
  }

  const allDeps: Record<string, string> = {
    ...readStringMap(parsed.optionalDependencies),
    ...readStringMap(parsed.dependencies),
  };
  if (!Object.hasOwn(allDeps, name)) {
    return {
      ok: false,
      error: `Plugin "${name}" is not installed in profile dependencies`,
      plugins: readInstalledProfilePlugins(profileDir),
    };
  }

  const existingDsh = isRecord(parsed.dsh) ? parsed.dsh : {};
  const existingProfile = isRecord(existingDsh.profile) ? existingDsh.profile : {};
  const currentBundles = Array.isArray(existingProfile.bundles)
    ? existingProfile.bundles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  let nextBundles: string[];
  let changed: boolean;
  if (enabled) {
    if (currentBundles.includes(name)) {
      nextBundles = currentBundles;
      changed = false;
    } else {
      nextBundles = [...currentBundles, name];
      changed = true;
    }
  } else {
    nextBundles = currentBundles.filter((item) => item !== name);
    changed = nextBundles.length !== currentBundles.length;
  }

  if (changed) {
    const nextManifest: Record<string, unknown> = {
      ...parsed,
      dsh: {
        ...existingDsh,
        profile: {
          ...existingProfile,
          bundles: nextBundles,
        },
      },
    };
    const nextText = `${JSON.stringify(nextManifest, null, 2)}\n`;
    const tmpPath = path.join(profileDir, `.package.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, nextText, { mode: 0o600 });
    fs.renameSync(tmpPath, pkgPath);
  }

  return {
    ok: true,
    changed,
    enabled,
    plugins: readInstalledProfilePlugins(profileDir),
  };
}

/**
 * Invokes `dsh plugin --profile lobsterai <args...>` through the shared
 * `<dshHomeDir>/dsh-launcher/launch.mjs` bundled-pnpm launcher so plugin
 * install/remove works with no global system `pnpm` on `PATH`.
 */
export function runDshPluginCommand(
  options: RunDshPluginCommandOptions,
): Promise<RunDshPluginCommandResult> {
  return new Promise((resolve) => {
    const sourceEnv = options.baseEnv ?? process.env;
    let env: NodeJS.ProcessEnv;
    let launchEntryPath: string;
    try {
      fs.mkdirSync(options.dshHomeDir, { recursive: true, mode: 0o700 });
      env = buildIsolatedDshBaseEnv({
        baseEnv: sourceEnv,
        dshHomeDir: options.dshHomeDir,
        skipElectronRunAsNode: options.skipElectronRunAsNode,
      });
      launchEntryPath = ensureDshLauncher({
        dshHomeDir: options.dshHomeDir,
        runtimeDir: options.runtimeDir,
        executablePath: options.executablePath,
        toolchain: options.nodeToolchain ?? options.toolchain,
        baseEnv: env,
      });
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      });
      return;
    }

    const child = spawn(
      options.executablePath,
      [...DSH_NODE_EXEC_ARGV, launchEntryPath, 'plugin', '--profile', DSH_PROFILE_NAME, ...options.args],
      {
        cwd: options.cwd ?? options.dshHomeDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      resolve({ ok: false, stdout, stderr: error.message, exitCode: 1 });
    });
    child.once('exit', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
