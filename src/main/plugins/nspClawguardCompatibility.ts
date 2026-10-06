import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { safelyReplaceTextFileSync } from '../libs/safeFileReplace';

export const NSP_CLAWGUARD = {
  Id: 'nsp-clawguard',
  // The published 2.4.13 archive still declares 2.4.12 in its plugin manifest.
  Releases: [
    { version: '2.4.13', manifestVersion: '2.4.12', registrationHash: '2eff634d2ade5e952927b6c4647ade0003db515165e2344437adf9099ea6ce60' },
    { version: '2.5.0', manifestVersion: '2.5.0', registrationHash: null as string | null },
  ],
  Entry: './dist/index.mjs',
} as const;

// Both supported releases contain this exact esbuild helper.
const LEGACY_REQUIRE = `var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});`;
const NATIVE_REQUIRE_V1 = `// LobsterAI: nsp-clawguard 2.5.0 native require compatibility v1.
import { createRequire as __lobsteraiNspCreateRequire } from 'node:module';
var __require = __lobsteraiNspCreateRequire(import.meta.url);`;
const nativeModuleContextFor = (version: string) => `// LobsterAI: nsp-clawguard ${version} native module compatibility v2.
import { createRequire as __lobsteraiNspCreateRequire } from 'node:module';
import { fileURLToPath as __lobsteraiNspFileURLToPath } from 'node:url';
import { dirname as __lobsteraiNspDirname } from 'node:path';
var __require = __lobsteraiNspCreateRequire(import.meta.url);
var __filename = __lobsteraiNspFileURLToPath(import.meta.url);
var __dirname = __lobsteraiNspDirname(__filename);`;
const SYNC_REGISTER = 'function register(api) {';
const ASYNC_REGISTER = `async ${SYNC_REGISTER}`;
const REGISTER_EXPORT = '\nexport {\n  register as default\n};';
const LEGACY_MANIFEST_HASH = '1cc6ff67c8ceaa9c502db5d70d6550cf8f9da4b70a9dc043e55e87afe936067a';

interface PluginState {
  pluginId: string;
  enabled: boolean;
}

interface CompatibilityOptions {
  plugins: readonly PluginState[];
  userDataDir: string;
  stateDir: string;
}

/** Recognize published package/manifest pairs without loading plugin code. */
export function readSupportedNspClawguardPackage(pluginDir: string): typeof NSP_CLAWGUARD.Releases[number] | undefined {
  // Do not follow a linked plugin or entry into an external checkout.
  const entryPath = path.join(pluginDir, NSP_CLAWGUARD.Entry);
  for (const directory of [pluginDir, path.dirname(entryPath)]) {
    if (!fs.existsSync(directory)) return undefined;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  }
  for (const file of ['package.json', 'openclaw.plugin.json', NSP_CLAWGUARD.Entry]) {
    const stat = fs.lstatSync(path.join(pluginDir, file));
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'openclaw.plugin.json'), 'utf8'));
  if (pkg?.name !== NSP_CLAWGUARD.Id || manifest?.id !== NSP_CLAWGUARD.Id) return undefined;
  const release = NSP_CLAWGUARD.Releases.find(release => pkg.version === release.version && manifest.version === release.manifestVersion);
  if (
    !release
    || pkg.main !== NSP_CLAWGUARD.Entry
    || !Array.isArray(pkg.openclaw?.extensions)
    || pkg.openclaw.extensions.length !== 1
    || pkg.openclaw.extensions[0] !== NSP_CLAWGUARD.Entry
  ) {
    console.warn(`[PluginCompatibility] Skipping unsupported ${NSP_CLAWGUARD.Id} package at ${pluginDir} (version=${pkg.version}).`);
    return undefined;
  }
  return release;
}

