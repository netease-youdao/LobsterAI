#!/usr/bin/env node
'use strict';

// Isolated, repeatable OpenClaw gateway startup benchmark (macOS).
//
// Each runtime under test starts from a clone of the user's real OpenClaw
// state, so plugins, channels, MCP servers, agents and migrations match what
// the app sees, but the gateway is jailed with sandbox-exec:
//   - outbound network is denied except loopback, so IM channels, model
//     providers, remote MCP servers and git sync cannot reach anything;
//   - writes under $HOME are denied, so the real state, logs and projects
//     cannot change (the clone lives in the temp directory).
// Credentials are never read: ${VAR} placeholders get dummy values.
//
//   node scripts/bench-openclaw-startup.cjs \
//     --runtime base=/Applications/LobsterAI.app/Contents/Resources/cfmind \
//     --runtime dev=vendor/openclaw-runtime/current --runs 5
//
// Run 1 of each runtime is the first start on the cloned state (startup
// migrations included); runs 2..N are warm restarts. Exit code 1 means a run
// failed, a health check failed, or runtimes disagree on loaded plugins or
// channel/MCP state, so the script can gate an optimization.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { parseArgs } = require('node:util');

const {
  STARTUP_PHASES,
  compareStartupCheckpoints,
  computeStartupPhases,
  matchGatewayMilestones,
  median,
  parseLoadedPlugins,
  stripAnsi,
  summarizeCpuProfile,
} = require('./openclaw-startup-timeline.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.join(os.homedir(), 'Library', 'Application Support', 'LobsterAI', 'openclaw');
const DEV_ELECTRON_HELPER = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app',
  'Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper');
// Matches src/main/libs/openclawGatewayProcess.ts: the app kills a gateway after this.
const APP_SHUTDOWN_GRACE_MS = 6000;
const BENCH_KILL_AFTER_MS = 20_000;
const PROBE_INTERVAL_MS = 100;
const PLACEHOLDER_SECRET = 'lobster-bench-placeholder';
const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
// Gateway RPCs run after the last start of each runtime; their summaries are compared across runtimes.
const HEALTH_CALLS = [
  { method: 'health', params: {} },
  { method: 'channels.status', params: {} },
  // A multi-agent config needs an explicit owner; the catalog includes MCP and plugin tools.
  { method: 'tools.catalog', params: { agentId: 'main' } },
  { method: 'skills.status', params: {} },
  { method: 'cron.status', params: {} },
];
const RAW_HEALTH_LIMIT = 20_000;
const ERROR_LINE_RE = /\[error\]|\b(error|failed|exception|unhandled)\b/i;
// A blocked filesystem write, as opposed to a blocked connect.
const BLOCKED_WRITE_RE = /(EPERM|EACCES|Operation not permitted).*\b(open|mkdir|rename|unlink|write|copyfile|symlink|chmod|utime|rmdir|scandir)\b/i;

function fail(message) {
  console.error(`[bench] ${message}`);
  process.exit(2);
}

function parseRuntimeSpecs(specs) {
  const list = specs.length > 0 ? specs : [`dev=${path.join(REPO_ROOT, 'vendor', 'openclaw-runtime', 'current')}`];
  return list.map((spec, index) => {
    const eq = spec.indexOf('=');
    const label = eq > 0 ? spec.slice(0, eq) : `runtime${index + 1}`;
    const root = fs.realpathSync(path.resolve(eq > 0 ? spec.slice(eq + 1) : spec));
    if (!fs.existsSync(path.join(root, 'openclaw.mjs'))) fail(`${root} has no openclaw.mjs`);
    return { label, root };
  });
}

/** The Electron helper the app would use for this runtime: the packaged app's own, or the dev one. */
function resolveElectronHelper(runtimeRoot, override) {
  if (override) return override;
  const appMatch = /^(.*?\.app)\/Contents\/Resources\//.exec(`${runtimeRoot}/`);
  if (appMatch) {
    const frameworks = path.join(appMatch[1], 'Contents', 'Frameworks');
    const helper = fs.readdirSync(frameworks).find(name => / Helper\.app$/.test(name));
    if (helper) return path.join(frameworks, helper, 'Contents', 'MacOS', helper.replace(/\.app$/, ''));
  }
  return DEV_ELECTRON_HELPER;
}

