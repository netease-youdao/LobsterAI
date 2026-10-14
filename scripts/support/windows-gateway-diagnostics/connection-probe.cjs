'use strict';

// Loopback probe for collect-connection.ps1. LobsterAI.exe runs it with
// ELECTRON_RUN_AS_NODE=1, so its sockets and fetch() go through the same
// executable and Node runtime that the app's main process uses when it polls
// the gateway (fetch http://127.0.0.1:<port>/startupz). The app only logs
// "fetch failed"; this probe records the underlying error code. It contacts
// 127.0.0.1 only and closes every server and child process it starts.
// Usage: LobsterAI.exe connection-probe.cjs <request.json>
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LOOPBACK_HOST = '127.0.0.1';
// The unauthenticated routes the app polls (GATEWAY_PROBE_PATH in openclawEngineManager.ts).
const GATEWAY_PROBE_PATHS = ['/startupz', '/healthz'];
const RESULT_MARKER = 'LOBSTERAI_CONNECTION_PROBE_RESULT ';
const DEFAULT_BUDGET_MS = 75000;
// Windows retries a refused loopback connect for about two seconds, so wait
// longer than the app's 1500 ms to see the real error instead of an abort.
const CONNECT_TIMEOUT_MS = 5000;
const CHILD_READY_TIMEOUT_MS = 15000;
const CHILD_STOP_TIMEOUT_MS = 3000;
const SERVER_CLOSE_TIMEOUT_MS = 2000;
const BODY_PREVIEW_CHARS = 300;
const TCP_ATTEMPTS = 3;
const FETCH_ATTEMPTS = 2;
const MAX_PORTS = 3;
const PROXY_ENV_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'];
const ABORT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);
const STARTUP_RESPONSE = '{"ok":true,"status":"started"}';

// A second LobsterAI.exe process serves this, like the gateway does for the
// main process. It is written to a file so no Windows argument quoting is involved.
const CHILD_SERVER_SOURCE = [
  "'use strict';",
  "const http = require('node:http');",
  "const port = Number(process.env.LOBSTERAI_DIAG_LISTEN_PORT || 0);",
  "const report = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
  'const server = http.createServer((request, response) => {',
  "  response.setHeader('Content-Type', 'application/json');",
  `  response.end('${STARTUP_RESPONSE}');`,
  '});',
  "server.on('error', (error) => { report({ listening: false, code: error.code, message: error.message }); process.exit(0); });",
  "server.listen(port, '127.0.0.1', () => report({ listening: true, port: server.address().port, pid: process.pid }));",
  "process.stdin.on('end', () => process.exit(0));",
  'process.stdin.resume();',
  'setTimeout(() => process.exit(0), 60000);',
  '',
].join('\n');

const startTimer = () => process.hrtime.bigint();
const elapsedMs = (start) => Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;

/** Keeps the fields that identify a network failure, including nested causes. */
function describeError(error, depth = 0) {
  if (error === null || error === undefined) return null;
  if (typeof error !== 'object' && typeof error !== 'function') return { message: String(error) };
  const described = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'address', 'port']) {
    const value = error[key];
    if (value !== undefined && value !== null && typeof value !== 'object' && typeof value !== 'function') described[key] = value;
  }
  if (depth < 3 && Array.isArray(error.errors) && error.errors.length > 0) {
    described.errors = error.errors.slice(0, 4).map((inner) => describeError(inner, depth + 1));
  }
  if (depth < 3 && error.cause !== undefined && error.cause !== null) described.cause = describeError(error.cause, depth + 1);
  return described;
}

function innermostCode(described) {
  if (!described) return null;
  if (ABORT_ERROR_NAMES.has(described.name)) return 'TIMEOUT';
  for (const inner of [described.cause, ...(described.errors || [])]) {
    const code = innermostCode(inner);
    if (code) return code;
  }
  return typeof described.code === 'string' ? described.code : null;
}

/** The most specific code: ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET, TIMEOUT, ... */
function rootCode(described) {
  if (!described) return null;
  return innermostCode(described) || described.name || 'ERROR';
}

