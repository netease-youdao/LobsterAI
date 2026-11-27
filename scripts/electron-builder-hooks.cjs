'use strict';

const path = require('path');
const { existsSync, readdirSync, statSync, mkdirSync, readFileSync, rmSync, cpSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const { ensurePortablePythonRuntime, checkRuntimeHealth } = require('./setup-python-runtime.js');
const { configureBetterSqlite3Payload } = require('./better-sqlite3-payload.cjs');
const { configureWindowsSkillsPayload } = require('./skill-payload.cjs');
const { prepareMacSkills, verifyPackagedMacSkills } = require('./skill-mac-dependencies.cjs');

const HEAVY_PRUNED_PACKAGES = [
  '@deepseek-ai/libreoffice-kit-darwin-arm64',
  '@deepseek-ai/libreoffice-kit-darwin-x64',
  '@deepseek-ai/libreoffice-kit-win32-x64',
  '@deepseek-ai/libreoffice-kit-wasm',
  'sherpa-onnx-node',
  'sherpa-onnx-darwin-arm64',
  'sherpa-onnx-darwin-x64',
  'sherpa-onnx-win-x64',
];

function isWindowsTarget(context) {
  return context?.electronPlatformName === 'win32';
}

function isMacTarget(context) {
  return context?.electronPlatformName === 'darwin';
}

function resolveTargetArch(context) {
  if (context?.arch === 3) return 'arm64';
  if (context?.arch === 0) return 'ia32';
  if (context?.arch === 1) return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'ia32';
  return 'x64';
}

function resolveDshRuntimeTargetId(context) {
  const platform = context?.electronPlatformName;
  const arch = resolveTargetArch(context);

  if (platform === 'darwin') {
    return arch === 'x64' ? 'mac-x64' : 'mac-arm64';
  }
  if (platform === 'win32') {
    return 'win-x64';
  }

  return null;
}

function readRuntimeBuildInfo(runtimeRoot) {
  const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
  if (!existsSync(buildInfoPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getDshRuntimeBuildHint(targetId) {
  if (!targetId) {
    return 'npm run dsh:runtime:host';
  }
  return `npm run dsh:runtime:${targetId}`;
}

function syncCurrentDshRuntimeForTarget(context) {
  const runtimeBase = path.join(__dirname, '..', 'vendor', 'dsh-runtime');
  const currentRoot = path.join(runtimeBase, 'current');
  const targetId = resolveDshRuntimeTargetId(context);

  if (!targetId) {
    return { runtimeRoot: currentRoot, targetId: null };
  }

  const targetRoot = path.join(runtimeBase, targetId);
  if (!existsSync(targetRoot)) {
    return { runtimeRoot: currentRoot, targetId };
  }

  const currentBuildInfo = readRuntimeBuildInfo(currentRoot);
  if (currentBuildInfo?.target !== targetId) {
    rmSync(currentRoot, { recursive: true, force: true });
    cpSync(targetRoot, currentRoot, { recursive: true, force: true });
    console.log(`[electron-builder-hooks] Synced DSH runtime ${targetId} -> current`);
  }

  return { runtimeRoot: currentRoot, targetId };
}

function ensureBundledDshRuntime(context) {
  const projectRoot = path.join(__dirname, '..');
  const { runtimeRoot, targetId } = syncCurrentDshRuntimeForTarget(context);
  const buildHint = getDshRuntimeBuildHint(targetId);

  const requiredRuntimePaths = [
    path.join(runtimeRoot, 'package.json'),
    path.join(runtimeRoot, 'lib', 'bin.js'),
    path.join(runtimeRoot, 'node_modules'),
    path.join(runtimeRoot, 'runtime-build-info.json'),
  ];
  const missingRuntime = requiredRuntimePaths.filter((candidate) => !existsSync(candidate));
  if (missingRuntime.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Bundled DSH runtime is incomplete. Missing: '
      + missingRuntime.join(', ')
      + `. Run \`${buildHint}\` before packaging.`,
    );
  }

  const buildInfo = readRuntimeBuildInfo(runtimeRoot);
  if (targetId && buildInfo?.target && buildInfo.target !== targetId) {
    throw new Error(
      `[electron-builder-hooks] Bundled DSH runtime target mismatch: expected ${targetId}, got ${buildInfo.target}. `
      + `Run \`${buildHint}\` before packaging.`,
    );
  }

  // Verify heavy optional native packages remain pruned so installers stay slim.
  const leftoverHeavy = HEAVY_PRUNED_PACKAGES.filter((pkgName) => (
    existsSync(path.join(runtimeRoot, 'node_modules', ...pkgName.split('/')))
  ));
  if (leftoverHeavy.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Heavy optional packages found in bundled DSH runtime: '
      + leftoverHeavy.join(', ')
      + `. Rebuild with \`${buildHint}\`.`,
    );
  }

  // Verify LobsterAI's built-in DSH bundles exist.
  const requiredBundlePaths = [
    path.join(projectRoot, 'dsh-bundles', 'lobsterai-host', 'package.json'),
    path.join(projectRoot, 'dsh-bundles', 'lobsterai-host', 'cordis.patch.yml'),
    path.join(projectRoot, 'dsh-bundles', 'lobsterai-channels', 'package.json'),
    path.join(projectRoot, 'dsh-bundles', 'lobsterai-channels', 'cordis.patch.yml'),
  ];
  const missingBundles = requiredBundlePaths.filter((candidate) => !existsSync(candidate));
  if (missingBundles.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Required DSH bundles are missing: '
      + missingBundles.join(', '),
    );
  }

  console.log(
    `[electron-builder-hooks] Verified DSH runtime (${buildInfo?.dshVersion || 'unknown'}, target=${buildInfo?.target || targetId || 'host'}) and bundles.`,
  );
}

function applyMacIconFix(appPath) {
  console.log('[electron-builder-hooks] Applying macOS icon fix for Apple Silicon compatibility...');

  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconPath = path.join(resourcesPath, 'icon.icns');

  if (!existsSync(infoPlistPath)) {
    console.warn(`[electron-builder-hooks] Info.plist not found at ${infoPlistPath}`);
    return;
  }

  if (!existsSync(iconPath)) {
    console.warn(`[electron-builder-hooks] icon.icns not found at ${iconPath}`);
    return;
  }

  const checkResult = spawnSync('plutil', [
    '-extract', 'CFBundleIconName', 'raw', infoPlistPath,
  ], { encoding: 'utf-8' });

  if (checkResult.status !== 0) {
    console.log('[electron-builder-hooks] Adding CFBundleIconName to Info.plist...');
    const addResult = spawnSync('plutil', [
      '-insert', 'CFBundleIconName', '-string', 'icon', infoPlistPath,
    ], { encoding: 'utf-8' });

    if (addResult.status === 0) {
      console.log('[electron-builder-hooks] CFBundleIconName added successfully');
    } else {
      console.warn('[electron-builder-hooks] Failed to add CFBundleIconName:', addResult.stderr);
    }
  } else {
    console.log('[electron-builder-hooks] CFBundleIconName already present');
  }

  spawnSync('xattr', ['-cr', appPath], { encoding: 'utf-8' });
  spawnSync('touch', [appPath], { encoding: 'utf-8' });
  spawnSync('touch', [resourcesPath], { encoding: 'utf-8' });

  console.log('[electron-builder-hooks] macOS icon fix applied');
}

/**
 * Remove all node_modules/.bin directories from packaged DSH resource trees.
 *
 * macOS codesign rejects symlinks inside app bundles (even valid relative ones).
 * .bin/ directories contain only CLI wrapper symlinks that are never used at
 * runtime, so removing them entirely is safe and prevents codesign failures.
 */
function removeAllBinDirsInResourceTree(targetDir, label) {
  if (!existsSync(targetDir)) {
    return;
  }

  console.log(`[electron-builder-hooks] Removing node_modules/.bin directories from ${label}...`);

  let removedCount = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name === '.bin' && path.basename(path.dirname(full)) === 'node_modules') {
        rmSync(full, { recursive: true, force: true });
        removedCount++;
        continue;
      }
      walk(full);
    }
  };
  walk(targetDir);

  console.log(`[electron-builder-hooks] Removed ${removedCount} .bin director${removedCount === 1 ? 'y' : 'ies'} from ${label}`);
}

function hasCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function installSkillDependencies() {
  if (!hasCommand('npm')) {
    console.warn('[electron-builder-hooks] npm not found in PATH, skipping skill dependency installation');
    return;
  }

  const skillsDir = path.join(__dirname, '..', 'SKILLs');
  if (!existsSync(skillsDir)) {
    console.log('[electron-builder-hooks] SKILLs directory not found, skipping skill dependency installation');
    return;
  }

  console.log('[electron-builder-hooks] Installing skill dependencies...');

  const entries = readdirSync(skillsDir);
  let installedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);
    const stat = statSync(skillPath);
    if (!stat.isDirectory()) continue;

    const packageJsonPath = path.join(skillPath, 'package.json');
    const nodeModulesPath = path.join(skillPath, 'node_modules');

    if (!existsSync(packageJsonPath)) continue;

    if (existsSync(nodeModulesPath)) {
      console.log(`[electron-builder-hooks]   ${entry}: node_modules exists, skipping`);
      skippedCount++;
      continue;
    }

    console.log(`[electron-builder-hooks]   ${entry}: installing dependencies...`);
    const isWin = process.platform === 'win32';
    const result = spawnSync('npm', ['install'], {
      cwd: skillPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000,
      shell: isWin,
    });

    if (result.status === 0) {
      console.log(`[electron-builder-hooks]   ${entry}: installed`);
      installedCount++;
    } else {
      console.error(`[electron-builder-hooks]   ${entry}: failed`);
      if (result.error) console.error(`[electron-builder-hooks]     Error: ${result.error.message}`);
      if (result.stderr) console.error(`[electron-builder-hooks]     ${result.stderr.substring(0, 200)}`);
      failedCount++;
    }
  }

  console.log(`[electron-builder-hooks] Skill dependencies: ${installedCount} installed, ${skippedCount} skipped, ${failedCount} failed`);
}

