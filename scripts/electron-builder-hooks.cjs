'use strict';

const path = require('path');
const { existsSync, readdirSync, statSync, mkdirSync, readFileSync, rmSync, cpSync, lstatSync } = require('fs');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const { ensurePortablePythonRuntime, checkRuntimeHealth } = require('./setup-python-runtime.js');
const { syncLocalOpenClawExtensions } = require('./sync-local-openclaw-extensions.cjs');
const { packMultipleSources } = require('./pack-openclaw-tar.cjs');

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

function resolveOpenClawRuntimeTargetId(context) {
  const platform = context?.electronPlatformName;
  const arch = resolveTargetArch(context);

  if (platform === 'darwin') {
    return arch === 'x64' ? 'mac-x64' : 'mac-arm64';
  }
  if (platform === 'win32') {
    return arch === 'arm64' ? 'win-arm64' : 'win-x64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
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

function getOpenClawRuntimeBuildHint(targetId) {
  if (!targetId) {
    return 'npm run openclaw:runtime:host';
  }
  return `npm run openclaw:runtime:${targetId}`;
}

function syncCurrentOpenClawRuntimeForTarget(context) {
  const runtimeBase = path.join(__dirname, '..', 'vendor', 'openclaw-runtime');
  const currentRoot = path.join(runtimeBase, 'current');
  const targetId = resolveOpenClawRuntimeTargetId(context);

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
    console.log(`[electron-builder-hooks] Synced OpenClaw runtime ${targetId} -> current`);
  }

  return { runtimeRoot: currentRoot, targetId };
}

function verifyPreinstalledPlugins(runtimeRoot, buildHint) {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  let plugins = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    plugins = (pkg.openclaw && pkg.openclaw.plugins) || [];
  } catch {
    return; // Cannot read package.json — skip verification
  }

  if (!Array.isArray(plugins) || plugins.length === 0) {
    return;
  }

  const extensionsDir = path.join(runtimeRoot, 'extensions');
  const missing = [];

  for (const plugin of plugins) {
    if (!plugin.id) continue;
    const pluginDir = path.join(extensionsDir, plugin.id);
    if (!existsSync(pluginDir)) {
      missing.push(plugin.id);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Preinstalled OpenClaw plugins missing from runtime: '
      + missing.join(', ')
      + `. Run \`${buildHint}\` (which includes openclaw:plugins) before packaging.`,
    );
  }

  console.log(`[electron-builder-hooks] Verified ${plugins.length} preinstalled OpenClaw plugin(s).`);
}

