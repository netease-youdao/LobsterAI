'use strict';

/**
 * Ensure preinstalled OpenClaw plugins are downloaded and placed into the
 * runtime extensions directory.
 *
 * Reads plugin declarations from package.json ("openclaw.plugins") and for
 * each plugin:
 *   1. Checks a local cache in vendor/openclaw-plugins/{id}/
 *   2. Downloads via npm install if not cached at the right version
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

function runNpm(args, opts = {}) {
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    shell: isWin,
    timeout: opts.timeout || 5 * 60 * 1000,
    windowsVerbatimArguments: isWin,
  });

  if (result.error) {
    throw new Error(`npm ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm ${args.join(' ')} exited with code ${result.status}` +
      (stderr ? `\n${stderr}` : '')
    );
  }

  return (result.stdout || '').trim();
}

function copyDirRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Find the installed package directory inside node_modules.
 * Handles scoped packages like @scope/name.
 */
function findInstalledPackageDir(nodeModulesDir, npmSpec) {
  // npm spec might be scoped like "@dingtalk-real-ai/dingtalk-connector"
  const pkgDir = path.join(nodeModulesDir, npmSpec);
  if (fs.existsSync(path.join(pkgDir, 'package.json'))) {
    return pkgDir;
  }

  // Fallback: scan node_modules for a package with an openclaw.plugin.json
  const scanDirs = (dir) => {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      if (entry.startsWith('@')) {
        // Scoped package — look inside
        const result = scanDirs(entryPath);
        if (result) return result;
      } else if (entry !== '.package-lock.json') {
        if (fs.existsSync(path.join(entryPath, 'openclaw.plugin.json'))) {
          return entryPath;
        }
      }
    }
    return null;
  };

  return scanDirs(nodeModulesDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
const runtimeExtensionsDir = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current', 'extensions');

// Verify runtime extensions directory exists
if (!fs.existsSync(runtimeExtensionsDir)) {
  die(
    `Runtime extensions directory does not exist: ${runtimeExtensionsDir}\n` +
    'Build the OpenClaw runtime first (e.g. npm run openclaw:runtime:host).'
  );
}

ensureDir(pluginCacheBase);

log(`Processing ${plugins.length} plugin(s)...`);

for (const plugin of plugins) {
  const { id, npm: npmSpec, version, registry, optional } = plugin;
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
    log(`Downloading ${npmSpec}@${version}...`);

    // Use a temp wrapper package to download the plugin via npm install.
    // This avoids platform-specific tar extraction issues on Windows.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-plugin-${id}-`));

    try {
      // Create a minimal wrapper package.json
      const wrapperPkg = {
        name: `openclaw-plugin-wrapper-${id}`,
        version: '0.0.0',
        private: true,
        dependencies: {
          [npmSpec]: version,
        },
      };
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify(wrapperPkg, null, 2),
        'utf-8'
      );

      // Step 1: Install the plugin package (npm handles download + extraction)
      log('  [1/2] Downloading plugin package...');
      const installArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
      if (registry) {
        installArgs.push(`--registry=${registry}`);
      }
      runNpm(
        installArgs,
        { cwd: tmpDir, stdio: 'inherit' }
      );

      // Step 2: Locate the installed plugin in node_modules
      const nodeModulesDir = path.join(tmpDir, 'node_modules');
      const pluginSrcDir = findInstalledPackageDir(nodeModulesDir, npmSpec);
      if (!pluginSrcDir) {
        throw new Error(
          `Could not find installed plugin package ${npmSpec} in ${nodeModulesDir}`
        );
      }

      log('  [2/2] Installing plugin dependencies...');

      // Install the plugin's own production dependencies inside it
      // so it becomes self-contained
      const pluginPkg = readJsonFile(path.join(pluginSrcDir, 'package.json'));
      const hasDeps = pluginPkg &&
        pluginPkg.dependencies &&
        Object.keys(pluginPkg.dependencies).length > 0;

      if (hasDeps) {
        runNpm(
          ['install', '--omit=dev', '--no-audit', '--no-fund', '--legacy-peer-deps'],
          { cwd: pluginSrcDir, stdio: 'inherit' }
        );
      }

      // Replace cache dir with new content
      if (fs.existsSync(cacheDir)) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
      ensureDir(path.dirname(cacheDir));
      copyDirRecursive(pluginSrcDir, cacheDir);

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
      // Clean up temp directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
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

// --- Post-install patch: openclaw-weixin gatewayMethods ---
// The openclaw-weixin plugin defines loginWithQrStart/loginWithQrWait in its
// gateway adapter but does not declare gatewayMethods on the channel plugin
// object.  Without this declaration, the gateway's resolveWebLoginProvider()
// cannot discover the plugin for web.login.start/web.login.wait RPC calls.
// Patch channel.ts to inject the missing property.
const weixinChannelPath = path.join(runtimeExtensionsDir, 'openclaw-weixin', 'src', 'channel.ts');
if (fs.existsSync(weixinChannelPath)) {
  let src = fs.readFileSync(weixinChannelPath, 'utf8');
  if (!src.includes('gatewayMethods')) {
    // Insert gatewayMethods right after the configSchema block in weixinPlugin
    const marker = 'configSchema: {';
    const idx = src.indexOf(marker);
    if (idx !== -1) {
      src = src.slice(0, idx) + 'gatewayMethods: ["web.login.start", "web.login.wait"],\n  ' + src.slice(idx);
      fs.writeFileSync(weixinChannelPath, src);
      log('Patched openclaw-weixin/src/channel.ts: added gatewayMethods declaration');
    }
  } else {
    log('openclaw-weixin/src/channel.ts already has gatewayMethods, skipping patch');
  }
}
