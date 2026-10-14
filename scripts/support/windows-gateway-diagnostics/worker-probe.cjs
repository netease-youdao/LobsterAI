'use strict';

// This entry never opens the customer's state. All SQLite files belong to workDir.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PROBE_VERSION = 2;
const CHILD_MARKER = '--openclaw-sqlite-readonly-child';
const RESULT_FILE_ARG = '--openclaw-sqlite-readonly-result-file';
const OUTPUT_LIMIT = 1024 * 1024;
const WORKER_TIMEOUT_MS = 30_000;

function classifyOutput(stdout, exitCode) {
  let parsed;
  let jsonError;
  try { parsed = JSON.parse(stdout); } catch (error) { jsonError = error.message; }
  const validWorkerResult = !!parsed && !Array.isArray(parsed)
    && Object.keys(parsed).length === 2
    && ((parsed.ok === true && typeof parsed.location === 'string')
      || (parsed.ok === false && typeof parsed.message === 'string'));
  return {
    exitCode,
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutSha256: crypto.createHash('sha256').update(stdout).digest('hex'),
    validWholeStdoutJson: jsonError === undefined,
    validWorkerResult,
    workerReportedOk: validWorkerResult ? parsed.ok : undefined,
    containsAnomaly: /ANOMALY:.*(?:REX|prefix)/i.test(stdout),
    jsonError,
    // A successful exit plus malformed stdout matches the upstream parser boundary.
    successfulExitWithInvalidJson: exitCode === 0 && jsonError !== undefined,
  };
}

function childEnvironment(workDir, inherited = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENCLAW_|LOBSTER_|LOBSTERAI_)/i.test(key)
      || /^(?:NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_DISABLE_COMPILE_CACHE)$/i.test(key)) {
      delete env[key];
    }
  }
  const stateDir = path.join(workDir, 'state');
  const tempDir = path.join(workDir, 'temp');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'openclaw.json'), '{}\n');
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    OPENCLAW_HOME: workDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
    NODE_COMPILE_CACHE: path.join(workDir, 'compile-cache'),
    XDG_CACHE_HOME: path.join(workDir, 'cache'),
    LOCALAPPDATA: path.join(workDir, 'local-app-data'),
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
  };
}

function executeChild(args, options, onSpawn = () => {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    let child;
    child = execFile(process.execPath, args, {
      ...options,
      encoding: 'utf8',
      windowsHide: true,
      timeout: WORKER_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      const exitCode = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({
        startedAt, durationMs: Date.now() - started, pid: child?.pid,
        exitCode, signal: error?.signal ?? null,
        timedOut: !!error?.killed,
        launchError: error?.message,
        stdout, stderr,
        analysis: classifyOutput(stdout, exitCode),
      });
    });
    child.once('spawn', () => onSpawn(child.pid));
  });
}