function ensureBundledOpenClawRuntime(context) {
  const { runtimeRoot, targetId } = syncCurrentOpenClawRuntimeForTarget(context);
  const buildHint = getOpenClawRuntimeBuildHint(targetId);

  const localMcpBridgeDir = path.join(runtimeRoot, 'extensions', 'mcp-bridge');
  if (!existsSync(localMcpBridgeDir)) {
    syncLocalOpenClawExtensions(runtimeRoot);
  }

  const requiredExternalPaths = [
    path.join(runtimeRoot, 'node_modules'),
  ];
  const missingExternal = requiredExternalPaths.filter((candidate) => !existsSync(candidate));
  if (missingExternal.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Bundled OpenClaw runtime is incomplete. Missing: '
      + missingExternal.join(', ')
      + `. Run \`${buildHint}\` before packaging.`,
    );
  }

  // Verify preinstalled plugins are present in the runtime extensions directory
  verifyPreinstalledPlugins(runtimeRoot, buildHint);

  // Verify gateway-bundle.mjs exists and is reasonably sized.
  // Without it, Windows first-launch falls back to loading ~1100 ESM modules
  // individually, causing 80-100s startup delay.
  const gatewayBundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  if (!existsSync(gatewayBundlePath)) {
    throw new Error(
      '[electron-builder-hooks] gateway-bundle.mjs is missing from '
      + runtimeRoot
      + '. Run `npm run openclaw:bundle` before packaging.',
    );
  }
  const gatewayBundleStat = statSync(gatewayBundlePath);
  if (gatewayBundleStat.size < 1_000_000) {
    throw new Error(
      '[electron-builder-hooks] gateway-bundle.mjs is suspiciously small ('
      + gatewayBundleStat.size
      + ' bytes, expected ~27MB). Rebuild with: `npm run openclaw:bundle`.',
    );
  }

  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
  if (existsSync(gatewayAsarPath)) {
    let entries;
    try {
      // Normalize paths: on Windows, asar.listPackage may return backslash paths
      entries = new Set(asar.listPackage(gatewayAsarPath).map(e => e.replace(/\\/g, '/')));
    } catch (error) {
      throw new Error(
        '[electron-builder-hooks] Failed to read OpenClaw gateway.asar: '
        + `${gatewayAsarPath}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const hasOpenClawEntry = entries.has('/openclaw.mjs');
    const hasControlUiIndex = entries.has('/dist/control-ui/index.html');
    const hasGatewayEntry = entries.has('/dist/entry.js') || entries.has('/dist/entry.mjs');

    if (!hasOpenClawEntry || !hasControlUiIndex || !hasGatewayEntry) {
      throw new Error(
        '[electron-builder-hooks] OpenClaw gateway.asar is incomplete. '
        + `openclaw.mjs=${hasOpenClawEntry}, control-ui=${hasControlUiIndex}, entry=${hasGatewayEntry}.`,
      );
    }

    return;
  }

  const legacyRequiredPaths = [
    path.join(runtimeRoot, 'openclaw.mjs'),
    path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'),
  ];

  const hasLegacyEntry = existsSync(path.join(runtimeRoot, 'dist', 'entry.js'))
    || existsSync(path.join(runtimeRoot, 'dist', 'entry.mjs'));
  if (!hasLegacyEntry) {
    throw new Error(
      '[electron-builder-hooks] Missing OpenClaw runtime entry. '
      + `Expected ${path.join(runtimeRoot, 'dist', 'entry.js')} or ${path.join(runtimeRoot, 'dist', 'entry.mjs')}, `
      + `or ${path.join(runtimeRoot, 'gateway.asar')}.`,
    );
  }

  const missingLegacy = legacyRequiredPaths.filter((candidate) => !existsSync(candidate));
  if (missingLegacy.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Bundled OpenClaw legacy runtime is incomplete. Missing: '
      + missingLegacy.join(', ')
      + `. Run \`${buildHint}\` before packaging.`,
    );
  }
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

function verifyPackagedPortableGitRuntimeDirs(appOutDir) {
  const requiredDirs = [
    path.join(appOutDir, 'resources', 'mingit', 'dev', 'shm'),
    path.join(appOutDir, 'resources', 'mingit', 'dev', 'mqueue'),
  ];
  const createdDirs = [];

  for (const dir of requiredDirs) {
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
  }

  const missingDirs = requiredDirs.filter((dir) => !existsSync(dir));
  if (missingDirs.length > 0) {
    throw new Error(
      'Windows package is missing required PortableGit runtime directories. '
      + `Missing: ${missingDirs.join(', ')}`
    );
  }

  if (createdDirs.length > 0) {
    console.log(
      '[electron-builder-hooks] Created missing PortableGit runtime directories: '
      + createdDirs.join(', ')
    );
  }

  console.log(
    '[electron-builder-hooks] Verified PortableGit runtime directories: '
    + requiredDirs.join(', ')
  );
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
 * Remove broken symlinks from a directory recursively.
 * This fixes macOS code signing failures caused by dangling symlinks in node_modules/.bin
 */
function removeBrokenSymlinks(dir) {
  if (!existsSync(dir)) return 0;

  let removedCount = 0;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    try {
      if (entry.isSymbolicLink()) {
        // Check if symlink target exists
        try {
          statSync(fullPath); // follows symlink
        } catch {
          // Symlink is broken - remove it
          rmSync(fullPath, { force: true });
          removedCount++;
        }
      } else if (entry.isDirectory()) {
        removedCount += removeBrokenSymlinks(fullPath);
      }
    } catch (err) {
      // Skip entries we can't access
    }
  }

  return removedCount;
}

/**
 * Clean up broken symlinks in cfmind/extensions to prevent macOS signing failures.
 */
function cleanupBrokenSymlinksInExtensions(appOutDir) {
  const extensionsDir = path.join(appOutDir, 'Contents', 'Resources', 'cfmind', 'extensions');

  if (!existsSync(extensionsDir)) {
    return;
  }

  console.log('[electron-builder-hooks] Cleaning up broken symlinks in cfmind/extensions...');

  let totalRemoved = 0;
  const extensionEntries = readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of extensionEntries) {
    if (!entry.isDirectory()) continue;

    const nodeModulesBin = path.join(extensionsDir, entry.name, 'node_modules', '.bin');
    if (existsSync(nodeModulesBin)) {
      const removed = removeBrokenSymlinks(nodeModulesBin);
      if (removed > 0) {
        console.log(`[electron-builder-hooks]   ${entry.name}: removed ${removed} broken symlink(s)`);
        totalRemoved += removed;
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(`[electron-builder-hooks] ✓ Removed ${totalRemoved} broken symlink(s) total`);
  } else {
    console.log('[electron-builder-hooks] ✓ No broken symlinks found');
  }
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
    // On Windows, use shell: true so cmd.exe resolves npm.cmd correctly
    const isWin = process.platform === 'win32';
    const result = spawnSync('npm', ['install'], {
      cwd: skillPath,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5 * 60 * 1000, // 5 minute timeout
      shell: isWin,
    });

    if (result.status === 0) {
      console.log(`[electron-builder-hooks]   ${entry}: ✓ installed`);
      installedCount++;
    } else {
      console.error(`[electron-builder-hooks]   ${entry}: ✗ failed`);
      if (result.error) {
        console.error(`[electron-builder-hooks]     Error: ${result.error.message}`);
      }
      if (result.stderr) {
        console.error(`[electron-builder-hooks]     ${result.stderr.substring(0, 200)}`);
      }
      failedCount++;
    }
  }

  console.log(`[electron-builder-hooks] Skill dependencies: ${installedCount} installed, ${skippedCount} skipped, ${failedCount} failed`);
}

async function beforePack(context) {
  ensureBundledOpenClawRuntime(context);
  // Install skill dependencies first (for all platforms)
  installSkillDependencies();

  if (isWindowsTarget(context)) {
    // Pack all large resource directories into a single tar for faster NSIS
    // installation.  NSIS extracts thousands of small files very slowly on NTFS;
    // a single tar archive is extracted by 7z almost instantly, and we unpack
    // it in the NSIS customInstall macro using Electron's Node runtime.
    const buildTarDir = path.join(__dirname, '..', 'build-tar');
    mkdirSync(buildTarDir, { recursive: true });

    const outputTar = path.join(buildTarDir, 'win-resources.tar');
    const sources = [
      {
        label: 'OpenClaw runtime',
        dir: path.join(__dirname, '..', 'vendor', 'openclaw-runtime', 'current'),
        prefix: 'cfmind',
      },
      {
        label: 'SKILLs',
        dir: path.join(__dirname, '..', 'SKILLs'),
        prefix: 'SKILLs',
      },
      {
        label: 'Python runtime',
        dir: path.join(__dirname, '..', 'resources', 'python-win'),
        prefix: 'python-win',
      },
    ];

    console.log(`[electron-builder-hooks] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();

    // Remove old tar if exists
    if (existsSync(outputTar)) rmSync(outputTar);

    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[electron-builder-hooks] Combined tar packed in ${elapsed}s: `
      + `${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`
    );
  }

  if (!isWindowsTarget(context)) {
    return;
  }

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

}

async function afterPack(context) {
  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      // Clean up broken symlinks before signing to prevent ENOENT errors
      cleanupBrokenSymlinksInExtensions(appPath);
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