function findLiveLobsterGateways() {
  const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  return (ps.stdout || '').split('\n')
    // A running gateway retitles itself `openclaw-gateway`.
    .filter(line => /openclaw\.mjs gateway|gateway-launcher\.cjs gateway|^\s*\d+ openclaw-gateway\b/.test(line)
      && !line.includes('lobster-bench'))
    .map(line => line.trim().split(/\s+/)[0]);
}

/**
 * Files under the real state changed since `sinceMs`. The jail should make
 * this empty; a hit means a write escaped (or LobsterAI itself was running).
 */
function listRealStateChanges(source, sinceMs, limit = 20) {
  const changed = [];
  const stack = [source];
  while (stack.length && changed.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.mtimeMs > sinceMs || stat.ctimeMs > sinceMs) changed.push(full);
      if (entry.isDirectory()) stack.push(full);
      if (changed.length >= limit) break;
    }
  }
  return changed;
}

function cloneState(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // APFS clonefile: a 1.5 GB state copies in about a second and shares blocks.
  const result = spawnSync('cp', ['-c', '-R', source, target], { encoding: 'utf8' });
  if (result.status !== 0) fail(`cloning ${source} failed: ${result.stderr}`);
}

/**
 * A clone taken while LobsterAI runs carries that gateway's lock files, whose
 * pid is alive, so the cloned gateway would refuse its startup migrations as
 * if another gateway owned the state. The clone is ours alone.
 */