async function runProbe({ runtimeRoot, workDir, reportDir, observationMs = 2500 }) {
  runtimeRoot = fs.realpathSync(runtimeRoot);
  workDir = fs.realpathSync(workDir);
  fs.mkdirSync(reportDir, { recursive: true });
  const env = childEnvironment(workDir);
  const reportPath = path.join(reportDir, 'worker-probe.json');
  const result = {
    probeVersion: PROBE_VERSION,
    startedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch,
    executablePath: process.execPath, runtimeRoot,
    versions: process.versions,
    scope: 'Synthetic database only; no customer database or config is opened.',
    attempts: [],
  };
  const save = () => {
    const temporary = reportPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n');
    fs.renameSync(temporary, reportPath);
  };
  const onSpawn = (pid) => {
    fs.writeFileSync(path.join(reportDir, 'active-probe.json'), JSON.stringify({ pid, parentPid: process.pid }));
  };
  save();
  try {
    result.baseline = await executeChild([
      '-e', 'process.stdout.write(JSON.stringify({diagnostic:"lobsterai-node-baseline",versions:process.versions}));setTimeout(()=>{},1800)',
    ], { env, cwd: workDir }, onSpawn);
    const { DatabaseSync } = require('node:sqlite');
    const fixture = path.join(workDir, 'diagnostic-fixture.sqlite');
    const database = new DatabaseSync(fixture);
    try {
      database.exec("CREATE TABLE diagnostic_probe (value TEXT); INSERT INTO diagnostic_probe VALUES ('synthetic data only');");
    } finally { database.close(); }
    result.fixtureSha256Before = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    const entries = [
      ['bundle-shim', path.join(runtimeRoot, 'sqlite-readonly-location.worker.mjs')],
      ['dist-worker', path.join(runtimeRoot, 'dist', 'infra', 'sqlite-readonly-location.worker.js')],
    ];
    for (const [entryKind, entryPath] of entries) {
      if (!fs.existsSync(entryPath)) {
        result.attempts.push({ entryKind, entryPath, skipped: 'Worker entry is missing in this installation.' });
        save();
        continue;
      }
      for (const mode of ['sync', 'async']) {
        // Older workers ignore these extra arguments, so the same probe supports both protocols.
        const resultFilePath = path.join(workDir, `worker-result-${entryKind}-${mode}.json`);
        const attempt = await executeChild([entryPath, CHILD_MARKER, mode, fixture, RESULT_FILE_ARG, resultFilePath], {
          env, cwd: workDir,
        }, onSpawn);
        attempt.resultFile = { present: fs.existsSync(resultFilePath) };
        if (attempt.resultFile.present) {
          try {
            const stat = fs.lstatSync(resultFilePath);
            if (!stat.isFile() || stat.size > OUTPUT_LIMIT) throw new Error('Invalid diagnostic result file.');
            const json = fs.readFileSync(resultFilePath, 'utf8');
            attempt.resultFile.json = json;
            attempt.resultFile.analysis = classifyOutput(json, attempt.exitCode);
          } catch (error) { attempt.resultFile.readError = error.message; }
        }
        result.attempts.push({ entryKind, entryPath, mode, ...attempt });
        save();
      }
    }
    result.fixtureSha256After = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
    result.fixtureBytesUnchanged = result.fixtureSha256Before === result.fixtureSha256After;
  } catch (error) {
    result.probeError = error.stack || String(error);
  } finally {
    const observed = result.attempts.filter((attempt) => attempt.analysis);
    const resultFilesSucceeded = observed.length === 4 && observed.every((attempt) =>
      attempt.exitCode === 0 && attempt.resultFile.analysis?.workerReportedOk === true);
    result.finding = resultFilesSucceeded
      ? 'Result-file protocol succeeded in all four probes. Inspect stdout separately for environmental noise.'
      : observed.some((attempt) => attempt.resultFile.present)
        ? 'Result-file protocol did not succeed in all four probes; inspect result files, exit codes, and stderr.'
      : observed.some((attempt) => attempt.analysis.successfulExitWithInvalidJson && attempt.analysis.containsAnomaly)
      ? 'Observed ANOMALY text and invalid whole-stdout JSON with worker exit code 0.'
      : observed.some((attempt) => attempt.analysis.successfulExitWithInvalidJson)
        ? 'Observed invalid whole-stdout JSON with worker exit code 0; inspect captured stdout.'
        : observed.length && observed.every((attempt) => attempt.exitCode !== 0)
          ? 'All worker probes failed; inspect exit codes and stderr. The contamination hypothesis remains unverified.'
        : observed.length
          ? 'No exit-0 JSON contamination observed in these isolated probes; this does not rule out the customer failure.'
          : 'No worker probe completed; see missing entries or probeError.';
    result.finishedAt = new Date().toISOString();
    save();
    // Keep this diagnostic process briefly observable for loaded-module collection.
    if (observationMs > 0) await new Promise((resolve) => setTimeout(resolve, observationMs));
  }
  return result;
}

module.exports = { classifyOutput, childEnvironment, executeChild, runProbe };

if (require.main === module) {
  const [runtimeRoot, workDir, reportDir] = process.argv.slice(2);
  if (!runtimeRoot || !workDir || !reportDir) {
    console.error('Usage: worker-probe.cjs <runtime-root> <private-work-dir> <report-dir>');
    process.exitCode = 2;
  } else {
    runProbe({ runtimeRoot, workDir, reportDir }).then(() => {
      console.log('Diagnostic worker probe completed.');
    }).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  }
}
