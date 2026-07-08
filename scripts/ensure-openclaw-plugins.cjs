'use strict';

/**
 * Ensure preinstalled OpenClaw plugins are downloaded and placed into the
 * runtime extensions directory.
 *
 * Uses the OpenClaw CLI (`openclaw plugins install`) to handle downloading,
 * dependency resolution, and proper module setup for each plugin declared in
 * package.json ("openclaw.plugins").
 *
 * Flow per plugin:
 *   1. Checks a local cache in vendor/openclaw-plugins/{id}/
 *   2. Installs via `openclaw plugins install` if not cached at the right version
 *   3. Copies the plugin into vendor/openclaw-runtime/current/extensions/{id}/
 *
 * Environment variables:
 *   OPENCLAW_SKIP_PLUGINS          – Set to "1" to skip this script entirely
 *   OPENCLAW_FORCE_PLUGIN_INSTALL  – Set to "1" to force re-download all plugins
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyOpenClawPluginPatches } = require('./openclaw-plugin-patches/index.cjs');
const {
  BEE_PACKAGE_NAME,
  prepareOpenClawNeteaseBeePackage,
} = require('./openclaw-plugin-preparers/netease-bee.cjs');
const {
  NIM_PLUGIN_PACKAGE_ID,
  prepareOpenClawNimPackage,
} = require('./openclaw-plugin-preparers/nim-channel.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rootDir = path.resolve(__dirname, '..');
function log(msg) {
  console.log(`[openclaw-plugins] ${msg}`);
}

function die(msg) {
  console.error(`[openclaw-plugins] ERROR: ${msg}`);
  process.exit(1);
}

function copyDirRecursive(src, dest) {
  const linkedOpenClawPeer = path.join(src, 'node_modules', 'openclaw');
  const shouldExcludeLinkedPeer =
    fs.existsSync(linkedOpenClawPeer) && fs.lstatSync(linkedOpenClawPeer).isSymbolicLink();

  fs.cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: sourcePath =>
      !shouldExcludeLinkedPeer || path.resolve(sourcePath) !== path.resolve(linkedOpenClawPeer),
  });
}

function isSameOrDescendant(candidatePath, targetPath) {
  const relative = path.relative(path.resolve(targetPath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findContainingNodeModulesDir(packageDir) {
  const parentDir = path.dirname(packageDir);
  if (path.basename(parentDir) === 'node_modules') {
    return parentDir;
  }

  const grandparentDir = path.dirname(parentDir);
  if (path.basename(grandparentDir) === 'node_modules' && path.basename(parentDir).startsWith('@')) {
    return grandparentDir;
  }

  return null;
}

function shouldCopyProjectDependency(sourcePath, installedDir, projectNodeModulesDir) {
  if (isSameOrDescendant(sourcePath, installedDir)) {
    return false;
  }

  const openclawPeer = path.join(projectNodeModulesDir, 'openclaw');
  if (isSameOrDescendant(sourcePath, openclawPeer)) {
    return false;
  }

  return true;
}

function copyInstalledPluginToCache(installedDir, cacheDir) {
  copyDirRecursive(installedDir, cacheDir);

  const projectNodeModulesDir = findContainingNodeModulesDir(installedDir);
  if (!projectNodeModulesDir) {
    return;
  }

  const cacheNodeModulesDir = path.join(cacheDir, 'node_modules');
  fs.cpSync(projectNodeModulesDir, cacheNodeModulesDir, {
    recursive: true,
    force: true,
    filter: sourcePath =>
      shouldCopyProjectDependency(sourcePath, installedDir, projectNodeModulesDir),
  });
}

/**
 * Fix broken symlinks in node_modules/.bin/ directories.
 *
 * npm creates absolute symlinks during `openclaw plugins install` that point
 * into the temporary staging directory.  After copying out of staging those
 * symlinks are broken.  This rewrites each one to a correct relative path
 * based on the symlink target structure (../pkgName/relative/to/bin).
 */