function directoryTotalFileBytes(rootDir) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += statSync(fullPath).size;
      } catch {
        // Ignore unreadable entries.
      }
    }
  }
  return total;
}

function verifyPackagedDshRuntimeAsar(resourcesDir, { isWindows = false } = {}) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    throw new Error(`[electron-builder-hooks] Packed archive not found: ${asarPath}`);
  }

  for (const rel of [
    'dsh-runtime/package.json',
    'dsh-runtime/lib/bin.js',
    'dsh-runtime/node_modules/@deepseek-ai/dsh-app-boot/package.json',
  ]) {
    try {
      const stat = asar.statFile(asarPath, rel.split('/').join(path.sep));
      if (!stat || stat.files) {
        throw new Error('not a file');
      }
    } catch (error) {
      throw new Error(
        `[electron-builder-hooks] ${rel} is missing from ${asarPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const requiredDiskPaths = [
    path.join(resourcesDir, 'app.asar.unpacked', 'dsh-runtime', 'package-manager', 'pnpm', 'package.json'),
    path.join(resourcesDir, 'dsh-bundles', 'lobsterai-host', 'package.json'),
    path.join(resourcesDir, 'dsh-bundles', 'lobsterai-channels', 'package.json'),
  ];
  if (isWindows) {
    requiredDiskPaths.push(path.join(resourcesDir, 'SKILLs'));
    requiredDiskPaths.push(path.join(resourcesDir, 'python-win'));
  }

  const missing = requiredDiskPaths.filter((candidate) => !existsSync(candidate));
  if (missing.length > 0) {
    throw new Error(
      `[electron-builder-hooks] Packaged resources are incomplete. Missing: ${missing.join(', ')}`,
    );
  }

  if (isWindows) {
    const hasPythonExe = existsSync(path.join(resourcesDir, 'python-win', 'python.exe'))
      || existsSync(path.join(resourcesDir, 'python-win', 'python3.exe'));
    if (!hasPythonExe) {
      throw new Error(`[electron-builder-hooks] Missing python executable under ${path.join(resourcesDir, 'python-win')}`);
    }
  }

  asar.uncacheAll();
  console.log(`[electron-builder-hooks] Verified app.asar/dsh-runtime, unpacked pnpm, and bundles in ${resourcesDir}`);
}

/**
 * Emit the build-time payload size metadata consumed by scripts/nsis-installer.nsh
 * (via `!include "${PROJECT_DIR}\build-tar\win-installer-payload-size.nsh"`).
 */
function writeWindowsPayloadSizeFragment(context) {
  const toMb = (bytes) => Math.ceil(bytes / (1024 * 1024));
  const buildTarDir = path.join(__dirname, '..', 'build-tar');
  mkdirSync(buildTarDir, { recursive: true });

  const packagedAsarPath = path.join(context.appOutDir, 'resources', 'app.asar');
  if (!existsSync(packagedAsarPath)) {
    throw new Error(
      `[electron-builder-hooks] ${packagedAsarPath} is missing from the packed app; `
      + 'cannot generate NSIS payload size metadata.',
    );
  }
  const asarBytes = statSync(packagedAsarPath).size;

  const unpackedBytes = directoryTotalFileBytes(context.appOutDir);
  if (asarBytes <= 0 || unpackedBytes < asarBytes) {
    throw new Error(
      `[electron-builder-hooks] Implausible payload sizes (asar=${asarBytes} bytes, unpacked=${unpackedBytes} bytes); `
      + 'the app directory must contain at least app.asar.',
    );
  }

  const fragmentPath = path.join(buildTarDir, 'win-installer-payload-size.nsh');
  const fragment = [
    '; Generated by scripts/electron-builder-hooks.cjs (afterPack). Do not edit or commit.',
    '; Consumed by scripts/nsis-installer.nsh for staging preflight and payload validation.',
    `!define LOBSTER_APP_ASAR_BYTES "${asarBytes}"`,
    `!define LOBSTER_PAYLOAD_UNPACKED_MB "${toMb(unpackedBytes)}"`,
    '',
  ].join('\r\n');
  writeFileSync(fragmentPath, fragment);
  console.log(
    '[electron-builder-hooks] Wrote NSIS payload size fragment: '
    + `asar=${asarBytes} bytes (${toMb(asarBytes)} MB), unpacked=${toMb(unpackedBytes)} MB -> ${fragmentPath}`,
  );
}

async function beforePack(context) {
  configureBetterSqlite3Payload(context);
  ensureBundledDshRuntime(context);
  if (isMacTarget(context)) {
    prepareMacSkills(context);
  } else {
    installSkillDependencies();
  }

  if (!isWindowsTarget(context)) {
    return;
  }

  const projectRoot = path.join(__dirname, '..');
  configureWindowsSkillsPayload(context, path.join(projectRoot, 'SKILLs'));

  console.log('[electron-builder-hooks] Windows target detected, ensuring portable Python runtime is prepared...');
  await ensurePortablePythonRuntime({ required: true });
  const pythonRuntimeRoot = path.join(__dirname, '..', 'resources', 'python-win');
  const runtimeHealth = checkRuntimeHealth(pythonRuntimeRoot, { requirePip: true });
  if (!runtimeHealth.ok) {
    throw new Error(
      'Portable Python runtime health check failed before pack. Missing files: '
      + runtimeHealth.missing.join(', '),
    );
  }
}

async function afterPack(context) {
  if (isMacTarget(context)) {
    verifyPackagedMacSkills(context, context.packager.projectDir);
  }

  if (isWindowsTarget(context)) {
    verifyPackagedDshRuntimeAsar(path.join(context.appOutDir, 'resources'), { isWindows: true });
    writeWindowsPayloadSizeFragment(context);
  }

  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      const resourcesDir = path.join(appPath, 'Contents', 'Resources');
      verifyPackagedDshRuntimeAsar(resourcesDir);
      removeAllBinDirsInResourceTree(path.join(resourcesDir, 'app.asar.unpacked'), 'app.asar.unpacked');
      removeAllBinDirsInResourceTree(path.join(resourcesDir, 'dsh-bundles'), 'dsh-bundles');
      applyMacIconFix(appPath);
    } else {
      console.warn(`[electron-builder-hooks] App not found at ${appPath}, skipping macOS post-pack steps`);
    }
  }
}

module.exports = {
  beforePack,
  afterPack,
};
