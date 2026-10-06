'use strict';

// Smoke-test a dsh runtime the same way the app will run it: spawn the CLI
// with Electron as Node (ELECTRON_RUN_AS_NODE=1), boot the web profile, trade
// the launch token it prints for a session cookie, poll until the loopback web
// server serves that session, and optionally assert configured
// providers/models through the unary RPC API.
//
// dsh 0.1.5+ answers 401 to every request without the session cookie, and the
// only way to mint one is the `dsh web: <url>?token=...` line it prints once
// its plugin tree settles (see src/main/libs/dshWebAuth.ts for the app side).
//
//   node scripts/verify-dsh-runtime.cjs [--runtime <dir>] [--dsh-home <dir>]
//        [--expect-provider <routeId>] [--expect-model <modelId>] [--keep-home]
//
// This intentionally goes beyond `--version`: the upstream packed-install gate
// only runs a version probe and skips optional platform packages, which is
// exactly where offline breakage hides (ripgrep/koffi/pty binaries).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { removeTree } = require('./dsh-remove-tree.cjs');

const LOG_TAG = '[verify-dsh-runtime]';
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

function readArgValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

// The launch token is a live credential for the runtime; output only ever
// leaves this script with it masked.
function redactTokens(text) {
  return text.replace(/([?&]token=)[^&#\s()<>"']+/g, '$1<redacted>');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeArg = readArgValue('--runtime');
const runtimeDir = fs.realpathSync(runtimeArg ? path.resolve(runtimeArg) : path.join(rootDir, 'vendor', 'dsh-runtime', 'current'));
const entryPath = path.join(runtimeDir, 'lib', 'bin.js');
if (!fs.existsSync(entryPath)) {
  fail(`Runtime entry not found: ${entryPath}. Run \`npm run dsh:runtime:host\` first.`);
}

// Under plain Node, require('electron') resolves to the bundled binary path.
const electronPath = require('electron');
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  fail('Could not resolve the Electron executable from node_modules.');
}

const dshHomeArg = readArgValue('--dsh-home');
const ownsDshHome = !dshHomeArg;
const dshHome = dshHomeArg ? path.resolve(dshHomeArg) : fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-home-'));
fs.mkdirSync(dshHome, { recursive: true });
const expectProvider = readArgValue('--expect-provider');
const expectModel = readArgValue('--expect-model');
const port = 30800 + Math.floor(Math.random() * 500);
const keepHome = process.argv.includes('--keep-home') || !ownsDshHome;

log(`Runtime: ${runtimeDir}`);
log(`Booting \`web\` on 127.0.0.1:${port} with DSH_HOME=${dshHome}`);

// --expose-internals feeds the Cordis loader's internals requirement the
// official way. The alternative supply (node-addon-require-builtin) loads but
// fails under Electron's Node ("no compatible GetAlignedPointerFromEmbedderData
// symbol"), so the flag is mandatory when running dsh with Electron as Node.
const startedAt = Date.now();
// --no-open: dsh would otherwise hand its URL to the default browser.
const child = spawn(electronPath, ['--expose-internals', entryPath, 'web', '--port', String(port), '--no-open'], {
  cwd: runtimeDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// fail() exits on the spot; never leave a live dsh behind (it would keep its
// port and home busy long after this check reported).
process.once('exit', () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    output += chunk;
    if (output.length > 200_000) output = output.slice(-100_000);
  });
}

// Only a complete stdout line counts: a chunk can end inside the token.
function findLaunchUrl(text) {
  for (const match of text.matchAll(/dsh web: (\S+)[^\n]*\n/g)) {
    try {
      const url = new URL(match[1]);
      if (url.hostname === '127.0.0.1' && url.port === String(port) && url.searchParams.get('token')) return url.href;
    } catch {
      // Not the URL line (the browser-handoff notice shares the prefix).
    }
  }
  return null;
}

let launchUrl = null;
let sessionCookie = null;
let stdoutText = '';
child.stdout.on('data', (chunk) => {
  if (launchUrl) return;
  stdoutText += chunk;
  launchUrl = findLaunchUrl(stdoutText);
  if (launchUrl) stdoutText = '';
  else if (stdoutText.length > 200_000) stdoutText = stdoutText.slice(-100_000);
});

let childExited = false;
let verified = false;
child.on('exit', (code, signal) => {
  childExited = true;
  if (!verified) {
    console.error(redactTokens(output));
    fail(`dsh exited before becoming ready (code=${code}, signal=${signal})`);
  }
});

function cleanupAndExit(code) {
  const finish = () => {
    if (!keepHome) {
      try {
        // Never `fs.rm` a dsh home: it is full of links into the runtime.
        removeTree(dshHome);
      } catch {
        // Best-effort cleanup.
      }
    } else if (ownsDshHome) {
      log(`Keeping DSH_HOME at ${dshHome}`);
    }
    process.exit(code);
  };
  if (childExited) {
    finish();
    return;
  }
  child.once('exit', finish);
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!childExited) child.kill('SIGKILL');
  }, 5_000).unref();
}