function fixBinSymlinks(baseDir) {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        const binDir = path.dirname(full);
        if (path.basename(binDir) !== '.bin') continue;
        const target = fs.readlinkSync(full);
        if (!path.isAbsolute(target)) continue;
        // Extract the path relative to node_modules/ from the absolute target.
        // e.g. "/tmp/.../extensions/moltbot-popo/node_modules/qrcode/bin/qrcode"
        //   -> "qrcode/bin/qrcode"
        const nmSegment = '/node_modules/';
        const nmIdx = target.lastIndexOf(nmSegment);
        if (nmIdx === -1) continue;
        const relToNm = target.slice(nmIdx + nmSegment.length); // "qrcode/bin/qrcode"
        const newTarget = path.join('..', relToNm);              // "../qrcode/bin/qrcode"
        try {
          fs.unlinkSync(full);
          fs.symlinkSync(newTarget, full);
        } catch {
          // best-effort; signing can still proceed if the symlink is removed
        }
      }
    }
  };
  walk(baseDir);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isLocalPathSpec(spec) {
  if (!spec || typeof spec !== 'string') return false;
  if (spec.startsWith('file:')) return true;
  if (path.isAbsolute(spec)) return true;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  if (spec === '.' || spec === '..') return true;
  // Windows drive letter path, e.g. C:\foo\bar
  if (/^[a-zA-Z]:[\\/]/.test(spec)) return true;
  return false;
}

function isGitSpec(spec) {
  if (!spec || typeof spec !== 'string') return false;
  if (spec.startsWith('git+')) return true;
  if (spec.startsWith('github:')) return true;
  if (/^git@github\.com:/i.test(spec)) return true;
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?(?:#.+)?$/i.test(spec)) return true;
  return false;
}

function resolveGitPackSpec(spec, version) {
  if (!isGitSpec(spec)) {
    return spec;
  }
  if (!version || spec.includes('#')) {
    return spec;
  }
  return `${spec}#${version}`;
}

function parseGitSpec(spec, version) {
  if (!isGitSpec(spec)) {
    return null;
  }

  const resolved = resolveGitPackSpec(spec, version);
  const hashIndex = resolved.lastIndexOf('#');
  const ref = hashIndex >= 0 ? resolved.slice(hashIndex + 1) : null;
  const rawSource = hashIndex >= 0 ? resolved.slice(0, hashIndex) : resolved;

  if (rawSource.startsWith('github:')) {
    return {
      cloneUrl: `https://github.com/${rawSource.slice('github:'.length)}.git`,
      ref,
    };
  }

  if (rawSource.startsWith('git+')) {
    return {
      cloneUrl: rawSource.slice(4),
      ref,
    };
  }

  return {
    cloneUrl: rawSource,
    ref,
  };
}

function isCommitHashRef(ref) {
  return typeof ref === 'string' && /^[0-9a-f]{7,40}$/i.test(ref);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function listDirectPackageDirs(nodeModulesDir) {
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }

  const packageDirs = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const entryPath = path.join(nodeModulesDir, entry.name);
    if (!entry.name.startsWith('@')) {
      packageDirs.push(entryPath);
      continue;
    }

    for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
      if (scopedEntry.isDirectory()) {
        packageDirs.push(path.join(entryPath, scopedEntry.name));
      }
    }
  }

  return packageDirs;
}

function selectInstalledPluginDir(candidateDirs, plugin) {
  const candidates = candidateDirs
    .filter(
      candidateDir =>
        fs.existsSync(path.join(candidateDir, 'openclaw.plugin.json')) ||
        fs.existsSync(path.join(candidateDir, 'package.json')),
    )
    .map(candidateDir => ({
      dir: candidateDir,
      manifest: readJsonFile(path.join(candidateDir, 'openclaw.plugin.json')),
      packageJson: readJsonFile(path.join(candidateDir, 'package.json')),
    }));

  const exactManifestMatch = candidates.find(({ manifest }) => manifest?.id === plugin.id);
  if (exactManifestMatch) return exactManifestMatch.dir;

  const exactPackageMatch = candidates.find(({ packageJson }) => packageJson?.name === plugin.npm);
  if (exactPackageMatch) return exactPackageMatch.dir;

  const pluginCandidates = candidates.filter(({ manifest }) => manifest);
  return pluginCandidates.length === 1 ? pluginCandidates[0].dir : null;
}

