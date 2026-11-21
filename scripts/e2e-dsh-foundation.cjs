'use strict';

// Exercise the embedded runtime with Electron's actual profile manager and Typert client.
// --resources <dir> exercises a previously packaged application's Resources directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[e2e-dsh]';
const rootDir = path.resolve(__dirname, '..');
const PICKER_DIALOG_TITLE = 'Select Workspace Directory';

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  throw new Error(message);
}

function electronRuntimeFor(resourcesDir) {
  if (!resourcesDir) return require('electron');
  const { executableName, productName } = require('../electron-builder.json');
  if (process.platform === 'darwin') {
    const helper = productName + ' Helper';
    return path.resolve(resourcesDir, '..', 'Frameworks', helper + '.app', 'Contents', 'MacOS', helper);
  }
  return path.resolve(resourcesDir, '..', executableName + (process.platform === 'win32' ? '.exe' : ''));
}

function step(description, command, args, options = {}) {
  log(`>> ${description}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: rootDir,
    shell: process.platform === 'win32' && command === 'npm',
    ...options,
  });
  if (result.status !== 0) {
    fail(`${description} exited with code ${result.status}`);
  }
}

// How many top-level windows currently carry the dialog's title. The dialog is
// a real OS window owned by a child process, so this is the only way to prove
// from outside that it actually opened.
function countPickerDialogs() {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process | Where-Object { $_.MainWindowTitle -eq '${PICKER_DIALOG_TITLE}' } | Measure-Object).Count`,
    ],
    { encoding: 'utf8' }
  );
  const count = Number(String(result.stdout).trim());
  return Number.isInteger(count) ? count : 0;
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return total;
}

const E2E_EXTERNAL_PLUGIN_NAME = '@dsh-external/dsh-e2e-loader-probe';

