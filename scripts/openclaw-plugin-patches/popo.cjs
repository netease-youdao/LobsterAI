'use strict';

const fs = require('fs');
const path = require('path');

const { readJsonFile } = require('./common.cjs');

const POPO_PLUGIN_VERSION = '2.1.13';
const POPO_ASYNC_FABRIC_MARKER = 'lobster_popo_async_fabric_cli';
const POPO_BACKGROUND_PREWARM_MARKER = 'lobster_popo_background_fabric_prewarm';

function assertPopoPluginVersion(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return false;
  }

  const packageJson = readJsonFile(path.join(pluginDir, 'package.json'));
  if (packageJson?.version !== POPO_PLUGIN_VERSION) {
    throw new Error(
      `moltbot-popo Fabric patch expects ${POPO_PLUGIN_VERSION}, found ${packageJson?.version ?? 'unknown'}`,
    );
  }
  return true;
}

function findSingleDistBundle(pluginDir, predicate, description) {
  const distDir = path.join(pluginDir, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error(`moltbot-popo ${description}: dist directory was not found`);
  }

  const matches = fs.readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(distDir, entry.name))
    .filter((filePath) => predicate(fs.readFileSync(filePath, 'utf8')));
  if (matches.length !== 1) {
    throw new Error(
      `moltbot-popo ${description}: expected one matching bundle, found ${matches.length}`,
    );
  }
  return matches[0];
}

function buildAsyncFabricCliImplementation() {
  return `// ${POPO_ASYNC_FABRIC_MARKER}: keep CLI maintenance off the gateway event loop.\nvar _ASYNC_CACHE_KEY = "__popo_fabricCliAsyncPromise__";\nfunction getExecFileAsync() {\n  return getFabricCliTestOverrides()?.execFile ?? _cp2.execFile;\n}\nfunction quoteWindowsCommandArg(value) {\n  return \`"\${String(value).replace(/"/g, '\"\"')}"\`;\n}\nfunction runFabricCommandAsync(command, args, timeoutMs) {\n  const executable = _isWin ? process.env.ComSpec || "cmd.exe" : command;\n  const execArgs = _isWin\n    ? ["/d", "/s", "/c", [command, ...args.map(quoteWindowsCommandArg)].join(" ")]\n    : args;\n  return new Promise((resolve) => {\n    try {\n      getExecFileAsync()(executable, execArgs, {\n        timeout: timeoutMs,\n        windowsHide: true,\n        maxBuffer: 1024 * 1024\n      }, (error) => {\n        resolve({ ok: !error, error });\n      });\n    } catch (error) {\n      resolve({ ok: false, error });\n    }\n  });\n}\nasync function performFabricCliEnsure(channel) {\n  const detected = await runFabricCommandAsync("fabric", ["--help"], 1e4);\n  if (detected.ok) {\n    _cache.available = true;\n    logger.info("[POPO] fabric-cli detected");\n    const args = ["upgrade", "-g"];\n    if (channel) args.push("--channel", channel);\n    const upgraded = await runFabricCommandAsync("fabric", args, INSTALL_TIMEOUT_MS);\n    if (upgraded.ok) {\n      logger.info(\`[POPO] fabric-cli upgrade completed\${channel ? \` (channel=\${channel})\` : ""}\`);\n    } else {\n      logger.warn(\`[POPO] fabric-cli upgrade failed: \${String(upgraded.error)}\`);\n    }\n    _cache.checked = true;\n    return true;\n  }\n\n  logger.info("[POPO] fabric-cli not found, attempting install...");\n  const installed = await runFabricCommandAsync("npm", [\n    "install",\n    "-g",\n    FABRIC_CLI_NPM_PACKAGE,\n    "--registry",\n    FABRIC_CLI_NPM_REGISTRY,\n    "--force"\n  ], INSTALL_TIMEOUT_MS);\n  if (!installed.ok) {\n    _cache.checked = true;\n    _cache.available = false;\n    logger.warn(\`[POPO] fabric-cli install failed: \${String(installed.error)}\`);\n    return false;\n  }\n\n  logger.info("[POPO] fabric-cli installed successfully");\n  const verified = await runFabricCommandAsync("fabric", ["--help"], 1e4);\n  _cache.checked = true;\n  _cache.available = verified.ok;\n  if (_cache.available) {\n    logger.info("[POPO] fabric-cli installed and verified");\n  } else {\n    logger.warn("[POPO] fabric-cli installed but not reachable");\n  }\n  return _cache.available;\n}\nfunction ensureFabricCli(channel) {\n  if (_cache.checked) return Promise.resolve(_cache.available);\n  const existing = _gCache[_ASYNC_CACHE_KEY];\n  if (existing) return existing;\n  const pending = performFabricCliEnsure(channel).catch((error) => {\n    _cache.checked = true;\n    _cache.available = false;\n    logger.warn(\`[POPO] fabric-cli initialization failed: \${String(error)}\`);\n    return false;\n  });\n  _gCache[_ASYNC_CACHE_KEY] = pending;\n  return pending;\n}`;
}

