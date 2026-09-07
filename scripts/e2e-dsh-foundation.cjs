'use strict';

// End-to-end gate for the dsh feature foundation:
//   compile -> build runtime -> pack archive -> serve it from an opaque URL
//   (the shape a per-file CDN hands out) -> install into a fresh base
//   -> render LobsterAI provider settings -> boot the INSTALLED runtime
//   -> load a profile-local external ESM plugin through the production launcher
//   -> RPC-assert the provider/model are live (the workbench surface)
//   -> boot again through the production launcher and keep that host live
//   -> open the native directory picker and assert the OS dialog really shows
//      (win32 only) -> tear the home down and assert the runtime survived it.
// Every step is a hard assertion; exit 0 means the whole flow works.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[e2e-dsh]';
const rootDir = path.resolve(__dirname, '..');
// The title dsh gives the win32 folder dialog, and our handle on it: the
// worker process owns that window while `IFileOpenDialog::Show` blocks.
const PICKER_DIALOG_TITLE = 'Select Workspace Directory';

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} FAILED: ${message}`);
  process.exit(1);
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

function resolveHostTargetId() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return null;
}

// Minimal OpenAI-compatible chat-completions upstream. It backs the rendered
// provider so the boot below has a reachable endpoint with zero external calls.
function startMockLlmServer(answerText) {
  const server = http.createServer((request, response) => {
    if (!request.url || !request.url.includes('/chat/completions')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      let wantsStream = true;
      try {
        wantsStream = JSON.parse(body).stream !== false;
      } catch {
        // Treat unparseable bodies as streaming requests.
      }
      const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'e2e-model' };
      if (!wantsStream) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: answerText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })
        );
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const frames = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { content: answerText }, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        },
      ];
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Boots through the same launcher used by DshEngineManager and resolves once
// the web server answers; the caller owns the returned child.
function bootDsh(installedRoot, dshHome, extraEnv) {
  const electronPath = require('electron');
  const { spawnDshProcess } = require(path.join(rootDir, 'dist-electron', 'main', 'libs', 'dshProcessLauncher.js'));
  const entry = path.join(installedRoot, 'lib', 'bin.js');
  const port = 31400 + Math.floor(Math.random() * 400);
  const child = spawnDshProcess({
    executablePath: electronPath,
    args: [entry, 'web', '--port', String(port)],
    cwd: installedRoot,
    env: { ...process.env, ...extraEnv, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' },
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      if (output.length > 100_000) output = output.slice(-50_000);
    });
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (child.exitCode !== null) {
        reject(new Error(`dsh exited before ready (code=${child.exitCode})\n${output}`));
        return;
      }
      if (Date.now() - startedAt > 90_000) {
        child.kill('SIGKILL');
        reject(new Error(`dsh not ready in 90s\n${output}`));
        return;
      }
      http
        .get({ host: '127.0.0.1', port, path: '/', timeout: 2_000 }, (response) => {
          response.resume();
          if (response.statusCode === 200) resolve({ child, port, url: `http://127.0.0.1:${port}` });
          else setTimeout(poll, 400);
        })
        .on('error', () => setTimeout(poll, 400));
    };
    setTimeout(poll, 400);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fires a unary RPC without waiting for it: the picker call stays open for as