function findInstalledPluginDir(stagingDir, plugin) {
  const extensionsDir = path.join(stagingDir, 'extensions');
  const expectedExtensionDir = path.join(extensionsDir, plugin.id);
  if (fs.existsSync(expectedExtensionDir)) {
    return expectedExtensionDir;
  }

  const extensionCandidates = fs.existsSync(extensionsDir)
    ? fs
        .readdirSync(extensionsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(extensionsDir, entry.name))
    : [];
  const extensionMatch = selectInstalledPluginDir(extensionCandidates, plugin);
  if (extensionMatch) return extensionMatch;

  // OpenClaw 2026.6+ installs npm plugins into an isolated npm project and
  // records only the enabled plugin id under OPENCLAW_STATE_DIR.
  const npmProjectsDir = path.join(stagingDir, 'npm', 'projects');
  if (!fs.existsSync(npmProjectsDir)) {
    return null;
  }

  const npmCandidates = fs
    .readdirSync(npmProjectsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => listDirectPackageDirs(path.join(npmProjectsDir, entry.name, 'node_modules')));
  return selectInstalledPluginDir(npmCandidates, plugin);
}

function buildNpmPackEnv() {
  return {
    ...process.env,
    npm_config_prefer_offline: '',
    npm_config_prefer_online: '',
    NPM_CONFIG_PREFER_OFFLINE: '',
    NPM_CONFIG_PREFER_ONLINE: '',
  };
}

function buildGitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Run the OpenClaw CLI with the given arguments.
 *
 * Uses the bundled runtime's openclaw.mjs entry point and sets
 * OPENCLAW_STATE_DIR to control where plugins are installed.
 */