function failure(phase, error) {
  const described = describeError(error);
  return { ok: false, phase, code: rootCode(described), error: described };
}

function readStartupStatus(text) {
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload.status === 'string' ? payload.status : null;
  } catch {
    return null;
  }
}

function tcpConnect(port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = startTimer();
    let settled = false;
    let timer = null;
    const socket = net.connect({ host: LOOPBACK_HOST, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, elapsedMs: elapsedMs(start) });
    };
    timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs);
    socket.once('connect', () => finish({ ok: true, code: null, localPort: socket.localPort }));
    socket.once('error', (error) => {
      const described = describeError(error);
      finish({ ok: false, code: rootCode(described), error: described });
    });
  });
}

/** Mirrors fetchWithTimeout() in openclawEngineManager.ts, with a longer timeout. */
async function fetchLikeApp(url, timeoutMs = CONNECT_TIMEOUT_MS) {
  const start = startTimer();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    return {
      ok: true,
      code: null,
      status: response.status,
      payloadStatus: readStartupStatus(text),
      body: text.slice(0, BODY_PREVIEW_CHARS),
      elapsedMs: elapsedMs(start),
    };
  } catch (error) {
    const described = describeError(error);
    return { ok: false, code: rootCode(described), error: described, elapsedMs: elapsedMs(start) };
  } finally {
    clearTimeout(timer);
  }
}

/** Node's own http client, to tell undici-only failures from socket failures. */
function httpGet(url, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = startTimer();
    let settled = false;
    let timer = null;
    let request = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (request) request.destroy();
      resolve({ ...result, elapsedMs: elapsedMs(start) });
    };
    timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT' }), timeoutMs);
    request = http.get(url, { agent: false, headers: { Connection: 'close' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < BODY_PREVIEW_CHARS) body += chunk;
      });
      response.on('end', () => finish({ ok: true, code: null, status: response.statusCode, body: body.slice(0, BODY_PREVIEW_CHARS) }));
      response.on('error', (error) => {
        const described = describeError(error);
        finish({ ok: false, code: rootCode(described), status: response.statusCode, error: described });
      });
    });
    request.on('error', (error) => {
      const described = describeError(error);
      finish({ ok: false, code: rootCode(described), error: described });
    });
  });
}

function tcpEcho(port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = startTimer();
    const payload = 'lobsterai-loopback-check';
    let received = '';
    let connected = false;
    let settled = false;
    let timer = null;
    const socket = net.connect({ host: LOOPBACK_HOST, port });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, elapsedMs: elapsedMs(start) });
    };
    timer = setTimeout(() => finish({ ok: false, code: 'TIMEOUT', phase: connected ? 'exchange' : 'connect' }), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      connected = true;
      socket.write(payload);
    });
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.length >= payload.length) {
        const matched = received === payload;
        finish({ ok: matched, code: matched ? null : 'MISMATCH', phase: 'exchange' });
      }
    });
    socket.once('error', (error) => {
      const described = describeError(error);
      finish({ ok: false, code: rootCode(described), phase: connected ? 'exchange' : 'connect', error: described });
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

/** Loopback inside this process: raw TCP echo and fetch() against a local HTTP server. */
async function inProcessSelfTest() {
  const result = {};
  const echoServer = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  try {
    const port = await listen(echoServer, 0);
    result.tcpEcho = { port, ...(await tcpEcho(port)) };
  } catch (error) {
    result.tcpEcho = failure('listen', error);
  } finally {
    await closeServer(echoServer);
  }
  const httpServer = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(STARTUP_RESPONSE);
  });
  try {
    const port = await listen(httpServer, 0);
    result.fetch = { port, ...(await fetchLikeApp(`http://${LOOPBACK_HOST}:${port}/startupz`)) };
  } catch (error) {
    result.fetch = failure('listen', error);
  } finally {
    await closeServer(httpServer);
  }
  result.ok = Boolean(result.tcpEcho.ok && result.fetch.ok);
  return result;
}