// long as the operator stares at the dialog, so the test needs the live request
// object to abort it.
function startRpc(port, method, timeoutMs) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `e2e-${method}`, method, payload: {} });
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: `/api/${method}`,
    method: 'POST',
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  const settled = new Promise((resolve) => {
    request.on('response', (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (raw += chunk));
      response.on('end', () => resolve({ kind: 'response', raw }));
    });
    request.on('error', (error) => resolve({ kind: 'error', raw: error.message }));
  });
  request.end(body);
  return { request, settled };
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
  const profileDir = path.join(dshHome, 'profiles', 'web');
  const pluginDir = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-e2e-loader-probe');
  const markerPath = path.join(dshHome, 'e2e-external-plugin-loaded.json');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-web',
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
      `const markerPath = process.env.DSH_E2E_PLUGIN_MARKER;\n` +
      `if (!markerPath) throw new Error('DSH_E2E_PLUGIN_MARKER is required');\n` +
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
async function assertNativeDirectoryPicker(port) {
  const baseline = countPickerDialogs();
  log('   a folder dialog will appear for a few seconds — the test closes it');

  const pick = startRpc(port, 'host.pickDirectory', 60_000);
  let settled = null;
  void pick.settled.then((outcome) => (settled = outcome));

  await delay(4_000);
  if (settled) {
    fail(`host.pickDirectory answered instead of opening a dialog: ${String(settled.raw).slice(0, 400)}`);
  }
  const whileOpen = countPickerDialogs();
  if (whileOpen !== baseline + 1) {
    fail(`expected one "${PICKER_DIALOG_TITLE}" window while the pick is pending, saw ${whileOpen} (baseline ${baseline})`);
  }
  log('   native folder dialog is open on the host display');

  // Dropping the caller closes the dialog: the driver posts WM_CLOSE until the
  // worker unwinds. A dialog left behind would strand a modal window on screen.
  pick.request.destroy();
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
  const targetId = resolveHostTargetId();
  if (!targetId) fail(`Unsupported host platform: ${process.platform}`);

  // [1/8] Fresh compiled modules — installer/client run from dist-electron.
  step('compile electron main', 'npm', ['run', 'compile:electron']);

  // [2/8] Build (idempotent via runtime-build-info cache) and pack when stale.
  step(`build runtime ${targetId}`, process.execPath, [path.join(rootDir, 'scripts', 'build-dsh-runtime.cjs'), targetId]);

  const buildInfo = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'vendor', 'dsh-runtime', targetId, 'runtime-build-info.json'), 'utf8')
  );
  const distDir = path.join(rootDir, 'vendor', 'dsh-dist');
  const manifestName = `dsh-runtime-${buildInfo.dshVersion}-${targetId}.manifest.json`;
  const manifestPath = path.join(distDir, manifestName);
  let needsPack = true;
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      needsPack = manifest.patchHash !== buildInfo.patchHash || manifest.version !== buildInfo.dshVersion;
    } catch {
      needsPack = true;
    }
  }
  if (needsPack) {
    step(`pack runtime ${targetId}`, process.execPath, [path.join(rootDir, 'scripts', 'pack-dsh-runtime.cjs'), targetId]);
  } else {
    log(`>> pack skipped (manifest current: ${manifestName})`);
  }

  // [3/8] Install exactly like a shipped app does: one absolute URL plus the
  // digest the app itself carries, verified before extraction.
  const { installDshRuntime, resolveDshArtifactFromConfig, resolveDshArtifactFromManifest } = require(
    path.join(rootDir, 'dist-electron', 'main', 'libs', 'dshRuntimeInstaller.js')
  );
  const installBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-install-'));

  // Serve the archive from an opaque URL that shares no directory with any
  // manifest — the shape a per-file CDN hands out.
  const localManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const archiveBytes = fs.readFileSync(path.join(distDir, localManifest.archive));
  const cdn = http.createServer((request, response) => {
    if (request.url !== '/d/9f8e7d6c5b4a?sig=xyz') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': archiveBytes.length });
    response.end(archiveBytes);
  });
  await new Promise((resolve) => cdn.listen(0, '127.0.0.1', resolve));
  const cdnUrl = `http://127.0.0.1:${cdn.address().port}/d/9f8e7d6c5b4a?sig=xyz`;
  log(`>> stand-in CDN serving the archive at ${cdnUrl}`);

  const artifact = resolveDshArtifactFromConfig(
    { [targetId]: { url: cdnUrl, sha256: localManifest.sha256, size: localManifest.size } },
    targetId,
    localManifest.version
  );
  if (!artifact) fail('config descriptor did not resolve to an artifact');

  log(`>> install into ${installBase}`);
  const installed = await installDshRuntime({
    artifact,
    baseDir: installBase,
    expectedTarget: targetId,
    onProgress: (progress) => {
      if (progress.stage !== 'download') log(`   install stage: ${progress.stage}`);
    },
  });
  if (installed.alreadyInstalled) fail('fresh install unexpectedly reported alreadyInstalled');
  log(`   installed ${installed.version} from the URL at ${installed.root}`);
  const again = await installDshRuntime({ artifact, baseDir: installBase, expectedTarget: targetId });
  if (!again.alreadyInstalled) fail('second install was not idempotent');
  log('   idempotent re-install OK');

  // A tampered archive must be refused even though the descriptor is intact.
  const tamperedBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-tamper-'));
  let refused = false;
  try {
    await installDshRuntime({
      artifact: { ...artifact, size: artifact.size + 1 },
      baseDir: tamperedBase,
      expectedTarget: targetId,
    });
  } catch {
    refused = true;
  }
  fs.rmSync(tamperedBase, { recursive: true, force: true });
  if (!refused) fail('a size mismatch was not refused');
  log('   integrity check refuses a mismatched archive');
  cdn.close();

  // Keep the manifest path exercised too: it is how dev builds install.
  const fromManifest = resolveDshArtifactFromManifest(distDir, manifestName);
  if (fromManifest.sha256 !== artifact.sha256) fail('manifest and config descriptors disagree');

  // [4/8] Start the mock LLM upstream, then render a LobsterAI provider that
  // points at it — settings.yaml on disk, the API key only in the child env.
  const ANSWER = 'E2E mock upstream answer.';
  const mock = await startMockLlmServer(ANSWER);
  log(`>> mock OpenAI upstream at 127.0.0.1:${mock.port}`);

  const { renderDshManagedSettings, writeDshManagedSettings } = require(
    path.join(rootDir, 'dist-electron', 'main', 'libs', 'dshConfigSync.js')
  );
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-home-'));
  const externalPluginMarker = prepareExternalPluginProfile(dshHome);
  log(`>> external ESM plugin profile prepared: ${E2E_EXTERNAL_PLUGIN_NAME}`);
  const managed = renderDshManagedSettings(
    {
      'E2E Fake': {
        enabled: true,
        apiKey: 'sk-e2e-not-real',
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiFormat: 'openai',
        displayName: 'E2E Fake Gateway',
        models: [{ id: 'e2e-model', name: 'E2E Model', contextWindow: 8192, maxTokens: 1024 }],
      },
    },
    { preferredDefault: { providerId: 'E2E Fake', modelId: 'e2e-model' } }
  );
  const routeIds = Object.keys(managed.routes);
  if (routeIds.length !== 1 || routeIds[0] !== 'lobsterai-e2e-fake') {
    fail(`unexpected rendered routes: ${routeIds.join(', ')} (skipped: ${JSON.stringify(managed.skipped)})`);
  }
  const written = await writeDshManagedSettings(dshHome, managed);
  log(`>> provider settings rendered at ${written.settingsPath}`);

  // [5/8] Boot the installed runtime and assert provider + model over RPC.
  step(
    'boot installed runtime (web smoke + provider RPC assertions)',
    process.execPath,
    [
      path.join(rootDir, 'scripts', 'verify-dsh-runtime.cjs'),
      '--runtime',
      installed.root,
      '--dsh-home',
      dshHome,
      '--expect-provider',
      'lobsterai-e2e-fake',
      '--expect-model',
      'e2e-model',
    ],
    { env: { ...process.env, ...managed.envVars, DSH_E2E_PLUGIN_MARKER: externalPluginMarker } }
  );
  assertExternalPluginMarker(externalPluginMarker, 'runtime smoke launcher');

  // [6/8] Boot again through the production launcher (the verify step owns
  // its own child and exits; the picker step needs a live host). Requiring a
  // fresh marker proves this second child loaded the plugin.
  fs.rmSync(externalPluginMarker, { force: true });
  log('>> boot installed runtime through the production launcher');
  const booted = await bootDsh(installed.root, dshHome, {
    ...managed.envVars,
    DSH_E2E_PLUGIN_MARKER: externalPluginMarker,
  });
  await delay(750);
  if (booted.child.exitCode !== null) {
    fail(`production launcher dsh child exited during readiness settle (code=${booted.child.exitCode})`);
  }
  assertExternalPluginMarker(externalPluginMarker, 'production launcher');
  log(`   dsh live at ${booted.url}`);

  // [7/8] Native workspace picker. Only win32 drives a spawned dialog worker;
  // the mac/linux backends shell out to osascript/zenity, which this step does
  // not cover.
  if (process.platform === 'win32') {
    log('>> native directory picker (win32 folder dialog)');
    // Opening the dialog exercises everything except reading the answer back,
    // and reading it back is what aborted the worker under Electron. Assert
    // that separately: driving a real selection needs a human or a UI robot.
    step(
      'picker reads native paths safely under Electron',
      require('electron'),
      [path.join(rootDir, 'scripts', 'verify-dsh-picker-path-read.cjs'), installed.root],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    );
    await assertNativeDirectoryPicker(booted.port);
  } else {
    log(`>> directory picker step skipped: no spawned-dialog backend on ${process.platform}`);
  }

  // The home teardown below only proves anything on the binary that runs it,
  // and the trap it guards is Electron's: assert it there too, since that is
  // the Node the app tears homes down with.
  step('home teardown is link-safe under Electron', require('electron'), [
    path.join(rootDir, 'scripts', 'verify-dsh-remove-tree.cjs'),
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });

  // [8/8] Cleanup.
  booted.child.kill('SIGTERM');
  await new Promise((resolve) => {
    booted.child.once('exit', resolve);
    setTimeout(() => {
      booted.child.kill('SIGKILL');
      resolve(null);
    }, 5_000).unref();
  });
  mock.server.close();

  // dsh fills the home with links into the runtime (`profiles/**` ->
  // `<runtime>/node_modules/<pkg>`), and on Windows those are junctions that
  // Electron's Node walks straight through when it removes a tree. Tearing the
  // home down must leave the runtime byte-for-byte intact — the alternative is
  // a runtime that still boots with pieces missing, which is exactly how the
  // directory picker's worker went absent.
  const runtimeFilesBefore = countFiles(installed.root);
  removeTree(dshHome);
  const runtimeFilesAfter = countFiles(installed.root);
  if (runtimeFilesAfter !== runtimeFilesBefore) {
    fail(
      `removing the dsh home deleted ${runtimeFilesBefore - runtimeFilesAfter} runtime files ` +
        `(${runtimeFilesBefore} -> ${runtimeFilesAfter}); it followed the profile links into ${installed.root}`
    );
  }
  log(`   home teardown left the runtime intact (${runtimeFilesAfter} files)`);

  removeTree(installBase);
  log('E2E foundation flow passed.');
  process.exit(0);
}

main().catch((error) => {
  fail(error && error.stack ? error.stack : String(error));
});