// Build the smallest realistic out-of-tree profile plugin: it is ESM, lives
// under the profile's own node_modules, and is enabled from cordis.patch.yml.
// Importing it writes a marker that records the Node switches/environment, so
// a passing HTTP probe cannot hide a loader that skipped the external row.
function prepareExternalPluginProfile(dshHome) {
  const profileDir = path.join(dshHome, 'profiles', 'lobsterai');
  const pluginDir = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-e2e-loader-probe');
  const markerPath = path.join(dshHome, 'e2e-external-plugin-loaded.json');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'lobsterai-dsh-profile',
        private: true,
        dependencies: { [E2E_EXTERNAL_PLUGIN_NAME]: '0.0.0-e2e' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(profileDir, 'cordis.patch.yml'),
    `- insert:\n    - id: dsh-e2e-loader-probe\n      name: '${E2E_EXTERNAL_PLUGIN_NAME}'\n`
  );
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    `${JSON.stringify(
      {
        name: E2E_EXTERNAL_PLUGIN_NAME,
        version: '0.0.0-e2e',
        private: true,
        type: 'module',
        exports: './index.js',
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `import { writeFileSync } from 'node:fs';\n\n` +
      `const markerPath = ${JSON.stringify(markerPath)};\n` +
      `writeFileSync(markerPath, JSON.stringify({\n` +
      `  plugin: '${E2E_EXTERNAL_PLUGIN_NAME}',\n` +
      `  execArgv: process.execArgv,\n` +
      `  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,\n` +
      `}) + '\\n');\n\n` +
      `export function apply() {}\n`
  );
  return markerPath;
}

function assertExternalPluginMarker(markerPath, launcher) {
  if (!fs.existsSync(markerPath)) {
    fail(`${launcher} reached dsh readiness without importing ${E2E_EXTERNAL_PLUGIN_NAME}`);
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    fail(`${launcher} wrote an invalid external-plugin marker: ${error.message}`);
  }
  if (marker.plugin !== E2E_EXTERNAL_PLUGIN_NAME) {
    fail(`${launcher} loaded the wrong external plugin: ${JSON.stringify(marker)}`);
  }
  if (!Array.isArray(marker.execArgv) || !marker.execArgv.includes('--expose-internals')) {
    fail(`${launcher} omitted --expose-internals: ${JSON.stringify(marker.execArgv)}`);
  }
  if (marker.electronRunAsNode !== '1') {
    fail(`${launcher} did not run Electron as Node: ${JSON.stringify(marker.electronRunAsNode)}`);
  }
  log(`   ${launcher} imported external ESM plugin with Electron Node mode`);
}

// The failure this covers: the picker spawns a child process that blocks inside
// the modal `Show`, and any breakage there (a missing worker file, a runtime
// that cannot load koffi, a child that is not run as Node) surfaces as an
// instant "worker exited before reporting a result" instead of a dialog.
async function assertNativeDirectoryPicker(client) {
  const baseline = countPickerDialogs();
  log('   a folder dialog will appear for a few seconds — the test closes it');

  const controller = new AbortController();
  let settled = false;
  void client.call('directoryPicker/pick', {}, controller.signal).then(
    () => { settled = true; }, () => { settled = true; },
  );

  await delay(4_000);
  if (settled) fail('The native directory picker exited before displaying a dialog');
  const whileOpen = countPickerDialogs();
  if (whileOpen !== baseline + 1) {
    fail(`expected one "${PICKER_DIALOG_TITLE}" window while the pick is pending, saw ${whileOpen} (baseline ${baseline})`);
  }
  log('   native folder dialog is open on the host display');

  // Dropping the caller closes the dialog: the driver posts WM_CLOSE until the
  // worker unwinds. A dialog left behind would strand a modal window on screen.
  controller.abort();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(1_000);
    if (countPickerDialogs() === baseline) {
      log('   abort closed the dialog and released the worker');
      return;
    }
  }
  fail('the folder dialog stayed open 10s after the caller aborted');
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length === 0 || (args.length === 2 && args[0] === '--resources'), 'Usage: npm run dsh:e2e -- [--resources <directory>]');
  step('compile desktop modules', 'npm', ['run', 'compile:electron']);
  if (!args.length) step('build and activate the embedded runtime', 'npm', ['run', 'dsh:runtime:host']);
  const { DshHostManager, resolveBundledDshPaths } = require('../dist-electron/main/libs/dsh/dshHostManager.js');
  const { findOrphanedDshRuntimes, isDshWebCommand, parseProcessTable } = require('../dist-electron/main/libs/dshOrphanReaper.js');
  const { DshOpsAction } = require('../dist-electron/shared/dshEngine/hostConstants.js');
  const layout = resolveBundledDshPaths({
    appRootDir: rootDir, isPackaged: Boolean(args.length), resourcesDir: args[1] && path.resolve(args[1]),
  });
  assert(layout.channelsBundleDir, 'Bundled IM service missing');
  assert.equal(require(path.join(layout.runtimeDir, 'package.json')).version, require('../package.json').dsh.version);
  const electron = electronRuntimeFor(args[1]);
  assert(fs.existsSync(electron), 'Electron executable missing from the selected application layout');
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const pnpm = path.join(layout.runtimeDir, 'package-manager', 'pnpm');
  const manifest = require(path.join(pnpm, 'package.json'));
  const pnpmRun = spawnSync(electron, [path.join(pnpm, typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pnpm), '--version'], {
    encoding: 'utf8', env: { ...childEnv, PATH: '' },
  });
  assert.equal(pnpmRun.status, 0, pnpmRun.stderr);
  assert.equal(pnpmRun.stdout.trim(), manifest.version);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-embedded-e2e-'));
  const hosts = [];
  const before = countFiles(layout.runtimeDir);
  try {
    for (const name of ['first', 'second']) {
      const userDataDir = path.join(temp, name);
      const skillsDir = path.join(userDataDir, 'SKILLs');
      fs.mkdirSync(skillsDir, { recursive: true });
      const host = new DshHostManager({ ...layout, userDataDir, skillsDir, executablePath: electron, instanceId: name });
      hosts.push(host);
      const marker = prepareExternalPluginProfile(host.getStatus().dshHomeDir);
      await host.start();
      assertExternalPluginMarker(marker, name);
      const client = host.getClient();
      const health = await client.callOps(DshOpsAction.Health);
      assert.equal(health.ok, true);
      for (const plugin of ['modelBridge', 'personaScope', 'hostTools', 'toolDisclosure', 'approvalGuard', 'opsRpc']) {
        assert.equal(health.pluginsReady?.[plugin], true, plugin);
      }
      const created = await client.createSession({ cwd: userDataDir });
      assert(created.sessionId);
      await client.getSessionProjections(created.sessionId);
      assert(Array.isArray((await client.getModelCatalog()).groups));
      await host.syncSkillsPolicy({ skillsDir, enabledIds: null });
      await host.bindSessionContext({ sessionId: created.sessionId, coworkSessionId: name, agentId: 'main' });
    }
    assert.notEqual(hosts[0].getStatus().pid, hosts[1].getStatus().pid);
    if (process.platform !== 'win32') {
      const pids = hosts.map(host => host.getStatus().pid);
      const table = parseProcessTable(execFileSync('ps', ['-ww', '-o', 'pid=,ppid=,command=', '-p', [process.pid, ...pids].join(',')], { encoding: 'utf8' }));
      for (const pid of pids) {
        const child = table.find(row => row.pid === pid);
        assert(child && child.ppid === process.pid && isDshWebCommand(child.command, electron), 'Missing live Electron child in process table');
      }
      assert.equal(findOrphanedDshRuntimes(table, electron).length, 0, 'An owned embedded host was selected for termination');
    }
    await hosts[1].stop();
    assert.equal((await hosts[0].getClient().callOps(DshOpsAction.Health)).ok, true);
    if (process.platform === 'win32') {
      step('bundled Git with no system Git', process.execPath, [path.join(__dirname, 'verify-dsh-git-install.cjs'), layout.runtimeDir]);
      step('native picker paths', electron, [path.join(__dirname, 'verify-dsh-picker-path-read.cjs'), layout.runtimeDir], { env: childEnv });
      await assertNativeDirectoryPicker(hosts[0].getClient());
    }
  } finally {
    try { await Promise.all(hosts.map(host => host.stop())); } finally { removeTree(temp); }
  }
  assert.equal(countFiles(layout.runtimeDir), before, 'Removing isolated profiles modified the runtime');
  step('link-safe profile cleanup', electron, [path.join(__dirname, 'verify-dsh-remove-tree.cjs')], { env: childEnv });
  log('Embedded Electron hosts, authenticated RPC, profile isolation and cleanup passed.');
}

main().catch(error => {
  console.error(`${LOG_TAG} ${String(error.message).replace(/([?&]token=)[^&\s]+/g, '$1[redacted]')}`);
  process.exitCode = 1;
});
