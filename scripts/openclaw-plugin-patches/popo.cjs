'use strict';

const fs = require('fs');
const path = require('path');

/**
 * moltbot-popo ships a fabric-cli "pre-warm" that runs on the gateway's main
 * thread with SYNCHRONOUS child_process calls:
 *
 *   monitorPopoProvider() -> ensureFabricCli()
 *     -> isFabricCliAvailable()  spawnSync('fabric --help', timeout 10s)
 *     -> installFabricCli()      execFileSync('npm install -g @fabric/cli', timeout 60s)
 *     -> runFabricUpgrade()      spawnSync('fabric upgrade -g',            timeout 60s)
 *
 * On machines where the npm install cannot finish (corp registry + EDR), this
 * freezes the entire gateway event loop for the full 60s right after
 * `[gateway] ready` — no HTTP, no WS, no timers. LobsterAI's gateway handshake
 * gives up at 60s, config delivery degrades to its restart fallback, and the
 * respawned gateway repeats the freeze. Field logs show the gateway reporting
 * `eventLoopUtilization=1` over a 62s window with a 5s startup timer firing at
 * 60583ms.
 *
 * These patches keep the fabric-cli capability but make it never block:
 *   1. drop the startup pre-warm entirely (nothing on the start path);
 *   2. install/upgrade via detached async spawn instead of sync calls;
 *   3. shorten the availability probe;
 *   4. bound INSTALL_TIMEOUT_MS in case a future version adds a sync caller
 *      before the pin is bumped.
 *
 * Remove this file once moltbot-popo ships a release that does the same
 * upstream (async pre-warm + an opt-out config flag).
 */
const PATCH_MARKER = 'popo_fabric_cli_nonblocking_patch';

const SPAWN_HELPER = '_popoSpawnAsync';

function findDistBundles(pluginDir) {
  const distDir = path.join(pluginDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return [];
  }
  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(distDir, entry.name));
}

/** Remove the synchronous fabric-cli pre-warm from the POPO provider start path. */
function patchStartupPrewarm(bundlePath, label, log) {
  let src = fs.readFileSync(bundlePath, 'utf8');
  if (src.includes(`${PATCH_MARKER}_prewarm`)) {
    log(`${label} fabric-cli pre-warm patch already applied, skipping`);
    return true;
  }
  if (!src.includes('ensureFabricCli(fabricCliChannel);')) {
    return false;
  }

  src = src.replace(
    'ensureFabricCli(fabricCliChannel);',
    `/* ${PATCH_MARKER}_prewarm */ void fabricCliChannel;`
  );
  fs.writeFileSync(bundlePath, src);
  log(`Patched ${label}: removed synchronous fabric-cli pre-warm from POPO startup`);
  return true;
}

/**
 * Declare an async spawn next to the plugin's existing sync child_process
 * handles. The module variable name is captured from the bundle so the patch
 * survives esbuild renaming it across plugin versions.
 */
function injectSpawnHelper(src, log, label) {
  if (src.includes(`var ${SPAWN_HELPER} =`)) {
    return src;
  }
  const declPattern = /var\s+\w+\s*=\s*(\w+)\[_execFileSyncName\];/;
  const match = src.match(declPattern);
  if (!match) {
    log(`${label}: child_process handle declaration not found, cannot inject async spawn`);
    return null;
  }
  return src.replace(
    match[0],
    `${match[0]}\nvar ${SPAWN_HELPER} = ${match[1]}["spawn"];`
  );
}