function patchPopoFabricManager(managerPath, log) {
  let src = fs.readFileSync(managerPath, 'utf8');
  const label = `moltbot-popo/dist/${path.basename(managerPath)}`;
  if (!src.includes(POPO_ASYNC_FABRIC_MARKER)) {
    const ensureBlock = /function ensureFabricCli\(channel\) \{[\s\S]*?\n\}\nasync function loadFabricSdk\(\) \{/;
    if (!ensureBlock.test(src)) {
      throw new Error(`${label}: synchronous ensureFabricCli implementation was not found`);
    }
    src = src.replace(
      ensureBlock,
      `${buildAsyncFabricCliImplementation()}\nasync function loadFabricSdk() {`,
    );
  }

  const syncSealCall = '  if (!ensureFabricCli()) {';
  const asyncSealCall = '  if (!await ensureFabricCli()) {';
  if (src.includes(syncSealCall)) {
    src = src.replace(syncSealCall, asyncSealCall);
  } else if (!src.includes(asyncSealCall)) {
    throw new Error(`${label}: sealAgentCtx Fabric availability check was not found`);
  }

  fs.writeFileSync(managerPath, src);
  log(`Patched ${label}: Fabric CLI maintenance now uses asynchronous child processes`);
}

function patchPopoBackgroundPrewarm(startupPath, log) {
  let src = fs.readFileSync(startupPath, 'utf8');
  const label = `moltbot-popo/dist/${path.basename(startupPath)}`;
  if (src.includes(POPO_BACKGROUND_PREWARM_MARKER)) {
    log(`${label} Fabric pre-warm already runs in the background, skipping patch`);
    return;
  }

  const syncPrewarm = /  try \{\r?\n    const fabricCliChannel = popoCfg\?\.fabricCliChannel;\r?\n    ensureFabricCli\(fabricCliChannel\);\r?\n  \} catch \(e\) \{\r?\n    logFn\(`\[POPO\] fabric-cli pre-warm failed: \$\{e\}`\);\r?\n  \}/;
  if (!syncPrewarm.test(src)) {
    throw new Error(`${label}: synchronous Fabric pre-warm block was not found`);
  }
  src = src.replace(
    syncPrewarm,
    `  const fabricCliChannel = popoCfg?.fabricCliChannel;\n  // ${POPO_BACKGROUND_PREWARM_MARKER}: first Fabric-dependent operation awaits the same promise.\n  void ensureFabricCli(fabricCliChannel).catch((e) => {\n    logFn(\`[POPO] fabric-cli pre-warm failed: \${e}\`);\n  });`,
  );
  fs.writeFileSync(startupPath, src);
  log(`Patched ${label}: Fabric CLI pre-warm no longer blocks channel startup`);
}

function patchPopo({ runtimeExtensionsDir, log }) {
  const pluginDir = path.join(runtimeExtensionsDir, 'moltbot-popo');
  if (!assertPopoPluginVersion(pluginDir)) {
    return;
  }

  const managerPath = findSingleDistBundle(
    pluginDir,
    (src) => src.includes('// src/fabric-cli-manager.ts') && src.includes('function ensureFabricCli(channel)'),
    'Fabric manager lookup',
  );
  const startupPath = findSingleDistBundle(
    pluginDir,
    (src) => src.includes('[POPO] fabric-cli pre-warm failed') && src.includes('[POPO] Starting monitor'),
    'channel startup lookup',
  );
  patchPopoFabricManager(managerPath, log);
  patchPopoBackgroundPrewarm(startupPath, log);
}

module.exports = {
  assertPopoPluginVersion,
  findSingleDistBundle,
  patchPopo,
  patchPopoBackgroundPrewarm,
  patchPopoFabricManager,
};