function patchInstalledPlugin(pluginDir: string): boolean {
  const pkg = readSupportedNspClawguardPackage(pluginDir);
  if (!pkg) return false;
  const entryPath = path.join(pluginDir, NSP_CLAWGUARD.Entry);

  const original = fs.readFileSync(entryPath);
  const source = original.toString('utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const legacyRequire = LEGACY_REQUIRE.replace(/\n/g, newline);
  const nativeRequireV1 = NATIVE_REQUIRE_V1.replace(/\n/g, newline);
  const nativeModuleContext = nativeModuleContextFor(pkg.version).replace(/\n/g, newline);
  let registrationSource = source;
  if (pkg.registrationHash && source.includes(ASYNC_REGISTER)) {
    // 2.4.13's register body is byte-identical to 2.5.0 after removing async;
    // it has no top-level await. The pinned runtime rejects Promise-returning
    // registration and discards its hooks. Never rewrite an unknown async body.
    const normalized = source.replace(/\r\n/g, '\n');
    const start = normalized.indexOf(ASYNC_REGISTER);
    const end = normalized.indexOf(REGISTER_EXPORT, start);
    if (end < 0 || normalized.indexOf(ASYNC_REGISTER, start + ASYNC_REGISTER.length) !== -1
      || createHash('sha256').update(normalized.slice(start, end)).digest('hex') !== pkg.registrationHash) {
      console.warn(`[PluginCompatibility] Skipping unrecognized ${NSP_CLAWGUARD.Id} registration at ${entryPath}.`);
      return false;
    }
    registrationSource = source.replace(ASYNC_REGISTER, SYNC_REGISTER);
  }
  const hasNativeContext = source.includes(nativeModuleContext) && !source.includes(legacyRequire) && !source.includes(nativeRequireV1);
  if (hasNativeContext && registrationSource === source) return false;

  // Upgrade installations patched by the previous release as well as pristine
  // packages. The v1 helper fixes registration but not SQL.js in gateway_start.
  const helper = hasNativeContext ? nativeModuleContext : source.includes(nativeRequireV1) ? nativeRequireV1 : legacyRequire;
  const offset = source.indexOf(helper);
  const remainder = source.replace(helper, '');
  if (
    offset < 0 || offset > 1024
    || source.indexOf(helper, offset + helper.length) !== -1
    || remainder.includes(legacyRequire)
    || remainder.includes('__lobsteraiNsp')
    || /\b(?:var|let|const|function|class)\s+__(?:filename|dirname)\b/.test(remainder)
  ) {
    console.warn(`[PluginCompatibility] Skipping unrecognized ${NSP_CLAWGUARD.Id} entry at ${entryPath}.`);
    return false;
  }

  // graceful-fs must receive the native fs object. An interop proxy loses its
  // symbol queue and poisons the gateway's shared fs.close/closeSync methods.
  // SQL.js also reads CommonJS paths when its async startup hook initializes
  // the database. Decode file URLs so Windows drives, spaces and Unicode work.
  const patched = registrationSource.replace(helper, nativeModuleContext);
  replaceWithBackup(entryPath, original, patched, 'native-module-v2');
  console.log(`[PluginCompatibility] Patched ${NSP_CLAWGUARD.Id} ${pkg.version} startup compatibility.`);
  return true;
}

function patchStartupManifest(pluginDir: string): boolean {
  const pkg = readSupportedNspClawguardPackage(pluginDir);
  if (!pkg?.registrationHash) return false;
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
  const original = fs.readFileSync(manifestPath);
  const source = original.toString('utf8');
  const normalized = source.replace(/\r\n/g, '\n').trimEnd();
  // 2.4.13 predates manifest startup activation. Preserve custom manifests and
  // all permissions; add only the lifecycle hint required to load its hooks.
  if (createHash('sha256').update(normalized).digest('hex') !== LEGACY_MANIFEST_HASH) return false;
  const entry = fs.readFileSync(path.join(pluginDir, NSP_CLAWGUARD.Entry), 'utf8').replace(/\r\n/g, '\n');
  const start = entry.indexOf(SYNC_REGISTER);
  const end = entry.indexOf(REGISTER_EXPORT, start);
  if (!entry.includes(nativeModuleContextFor(pkg.version)) || entry.includes(ASYNC_REGISTER)
    || start < 0 || end < 0
    || createHash('sha256').update('async ' + entry.slice(start, end)).digest('hex') !== pkg.registrationHash) return false;
  const manifest = JSON.parse(source);
  const patched = JSON.stringify({ ...manifest, activation: { onStartup: true } }, null, 2)
    .replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n');
  replaceWithBackup(manifestPath, original, patched, 'startup-manifest-v1');
  console.log(`[PluginCompatibility] Added ${NSP_CLAWGUARD.Id} ${pkg.version} startup activation.`);
  return true;
}

function replaceWithBackup(filePath: string, original: Buffer, content: string, backupLabel: string): void {
  const hash = createHash('sha256').update(original).digest('hex');
  const backupPath = `${filePath}.lobsterai-${backupLabel}.${hash}.bak`;
  const mode = fs.statSync(filePath).mode & 0o777;
  try {
    fs.writeFileSync(backupPath, original, { flag: 'wx', mode, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const backupStat = fs.lstatSync(backupPath);
    if (backupStat.isSymbolicLink() || !backupStat.isFile() || !fs.readFileSync(backupPath).equals(original)) {
      throw new Error(`Existing plugin backup does not match ${filePath}`);
    }
  }
  // An external plugin updater may have replaced the entry while we prepared
  // the backup. Never overwrite an update with a patched older package.
  if (!fs.readFileSync(filePath).equals(original)) {
    throw new Error(`Plugin file changed while preparing compatibility patch: ${filePath}`);
  }
  safelyReplaceTextFileSync({ filePath, content, mode, tempLabel: 'nsp-compatibility' });
  console.log(`[PluginCompatibility] Saved ${NSP_CLAWGUARD.Id} compatibility backup: ${backupPath}`);
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
    for (const patch of [patchInstalledPlugin, patchStartupManifest]) {
      try {
        changed = patch(pluginDir) || changed;
      } catch (error) {
        // Retain successful partial progress for restart/retry. Each file has
        // its own backup; manifest activation requires the repaired entry.
        console.error(`[PluginCompatibility] Failed to patch ${NSP_CLAWGUARD.Id} at ${pluginDir}:`, error);
      }
    }
  }
  return changed;
}