function runOpenClawCli(args, opts = {}) {
  const openclawMjs = path.join(
    rootDir, 'vendor', 'openclaw-runtime', 'current', 'openclaw.mjs'
  );

  if (!fs.existsSync(openclawMjs)) {
    throw new Error(`OpenClaw CLI not found at ${openclawMjs}`);
  }

  const bundledPluginsDir = path.join(path.dirname(openclawMjs), 'dist', 'extensions');
  const env = { ...process.env };
  if (fs.existsSync(bundledPluginsDir) && !env.OPENCLAW_BUNDLED_PLUGINS_DIR) {
    env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
  }

  const result = spawnSync(process.execPath, [openclawMjs, ...args], {
    encoding: 'utf-8',
    stdio: opts.stdio || 'inherit',
    cwd: opts.cwd || rootDir,
    env: { ...env, ...opts.env },
    timeout: opts.timeout || 5 * 60 * 1000,
  });

  if (result.error) {
    throw new Error(`openclaw ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `openclaw ${args.join(' ')} exited with code ${result.status}` +
      (stderr ? `\n${stderr}` : '')
    );
  }

  return (result.stdout || '').trim();
}

/**
 * Run npm to pack a plugin into a .tgz file.
 * Returns the path to the packed .tgz.
 */
function npmPack(packSpec, registry, outputDir) {
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  const args = ['pack', packSpec, '--pack-destination', outputDir];
  if (registry) {
    args.push(`--registry=${registry}`);
  }

  const result = spawnSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: outputDir,
    env: buildNpmPackEnv(),
    shell: isWin,
    timeout: 3 * 60 * 1000,
    windowsVerbatimArguments: isWin,
  });

  if (result.error) {
    throw new Error(`npm pack ${packSpec} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm pack ${packSpec} exited with code ${result.status}` +
      (stderr ? `\n${stderr}` : '')
    );
  }

  // npm pack outputs the filename of the tarball
  const tgzName = (result.stdout || '').trim().split('\n').pop();
  return path.join(outputDir, tgzName);
}

function gitCloneAndPack(spec, version, outputDir) {
  const parsed = parseGitSpec(spec, version);
  if (!parsed) {
    throw new Error(`Unsupported git spec: ${spec}`);
  }

  const sourceDir = path.join(outputDir, 'git-source');
  const gitEnv = buildGitEnv();

  if (parsed.ref && isCommitHashRef(parsed.ref)) {
    fs.mkdirSync(sourceDir, { recursive: true });

    const initResult = spawnSync('git', ['init'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: sourceDir,
      env: gitEnv,
      timeout: 5 * 60 * 1000,
    });
    if (initResult.error) {
      throw new Error(`git init ${sourceDir} failed: ${initResult.error.message}`);
    }
    if (initResult.status !== 0) {
      const stderr = (initResult.stderr || '').trim();
      throw new Error(
        `git init ${sourceDir} exited with code ${initResult.status}` +
        (stderr ? `\n${stderr}` : '')
      );
    }

    const remoteResult = spawnSync('git', ['remote', 'add', 'origin', parsed.cloneUrl], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: sourceDir,
      env: gitEnv,
      timeout: 5 * 60 * 1000,
    });
    if (remoteResult.error) {
      throw new Error(`git remote add origin ${parsed.cloneUrl} failed: ${remoteResult.error.message}`);
    }
    if (remoteResult.status !== 0) {
      const stderr = (remoteResult.stderr || '').trim();
      throw new Error(
        `git remote add origin ${parsed.cloneUrl} exited with code ${remoteResult.status}` +
        (stderr ? `\n${stderr}` : '')
      );
    }

    const fetchResult = spawnSync('git', ['fetch', '--depth', '1', 'origin', parsed.ref], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: sourceDir,
      env: gitEnv,
      timeout: 5 * 60 * 1000,
    });
    if (fetchResult.error) {
      throw new Error(`git fetch ${parsed.cloneUrl} ${parsed.ref} failed: ${fetchResult.error.message}`);
    }
    if (fetchResult.status !== 0) {
      const stderr = (fetchResult.stderr || '').trim();
      throw new Error(
        `git fetch ${parsed.cloneUrl} ${parsed.ref} exited with code ${fetchResult.status}` +
        (stderr ? `\n${stderr}` : '')
      );
    }

    const checkoutResult = spawnSync('git', ['checkout', '--detach', 'FETCH_HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: sourceDir,
      env: gitEnv,
      timeout: 5 * 60 * 1000,
    });
    if (checkoutResult.error) {
      throw new Error(`git checkout FETCH_HEAD failed: ${checkoutResult.error.message}`);
    }
    if (checkoutResult.status !== 0) {
      const stderr = (checkoutResult.stderr || '').trim();
      throw new Error(
        `git checkout FETCH_HEAD exited with code ${checkoutResult.status}` +
        (stderr ? `\n${stderr}` : '')
      );
    }
  } else {
    const cloneArgs = ['clone', '--depth', '1'];
    if (parsed.ref) {
      cloneArgs.push('--branch', parsed.ref);
    }
    cloneArgs.push(parsed.cloneUrl, sourceDir);

    const cloneResult = spawnSync('git', cloneArgs, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: outputDir,
      env: gitEnv,
      timeout: 5 * 60 * 1000,
    });

    if (cloneResult.error) {
      throw new Error(`git clone ${parsed.cloneUrl} failed: ${cloneResult.error.message}`);
    }
    if (cloneResult.status !== 0) {
      const stderr = (cloneResult.stderr || '').trim();
      throw new Error(
        `git clone ${parsed.cloneUrl} exited with code ${cloneResult.status}` +
        (stderr ? `\n${stderr}` : '')
      );
    }
  }

  return npmPack(sourceDir, null, outputDir);
}

function resolvePluginInstallSource(plugin) {
  const { npm: npmSpec, version, registry } = plugin;

  if (registry) {
    return {
      kind: 'packed',
      packSpec: `${npmSpec}@${version}`,
      pinnedDisplaySpec: `${npmSpec}@${version}`,
      registry,
    };
  }

  if (isGitSpec(npmSpec)) {
    return {
      kind: 'git',
      gitSpec: resolveGitPackSpec(npmSpec, version),
      pinnedDisplaySpec: resolveGitPackSpec(npmSpec, version),
    };
  }

  if (isLocalPathSpec(npmSpec)) {
    return {
      kind: 'direct',
      installSpec: npmSpec,
      pinnedDisplaySpec: npmSpec,
    };
  }

  return {
    kind: 'direct',
    installSpec: `${npmSpec}@${version}`,
    pinnedDisplaySpec: `${npmSpec}@${version}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.OPENCLAW_SKIP_PLUGINS === '1') {
    log('Skipped (OPENCLAW_SKIP_PLUGINS=1).');
    process.exit(0);
  }

  // Read plugin declarations from package.json
  const pkg = require(path.join(rootDir, 'package.json'));
  const plugins = (pkg.openclaw && pkg.openclaw.plugins) || [];

  if (!Array.isArray(plugins) || plugins.length === 0) {
    log('No plugins declared in package.json, nothing to do.');
    process.exit(0);
  }

  // Validate plugin declarations
  for (const plugin of plugins) {
    if (!plugin.id || !plugin.npm || !plugin.version) {
      die(
        `Invalid plugin declaration: ${JSON.stringify(plugin)}. ` +
        'Each plugin must have "id", "npm", and "version" fields.'
      );
    }
  }

  const forceInstall = process.env.OPENCLAW_FORCE_PLUGIN_INSTALL === '1';
  const pluginCacheBase = path.join(rootDir, 'vendor', 'openclaw-plugins');
  const runtimeCurrentDir = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');
  // Third-party plugins go into `third-party-extensions/` — a directory the gateway's
  // bundled-channel metadata scan never touches.  When the gateway runs from
  // `gateway-bundle.mjs` (root, not dist/), `RUNNING_FROM_BUILT_ARTIFACT` is false
  // and `resolveBundledPluginScanDir` falls back to `extensions/`.  Placing our
  // plugins there caused them to fail the `bundled-channel-entry` contract check
  // and wasted ~30s on serial load failures.  `third-party-extensions/` is discovered
  // solely via `plugins.load.paths` (origin="config"), bypassing the bundled contract.
  // See openclaw/openclaw#60196.
  const runtimeExtensionsDir = path.join(runtimeCurrentDir, 'third-party-extensions');

  ensureDir(runtimeExtensionsDir);
  ensureDir(pluginCacheBase);

  log(`Processing ${plugins.length} plugin(s)...`);

  for (const plugin of plugins) {
    const { id, npm: npmSpec, version, optional } = plugin;
    const cacheDir = path.join(pluginCacheBase, id);
    const installInfoPath = path.join(cacheDir, 'plugin-install-info.json');
    const targetDir = path.join(runtimeExtensionsDir, id);

    log(`--- Plugin: ${id} (${npmSpec}@${version}) ---`);

    // Check cache
    let needsDownload = true;
    if (!forceInstall && fs.existsSync(installInfoPath)) {
      const info = readJsonFile(installInfoPath);
      if (info && info.version === version && info.npmSpec === npmSpec) {
        log(`Cache hit (version=${version}), skipping download.`);
        needsDownload = false;
      } else {
        log(`Cache version mismatch (cached=${info?.version || 'none'}, wanted=${version}).`);
      }
    }

    if (needsDownload) {
      const source = resolvePluginInstallSource(plugin);
      log(`Installing ${source.pinnedDisplaySpec} via OpenClaw CLI...`);

      // Use a temporary OPENCLAW_STATE_DIR so the CLI installs plugins
      // into a staging directory rather than the user's global config.
      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-plugin-staging-`));

      try {
        let installSpec;

        if (source.kind === 'git') {
          log('  Cloning plugin from Git source before install.');
          installSpec = gitCloneAndPack(npmSpec, version, stagingDir);
        } else if (source.kind === 'packed') {
          if (source.registry) {
            log(`  Packing from custom registry: ${source.registry}`);
          }
          installSpec = npmPack(source.packSpec, source.registry, stagingDir);
        } else {
          installSpec = source.installSpec;
        }

        if (id === BEE_PACKAGE_NAME || npmSpec === BEE_PACKAGE_NAME) {
          log('  Preparing NetEase Bee package for OpenClaw 2026.6 runtime install.');
          if (!fs.existsSync(installSpec) || fs.statSync(installSpec).isDirectory()) {
            installSpec = npmPack(`${BEE_PACKAGE_NAME}@${version}`, plugin.registry, stagingDir);
          }
          installSpec = prepareOpenClawNeteaseBeePackage(installSpec, stagingDir, { log });
        }

        if (id === NIM_PLUGIN_PACKAGE_ID) {
          log('  Preparing NIM package for OpenClaw 2026.6 runtime install.');
          installSpec = prepareOpenClawNimPackage(installSpec, stagingDir, { log });
        }

        runOpenClawCli(
          ['plugins', 'install', installSpec, '--force', '--dangerously-force-unsafe-install'],
          {
            env: {
              OPENCLAW_STATE_DIR: stagingDir,
              // Prevent npm from auto-installing peerDependencies (npm v7+).
              // Channel plugins declare openclaw as a peerDep, but the host
              // gateway already provides the SDK at runtime.  Without this,
              // npm installs the full openclaw SDK + transitive deps (~738 MB)
              // into each plugin's node_modules.
              npm_config_legacy_peer_deps: 'true',
            },
            stdio: 'inherit',
          }
        );

        const installedDir = findInstalledPluginDir(stagingDir, plugin);
        if (!installedDir) {
          throw new Error('No plugin found in staging directory after install');
        }

        // Replace cache dir with new content
        if (fs.existsSync(cacheDir)) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }
        ensureDir(path.dirname(cacheDir));
        copyInstalledPluginToCache(installedDir, cacheDir);
        fixBinSymlinks(cacheDir);

        // Write install info for cache validation
        fs.writeFileSync(
          installInfoPath,
          JSON.stringify(
            {
              pluginId: id,
              npmSpec,
              version,
              installedAt: new Date().toISOString(),
            },
            null,
            2
          ) + '\n',
          'utf-8'
        );

        log(`Downloaded and cached ${id}@${version}.`);
      } catch (err) {
        if (optional) {
          log(`WARNING: Failed to install optional plugin ${id}: ${err.message}`);
          log(`Skipping ${id} — it may not be available from this network.`);
          continue;
        }
        die(`Failed to install plugin ${id}: ${err.message}`);
      } finally {
        // Clean up staging directory
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }

    // Copy from cache to runtime extensions directory
    if (!fs.existsSync(cacheDir)) {
      if (optional) {
        log(`Skipping ${id} — cache not available (optional plugin).`);
        continue;
      }
      die(`Plugin cache directory missing after install: ${cacheDir}`);
    }

    // Remove existing target and copy fresh
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    copyDirRecursive(cacheDir, targetDir);

    // Remove the plugin-install-info.json from the target (it's cache metadata only)
    const targetInfoPath = path.join(targetDir, 'plugin-install-info.json');
    if (fs.existsSync(targetInfoPath)) {
      fs.unlinkSync(targetInfoPath);
    }

    log(`Installed ${id} -> ${path.relative(rootDir, targetDir)}`);
  }

  log(`All ${plugins.length} plugin(s) installed successfully.`);

  applyOpenClawPluginPatches({ runtimeExtensionsDir, log });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildNpmPackEnv,
  buildGitEnv,
  copyDirRecursive,
  copyInstalledPluginToCache,
  findInstalledPluginDir,
  gitCloneAndPack,
  isGitSpec,
  isLocalPathSpec,
  main,
  npmPack,
  parseGitSpec,
  resolveGitPackSpec,
  resolvePluginInstallSource,
};
