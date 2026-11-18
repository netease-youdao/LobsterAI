'use strict';

// Startup performance probe, run by LobsterAI.exe with ELECTRON_RUN_AS_NODE=1.
// Customer files are only read as raw bytes (never opened through SQLite).
// All writes stay in the diagnostic directories named by the request.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROBE_VERSION = 2;
// Time from process creation to the first probe statement: Electron-as-Node bootstrap.
const BOOTSTRAP_MS = Math.round(process.uptime() * 1000);
const LARGE_FILE_READ_LIMIT = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const SPAWN_TIMEOUT_MS = 60_000;
const SLOWEST_LIMIT = 10;

function round(value) {
  return Math.round(value * 100) / 100;
}

function elapsedSince(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function summarize(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = quantile => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    totalMs: round(total),
    meanMs: round(total / values.length),
    p50Ms: round(at(0.5)),
    p90Ms: round(at(0.9)),
    p99Ms: round(at(0.99)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

/** Wall time versus this process's CPU time: I/O or scanner waits show as wall >> CPU. */
async function measure(run) {
  const cpuBefore = process.cpuUsage();
  const start = process.hrtime.bigint();
  let value;
  try {
    value = await run();
  } catch (error) {
    value = { error: String(error && error.stack ? error.stack : error) };
  }
  const cpu = process.cpuUsage(cpuBefore);
  return { ...value, wallMs: round(elapsedSince(start)), cpuMs: round((cpu.user + cpu.system) / 1000) };
}

function readFiles(files, root) {
  const latencies = [];
  const timed = [];
  let bytes = 0;
  let failures = 0;
  for (const file of files) {
    const start = process.hrtime.bigint();
    try {
      bytes += fs.readFileSync(file).length;
    } catch {
      failures += 1;
      continue;
    }
    const ms = elapsedSince(start);
    latencies.push(ms);
    timed.push({ file: root ? path.relative(root, file) : path.basename(file), ms: round(ms) });
  }
  timed.sort((left, right) => right.ms - left.ms);
  return { ...summarize(latencies), bytes, failures, slowest: timed.slice(0, SLOWEST_LIMIT) };
}

function readLargeFile(entry) {
  let stat;
  try {
    stat = fs.statSync(entry.path);
  } catch {
    return { label: entry.label, exists: false };
  }
  const openStart = process.hrtime.bigint();
  const fd = fs.openSync(entry.path, 'r');
  const openMs = elapsedSince(openStart);
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const readStart = process.hrtime.bigint();
  let firstChunkMs;
  let bytesRead = 0;
  try {
    while (bytesRead < LARGE_FILE_READ_LIMIT) {
      const count = fs.readSync(fd, buffer, 0, CHUNK_BYTES, bytesRead);
      if (firstChunkMs === undefined) firstChunkMs = elapsedSince(readStart);
      if (count <= 0) break;
      bytesRead += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  const readMs = elapsedSince(readStart);
  return {
    label: entry.label,
    exists: true,
    sizeBytes: stat.size,
    openMs: round(openMs),
    firstChunkMs: round(firstChunkMs ?? 0),
    readMs: round(readMs),
    bytesRead,
    mbPerSec: readMs > 0 ? round(bytesRead / 1048576 / (readMs / 1000)) : null,
  };
}

function writeBench(entry) {
  const count = entry.count ?? 100;
  const directory = entry.path;
  fs.mkdirSync(directory, { recursive: true });
  const payload = Buffer.alloc(4096, 0x61);
  const createMs = [];
  const deleteMs = [];
  const created = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const file = path.join(directory, `bench-${index}.tmp`);
      const start = process.hrtime.bigint();
      const fd = fs.openSync(file, 'wx');
      created.push(file);
      try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      createMs.push(elapsedSince(start));
    }
    for (const file of created.splice(0)) {
      const start = process.hrtime.bigint();
      fs.unlinkSync(file);
      deleteMs.push(elapsedSince(start));
    }
    const large = path.join(directory, 'bench-large.tmp');
    const chunk = Buffer.alloc(CHUNK_BYTES, 0x62);
    const largeChunks = 16;
    const writeStart = process.hrtime.bigint();
    const fd = fs.openSync(large, 'wx');
    created.push(large);
    try {
      for (let index = 0; index < largeChunks; index += 1) fs.writeSync(fd, chunk);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const largeWriteMs = elapsedSince(writeStart);
    const readStart = process.hrtime.bigint();
    const readBytes = fs.readFileSync(large).length;
    const readBackMs = elapsedSince(readStart);
    return {
      label: entry.label,
      smallCreateWriteFsync: summarize(createMs),
      smallDelete: summarize(deleteMs),
      largeWriteFsyncMs: round(largeWriteMs),
      largeWriteMBps: round(largeChunks / (largeWriteMs / 1000)),
      // Served from cache, so this mostly measures scanning of a freshly written file.
      largeReadBackMs: round(readBackMs),
      largeReadBackBytes: readBytes,
    };
  } finally {
    for (const file of created) fs.rmSync(file, { force: true });
  }
}

/** Mirrors OpenClaw's defaults: WAL plus SQLite's default synchronous=FULL. */
function sqliteBench(directory) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (error) {
    return { unavailable: String(error && error.message ? error.message : error) };
  }
  fs.mkdirSync(directory, { recursive: true });
  const results = {};
  for (const [label, journalMode, count] of [['walFull', 'WAL', 100], ['rollbackFull', 'DELETE', 50]]) {
    const file = path.join(directory, `bench-${label}.sqlite`);
    const commits = [];
    const openStart = process.hrtime.bigint();
    const database = new DatabaseSync(file);
    const openMs = elapsedSince(openStart);
    try {
      database.exec(`PRAGMA journal_mode = ${journalMode}; PRAGMA synchronous = FULL; CREATE TABLE bench (id INTEGER PRIMARY KEY, value BLOB);`);
      const insert = database.prepare('INSERT INTO bench (value) VALUES (?)');
      const payload = Buffer.alloc(1024, 0x63);
      for (let index = 0; index < count; index += 1) {
        const start = process.hrtime.bigint();
        database.exec('BEGIN IMMEDIATE');
        insert.run(payload);
        database.exec('COMMIT');
        commits.push(elapsedSince(start));
      }
    } finally {
      database.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
    }
    results[label] = { openMs: round(openMs), commit: summarize(commits) };
  }
  return results;
}

const SAMPLE_EXTENSIONS = /\.(?:js|mjs|cjs|json|py|md)$/i;
const SMALL_FILE_LIMIT = 1024 * 1024;

/** Depth-first listing with a time budget; reparse points are never followed. */
function walkFiles(root, { budgetMs = 20_000, include = () => true } = {}) {
  const files = [];
  const started = Date.now();
  const stack = [root];
  let truncated = false;
  while (stack.length) {
    if (Date.now() - started > budgetMs) {
      truncated = true;
      break;
    }
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && include(full)) files.push(full);
    }
  }
  files.sort();
  return { files, truncated, walkMs: Date.now() - started };
}

function sampleEvenly(files, limit) {
  if (files.length <= limit) return files;
  const step = files.length / limit;
  return Array.from({ length: limit }, (_, index) => files[Math.floor(index * step)]);
}

function smallSampleFile(file) {
  if (!SAMPLE_EXTENSIONS.test(file)) return false;
  try {
    const size = fs.statSync(file).size;
    return size > 0 && size <= SMALL_FILE_LIMIT;
  } catch {
    return false;
  }
}

/** First reads of files outside the runtime tree: same disk, different Defender exclusion state. */
function readLocationGroup(group) {
  const listing = walkFiles(group.root, { budgetMs: group.budgetMs ?? 20_000, include: smallSampleFile });
  const files = sampleEvenly(listing.files, group.limit ?? 80);
  return { label: group.label, walkMs: listing.walkMs, walkTruncated: listing.truncated, ...readFiles(files, group.root) };
}

function largestFiles(root, pattern, limit) {
  return walkFiles(root, { budgetMs: 10_000, include: file => pattern.test(file) }).files
    .map(file => ({ file, size: fs.statSync(file).size }))
    .sort((left, right) => right.size - left.size)
    .slice(0, limit)
    .map(entry => entry.file);
}

/** Disk latency without per-file open costs: scattered 4 KB reads inside one large file. */
function randomReadBench(entry) {
  const blockSize = entry.blockSize ?? 4096;
  const count = entry.count ?? 100;
  let size;
  try {
    size = fs.statSync(entry.path).size;
  } catch {
    return { label: entry.label, exists: false };
  }
  if (size < blockSize * count * 2) return { label: entry.label, exists: true, sizeBytes: size, skipped: 'file too small' };
  const openStart = process.hrtime.bigint();
  const fd = fs.openSync(entry.path, 'r');
  const openMs = elapsedSince(openStart);
  const buffer = Buffer.allocUnsafe(blockSize);
  const stride = Math.floor(size / count);
  let seed = 2166136261;
  const latencies = [];
  try {
    for (let index = 0; index < count; index += 1) {
      seed = (Math.imul(seed, 16777619) + index) >>> 0;
      // One read per stride keeps requests apart so read-ahead cannot serve the next one.
      const offset = Math.min(size - blockSize, index * stride + (seed % Math.max(1, stride - blockSize)));
      const start = process.hrtime.bigint();
      fs.readSync(fd, buffer, 0, blockSize, offset - (offset % blockSize));
      latencies.push(elapsedSince(start));
    }
  } finally {
    fs.closeSync(fd);
  }
  return { label: entry.label, exists: true, sizeBytes: size, openMs: round(openMs), read: summarize(latencies) };
}

function relativeLabel(prefix, root, file) {
  return `${prefix}/${path.relative(root, file).split(path.sep).join('/')}`;
}

/** Targets chosen by the probe so the collector only passes plain directory paths. */
function defaultTargets(request) {
  const targets = { largeFiles: [], randomReads: [], locationGroups: [] };
  if (request.runtimeRoot) {
    targets.largeFiles.push({ label: 'runtime/gateway-bundle.mjs', path: path.join(request.runtimeRoot, 'gateway-bundle.mjs') });
  }
  if (request.stateDir) {
    for (const file of largestFiles(request.stateDir, /\.sqlite$/i, 3)) {
      targets.largeFiles.push({ label: relativeLabel('state', request.stateDir, file), path: file });
    }
  }
  if (request.userDataDir) {
    targets.largeFiles.push({ label: 'userData/lobsterai.sqlite', path: path.join(request.userDataDir, 'lobsterai.sqlite') });
    targets.locationGroups.push({ label: 'userData/SKILLs', root: path.join(request.userDataDir, 'SKILLs') });
  }
  if (request.installRoot) {
    const resources = path.join(request.installRoot, 'resources');
    // The installer excludes cfmind, python-win and app.asar from Defender but keeps SKILLs scannable.
    targets.locationGroups.unshift({ label: 'install/resources/SKILLs', root: path.join(resources, 'SKILLs') });
    let installLarge;
    try {
      installLarge = fs.readdirSync(path.join(resources, 'python-win'), { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => path.join(resources, 'python-win', entry.name))
        .sort((left, right) => fs.statSync(right).size - fs.statSync(left).size)[0];
    } catch { /* python-win is optional */ }
    installLarge ??= path.join(resources, 'app.asar');
    targets.randomReads.push({ label: relativeLabel('install', request.installRoot, installLarge), path: installLarge });
  }
  const stateLarge = targets.largeFiles.find(entry => entry.label.startsWith('state/'));
  if (stateLarge) targets.randomReads.push({ label: stateLarge.label, path: stateLarge.path });
  return targets;
}

function timeSpawn(command, args, options = {}) {
  const start = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    windowsHide: true,
    ...options,
  });
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  return {
    ms: round(elapsedSince(start)),
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : undefined,
    // PowerShell writes module-preparation progress as CLIXML when redirected.
    powershellProgress: stderr.includes('#< CLIXML'),
    stdoutHead: stdout.slice(0, 200),
    stderrHead: stderr.slice(0, 400),
  };
}