// Open the launch URL as a browser would: dsh answers 303 with the session
// cookie. Resolves the Cookie header value, or null until it does.
function exchangeLaunchToken(onDone) {
  const request = http.get(launchUrl, { timeout: 3_000 }, (response) => {
    response.resume();
    const cookie = []
      .concat(response.headers['set-cookie'] || [])
      .map((entry) => entry.split(';', 1)[0].trim())
      .filter((entry) => entry.length > 0)
      .join('; ');
    onDone(response.statusCode === 303 && cookie ? cookie : null);
  });
  request.on('timeout', () => request.destroy(new Error('timeout')));
  request.on('error', () => onDone(null));
}

function fetchIndex(onDone) {
  const request = http.get(
    { host: '127.0.0.1', port, path: '/', timeout: 3_000, headers: { Cookie: sessionCookie } },
    (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 4_096) body += chunk;
      });
      response.on('end', () => onDone(response.statusCode, body));
    }
  );
  request.on('timeout', () => request.destroy(new Error('timeout')));
  request.on('error', () => onDone(0, ''));
}

// Typert Remote endpoint (`<namespace>/<method>`) with its named arguments.
let rpcCounter = 0;
function rpcCall(method, args) {
  rpcCounter += 1;
  const rpcId = `verify-${rpcCounter}`;
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: args ?? {} } });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/${method}`,
        method: 'POST',
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Cookie: sessionCookie,
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`${method} -> HTTP ${response.statusCode}: ${raw.slice(0, 400)}`));
            return;
          }
          try {
            const envelope = JSON.parse(raw);
            if (!envelope.result || envelope.result.ok !== true) {
              reject(new Error(`${method} rejected: ${JSON.stringify(envelope.result ?? envelope).slice(0, 400)}`));
              return;
            }
            resolve(envelope.result.value);
          } catch (error) {
            reject(new Error(`${method} returned invalid JSON: ${error.message}`));
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error(`${method} timed out`)));
    request.on('error', reject);
    request.end(body);
  });
}

// llm/listProviders lists routes with a registered adapter; the session model
// catalog says which of them can serve a request right now and which models
// they offer — together what the workbench's model picker shows.
async function runRpcAssertions() {
  if (!expectProvider && !expectModel) return;
  const catalog = await rpcCall('session/modelCatalog');
  if (expectProvider) {
    const value = await rpcCall('llm/listProviders');
    const providers = Array.isArray(value) ? value : [];
    if (!providers.some((candidate) => candidate && candidate.id === expectProvider)) {
      throw new Error(`Provider ${expectProvider} not registered. Providers: ${providers.map((p) => p.id).join(', ')}`);
    }
    const routable = Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : [];
    if (!routable.includes(expectProvider)) {
      throw new Error(`Provider ${expectProvider} registered but not routable. Routable: ${routable.join(', ')}`);
    }
    log(`Provider ${expectProvider} is registered and routable.`);
  }
  if (expectModel) {
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    const models = groups.flatMap((group) => (Array.isArray(group?.models) ? group.models : []));
    if (!models.some((model) => model && model.id === expectModel)) {
      const failures = Array.isArray(catalog?.failures) ? JSON.stringify(catalog.failures) : '[]';
      throw new Error(`Model ${expectModel} not listed. Models: ${models.map((m) => m.id).join(', ')}; failures: ${failures}`);
    }
    log(`Model ${expectModel} is listed in the live catalog.`);
  }
}

function poll() {
  if (childExited) return;
  if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    console.error(redactTokens(output));
    const detail = launchUrl ? '' : ' (dsh never printed its launch URL)';
    fail(`Web server did not become ready within ${READY_TIMEOUT_MS / 1000}s${detail}`);
  }
  if (!launchUrl) {
    setTimeout(poll, POLL_INTERVAL_MS);
    return;
  }
  exchangeLaunchToken((cookie) => {
    if (!cookie) {
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }
    sessionCookie = cookie;
    fetchIndex((status, body) => {
      if (status === 200) {
        // Confirm the RPC surface answers the same session before asserting
        // anything: the index alone does not prove /api is mounted.
        rpcCall('llm/listProviders')
          .then(() => onServerConfirmed(body))
          .catch(() => setTimeout(poll, POLL_INTERVAL_MS));
      } else {
        setTimeout(poll, POLL_INTERVAL_MS);
      }
    });
  });
}

function onServerConfirmed(body) {
  verified = true;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const looksLikeHtml = /<!doctype html|<html/i.test(body);
  log(`Ready in ${elapsed}s (dsh confirmed, ${looksLikeHtml ? 'HTML page served' : 'non-HTML body'})`);
  if (!looksLikeHtml) {
    console.error(body.slice(0, 500));
    cleanupAndExit(1);
    return;
  }
  runRpcAssertions()
    .then(() => {
      log('Smoke test passed.');
      cleanupAndExit(0);
    })
    .catch((error) => {
      console.error(`${LOG_TAG} RPC assertion failed: ${error.message}`);
      console.error(redactTokens(output.slice(-4_000)));
      cleanupAndExit(1);
    });
}

setTimeout(poll, POLL_INTERVAL_MS);