/** Swap the sync install/upgrade calls for detached, non-blocking spawns. */
function patchFabricCliBackgrounding(bundlePath, label, log) {
  let src = fs.readFileSync(bundlePath, 'utf8');
  if (!src.includes('function installFabricCli()')) {
    return false;
  }
  if (src.includes(`${PATCH_MARKER}_background`)) {
    log(`${label} fabric-cli backgrounding patch already applied, skipping`);
    return true;
  }

  const withHelper = injectSpawnHelper(src, log, label);
  if (!withHelper) {
    return true;
  }
  src = withHelper;

  const spawnDetached = (bin, argsExpr, startedLog, failedLog) => `  try {
    const child = ${SPAWN_HELPER}(${bin}, ${argsExpr}, {
      stdio: "ignore",
      shell: _isWin,
      detached: !_isWin,
      windowsHide: true
    });
    child?.on?.("error", () => {});
    child?.unref?.();
    ${startedLog}
  } catch (e) {
    ${failedLog}
  }`;

  const upgradeReplacement = `function runFabricUpgrade(channel) {
  /* ${PATCH_MARKER}_background: detached spawn — never block the gateway event loop */
  const args = ["upgrade", "-g"];
  if (channel) args.push("--channel", channel);
${spawnDetached(
    '"fabric"',
    'args',
    'logger.info(`[POPO] fabric-cli upgrade started in background${channel ? ` (channel=${channel})` : ""}`);',
    'logger.warn(`[POPO] fabric-cli upgrade failed to start: ${e}`);'
  )}
}
`;

  const installReplacement = `function installFabricCli() {
  /* ${PATCH_MARKER}_background: detached spawn — never block the gateway event loop */
${spawnDetached(
    '"npm"',
    '[\n      "install",\n      "-g",\n      FABRIC_CLI_NPM_PACKAGE,\n      "--registry",\n      FABRIC_CLI_NPM_REGISTRY,\n      "--force"\n    ]',
    'logger.info("[POPO] fabric-cli install started in background; fabric tools stay unavailable until a later gateway start");',
    'logger.warn(`[POPO] fabric-cli background install failed to start: ${e}`);'
  )}
  // The install runs detached, so it is never ready within this process.
  return false;
}
`;

  const upgradePattern = /function runFabricUpgrade\(channel\) \{[\s\S]*?\r?\n\}\r?\n(?=function installFabricCli)/;
  const installPattern = /function installFabricCli\(\) \{[\s\S]*?\r?\n\}\r?\n(?=function ensureFabricCli)/;

  if (!upgradePattern.test(src) || !installPattern.test(src)) {
    log(`${label}: fabric-cli install/upgrade shape not recognised, skipping backgrounding patch`);
    return true;
  }

  src = src.replace(upgradePattern, upgradeReplacement);
  src = src.replace(installPattern, installReplacement);
  // The caller's failure log now describes a dispatch, not a failed install.
  src = src.replace(
    'logger.warn("[POPO] fabric-cli unavailable \\u2014 install failed");',
    'logger.warn("[POPO] fabric-cli unavailable this run; a background install was dispatched");'
  );
  fs.writeFileSync(bundlePath, src);
  log(`Patched ${label}: fabric-cli install/upgrade now run detached instead of blocking the event loop`);
  return true;
}

/** Bound the remaining sync probe and the shared timeout constant. */
function patchFabricCliTimeouts(bundlePath, label, log) {
  let src = fs.readFileSync(bundlePath, 'utf8');
  if (!src.includes('function isFabricCliAvailable()')) {
    return false;
  }
  if (src.includes(`${PATCH_MARKER}_timeouts`)) {
    log(`${label} fabric-cli timeout patch already applied, skipping`);
    return true;
  }

  const probePattern = /(function isFabricCliAvailable\(\) \{[\s\S]*?)timeout: 1e4/;
  const installTimeoutPattern = /var INSTALL_TIMEOUT_MS = 6e4;/;
  if (!probePattern.test(src) || !installTimeoutPattern.test(src)) {
    log(`${label}: fabric-cli timeout constants not found, skipping timeout patch`);
    return true;
  }

  src = src.replace(probePattern, `$1/* ${PATCH_MARKER}_timeouts */ timeout: 5e3`);
  src = src.replace(installTimeoutPattern, 'var INSTALL_TIMEOUT_MS = 8e3;');
  fs.writeFileSync(bundlePath, src);
  log(`Patched ${label}: fabric-cli probe timeout 10s->5s, install timeout ceiling 60s->8s`);
  return true;
}

function patchPopo({ runtimeExtensionsDir, log }) {
  const pluginDir = path.join(runtimeExtensionsDir, 'moltbot-popo');
  if (!fs.existsSync(pluginDir)) {
    log('moltbot-popo not installed, skipping fabric-cli patches');
    return;
  }

  const bundles = findDistBundles(pluginDir);
  const applied = { prewarm: false, background: false, timeouts: false };
  for (const bundlePath of bundles) {
    const label = `moltbot-popo/dist/${path.basename(bundlePath)}`;
    applied.prewarm = patchStartupPrewarm(bundlePath, label, log) || applied.prewarm;
    applied.background = patchFabricCliBackgrounding(bundlePath, label, log) || applied.background;
    applied.timeouts = patchFabricCliTimeouts(bundlePath, label, log) || applied.timeouts;
  }

  for (const [name, ok] of Object.entries(applied)) {
    if (!ok) {
      log(`moltbot-popo: fabric-cli ${name} anchor not found in any dist bundle — verify the plugin version`);
    }
  }
}

module.exports = {
  findDistBundles,
  patchPopo,
};