function readChildReady(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish({ listening: false, code: 'TIMEOUT', stderr: stderr.slice(-500) }), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(JSON.parse(stdout.slice(0, newline)));
      } catch {
        finish({ listening: false, code: 'BAD_OUTPUT', output: stdout.slice(0, BODY_PREVIEW_CHARS) });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      const described = describeError(error);
      finish({ listening: false, code: rootCode(described), error: described });
    });
    child.once('exit', (exitCode, signal) => finish({ listening: false, code: 'CHILD_EXITED', exitCode, signal, stderr: stderr.slice(-500) }));
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, CHILD_STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
  });
}

/**
 * Another runtime process listens and this one connects, as the gateway and
 * the main process do. Port 0 picks a free port; a fixed port checks whether
 * that port in particular is blocked or reserved.
 */
async function crossProcessServerTest({ port = 0, workDir, execPath = process.execPath } = {}) {
  const directory = workDir || os.tmpdir();
  fs.mkdirSync(directory, { recursive: true });
  const scriptPath = path.join(directory, `lobsterai-loopback-server-${process.pid}-${port}.cjs`);
  fs.writeFileSync(scriptPath, CHILD_SERVER_SOURCE);
  const result = { requestedPort: port };
  const child = spawn(execPath, [scriptPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LOBSTERAI_DIAG_LISTEN_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  result.childPid = child.pid;
  try {
    result.listen = await readChildReady(child, CHILD_READY_TIMEOUT_MS);
    if (result.listen.listening) {
      result.tcp = await tcpConnect(result.listen.port);
      result.fetch = await fetchLikeApp(`http://${LOOPBACK_HOST}:${result.listen.port}/startupz`);
      result.ok = Boolean(result.tcp.ok && result.fetch.ok && result.fetch.status === 200);
    } else {
      result.ok = false;
    }
  } finally {
    await stopChild(child);
    try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
  }
  return result;
}

function lookupLocalhost() {
  return new Promise((resolve) => {
    dns.lookup('localhost', { all: true }, (error, addresses) => {
      if (error) {
        const described = describeError(error);
        resolve({ ok: false, code: rootCode(described), error: described });
        return;
      }
      resolve({ ok: true, addresses: addresses.map((entry) => entry.address) });
    });
  });
}

function hideUserInfo(value) {
  return value.replace(/\/\/[^/@\s]+@/g, '//<USERINFO>@');
}

/** Values the main process would also see; proxy credentials are removed. */
function proxyEnvironment(env = process.env) {
  const found = {};
  for (const name of PROXY_ENV_NAMES) {
    const upper = env[name];
    const lower = env[name.toLowerCase()];
    if (upper) found[name] = hideUserInfo(upper);
    if (lower && lower !== upper) found[name.toLowerCase()] = hideUserInfo(lower);
  }
  return found;
}

function runtimeInfo(env = process.env) {
  return {
    node: process.versions.node,
    electron: process.versions.electron || null,
    execPath: process.execPath,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    runAsNode: env.ELECTRON_RUN_AS_NODE === '1',
    proxyEnvironment: proxyEnvironment(env),
  };
}

function summarizeGatewayProbe(entry) {
  const tcp = entry.tcp || [];
  const fetches = Object.values(entry.fetch || {}).flat();
  const failures = [...tcp, ...fetches, ...(entry.http ? [entry.http] : [])].filter((attempt) => !attempt.ok && !attempt.skipped);
  const startup = (entry.fetch?.['/startupz'] || []).find((attempt) => attempt.ok);
  let startupStatus = null;
  if (startup) startupStatus = `HTTP ${startup.status}${startup.payloadStatus ? ` ${startup.payloadStatus}` : ''}`;
  return {
    tcpOk: tcp.filter((attempt) => attempt.ok).length,
    tcpTotal: tcp.length,
    fetchOk: fetches.filter((attempt) => attempt.ok).length,
    fetchTotal: fetches.length,
    httpOk: Boolean(entry.http && entry.http.ok),
    errorCodes: [...new Set(failures.map((attempt) => attempt.code).filter(Boolean))],
    startupStatus,
  };
}

async function probeGatewayPort(port, deadline) {
  const entry = { port, tcp: [], fetch: {}, http: null };
  for (let attempt = 0; attempt < TCP_ATTEMPTS && Date.now() < deadline; attempt += 1) {
    entry.tcp.push(await tcpConnect(port));
  }
  for (const probePath of GATEWAY_PROBE_PATHS) {
    entry.fetch[probePath] = [];
    for (let attempt = 0; attempt < FETCH_ATTEMPTS && Date.now() < deadline; attempt += 1) {
      entry.fetch[probePath].push(await fetchLikeApp(`http://${LOOPBACK_HOST}:${port}${probePath}`));
    }
  }
  if (Date.now() < deadline) entry.http = await httpGet(`http://${LOOPBACK_HOST}:${port}${GATEWAY_PROBE_PATHS[0]}`);
  entry.summary = summarizeGatewayProbe(entry);
  return entry;
}

async function guarded(task) {
  try {
    return await task();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function normalizePorts(ports) {
  // Windows PowerShell may serialize a one-element array as a bare number.
  let list = [];
  if (Array.isArray(ports)) list = ports;
  else if (ports !== undefined && ports !== null) list = [ports];
  const valid = list
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return [...new Set(valid)].slice(0, MAX_PORTS);
}

async function runProbe(request = {}) {
  const budgetMs = Number(request.budgetMs) > 0 ? Number(request.budgetMs) : DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const ports = normalizePorts(request.ports);
  const report = {
    toolVersion: 1,
    startedAt: new Date().toISOString(),
    runtime: runtimeInfo(),
    ports,
    allowFixedPortTest: Boolean(request.allowFixedPortTest),
  };
  // The gateway goes first: the app stops it once its own startup wait runs out.
  report.gateway = [];
  for (const port of ports) report.gateway.push(await guarded(() => probeGatewayPort(port, deadline)));
  report.dns = await guarded(() => lookupLocalhost());
  report.selfTest = await guarded(() => inProcessSelfTest());
  report.crossProcess = Date.now() < deadline
    ? await guarded(() => crossProcessServerTest({ port: 0, workDir: request.workDir }))
    : { ok: false, skipped: 'time budget' };
  if (report.allowFixedPortTest) {
    report.fixedPort = [];
    for (const port of ports) {
      report.fixedPort.push(Date.now() < deadline
        ? await guarded(() => crossProcessServerTest({ port, workDir: request.workDir }))
        : { requestedPort: port, ok: false, skipped: 'time budget' });
    }
  } else {
    report.fixedPort = { skipped: 'LobsterAI is running, so its gateway may need these ports' };
  }
  report.finishedAt = new Date().toISOString();
  if (request.reportPath) fs.writeFileSync(request.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function compactSummary(report) {
  return {
    gateway: (report.gateway || []).map((entry) => ({ port: entry.port, ...(entry.summary || {}) })),
    selfTest: Boolean(report.selfTest && report.selfTest.ok),
    crossProcess: Boolean(report.crossProcess && report.crossProcess.ok),
  };
}

module.exports = {
  CHILD_SERVER_SOURCE,
  RESULT_MARKER,
  compactSummary,
  crossProcessServerTest,
  describeError,
  fetchLikeApp,
  httpGet,
  inProcessSelfTest,
  normalizePorts,
  probeGatewayPort,
  proxyEnvironment,
  rootCode,
  runProbe,
  summarizeGatewayProbe,
  tcpConnect,
};

if (require.main === module) {
  let request;
  try {
    request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    process.stderr.write(`Cannot read the probe request: ${error && error.message}\n`);
    process.exit(2);
  }
  runProbe(request).then((report) => {
    // Exit explicitly: idle keep-alive sockets in fetch's pool would hold the process open.
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(compactSummary(report))}\n`, () => process.exit(0));
  }, (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}
