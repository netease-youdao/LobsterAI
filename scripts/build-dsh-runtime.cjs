'use strict';

// Build a self-contained DeepSeek Harness (dsh) runtime under
// vendor/dsh-runtime/<target-id>, mirroring the OpenClaw runtime pipeline but
// starting from the published npm package instead of a source checkout:
//
//   npm pack @deepseek-ai/dsh@<pinned> -> extract -> apply pinned patches
//   -> npm install --omit=dev (platform/arch scoped) -> prune -> verify layout
//
// The pinned version lives in package.json under the "dsh" field. The result
// is offline-complete: user machines never run npm or download anything.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveTarCommand } = require('./dsh-tar.cjs');

const LOG_TAG = '[build-dsh-runtime]';

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function warn(message) {
  console.warn(`${LOG_TAG} WARN: ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

// Files no runtime reads. Mirrors scripts/prune-openclaw-runtime.cjs, with one
// deliberate difference: LICENSE files stay. We redistribute this runtime, and
// dsh is MIT — the licence text has to travel with the copies.
const PRUNE_FILE_PATTERNS = [
  /\.map$/i,
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const PRUNE_DIR_NAMES = new Set(['test', 'tests', '__tests__', '__mocks__', '.github', 'example', 'examples', 'coverage']);

// `git apply` can report success while a patch lands somewhere unexpected, and
// an upstream refactor can move the code a patch targets. Each patch therefore
// declares a string that must exist afterwards, so a silent no-op fails the
// build instead of shipping a runtime that quietly lost the fix.
const PATCH_SENTINELS = [
  {
    patch: '01-windows-sandbox-hide-console.cjs',
    file: 'node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/types-CNjZgO4h.js',
    // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, with SW_HIDE, at both
    // sandboxed spawn sites — otherwise every tool run flashes a console.
    expect: 'wShowWindow: 0,',
    occurrences: 2,
  },
  {
    // The same fix once dsh 0.1.5 moved CreateProcess into its own package;
    // the second site now also carries every ordinary Windows subprocess.
    patch: '01-win32-process-hide-console.cjs',
    file: 'node_modules/@deepseek-ai/dsh-win32-process/lib/index.js',
    expect: 'wShowWindow: 0,',
    occurrences: 2,
  },
  {
    patch: '02-picker-electron-safe-path-read.cjs',
    file: 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs',
    // koffi.view() over native memory aborts under Electron's sandboxed V8, so
    // the picked path must come back through koffi's own string marshalling.
    expect: '_Out_ str16 *name',
    occurrences: 1,
  },
];

const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'mac-x64': { platform: 'darwin', arch: 'x64' },
  'win-x64': { platform: 'win32', arch: 'x64' },
  'linux-x64': { platform: 'linux', arch: 'x64' },
};

const targetId = (process.argv[2] || '').trim();
if (!targetId || !TARGETS[targetId]) {
  fail(`Usage: node scripts/build-dsh-runtime.cjs <${Object.keys(TARGETS).join('|')}>`);
}
const target = TARGETS[targetId];

const rootDir = path.resolve(__dirname, '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const dshMeta = rootPkg.dsh;
if (!dshMeta || !dshMeta.version || !dshMeta.npm) {
  fail('package.json is missing the "dsh" field ({ version, npm }).');
}
const dshVersion = dshMeta.version;
const dshPackage = dshMeta.npm;
const registry = process.env.DSH_NPM_REGISTRY || dshMeta.registry || '';

const runtimeBaseDir = path.join(rootDir, 'vendor', 'dsh-runtime');
const outDir = path.join(runtimeBaseDir, targetId);
const buildInfoPath = path.join(outDir, 'runtime-build-info.json');
const patchesDir = path.join(rootDir, 'scripts', 'dsh-patches', dshVersion);

function runOrFail(command, args, options, description) {
  // `tar` is resolved to an absolute path by the caller, so it never needs a shell.
  const useShell = process.platform === 'win32' && (command === 'npm' || command === 'git');
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: useShell,
    ...options,
  });
  if (result.error) {
    fail(`${description} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${description} exited with code ${result.status}`);
  }
  return result;
}

function computePatchHash() {
  if (!fs.existsSync(patchesDir)) return 'none';
  const patchFiles = listPatchFileNames();
  if (patchFiles.length === 0) return 'none';
  const hash = crypto.createHash('sha256');
  for (const name of patchFiles) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(patchesDir, name)));
  }
  return hash.digest('hex');
}

function listPatchFileNames() {
  if (!fs.existsSync(patchesDir)) return [];
  return fs
    .readdirSync(patchesDir)
    .filter((name) => name.endsWith('.cjs'))
    .sort();
}

function listPatchFiles() {
  return listPatchFileNames().map((name) => path.join(patchesDir, name));
}

function isRuntimeComplete() {
  return (
    fs.existsSync(path.join(outDir, 'lib', 'bin.js')) &&
    fs.existsSync(path.join(outDir, 'node_modules')) &&
    fs.existsSync(path.join(outDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))
  );
}

const patchHash = computePatchHash();

// Idempotency: skip the build when the pinned version, patches, and layout all
// match, unless DSH_FORCE_BUILD=1 is set.
if (process.env.DSH_FORCE_BUILD !== '1' && fs.existsSync(buildInfoPath)) {
  try {
    const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    if (info.dshVersion === dshVersion && info.patchHash === patchHash && info.target === targetId && isRuntimeComplete()) {
      log(`Runtime ${targetId} for dsh ${dshVersion} is up to date. Set DSH_FORCE_BUILD=1 to rebuild.`);
      process.exit(0);
    }
  } catch (_e) {
    // Corrupt build info — rebuild.
  }
}

if (target.platform !== process.platform) {
  warn(
    `Cross-building ${targetId} on ${process.platform}: npm install scripts (e.g. node-pty prebuild) run on the ` +
      'host and key on process.platform, so native artifacts may be wrong. Build each platform on its own machine.'
  );
}

log(`Building dsh runtime ${targetId} (${dshPackage}@${dshVersion}, patches: ${patchHash === 'none' ? 'none' : patchHash.slice(0, 12)})`);

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-'));
process.on('exit', () => {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (_e) {
    // Best-effort cleanup.
  }
});

// [1/6] Download the published CLI package tarball. `npm pack` of a remote
// spec only downloads; no scripts run locally.
const packArgs = ['pack', `${dshPackage}@${dshVersion}`, '--pack-destination', stagingDir, '--loglevel=error'];
if (registry) packArgs.push(`--registry=${registry}`);
runOrFail('npm', packArgs, { cwd: stagingDir }, 'npm pack');

const tarball = fs.readdirSync(stagingDir).find((name) => name.endsWith('.tgz'));
if (!tarball) {
  fail(`npm pack produced no tarball in ${stagingDir}`);
}

// [2/6] Extract. npm tarballs always wrap contents in a "package/" directory.
runOrFail(resolveTarCommand(), ['-xzf', path.join(stagingDir, tarball), '-C', stagingDir], {}, 'tar extract');
const extractedDir = path.join(stagingDir, 'package');
if (!fs.existsSync(path.join(extractedDir, 'package.json'))) {
  fail(`Extracted tarball has no package.json at ${extractedDir}`);
}

// [3/6] Lay down the runtime root and neutralize the manifest: devDependencies
// must not resolve and the CLI package's own lifecycle scripts must never run.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(runtimeBaseDir, { recursive: true });
fs.cpSync(extractedDir, outDir, { recursive: true });

const runtimePkgPath = path.join(outDir, 'package.json');
const runtimePkg = JSON.parse(fs.readFileSync(runtimePkgPath, 'utf8'));
delete runtimePkg.devDependencies;
delete runtimePkg.scripts;
fs.writeFileSync(runtimePkgPath, `${JSON.stringify(runtimePkg, null, 2)}\n`);

// [4/6] Install production dependencies scoped to the target platform/arch so
// npm selects the matching optionalDependencies prebuilds (ripgrep, koffi,
// landlock, require-builtin). Transitive install scripts stay enabled — the
// node-pty prebuild/chmod steps are required.
const installEnv = {
  ...process.env,
  npm_config_platform: target.platform,
  npm_config_arch: target.arch,
};
if (registry) installEnv.npm_config_registry = registry;

const installArgs = ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'];
const firstInstall = spawnSync('npm', installArgs, {
  cwd: outDir,
  env: installEnv,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (firstInstall.status !== 0) {
  warn('npm install failed; retrying with --legacy-peer-deps');
  runOrFail('npm', [...installArgs, '--legacy-peer-deps'], { cwd: outDir, env: installEnv }, 'npm install (legacy peer deps)');
}

// [5/6] Apply LobsterAI patches pinned to this dsh version. Patches target the
// installed tree (published lib/*.js under the root or node_modules), so they
// run after install. Each patch is a module exporting apply(runtimeRoot) — the
// published bundles carry content-hashed filenames, and `git apply` resolves
// diff paths against the repo root and silently skips this gitignored vendor
// directory (exit 0, "Skipped patch").
for (const patchFile of listPatchFiles()) {
  const name = path.basename(patchFile);
  let transform;
  try {
    transform = require(patchFile);
  } catch (error) {
    fail(`Patch ${name} could not be loaded: ${error.message}`);
  }
  if (typeof transform.apply !== 'function') {
    fail(`Patch ${name} does not export an apply(runtimeRoot) function`);
  }
  try {
    const detail = transform.apply(outDir);
    log(`Applied ${name}: ${detail || transform.description || 'ok'}`);
  } catch (error) {
    fail(`Patch ${name} failed: ${error.message}`);
  }
}
assertPatchesLanded();

// [6/6] Prune and verify.
pruneRuntime();
verifyRuntimeLayout();

fs.writeFileSync(
  buildInfoPath,
  `${JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      target: targetId,
      platform: target.platform,
      arch: target.arch,
      npmPackage: dshPackage,
      dshVersion,
      patchHash,
      builderVersion: 1,
    },
    null,
    2
  )}\n`
);
log(`Done: ${path.relative(rootDir, outDir)}`);

function pruneGenericFiles(root) {
  let removedBytes = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name.toLowerCase())) {
          removedBytes += directorySize(entryPath);
          fs.rmSync(entryPath, { recursive: true, force: true });
          continue;
        }
        walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (PRUNE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
        try {
          removedBytes += fs.statSync(entryPath).size;
          fs.rmSync(entryPath);
        } catch {
          // Raced with something else; skip.
        }
      }
    }
  };
  walk(root);
  return removedBytes;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(entryPath).size;
      } catch {
        // Ignore.
      }
    }
  }
  return total;
}

function assertPatchesLanded() {
  const applied = new Set(listPatchFiles().map((file) => path.basename(file)));
  for (const sentinel of PATCH_SENTINELS) {
    if (!applied.has(sentinel.patch)) continue;
    const filePath = path.join(outDir, ...sentinel.file.split('/'));
    if (!fs.existsSync(filePath)) {
      fail(`Patch ${sentinel.patch} target is missing: ${sentinel.file}`);
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    const found = contents.split(sentinel.expect).length - 1;
    if (found !== sentinel.occurrences) {
      fail(`Patch ${sentinel.patch} did not land: expected ${sentinel.occurrences} × "${sentinel.expect}", found ${found}`);
    }
    log(`Verified ${sentinel.patch} (${found} sites)`);
  }
}

function pruneRuntime() {
  const nodeModules = path.join(outDir, 'node_modules');

  // node-pty ships every platform's prebuilt binary inside one package, so a
  // mac runtime otherwise carries ~58 MB of Windows PTY binaries.
  const prebuildsDir = path.join(nodeModules, 'node-pty', 'prebuilds');
  if (fs.existsSync(prebuildsDir)) {
    const keep = `${target.platform}-${target.arch}`;
    let removedBytes = 0;
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keep) continue;
      const entryPath = path.join(prebuildsDir, entry.name);
      removedBytes += directorySize(entryPath);
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
    if (removedBytes > 0) {
      log(`Pruned node-pty prebuilds for other platforms (${Math.round(removedBytes / 1024 / 1024)} MB, kept ${keep})`);
    }
  }

  // Windows node-pty keeps large .pdb debug symbols beside its prebuilds.
  if (target.platform === 'win32' && fs.existsSync(prebuildsDir)) {
    let removedBytes = 0;
    for (const entry of fs.readdirSync(prebuildsDir, { recursive: true })) {
      const entryPath = path.join(prebuildsDir, String(entry));
      if (entryPath.endsWith('.pdb') && fs.existsSync(entryPath)) {
        removedBytes += fs.statSync(entryPath).size;
        fs.rmSync(entryPath);
      }
    }
    if (removedBytes > 0) log(`Pruned node-pty debug symbols (${Math.round(removedBytes / 1024 / 1024)} MB)`);
  }

  const genericBytes = pruneGenericFiles(nodeModules);
  if (genericBytes > 0) log(`Pruned maps, declarations, docs, and test fixtures (${Math.round(genericBytes / 1024 / 1024)} MB)`);

  // Remove broken .bin symlinks; they break codesign on macOS and tar on Windows.
  const binDir = path.join(nodeModules, '.bin');
  if (fs.existsSync(binDir)) {
    for (const entry of fs.readdirSync(binDir)) {
      const entryPath = path.join(binDir, entry);
      try {
        fs.statSync(entryPath);
      } catch (_e) {
        fs.rmSync(entryPath, { force: true });
        log(`Removed broken .bin link: ${entry}`);
      }
    }
  }
}

function verifyRuntimeLayout() {
  const mustExist = [
    ['lib/bin.js', 'CLI entry'],
    ['node_modules', 'dependency tree'],
    ['node_modules/@deepseek-ai/dsh-base', 'dsh-base bundle'],
    ['node_modules/@deepseek-ai/dsh-web-app', 'dsh-web-app bundle'],
    ['node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', 'web frontend static assets'],
  ];
  for (const [relPath, label] of mustExist) {
    if (!fs.existsSync(path.join(outDir, relPath))) {
      fail(`Runtime layout check failed: missing ${label} (${relPath})`);
    }
  }

  // Platform binaries selected by npm_config_platform/arch. Warn-only until a
  // real dependency change proves the expected package names wrong.
  const ripgrepDir = path.join(outDir, 'node_modules', '@vscode');
  const hasRipgrepPlatform =
    fs.existsSync(ripgrepDir) && fs.readdirSync(ripgrepDir).some((name) => name.startsWith('ripgrep-'));
  if (!hasRipgrepPlatform) {
    warn('No @vscode/ripgrep-<platform> package found; grep/glob tools may be broken. Check optionalDependencies install.');
  }

  // macOS: node-pty needs an executable spawn-helper. Installs that skipped
  // lifecycle scripts lose the exec bit, so restore it here.
  if (target.platform === 'darwin') {
    const helperPath = path.join(outDir, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper');
    if (fs.existsSync(helperPath)) {
      fs.chmodSync(helperPath, 0o755);
    } else {
      warn(`node-pty spawn-helper not found at ${helperPath}; terminal PTY support may be broken.`);
    }
  }
}