function clearClonedGatewayLocks(sandboxBase) {
  const tmpDir = path.join(sandboxBase, 'state', 'tmp');
  if (!fs.existsSync(tmpDir)) return 0;
  let removed = 0;
  for (const owner of fs.readdirSync(tmpDir).filter(name => name.startsWith('openclaw'))) {
    for (const name of fs.readdirSync(path.join(tmpDir, owner)).filter(n => /^gateway\..*\.lock$/.test(n))) {
      fs.rmSync(path.join(tmpDir, owner, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

function jsonPathFragment(value) {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Points the cloned config at the clone and at the runtime under test, keeping
 * everything else identical. Returns the ${VAR} names the config expects.
 */
function rewriteClonedConfig({ sourceBase, sandboxBase, runtimeRoot, logFile }) {
  const configPath = path.join(sandboxBase, 'state', 'openclaw.json');
  const original = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(original.split(jsonPathFragment(sourceBase)).join(jsonPathFragment(sandboxBase)));
  const userThirdParty = path.join(path.dirname(sourceBase), 'third-party-extensions');
  const loadPaths = config.plugins?.load?.paths;
  if (Array.isArray(loadPaths)) {
    // The bundled third-party extensions belong to the runtime; user-installed ones stay shared.
    config.plugins.load.paths = loadPaths.map(p => (p.endsWith(`${path.sep}third-party-extensions`) && p !== userThirdParty
      ? path.join(runtimeRoot, 'third-party-extensions')
      : p));
  }
  config.logging = { ...config.logging, file: logFile };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return [...new Set([...original.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map(m => m[1]))];
}

/**
 * There is deliberately no way to allow the network: the clone holds real
 * channel tokens (e.g. Weixin), so an unjailed gateway would poll the user's
 * IM accounts and could answer their messages.
 */
function buildSandboxProfile({ sandboxRoot }) {
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-write* (subpath ${JSON.stringify(fs.realpathSync(os.homedir()))}))`,
    `(allow file-write* (subpath ${JSON.stringify(sandboxRoot)}))`,
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ].join('\n');
}

function buildGatewayEnv({ sandboxBase, sandboxRoot, runtimeRoot, entry, helper, port, token, secretNames }) {
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  const stateDir = path.join(sandboxBase, 'state');
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    SKILLS_ROOT: path.join(path.dirname(DEFAULT_SOURCE), 'SKILLs'),
    LOBSTERAI_SKILLS_ROOT: path.join(path.dirname(DEFAULT_SOURCE), 'SKILLs'),
    OPENCLAW_HOME: sandboxBase,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
    LOBSTERAI_MANAGED_WORKSPACE_ROOT: stateDir,
    CODEX_HOME: path.join(sandboxRoot, 'codex'),
    // SQLite snapshot staging otherwise lands in ~/Library/Caches/openclaw, which the jail denies.
    XDG_CACHE_HOME: path.join(sandboxRoot, 'cache'),
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeRoot, 'dist', 'extensions'),
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_LOG_LEVEL: 'debug',
    // Same as buildOpenClawCompileCacheEnv in openclawEngineManager.ts: no launcher respawn.
    NODE_COMPILE_CACHE: path.join(stateDir, '.compile-cache'),
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: '1',
    LOBSTERAI_ELECTRON_PATH: helper,
    LOBSTERAI_OPENCLAW_ENTRY: entry,
    TZ: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  for (const name of secretNames) env[name] = PLACEHOLDER_SECRET;
  env.OPENCLAW_GATEWAY_TOKEN = token;
  return env;
}

// OpenClaw v2026.8.1 src/infra/startup-migration-checkpoint.ts meta keys. State migrations
// (including a full integrity_check of every agent database) rerun only when both miss.
const CHECKPOINT_META_KEYS = { startup: 'startup-migrations', state: 'state-migrations' };

/** OpenClaw's migration checkpoint rows, read with the system sqlite3 (read-only). */
function readStartupCheckpoints(sandboxBase) {
  const db = path.join(sandboxBase, 'state', 'state', 'openclaw.sqlite');
  const rows = {};
  if (!fs.existsSync(db)) return rows;
  const result = spawnSync('sqlite3', ['-readonly', '-json', db,
    'SELECT meta_key AS key, app_version AS value, updated_at AS updatedAt FROM schema_meta'], { encoding: 'utf8' });
  try {
    for (const row of JSON.parse(result.stdout || '[]')) rows[row.key] = row;
  } catch {
    // Diagnostics only.
  }
  return rows;
}

// openclaw-agent-db-integrity-stamp.patch: <db>.integrity-stamp.json binds a
// verified clean close to the file's identity.
const INTEGRITY_STAMP_SUFFIX = '.integrity-stamp.json';

/**
 * The re-clone below changes inode and times but not one byte, and a reboot
 * changes neither: point the stamp at the clone so the run models a reboot,
 * not a replaced file (which must, and does, force a rescan).
 */
function rebindIntegrityStamp(dbPath) {
  const stampPath = `${dbPath}${INTEGRITY_STAMP_SUFFIX}`;
  let stamp;
  try { stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')); } catch { return; }
  const stat = fs.statSync(dbPath, { bigint: true });
  stamp.file = {
    ...stamp.file,
    birthtimeNs: String(stat.birthtimeNs),
    ctimeNs: String(stat.ctimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeNs: String(stat.mtimeNs),
    size: String(stat.size),
  };
  fs.writeFileSync(stampPath, `${JSON.stringify(stamp)}\n`);
}

/**
 * Re-clones every SQLite file in place: same path and bytes, but a new file,
 * so none of it is in the page cache. Models the first start after a reboot
 * or a long idle, when OpenClaw's integrity checks read the databases cold.
 */
function evictDatabasePageCache(sandboxBase) {
  const stack = [path.join(sandboxBase, 'state')];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'browser' && entry.name !== 'node_modules') stack.push(full);
      } else if (/\.sqlite(-wal)?$/.test(entry.name)) {
        const tmp = `${full}.bench-evict`;
        if (spawnSync('cp', ['-c', '-p', full, tmp]).status === 0) {
          fs.renameSync(tmp, full);
          rebindIntegrityStamp(full);
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * Changes one effective-config value the way a LobsterAI config sync does
 * before its restart, without touching channels, MCP or plugins.
 */
function mutateClonedConfig(sandboxBase, runIndex) {
  const configPath = path.join(sandboxBase, 'state', 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  const base = config.agents.defaults.timeoutSeconds ?? 600;
  config.agents.defaults.timeoutSeconds = base + (runIndex % 2 === 0 ? 1 : -1);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Boot-phase hotspots from the gateway's own .cpuprofile (the largest file is the gateway, not a worker). */
function summarizeRunProfile(profileDir, bootMs, roots) {
  if (!fs.existsSync(profileDir)) return null;
  const summaries = fs.readdirSync(profileDir).filter(f => f.endsWith('.cpuprofile')).map(f => {
    const file = path.join(profileDir, f);
    const summary = summarizeCpuProfile(JSON.parse(fs.readFileSync(file, 'utf8')), { untilMs: bootMs ?? Infinity, rootsToStrip: roots });
    const idleMs = summary.files.find(x => x.name === '((idle))')?.ms ?? 0;
    return { file, busyMs: summary.sampledMs - idleMs, ...summary };
  });
  // Workers and launchers profile too; the gateway is the busiest process during boot.
  return summaries.sort((a, b) => b.busyMs - a.busyMs)[0] ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function probeStartup(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1000) });
    if (response.status === 404) {
      const legacy = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
      return legacy.ok && (await legacy.json().catch(() => null))?.ready === true;
    }
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.ok === true && payload.status === 'started';
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

/** One gateway start: milestones, readiness, optional health RPCs, then a timed SIGTERM shutdown. */
async function runGatewayOnce(ctx, runIndex, { healthCheck }) {
  const { port, token } = ctx;
  const env = buildGatewayEnv({ ...ctx, port, token });
  const execArgv = ['--max-old-space-size=4096'];
  const profileDir = path.join(ctx.sandboxRoot, 'cpu-profiles', `run${runIndex}`);
  if (ctx.cpuProf) execArgv.push('--cpu-prof', `--cpu-prof-dir=${profileDir}`);
  const checkpointsBefore = readStartupCheckpoints(ctx.sandboxBase);
  const logPath = path.join(ctx.sandboxRoot, `run${runIndex}.log`);
  const log = fs.createWriteStream(logPath);
  const args = ['-p', ctx.profile, ctx.helper, ...execArgv, ctx.entry, 'gateway', '--port', String(port), '--token', token];

  const startedAt = performance.now();
  const child = spawn('sandbox-exec', args, { cwd: ctx.runtimeRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const marks = {};
  let plugins = null;
  const errors = new Set();
  const isolationHits = new Set();
  // Agent databases opened without a rescan (openclaw-agent-db-integrity-stamp.patch).
  let integrityStampHits = 0;
  const normalize = line => normalizeErrorLine(line, [ctx.sandboxRoot, ctx.runtimeRoot]);
  let exitedEarly = null;

  const onOutput = chunk => {
    const text = chunk.toString();
    log.write(text);
    const at = Math.round(performance.now() - startedAt);
    for (const key of matchGatewayMilestones(text)) if (marks[key] === undefined) marks[key] = at;
    plugins = plugins ?? parseLoadedPlugins(text);
    for (const line of stripAnsi(text).split('\n')) {
      if (line.includes('unchanged since its last verified clean close')) integrityStampHits += 1;
      if (BLOCKED_WRITE_RE.test(line)) isolationHits.add(line.trim().slice(0, 300));
      else if (ERROR_LINE_RE.test(line)) errors.add(normalize(line));
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.once('exit', (code, signal) => { exitedEarly = { code, signal }; });

  let ready = false;
  while (!exitedEarly && performance.now() - startedAt < ctx.timeoutMs) {
    if (await probeStartup(port)) { ready = true; break; }
    await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
  }
  if (ready) marks.probeReady = Math.round(performance.now() - startedAt);

  const health = ready && healthCheck ? runHealthCalls(ctx, env, port, token) : null;
  // Stay up after readiness to see post-ready background work: the slowest probe
  // is how long the event loop was blocked, i.e. how long a request had to wait.
  let postReadyMaxProbeMs = null;
  if (ready && ctx.holdMs > 0) {
    postReadyMaxProbeMs = 0;
    const holdUntil = performance.now() + ctx.holdMs;
    while (!exitedEarly && performance.now() < holdUntil) {
      const probeAt = performance.now();
      await probeStartup(port);
      postReadyMaxProbeMs = Math.max(postReadyMaxProbeMs, Math.round(performance.now() - probeAt));
      await new Promise(r => setTimeout(r, PROBE_INTERVAL_MS));
    }
  }

  let shutdownMs = null;
  let killed = false;
  if (!exitedEarly) {
    const stopAt = performance.now();
    child.kill('SIGTERM');
    if (!(await waitForExit(child, BENCH_KILL_AFTER_MS))) {
      killed = true;
      child.kill('SIGKILL');
      await waitForExit(child, 5000);
    }
    shutdownMs = Math.round(performance.now() - stopAt);
  }
  await new Promise(r => log.end(r));
  const phases = computeStartupPhases(marks);
  return {
    run: runIndex,
    ready,
    exitedEarly: ready ? null : exitedEarly,
    marks,
    phases,
    ...(() => {
      const after = readStartupCheckpoints(ctx.sandboxBase);
      return {
        checkpoint: compareStartupCheckpoints(checkpointsBefore[CHECKPOINT_META_KEYS.startup], after[CHECKPOINT_META_KEYS.startup]),
        stateCheckpoint: compareStartupCheckpoints(checkpointsBefore[CHECKPOINT_META_KEYS.state], after[CHECKPOINT_META_KEYS.state]),
      };
    })(),
    bootProfile: ctx.cpuProf ? summarizeRunProfile(profileDir, phases.boot, [ctx.runtimeRoot, 'file://']) : null,
    plugins,
    integrityStampHits,
    postReadyMaxProbeMs,
    errors: [...errors].sort(),
    isolationHits: [...isolationHits],
    shutdownMs,
    wouldBeKilledByApp: shutdownMs !== null && shutdownMs > APP_SHUTDOWN_GRACE_MS,
    killed,
    health,
    logPath,
  };
}

/** A stable, comparable digest of a gateway RPC result: what is configured and running, not timestamps. */
function summarizeHealth(method, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (method === 'channels.status') {
    const channels = payload.channels || payload.channelAccounts || payload;
    const out = {};
    for (const [id, value] of Object.entries(channels)) {
      const accounts = Array.isArray(value) ? value : value?.accounts ? Object.values(value.accounts) : [value];
      out[id] = accounts.map(a => ({ configured: a?.configured ?? null, enabled: a?.enabled ?? null, running: a?.running ?? null }));
    }
    return out;
  }
  if (method === 'tools.catalog') {
    const groups = payload.groups || payload.sources || [];
    const tools = Array.isArray(payload.tools) ? payload.tools : groups.flatMap(g => g.tools || []);
    const bySource = {};
    for (const tool of tools) {
      const source = tool.source || tool.pluginId || tool.group || 'core';
      bySource[source] = (bySource[source] || 0) + 1;
    }
    return { toolCount: tools.length, bySource };
  }
  if (method === 'skills.status') {
    const skills = payload.skills || [];
    return { count: skills.length, eligible: skills.filter(s => s.eligible).length };
  }
  if (method === 'cron.status') return { enabled: payload.enabled ?? null, jobs: payload.jobs ?? payload.jobCount ?? null };
  if (method === 'health') return { ok: payload.ok ?? null };
  return payload;
}

/** An error line without what changes between runs: timestamps, temp paths, ids and numbers. */
function normalizeErrorLine(line, roots) {
  let out = line.trim().replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})\s*/, '');
  for (const root of roots) out = out.split(root).join('<root>');
  return out
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)*/g, '#')
    .slice(0, 240);
}

function runHealthCalls(ctx, env, port, token) {
  const results = {};
  for (const { method, params } of HEALTH_CALLS) {
    const result = spawnSync('sandbox-exec', ['-p', ctx.profile, ctx.helper, ctx.entry, 'gateway', 'call', method,
      '--params', JSON.stringify(params), '--json', '--url', `ws://127.0.0.1:${port}`, '--token', token], {
      cwd: ctx.runtimeRoot, env, encoding: 'utf8', timeout: 60_000,
    });
    const stdout = stripAnsi(result.stdout || '');
    const jsonStart = stdout.indexOf('{');
    let payload = null;
    try { payload = jsonStart >= 0 ? JSON.parse(stdout.slice(jsonStart)) : null; } catch { /* reported below */ }
    results[method] = payload
      ? { ok: true, summary: summarizeHealth(method, payload), raw: JSON.stringify(payload).slice(0, RAW_HEALTH_LIMIT) }
      : { ok: false, error: stripAnsi(`${result.stderr || ''}${stdout}`).trim().split('\n').slice(-3).join(' | ').slice(0, 400) };
  }
  return results;
}

function fmt(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(2)}s` : '-';
}

function summarizeRuntime(runs) {
  const warm = runs.slice(1).filter(r => r.ready);
  const phase = (list, key) => median(list.map(r => r.phases[key]));
  return {
    first: Object.fromEntries(STARTUP_PHASES.map(p => [p.key, runs[0]?.ready ? runs[0].phases[p.key] : null])),
    warm: Object.fromEntries(STARTUP_PHASES.map(p => [p.key, phase(warm, p.key)])),
    shutdownMedianMs: median(runs.map(r => r.shutdownMs)),
    wouldBeKilled: runs.filter(r => r.wouldBeKilledByApp).length,
    failedRuns: runs.filter(r => !r.ready).map(r => r.run),
  };
}

function printReport(results) {
  for (const r of results) {
    console.log(`\n=== ${r.label}: ${r.root}`);
    const rows = {};
    for (const p of STARTUP_PHASES) {
      rows[p.key] = { first: fmt(r.summary.first[p.key]), warmMedian: fmt(r.summary.warm[p.key]), ...Object.fromEntries(r.runs.map(run => [`run${run.run}`, fmt(run.phases[p.key])])) };
    }
    console.table(rows);
    console.log(`  shutdown median ${fmt(r.summary.shutdownMedianMs)}; over the app's ${APP_SHUTDOWN_GRACE_MS}ms grace: ${r.summary.wouldBeKilled}/${r.runs.length}`);
    if (r.summary.failedRuns.length) console.log(`  FAILED runs: ${r.summary.failedRuns.join(', ')} (see run logs in ${r.sandboxRoot})`);
    const last = r.runs[r.runs.length - 1];
    console.log(`  plugins (${last?.plugins?.length ?? 0}): ${(last?.plugins || []).join(', ')}`);
    if (last?.health) {
      for (const [method, value] of Object.entries(last.health)) {
        console.log(`  ${method}: ${value.ok ? JSON.stringify(value.summary) : `FAILED ${value.error}`}`);
      }
    }
    for (const run of r.runs.filter(x => x.bootProfile)) {
      console.log(`  run${run.run} boot hotspots (self time; ${run.bootProfile.busyMs}ms busy of ${run.bootProfile.sampledMs}ms before "loading configuration"):`);
      for (const f of run.bootProfile.files.slice(0, 10)) console.log(`    ${String(f.ms).padStart(6)}ms  ${f.name}`);
      console.log('    top functions:');
      for (const f of run.bootProfile.functions.slice(0, 10)) console.log(`    ${String(f.ms).padStart(6)}ms  ${f.name}`);
    }
    const hits = [...new Set(r.runs.flatMap(run => run.isolationHits))];
    if (hits.length) console.log(`  writes the jail blocked (${hits.length}):\n    ${hits.slice(0, 8).join('\n    ')}`);
    const errors = [...new Set(r.runs.flatMap(run => run.errors))];
    console.log(`  distinct error signatures: ${errors.length} (full output in ${r.sandboxRoot}/run*.log)`);
  }
}

/** Regressions between the first runtime (baseline) and each other one. */
function compareRuntimes(results) {
  const problems = [];
  for (const r of results) {
    if (r.summary.failedRuns.length) problems.push(`${r.label}: runs ${r.summary.failedRuns.join(', ')} did not become ready`);
    const last = r.runs[r.runs.length - 1];
    for (const [method, value] of Object.entries(last?.health || {})) {
      if (!value.ok) problems.push(`${r.label}: ${method} failed`);
    }
  }
  const [base, ...others] = results;
  for (const other of others) {
    const baseLast = base.runs[base.runs.length - 1];
    const otherLast = other.runs[other.runs.length - 1];
    const missing = (baseLast?.plugins || []).filter(id => !(otherLast?.plugins || []).includes(id));
    const added = (otherLast?.plugins || []).filter(id => !(baseLast?.plugins || []).includes(id));
    if (missing.length) problems.push(`${other.label}: plugins missing vs ${base.label}: ${missing.join(', ')}`);
    if (added.length) console.log(`  note: ${other.label} also loads ${added.join(', ')}`);
    // Jail noise is the same on both sides, so only new signatures are worth a look.
    const baseErrors = new Set(base.runs.flatMap(run => run.errors));
    const newErrors = [...new Set(other.runs.flatMap(run => run.errors))].filter(e => !baseErrors.has(e));
    if (newErrors.length) {
      console.log(`\n  error signatures only ${other.label} printed (${newErrors.length}; review, not a failure):\n    ${newErrors.slice(0, 15).join('\n    ')}`);
    }
    for (const { method } of HEALTH_CALLS) {
      const a = JSON.stringify(baseLast?.health?.[method]?.summary ?? null);
      const b = JSON.stringify(otherLast?.health?.[method]?.summary ?? null);
      if (a !== b) problems.push(`${other.label}: ${method} differs from ${base.label}\n      ${base.label}: ${a}\n      ${other.label}: ${b}`);
    }
    console.log(`\n=== ${other.label} vs ${base.label} (negative is faster)`);
    const rows = {};
    for (const p of STARTUP_PHASES) {
      const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' ? `${x - y >= 0 ? '+' : ''}${fmt(x - y)}` : '-');
      rows[p.key] = { first: delta(other.summary.first[p.key], base.summary.first[p.key]), warmMedian: delta(other.summary.warm[p.key], base.summary.warm[p.key]) };
    }
    rows.shutdown = { first: '-', warmMedian: (() => {
      const x = other.summary.shutdownMedianMs; const y = base.summary.shutdownMedianMs;
      return typeof x === 'number' && typeof y === 'number' ? `${x - y >= 0 ? '+' : ''}${fmt(x - y)}` : '-';
    })() };
    console.table(rows);
  }
  return problems;
}

async function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string', multiple: true, default: [] },
      runs: { type: 'string', default: '5' },
      source: { type: 'string', default: DEFAULT_SOURCE },
      electron: { type: 'string' },
      'work-dir': { type: 'string', default: path.join(os.tmpdir(), 'lobster-bench-openclaw') },
      timeout: { type: 'string', default: '180000' },
      'cpu-prof': { type: 'boolean', default: false },
      'skip-health': { type: 'boolean', default: false },
      // Restart after a config change, like LobsterAI's config-sync restarts.
      'config-change': { type: 'boolean', default: false },
      // Start every run with the databases out of the page cache.
      'cold-cache': { type: 'boolean', default: false },
      // Keep each gateway up this long after readiness and report its slowest probe.
      hold: { type: 'string', default: '0' },
      keep: { type: 'boolean', default: false },
      json: { type: 'string' },
    },
  });
  if (process.platform !== 'darwin') fail('the jailed benchmark needs macOS sandbox-exec; on other platforms use analyze-openclaw-startup-logs.cjs');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) fail('--runs must be a positive integer');
  const source = fs.realpathSync(values.source);
  if (!fs.existsSync(path.join(source, 'state', 'openclaw.json'))) fail(`${source}/state/openclaw.json not found`);
  const runtimes = parseRuntimeSpecs(values.runtime);

  const benchStartedAt = Date.now();
  const live = findLiveLobsterGateways();
  if (live.length) {
    console.warn(`[bench] LobsterAI's gateway is running (pid ${live.join(', ')}). The clone may catch its database mid-write`
      + ' and its CPU use skews timings; quit LobsterAI for clean numbers.');
  }

  fs.mkdirSync(values['work-dir'], { recursive: true });
  const workDir = fs.mkdtempSync(path.join(fs.realpathSync(values['work-dir']), 'run-'));
  console.log(`[bench] work dir: ${workDir}`);
  console.log(`[bench] isolation: writes under ${os.homedir()} denied; outbound network denied except loopback`);

  const results = [];
  for (const runtime of runtimes) {
    const sandboxRoot = path.join(workDir, runtime.label);
    const sandboxBase = path.join(sandboxRoot, 'openclaw');
    console.log(`\n[bench] ${runtime.label}: cloning state into ${sandboxBase}`);
    cloneState(source, sandboxBase);
    clearClonedGatewayLocks(sandboxBase);
    fs.mkdirSync(path.join(sandboxRoot, 'codex'), { recursive: true });
    const secretNames = rewriteClonedConfig({
      sourceBase: source, sandboxBase, runtimeRoot: runtime.root, logFile: path.join(sandboxRoot, 'openclaw.log'),
    });
    const helper = resolveElectronHelper(runtime.root, values.electron);
    const ctx = {
      sandboxRoot, sandboxBase, runtimeRoot: runtime.root, helper, secretNames,
      entry: path.join(runtime.root, 'openclaw.mjs'),
      profile: buildSandboxProfile({ sandboxRoot }),
      timeoutMs: Number(values.timeout),
      // Stable across runs like the app's persisted port and token: both feed the
      // effective-config fingerprint, so changing them would miss the checkpoint every run.
      port: await freePort(),
      token: crypto.randomBytes(24).toString('hex'),
      cpuProf: values['cpu-prof'],
      holdMs: Number(values.hold),
    };
    console.log(`[bench] ${runtime.label}: electron helper ${helper}`);
    const runResults = [];
    for (let i = 1; i <= runs; i += 1) {
      if (values['config-change'] && i > 1) mutateClonedConfig(sandboxBase, i);
      if (values['cold-cache'] && i > 1) evictDatabasePageCache(sandboxBase);
      const result = await runGatewayOnce(ctx, i, { healthCheck: i === runs && !values['skip-health'] });
      console.log(`[bench] ${runtime.label} run ${i}/${runs}: ${result.ready ? `ready in ${fmt(result.phases.total)}` : 'NOT READY'}`
        + `, boot ${fmt(result.phases.boot)}, checkpoint ${result.checkpoint.outcome}`
        + `${result.checkpoint.changed.length ? `(${result.checkpoint.changed.join(',')})` : ''}`
        + `, state migrations ${result.stateCheckpoint.outcome === 'miss' ? 'reran' : 'skipped'}`
        + `, integrity stamps used ${result.integrityStampHits}`
        + `${result.postReadyMaxProbeMs === null ? '' : `, slowest post-ready probe ${result.postReadyMaxProbeMs}ms`}`
        + `, shutdown ${fmt(result.shutdownMs)}${result.wouldBeKilledByApp ? ' (app would SIGKILL)' : ''}`);
      runResults.push(result);
    }
    results.push({ ...runtime, sandboxRoot, runs: runResults, summary: summarizeRuntime(runResults) });
  }

  printReport(results);
  const problems = compareRuntimes(results);
  const realChanges = listRealStateChanges(source, benchStartedAt);
  if (realChanges.length) {
    const message = `real state changed during the bench (${realChanges.length}${realChanges.length >= 20 ? '+' : ''}):\n      ${realChanges.join('\n      ')}`;
    // With LobsterAI running its own writes are expected; without it, this is an isolation failure.
    if (live.length) console.warn(`\n[bench] note: ${message}`);
    else problems.push(message);
  } else {
    console.log(`\n[bench] verified: nothing under ${source} changed during the bench`);
  }
  if (values.json) {
    fs.writeFileSync(values.json, `${JSON.stringify({ workDir, runtimes: results, problems }, null, 2)}\n`);
    console.log(`\n[bench] wrote ${values.json}`);
  }
  if (!values.keep) {
    // Run logs and profiles are small; the cloned state is the bulk.
    for (const r of results) fs.rmSync(path.join(r.sandboxRoot, 'openclaw'), { recursive: true, force: true });
    console.log(`[bench] removed cloned state; run logs kept in ${workDir}`);
  }
  if (problems.length) {
    console.log(`\n[bench] PROBLEMS:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('\n[bench] no functional differences found');
}

main().catch(error => {
  console.error('[bench] crashed', error);
  process.exit(2);
});
