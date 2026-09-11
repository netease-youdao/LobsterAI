'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { collectPluginRuntimeEntries } = require('./openclaw-plugin-entries.cjs');

const VERIFICATION_FILE = 'plugin-load-verification.json';
const PLATFORM_IDS = { win32: 'win', darwin: 'mac', linux: 'linux' };
const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function isolatedProbeEnv(stateDir, runtimeRoot) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production',
    HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
    TMP: stateDir, TEMP: stateDir, XDG_CACHE_HOME: path.join(stateDir, 'cache'),
    XDG_CONFIG_HOME: stateDir, XDG_DATA_HOME: stateDir,
    OPENCLAW_HOME: stateDir, OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeRoot, 'dist/extensions'),
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: '1',
    NODE_COMPILE_CACHE: path.join(stateDir, 'compile-cache'),
  };
}

function verifyOpenClawPluginLoad(runtimeDirectory, options = {}) {
  const runtimeRoot = fs.realpathSync(runtimeDirectory);
  const reportPath = path.join(runtimeRoot, VERIFICATION_FILE);
  // A failed current verification must never leave an older success marker.
  fs.rmSync(reportPath, { force: true });
  const build = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'));
  const entries = collectPluginRuntimeEntries(runtimeRoot);
  for (const entry of entries) {
    if (!/\.(?:mjs|cjs|js)$/i.test(entry.source)) {
      throw new Error(`[openclaw-plugin-load] Plugin entry is not compiled JavaScript: ${entry.source}`);
    }
  }
  const native = build.target === `${PLATFORM_IDS[process.platform]}-${process.arch}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-plugin-verify-'));
  let proof;
  try {
    if (native) {
      const requestPath = path.join(stateDir, 'request.json');
      const resultPath = path.join(stateDir, 'result.json');
      fs.mkdirSync(path.join(stateDir, 'workspace'));
      fs.writeFileSync(path.join(stateDir, 'openclaw.json'), '{}');
      fs.writeFileSync(requestPath, JSON.stringify({ runtimeRoot, entries, resultPath, stateDir }));
      const executable = options.executable ?? require('electron');
      const result = spawnSync(executable, [path.join(__dirname, 'openclaw-plugin-load-smoke.mjs'), requestPath], {
        cwd: runtimeRoot, env: isolatedProbeEnv(stateDir, runtimeRoot), windowsHide: true,
        encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
      });
      if (result.status !== 0 || !fs.existsSync(resultPath)) {
        const details = [result.error?.message, result.stderr?.slice(-12_000), result.stdout?.slice(-4_000)]
          .filter(Boolean).join('\n');
        throw new Error(`[openclaw-plugin-load] Native verification failed (exit ${result.status}): ${details}`);
      }
      proof = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    }
    const report = { schemaVersion: 1, target: build.target, openclawVersion: build.openclawVersion,
      patchHash: build.patchHash, nativeVerified: native, verifiedAt: new Date().toISOString(),
      entries: entries.map(entry => ({ id: entry.id, kind: entry.kind, origin: entry.origin,
        source: path.relative(runtimeRoot, entry.source).split(path.sep).join('/'), sha256: hashFile(entry.source),
        packageSha256: fs.existsSync(path.join(entry.pluginDir, 'package.json')) ? hashFile(path.join(entry.pluginDir, 'package.json')) : null,
        manifestSha256: fs.existsSync(path.join(entry.pluginDir, 'openclaw.plugin.json')) ? hashFile(path.join(entry.pluginDir, 'openclaw.plugin.json')) : null,
      })), proof,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[openclaw-plugin-load] Verified ${entries.length} entries (${native ? `Electron native, ${Math.round(proof.totalMs)}ms` : 'static only; execute native verification on the target host'}).`);
    return report;
  } finally {
    // Only the directory allocated above is removed, never runtime/user state.
    if (path.dirname(stateDir) !== path.resolve(os.tmpdir())) throw new Error('Unexpected verification state path');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    verifyOpenClawPluginLoad(process.argv[2] || path.join(__dirname, '../vendor/openclaw-runtime/current'));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { verifyOpenClawPluginLoad, isolatedProbeEnv };