function spawnBench(env = process.env, platform = process.platform) {
  const result = {
    electronNode: [1, 2, 3].map(() => timeSpawn(process.execPath, ['-e', '0'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } })),
  };
  if (platform !== 'win32') return result;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const system32 = path.win32.join(systemRoot, 'System32');
  const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  result.cmd = [1, 2].map(() => timeSpawn(path.win32.join(system32, 'cmd.exe'), ['/d', '/c', 'exit 0']));
  result.powershell = [1, 2].map(() => timeSpawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']));
  // The exact lock-owner identity query OpenClaw runs with a 5 second limit.
  result.powershellProcessStartQuery = timeSpawn(powershell, [
    '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $process = [System.Diagnostics.Process]::GetProcessById(${process.pid}); try { [Console]::Out.Write($process.StartTime.ToUniversalTime().ToString("o")) } finally { $process.Dispose() }`,
  ]);
  result.wmicProcessStartQuery = timeSpawn(path.win32.join(system32, 'wbem', 'wmic.exe'), [
    'process', 'where', `ProcessId=${process.pid}`, 'get', 'CreationDate', '/value',
  ]);
  return result;
}

function runtimeInfo() {
  const cpus = os.cpus();
  let reportHeader;
  try {
    const header = process.report && process.report.getReport ? process.report.getReport().header : undefined;
    if (header) reportHeader = { osMachine: header.osMachine, osVersion: header.osVersion, osRelease: header.osRelease, arch: header.arch };
  } catch { /* process.report is optional diagnostics */ }
  return {
    versions: {
      node: process.versions.node,
      electron: process.versions.electron,
      v8: process.versions.v8,
      sqlite: process.versions.sqlite,
    },
    arch: process.arch,
    platform: process.platform,
    osRelease: os.release(),
    osVersion: typeof os.version === 'function' ? os.version() : undefined,
    machine: typeof os.machine === 'function' ? os.machine() : undefined,
    cpuModel: cpus[0] ? cpus[0].model : undefined,
    cpuCount: cpus.length,
    cpuSpeedMHz: cpus[0] ? cpus[0].speed : undefined,
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    uptimeSec: Math.round(os.uptime()),
    bootstrapMs: BOOTSTRAP_MS,
    processorEnvironment: {
      PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
      PROCESSOR_ARCHITEW6432: process.env.PROCESSOR_ARCHITEW6432,
      PROCESSOR_IDENTIFIER: process.env.PROCESSOR_IDENTIFIER,
    },
    reportHeader,
  };
}

