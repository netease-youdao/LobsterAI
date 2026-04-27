import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const LOCAL_EXTENSIONS_DIR = 'openclaw-extensions';
const THIRD_PARTY_EXTENSIONS_DIR = 'third-party-extensions';

const findLocalExtensionsSourceDir = (): string | null => {
  if (app.isPackaged) {
    return null;
  }

  const candidates = [
    path.join(app.getAppPath(), LOCAL_EXTENSIONS_DIR),
    path.join(process.cwd(), LOCAL_EXTENSIONS_DIR),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  return null;
};

const findBundledExtensionsDir = (): string | null => {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'cfmind', THIRD_PARTY_EXTENSIONS_DIR)]
    : [
        path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current', THIRD_PARTY_EXTENSIONS_DIR),
        path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current', THIRD_PARTY_EXTENSIONS_DIR),
      ];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  return null;
};

export const syncLocalOpenClawExtensionsIntoRuntime = (
  runtimeRoot: string,
): { sourceDir: string | null; copied: string[] } => {
  const sourceDir = findLocalExtensionsSourceDir();
  if (!sourceDir) {
    return { sourceDir: null, copied: [] };
  }

  const targetExtensionsDir = path.join(runtimeRoot, THIRD_PARTY_EXTENSIONS_DIR);
  try {
    if (!fs.statSync(targetExtensionsDir).isDirectory()) {
      return { sourceDir, copied: [] };
    }
  } catch {
    return { sourceDir, copied: [] };
  }

  const copied: string[] = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    fs.cpSync(
      path.join(sourceDir, entry.name),
      path.join(targetExtensionsDir, entry.name),
      { recursive: true, force: true },
    );
    copied.push(entry.name);
  }

  return { sourceDir, copied };
};

export const listLocalOpenClawExtensionIds = (): string[] => {
  const sourceDir = findLocalExtensionsSourceDir();
  if (!sourceDir) {
    return [];
  }

  try {
    return fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(sourceDir, entry.name, 'openclaw.plugin.json')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const listBundledOpenClawExtensionIds = (): string[] => {
  const extensionsDir = findBundledExtensionsDir();
  if (!extensionsDir) {
    return [];
  }

  try {
    return fs.readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fs.existsSync(path.join(extensionsDir, entry.name, 'openclaw.plugin.json')))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const hasBundledOpenClawExtension = (extensionId: string): boolean => {
  return listBundledOpenClawExtensionIds().includes(extensionId)
    || listLocalOpenClawExtensionIds().includes(extensionId);
};

/**
 * Returns the absolute path to the third-party plugins directory.
 *
 * Third-party plugins (declared in package.json openclaw.plugins) are placed
 * in a separate `extensions/` directory — NOT in `dist/extensions/` which is
 * reserved for runtime-bundled plugins that satisfy the bundled-channel-entry
 * contract.  The gateway discovers these via `plugins.load.paths`.
 */
export const findThirdPartyExtensionsDir = (): string | null => {
  const dir = findBundledExtensionsDir();
  if (!dir) return null;
  // Resolve symlinks so the path matches what the gateway sees after
  // resolving the `current` → `win-x64` (or other platform) junction.
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * Remove third-party plugins that may linger in directories scanned by the
 * gateway's bundled-channel metadata loader.  Two locations are cleaned:
 *
 * 1. `dist/extensions/{id}` — legacy overlay installs placed plugins here.
 * 2. `extensions/{id}` — prior versions of LobsterAI installed plugins here.
 *    Because gateway-bundle.mjs runs from the package root (not dist/),
 *    `RUNNING_FROM_BUILT_ARTIFACT` is false and `resolveBundledPluginScanDir`
 *    falls back to `extensions/`.  Third-party plugins there fail the
 *    bundled-channel-entry contract check and waste startup time.
 */
export const cleanupStaleThirdPartyPluginsFromBundledDir = (
  runtimeRoot: string,
  thirdPartyPluginIds: readonly string[],
): string[] => {
  const staleDirs = [
    path.join(runtimeRoot, 'dist', 'extensions'),
    path.join(runtimeRoot, 'extensions'),
  ];
  const removed: string[] = [];

  for (const id of thirdPartyPluginIds) {
    for (const baseDir of staleDirs) {
      const staleDir = path.join(baseDir, id);
      try {
        if (fs.statSync(staleDir).isDirectory()) {
          fs.rmSync(staleDir, { recursive: true, force: true });
          removed.push(id);
        }
      } catch {
        // Directory doesn't exist or can't be accessed — nothing to clean up.
      }
    }
  }

  return removed;
};
