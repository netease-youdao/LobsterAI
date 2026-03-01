'use strict';

const path = require('path');
const { existsSync, readdirSync, statSync } = require('fs');
const { spawnSync } = require('child_process');
const { ensurePortableGit } = require('./setup-mingit.js');
const { ensurePortablePythonRuntime, checkRuntimeHealth } = require('./setup-python-runtime.js');

function isWindowsTarget(context) {
  return context?.electronPlatformName === 'win32';
}

function isMacTarget(context) {
  return context?.electronPlatformName === 'darwin';
}

function findPackagedBash(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'mingit', 'bin', 'bash.exe'),
    path.join(appOutDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findPackagedPythonExecutable(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'python-win', 'python.exe'),
    path.join(appOutDir, 'resources', 'python-win', 'python3.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

  // Check if CFBundleIconName already exists
  const checkResult = spawnSync('plutil', [
    '-extract', 'CFBundleIconName', 'raw', infoPlistPath
  ], { encoding: 'utf-8' });

  if (checkResult.status !== 0) {
    // CFBundleIconName doesn't exist, add it
    console.log('[electron-builder-hooks] Adding CFBundleIconName to Info.plist...');
    const addResult = spawnSync('plutil', [
      '-insert', 'CFBundleIconName', '-string', 'icon', infoPlistPath
    ], { encoding: 'utf-8' });

    if (addResult.status === 0) {
      console.log('[electron-builder-hooks] ✓ CFBundleIconName added successfully');
    } else {
      console.warn('[electron-builder-hooks] Failed to add CFBundleIconName:', addResult.stderr);
    }
  } else {
    console.log('[electron-builder-hooks] ✓ CFBundleIconName already present');
  }

  // Clear extended attributes
  spawnSync('xattr', ['-cr', appPath], { encoding: 'utf-8' });

  // Touch the app to update modification time
  spawnSync('touch', [appPath], { encoding: 'utf-8' });
  spawnSync('touch', [resourcesPath], { encoding: 'utf-8' });

  console.log('[electron-builder-hooks] ✓ macOS icon fix applied');
}

/**
 * Re-download node-nim native binaries for the target platform.
 *
 * node-nim's download-sdk.js has a bug when cross-compiling: it uses
 * `process.platform` (immutable) instead of `npm_config_platform` to decide
 * the arch, so on macOS it always picks "universal" even when targeting win32.
 *
 * To work around this we invoke the script with a small wrapper that patches
 * `process.platform` before the real script runs.
 */
async function rebuildNodeNimForTarget(targetPlatform, targetArch) {
  const nodeNimDir = path.join(__dirname, '..', 'node_modules', 'node-nim');
  const downloadScript = path.join(nodeNimDir, 'script', 'download-sdk.js');

  if (!existsSync(downloadScript)) {
    console.warn('[electron-builder-hooks] node-nim download script not found, skipping native binary rebuild');
    return;
  }

  const releaseDir = path.join(nodeNimDir, 'build', 'Release');
  if (existsSync(releaseDir)) {
    const fs = require('fs');
    const files = fs.readdirSync(releaseDir);
    const hasDylib = files.some(f => f.endsWith('.dylib'));
    const hasDll = files.some(f => f.endsWith('.dll'));

    if (targetPlatform === 'win32' && hasDll && !hasDylib) {
      console.log('[electron-builder-hooks] node-nim already has win32 binaries, skipping re-download');
      return;
    }
    if (targetPlatform === 'darwin' && hasDylib && !hasDll) {
      console.log('[electron-builder-hooks] node-nim already has darwin binaries, skipping re-download');
      return;
    }
  }

  console.log(`[electron-builder-hooks] Re-downloading node-nim binaries for ${targetPlatform}-${targetArch}...`);

  // Workaround for cross-platform builds:
  //
  // node-nim's download-sdk.js has two issues when cross-compiling:
  // 1. It uses `process.platform` (immutable) to decide arch → always 'universal' on macOS
  // 2. The download logic only runs when `require.main === module`
  //
  // Solution: create a wrapper script that:
  // - Overrides process.platform and process.arch BEFORE the module loads
  // - Calls the exported downloadSDK() function directly (bypassing the main guard)
  //
  // We also must ensure the module-level `arch` and `platform` variables pick up
  // the overridden values, which happens because they read process.platform at
  // load time via `const platform = process.env.npm_config_platform || process.platform`.
  const wrapperCode = [
    // Override process.platform and process.arch so module-level const picks them up
    `Object.defineProperty(process, 'platform', { value: '${targetPlatform}', writable: true, configurable: true });`,
    `Object.defineProperty(process, 'arch', { value: '${targetArch}', writable: true, configurable: true });`,
    // Load the module (this evaluates the top-level const arch/platform with our overrides)
    `const sdk = require(${JSON.stringify(downloadScript)});`,
    // Call the exported downloadSDK() function directly
    `sdk.downloadSDK().then(() => {`,
    `  console.log(' ✅ Download completed successfully');`,
    `}).catch((err) => {`,
    `  console.error(' ❌ Download failed:', err.message);`,
    `  process.exit(1);`,
    `});`,
  ].join('\n');

  const result = spawnSync(process.execPath, ['-e', wrapperCode], {
    cwd: nodeNimDir,
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 5 * 60 * 1000, // 5 minute timeout for download
    env: {
      ...process.env,
      npm_config_platform: targetPlatform,
      npm_config_arch: targetArch,
      npm_package_version: require(path.join(nodeNimDir, 'package.json')).version,
    },
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to download node-nim binaries for ${targetPlatform}-${targetArch}. ` +
      `Exit code: ${result.status}. ${result.stderr || ''}`
    );
  }

  // Verify the downloaded binaries are correct
  if (existsSync(releaseDir)) {
    const fs = require('fs');
    const files = fs.readdirSync(releaseDir);
    console.log(`[electron-builder-hooks] node-nim build/Release contents: ${files.join(', ')}`);

    const hasDll = files.some(f => f.endsWith('.dll'));
    const hasNode = files.some(f => f.endsWith('.node'));
    if (targetPlatform === 'win32' && (!hasDll || !hasNode)) {
      throw new Error(
        `node-nim binary download completed but win32 binaries (.dll/.node) not found. ` +
        `Found: ${files.join(', ')}`
      );
    }
  }

  console.log(`[electron-builder-hooks] ✓ node-nim binaries updated for ${targetPlatform}-${targetArch}`);
}

/**
 * Check if a command exists in the system PATH.
 */
function hasCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Install dependencies for all skills in the SKILLs directory.
 * This ensures bundled skills include node_modules for users without npm.
 */
function installSkillDependencies() {
  // Check if npm is available (should be available during build)
  if (!hasCommand('npm')) {
    console.warn('[electron-builder-hooks] npm not found in PATH, skipping skill dependency installation');
    console.warn('[electron-builder-hooks]   (This is only a warning - skills will be installed at runtime if needed)');
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

    if (!existsSync(packageJsonPath)) {
      continue; // No package.json, skip
    }

    if (existsSync(nodeModulesPath)) {
      console.log(`[electron-builder-hooks]   ${entry}: node_modules exists, skipping`);
      skippedCount++;
      continue;
    }

    console.log(`[electron-builder-hooks]   ${entry}: installing dependencies...`);
    const result = spawnSync('npm', ['install'], {
      cwd: skillPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000, // 5 minute timeout
    });

    if (result.status === 0) {
      console.log(`[electron-builder-hooks]   ${entry}: ✓ installed`);
      installedCount++;
    } else {
      console.error(`[electron-builder-hooks]   ${entry}: ✗ failed`);
      if (result.stderr) {
        console.error(`[electron-builder-hooks]     ${result.stderr.substring(0, 200)}`);
      }
      failedCount++;
    }
  }

  console.log(`[electron-builder-hooks] Skill dependencies: ${installedCount} installed, ${skippedCount} skipped, ${failedCount} failed`);
}

async function beforePack(context) {
  // Install skill dependencies first (for all platforms)
  installSkillDependencies();

  if (!isWindowsTarget(context)) {
    return;
  }

  console.log('[electron-builder-hooks] Windows target detected, ensuring PortableGit is prepared...');
  await ensurePortableGit({ required: true });
  console.log('[electron-builder-hooks] Windows target detected, ensuring portable Python runtime is prepared...');
  await ensurePortablePythonRuntime({ required: true });
  const runtimeRoot = path.join(__dirname, '..', 'resources', 'python-win');
  const runtimeHealth = checkRuntimeHealth(runtimeRoot, { requirePip: true });
  if (!runtimeHealth.ok) {
    throw new Error(
      'Portable Python runtime health check failed before pack. Missing files: '
      + runtimeHealth.missing.join(', ')
    );
  }

  // Re-download node-nim native binaries for Windows
  const targetArch = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : 'x64';
  await rebuildNodeNimForTarget('win32', targetArch);
}

/**
 * Check if node-nim binaries match the host platform.
 * Returns true if they need to be restored.
 */
function nodeNimNeedsRestore() {
  const hostPlatform = process.platform; // real platform (not overridden here)
  const releaseDir = path.join(__dirname, '..', 'node_modules', 'node-nim', 'build', 'Release');
  if (!existsSync(releaseDir)) return false;

  const fs = require('fs');
  const files = fs.readdirSync(releaseDir);
  const hasDylib = files.some(f => f.endsWith('.dylib'));
  const hasDll = files.some(f => f.endsWith('.dll'));

  if (hostPlatform === 'darwin' && hasDll && !hasDylib) return true;
  if (hostPlatform === 'win32' && hasDylib && !hasDll) return true;
  return false;
}

/**
 * Restore node-nim binaries to the host (build machine) platform.
 * This is called after cross-platform packaging so that local dev
 * (`npm run electron:dev`) continues to work.
 */
function restoreNodeNimForHost() {
  const hostPlatform = process.platform;
  const hostArch = process.arch;

  if (!nodeNimNeedsRestore()) return;

  console.log(`[electron-builder-hooks] Restoring node-nim binaries for host platform (${hostPlatform}-${hostArch})...`);

  const nodeNimDir = path.join(__dirname, '..', 'node_modules', 'node-nim');
  const downloadScript = path.join(nodeNimDir, 'script', 'download-sdk.js');

  if (!existsSync(downloadScript)) {
    console.warn('[electron-builder-hooks] node-nim download script not found, cannot restore host binaries');
    return;
  }

  // For the host platform, download-sdk.js works correctly without patching
  // because process.platform already matches the host.
  const result = spawnSync(process.execPath, [downloadScript], {
    cwd: nodeNimDir,
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
    env: {
      ...process.env,
      npm_package_version: require(path.join(nodeNimDir, 'package.json')).version,
    },
  });

  if (result.status !== 0) {
    console.error(
      `[electron-builder-hooks] ⚠️ Failed to restore node-nim for ${hostPlatform}-${hostArch}. ` +
      `Run "cd node_modules/node-nim && node script/download-sdk.js" manually to fix.`
    );
  } else {
    console.log(`[electron-builder-hooks] ✓ node-nim binaries restored for ${hostPlatform}-${hostArch}`);
  }
}

async function afterPack(context) {
  if (isWindowsTarget(context)) {
    const bashPath = findPackagedBash(context.appOutDir);
    if (!bashPath) {
      throw new Error(
        'Windows package is missing bundled PortableGit bash.exe. '
        + 'Expected one of: '
        + `${path.join(context.appOutDir, 'resources', 'mingit', 'bin', 'bash.exe')} or `
        + `${path.join(context.appOutDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe')}`
      );
    }

    console.log(`[electron-builder-hooks] Verified bundled PortableGit: ${bashPath}`);

    const pythonExe = findPackagedPythonExecutable(context.appOutDir);
    if (!pythonExe) {
      throw new Error(
        'Windows package is missing bundled python runtime executable. '
        + 'Expected one of: '
        + `${path.join(context.appOutDir, 'resources', 'python-win', 'python.exe')} or `
        + `${path.join(context.appOutDir, 'resources', 'python-win', 'python3.exe')}`
      );
    }
    const packagedRuntimeRoot = path.join(context.appOutDir, 'resources', 'python-win');
    const packagedRuntimeHealth = checkRuntimeHealth(packagedRuntimeRoot, { requirePip: true });
    if (!packagedRuntimeHealth.ok) {
      throw new Error(
        'Windows package bundled python runtime is unhealthy. Missing files: '
        + packagedRuntimeHealth.missing.join(', ')
      );
    }
    console.log(`[electron-builder-hooks] Verified bundled Python runtime: ${pythonExe}`);

    // Restore node-nim to host platform after packaging is done
    // so that local dev (npm run electron:dev) still works
    restoreNodeNimForHost();
  }

  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      applyMacIconFix(appPath);
    } else {
      console.warn(`[electron-builder-hooks] App not found at ${appPath}, skipping icon fix`);
    }
  }
}

module.exports = {
  beforePack,
  afterPack,
};