async function runProbe(request) {
  const report = {
    probeVersion: PROBE_VERSION,
    startedAt: new Date().toISOString(),
    runtime: runtimeInfo(),
    sections: {},
  };
  const save = () => {
    const temporary = request.reportPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
    fs.renameSync(temporary, request.reportPath);
  };
  save();
  const targets = defaultTargets(request);
  const sections = [
    // Cold: files this installation has not loaded since it was written.
    ['coldRead', () => readFiles(request.coldFiles || [], request.runtimeRoot)],
    ['repeatRead', () => readFiles(request.coldFiles || [], request.runtimeRoot)],
    // Files PowerShell read just before: shows whether scanning is cached per file or per process.
    ['crossProcessRead', () => readFiles(request.crossFiles || [], request.runtimeRoot)],
    ['locationGroups', () => ({ groups: (request.locationGroups || targets.locationGroups).map(readLocationGroup) })],
    // Before largeFiles, which would pull the same files into the cache.
    ['randomReads', () => ({ files: (request.randomReads || targets.randomReads).map(randomReadBench) })],
    ['largeFiles', () => ({ files: (request.largeFiles || targets.largeFiles).map(readLargeFile) })],
    ['writes', () => ({ locations: (request.writeDirs || []).map(writeBench) })],
    ['sqlite', () => (request.sqliteDir ? sqliteBench(request.sqliteDir) : { skipped: true })],
    ['spawn', () => (request.spawn ? spawnBench() : { skipped: true })],
  ];
  for (const [name, run] of sections) {
    report.sections[name] = await measure(run);
    save();
  }
  report.resourceUsage = process.resourceUsage();
  report.finishedAt = new Date().toISOString();
  save();
  return report;
}

module.exports = {
  summarize, readFiles, readLargeFile, writeBench, sqliteBench, spawnBench, runProbe,
  walkFiles, sampleEvenly, readLocationGroup, randomReadBench, defaultTargets,
};

if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('Usage: performance-probe.cjs <request.json>');
    process.exitCode = 2;
  } else {
    runProbe(JSON.parse(fs.readFileSync(requestPath, 'utf8'))).then(() => {
      console.log('Performance probe completed.');
    }).catch(error => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
