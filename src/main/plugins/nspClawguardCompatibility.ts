import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { safelyReplaceTextFileSync } from '../libs/safeFileReplace';

export const NSP_CLAWGUARD = {
  Id: 'nsp-clawguard',
  SupportedVersion: '2.5.0',
  Entry: './dist/index.mjs',
} as const;

// Match the published 2.5.0 esbuild helper, not arbitrary user plugin code.
const LEGACY_REQUIRE = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});`;
const NATIVE_REQUIRE = `// LobsterAI: nsp-clawguard 2.5.0 native require compatibility v1.
import { createRequire as __lobsteraiNspCreateRequire } from 'node:module';
var __require = __lobsteraiNspCreateRequire(import.meta.url);`;

interface PluginState {
  pluginId: string;
  enabled: boolean;
}

interface CompatibilityOptions {
  plugins: readonly PluginState[];
  userDataDir: string;
  stateDir: string;
}

function patchInstalledPlugin(pluginDir: string): boolean {
  // Do not follow a linked plugin or entry into an external checkout.
  const entryPath = path.join(pluginDir, NSP_CLAWGUARD.Entry);
  for (const directory of [pluginDir, path.dirname(entryPath)]) {
    if (!fs.existsSync(directory)) return false;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  for (const file of ['package.json', 'openclaw.plugin.json', NSP_CLAWGUARD.Entry]) {
    const stat = fs.lstatSync(path.join(pluginDir, file));
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  if (pkg?.name !== NSP_CLAWGUARD.Id || manifest?.id !== NSP_CLAWGUARD.Id) return false;
  if (
    pkg.version !== NSP_CLAWGUARD.SupportedVersion
    || manifest.version !== NSP_CLAWGUARD.SupportedVersion
    || pkg.main !== NSP_CLAWGUARD.Entry
    || !Array.isArray(pkg.openclaw?.extensions)
    || pkg.openclaw.extensions.length !== 1
    || pkg.openclaw.extensions[0] !== NSP_CLAWGUARD.Entry
  ) {
    console.warn(`[PluginCompatibility] Skipping unsupported ${NSP_CLAWGUARD.Id} package at ${pluginDir} (version=${pkg.version}).`);
    return false;
  }

  const original = fs.readFileSync(entryPath);
  const source = original.toString('utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const legacyRequire = LEGACY_REQUIRE.replace(/\n/g, newline);
  const nativeRequire = NATIVE_REQUIRE.replace(/\n/g, newline);
  if (source.includes(nativeRequire) && !source.includes(legacyRequire)) return false;

  const offset = source.indexOf(legacyRequire);
  if (
    offset < 0 || offset > 1024
    || source.indexOf(legacyRequire, offset + legacyRequire.length) !== -1
    || source.includes('__lobsteraiNspCreateRequire')
  ) {
    console.warn(`[PluginCompatibility] Skipping unrecognized ${NSP_CLAWGUARD.Id} entry at ${entryPath}.`);
    return false;
  }

  // graceful-fs must receive the native fs object. An interop proxy loses its
  // symbol queue and poisons the gateway's shared fs.close/closeSync methods.
  const patched = source.replace(legacyRequire, nativeRequire);
  const hash = createHash('sha256').update(original).digest('hex');
  const backupPath = `${entryPath}.lobsterai-native-require-v1.${hash}.bak`;
  const mode = fs.statSync(entryPath).mode & 0o777;
  try {
    fs.writeFileSync(backupPath, original, { flag: 'wx', mode, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const backupStat = fs.lstatSync(backupPath);
    if (backupStat.isSymbolicLink() || !backupStat.isFile() || !fs.readFileSync(backupPath).equals(original)) {
      throw new Error(`Existing plugin backup does not match ${entryPath}`);
    }
  }
  // An external plugin updater may have replaced the entry while we prepared
  // the backup. Never overwrite an update with a patched older package.
  if (!fs.readFileSync(entryPath).equals(original)) {
    throw new Error(`Plugin entry changed while preparing compatibility patch: ${entryPath}`);
  }
  safelyReplaceTextFileSync({ filePath: entryPath, content: patched, mode, tempLabel: 'nsp-native-require' });
  console.log(`[PluginCompatibility] Patched ${NSP_CLAWGUARD.Id} ${pkg.version} native require; backup=${backupPath}`);
  return true;
}

/**
 * Patch only enabled, locally managed installations before any OpenClaw CLI
 * migration or gateway load. Never install a plugin or change its enabled state.
 * Recheck on config sync so installing, enabling and updating use the same path.
 * Returns true when a running gateway needs a new process to load the patch.
 */
export function patchEnabledNspClawguard(options: CompatibilityOptions): boolean {
  if (!options.plugins.some(plugin => plugin.pluginId === NSP_CLAWGUARD.Id && plugin.enabled)) {
    return false;
  }

  let changed = false;
  const pluginDirs = new Set([
    path.join(options.userDataDir, 'third-party-extensions', NSP_CLAWGUARD.Id),
    path.join(options.stateDir, 'extensions', NSP_CLAWGUARD.Id),
  ]);
  for (const pluginDir of pluginDirs) {
    try {
      changed = patchInstalledPlugin(pluginDir) || changed;
    } catch (error) {
      // Leave the original entry in place if a backup/write cannot complete.
      // Other plugins and users without this plugin keep their existing flow.
      console.error(`[PluginCompatibility] Failed to patch ${NSP_CLAWGUARD.Id} at ${pluginDir}:`, error);
    }
  }
  return changed;
}
