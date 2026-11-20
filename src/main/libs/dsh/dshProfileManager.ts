// Pure helpers for preparing LobsterAI's App-Owned DSH Profile and built-in
// `dsh` CLI shim. Keeps user-installed DSH bundles and `cordis.patch.yml`
// intact across LobsterAI upgrades (no Electron imports; fully unit-testable).

import * as fs from 'fs';
import * as path from 'path';

import {
  DSH_BASE_BUNDLE_NAME,
  DSH_CHANNELS_BUNDLE_NAME,
  DSH_HOST_BUNDLE_NAME,
  DSH_PROFILE_NAME,
  DSH_WEB_APP_BUNDLE_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { DSH_NODE_EXEC_ARGV } from '../dshRuntime';

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
  runtimeEntryPath: string;
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
 * Generates a lightweight `dsh` CLI shim under `<profileDir>/bin/` so power
 * users and community tutorials can invoke `dsh plugin add ...`, `dsh --dump-config`,
 * `dsh headless`, or `dsh acp` directly against LobsterAI's runtime.
 */
export function writeDshCliShim(options: WriteDshCliShimOptions): string {
  const platform = options.platform ?? process.platform;
  fs.mkdirSync(options.binDir, { recursive: true });
  const execFlags = DSH_NODE_EXEC_ARGV.join(' ');

  if (platform === 'win32') {
    const shimPath = path.join(options.binDir, 'dsh.cmd');
    const content = [
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      `set "DSH_HOME=${options.dshHomeDir}"`,
      `set "LOBSTERAI_DSH_PROFILE_DIR=${options.profileDir}"`,
      `"${options.electronPath}" ${execFlags} "${options.runtimeEntryPath}" %*`,
      '',
    ].join('\r\n');
    writeIfChanged(shimPath, content);
    return shimPath;
  }

  const shimPath = path.join(options.binDir, 'dsh');
  const content = [
    '#!/usr/bin/env sh',
    'set -e',
    'export ELECTRON_RUN_AS_NODE=1',
    `export DSH_HOME=${shellQuotePosix(options.dshHomeDir)}`,
    `export LOBSTERAI_DSH_PROFILE_DIR=${shellQuotePosix(options.profileDir)}`,
    `exec ${shellQuotePosix(options.electronPath)} ${execFlags} ${shellQuotePosix(options.runtimeEntryPath)} "$@"`,
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
